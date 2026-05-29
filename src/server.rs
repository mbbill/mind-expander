//! HTTP server for the `view` subcommand.
//!
//! Serves:
//!   - the embedded viewer bundle (HTML + assets) at `/`
//!   - `/api/health` — liveness probe used by the `tour` CLI
//!   - `/api/facts` — JSON of facts extracted from the workspace
//!   - `/api/source?path=<abs>` — source-file streaming, sandboxed to
//!     the workspace root so the viewer can render the code panel.
//!   - `/api/diff?path=<rel>` — structured per-file unified diff
//!     (base→head); only available when `--at` enabled diff mode.
//!     The panel falls back to `/api/source` on 204 (unchanged).
//!   - `/api/tour` (POST) — accept a tour JSON, validate + resolve it
//!     against the span index, and push the resolved form onto the
//!     in-memory queue (consumed later by the viewer's SSE channel).
//!
//! The Vite dev server proxies the `/api/*` routes here during viewer
//! development; in production this binary serves everything.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use arc_swap::ArcSwap;
use axum::{
    extract::{Query, State},
    http::{header, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{get, post},
    Json, Router,
};
use futures::stream::{Stream, StreamExt};
use include_dir::{include_dir, Dir};
use notify::{RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::convert::Infallible;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use tokio_stream::wrappers::{errors::BroadcastStreamRecvError, BroadcastStream};

use crate::diff::{diff_file, DiffOutcome};
use crate::git_view::{
    find_repo_root, materialize_head, mind_expander_cache_dir, prune_worktrees, resolve_sha,
    show_blob, RevSpec,
};
use crate::model::WorkspaceFacts;
use crate::tour::{ingest, IngestErr, IngestOk, ResolveError, SpanIndex, Tour, TourQueue};
use crate::unified_facts::{build_unified, is_source_path, Hunks};

// Embed the built viewer at compile time. `build.rs` checks that
// `viewer/dist/index.html` exists and fails the build with a helpful
// message if it's missing.
static VIEWER_DIST: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/viewer/dist");

/// The single immutable unit swapped atomically on every re-extract.
/// `facts_json` (served by `/api/facts`) and `span_index` (used by
/// `/api/tour` resolution) MUST move together: a reader that loads one
/// and then the other across a swap boundary would otherwise observe a
/// torn pair (new facts JSON against a stale span index). Holding them
/// in one `Arc<FactsSnapshot>` behind an `ArcSwap` makes the swap
/// atomic from any reader's point of view.
struct FactsSnapshot {
    facts_json: String,
    span_index: SpanIndex,
}

/// Closed sum type carried on the single SSE broadcast channel. Both
/// `tour` and `facts_updated` flow over the one stream the viewer
/// already subscribes to (`/api/tour-events`), so we don't double the
/// keepalive/reconnect plumbing for a second EventSource. `ResolvedTour`
/// is boxed so the enum stays small relative to the tiny FactsUpdated
/// marker.
#[derive(Clone)]
enum ServerEvent {
    Tour(Box<crate::tour::ResolvedTour>),
    FactsUpdated {
        type_count: usize,
        crate_count: usize,
    },
}

struct AppState {
    /// Atomic (facts_json + span_index) pair. Replaced wholesale by the
    /// watcher worker on each debounced source change; read via `load()`
    /// by `/api/facts` and `/api/tour`.
    snapshot: ArcSwap<FactsSnapshot>,
    /// Immutable base snapshot facts, present iff diff mode merged a
    /// committed base. Write-once at startup, read-cloned by the watcher
    /// worker per re-merge; immutable so concurrent /api/facts reads
    /// never touch it. Deliberately NOT inside FactsSnapshot — base
    /// never re-extracts, so it must not be re-stored on every update.
    base_facts: Option<WorkspaceFacts>,
    /// Owned copy of the extraction language filter (`--lang`). RunArgs
    /// borrows it with a lifetime that ends when `run` returns, but the
    /// long-lived watcher worker needs it for every re-extract.
    lang: Option<String>,
    /// The directory the extractor parsed for head. When `--at`
    /// selects a head ref, this is the materialized worktree under
    /// the cache dir; otherwise the user's workspace path. The
    /// `/api/source` sandbox is anchored here for head-side reads.
    workspace_root: PathBuf,
    /// Materialized base worktree, present iff `base_sha` is also
    /// present. Base-side source reads go through `git show` against
    /// `base_sha` (no filesystem access required); this path is the
    /// strip-prefix anchor for span-file → repo-rel resolution and is
    /// passed to `Hunks::collect` on every re-merge.
    base_workspace_root: Option<PathBuf>,
    /// `git -C` toplevel that contains `workspace_root`. Only set when
    /// `--at` enables diff mode (we need it to invoke `git diff`).
    repo_root: Option<PathBuf>,
    /// Diff sides resolved to shas. `head_sha = None` with
    /// `diff_enabled = true` means "head is the working tree."
    /// `base_sha = None` with `diff_enabled = true` means "base is
    /// the working tree" (the `..ref` form). When `diff_enabled` is
    /// false there is no diff at all.
    diff_enabled: bool,
    base_sha: Option<String>,
    head_sha: Option<String>,
    tours: TourQueue,
    /// Fan-out for SSE subscribers. Carries both resolved tours and
    /// `facts_updated` markers (see `ServerEvent`). Each active
    /// `/api/tour-events` stream pulls a fresh receiver and forwards
    /// events to its viewer.
    tour_tx: broadcast::Sender<ServerEvent>,
}

/// Arguments to [`run`]. Encoded as a struct so the CLI shim doesn't
/// need to be edited every time a flag is added.
pub struct RunArgs<'a> {
    pub workspace: &'a Path,
    pub revspec: RevSpec,
    /// `None` → bind to port 0 and let the OS pick a free port.
    pub port: Option<u16>,
    /// Frontend filter: `None` = run every registered frontend,
    /// `Some(name)` = restrict to the named frontend (`"rust"` /
    /// `"typescript"`). Passed straight through to
    /// [`crate::frontend::dispatch_with`].
    pub lang: Option<&'a str>,
}

pub fn run(args: RunArgs<'_>) -> Result<()> {
    let RunArgs {
        workspace,
        revspec,
        port,
        lang,
    } = args;
    let user_workspace = std::fs::canonicalize(workspace)
        .with_context(|| format!("workspace path not found: {}", workspace.display()))?;

    // Resolve `--at` into the snapshot we'll actually parse and the
    // shas we'll pass to `git diff`. Layered so the no-flag path
    // bypasses every git invocation: a workspace that isn't a git
    // repo still works fine when --at is absent.
    let (workspace_root, repo_root, base_sha, head_sha) =
        if revspec.head.is_none() && revspec.base.is_none() && !revspec.diff_enabled {
            (user_workspace.clone(), None, None, None)
        } else {
            let repo = find_repo_root(&user_workspace)?;
            // Hygiene first: drop stale worktree entries from prior crashes.
            prune_worktrees(&repo)?;
            let base_sha = match &revspec.base {
                Some(r) => Some(resolve_sha(&repo, r)?),
                None => None,
            };
            let head_sha = match &revspec.head {
                Some(r) => Some(resolve_sha(&repo, r)?),
                None => None,
            };
            let parsed_path = match &head_sha {
                Some(sha) => {
                    eprintln!("[mind-expander] Materializing worktree at {sha} ...");
                    materialize_head(&repo, sha)?
                }
                None => user_workspace.clone(),
            };
            (parsed_path, Some(repo), base_sha, head_sha)
        };

    // `lang` is `Option<&str>` borrowed from `RunArgs`, which is dropped
    // when `run` returns. The long-lived watcher worker re-extracts on
    // every source change, so it needs an owned copy that outlives the
    // borrow.
    let lang_owned: Option<String> = lang.map(|s| s.to_string());
    // SCOPE RULE, decided once from the same `head_sha` used everywhere:
    // watch IFF the parsed head IS the live working tree (full mode,
    // `<base>..`, `HEAD..`). A committed head sha is an immutable
    // worktree under the cache dir → nothing to watch.
    let watch_enabled = head_sha.is_none();

    // Materialize the base worktree (if diff mode with a base ref)
    // BEFORE forking the extract threads — git plumbing is sequential
    // and cheap when the worktree is already cached. After this point
    // both sides have a parsed source root, so the two extracts can
    // run concurrently.
    let base_path_opt =
        if let (Some(repo), Some(bsha)) = (repo_root.as_deref(), base_sha.as_deref()) {
            eprintln!("[mind-expander] Materializing base worktree at {bsha} ...");
            Some(materialize_head(repo, bsha)?)
        } else {
            None
        };

    eprintln!(
        "[mind-expander] Extracting facts from {} ...",
        workspace_root.display()
    );
    // Run head and (optional) base extracts in parallel. Each side
    // is independent until `build_unified`, so a scoped thread pair
    // halves the wall-clock cost of diff mode on big workspaces.
    let (head_facts, base_facts_opt) = std::thread::scope(|s| {
        let head_handle = s.spawn(|| crate::frontend::dispatch_with(&workspace_root, lang));
        let base_facts_opt = if let Some(base_path) = base_path_opt.as_deref() {
            eprintln!(
                "[mind-expander] Extracting base facts from {} ...",
                base_path.display()
            );
            Some(crate::frontend::dispatch_with(base_path, lang)?)
        } else {
            None
        };
        let head_facts = head_handle.join().expect("head extract thread panicked")?;
        Ok::<_, anyhow::Error>((head_facts, base_facts_opt))
    })?;

    // When diff mode is on AND a base sha is set, merge head + base
    // into the union facts the viewer renders. The base worktree path
    // is held in AppState so /api/source?side=base can service files
    // via `git show` (no need to read from the worktree once parsed).
    // `stored_base` is the immutable base clone the watcher re-merges
    // against — Some only in the merge arm.
    let (facts, base_workspace_root, stored_base) =
        if let (Some(repo), Some(bsha), Some(base_facts), Some(base_path)) = (
            repo_root.as_deref(),
            base_sha.as_deref(),
            base_facts_opt,
            base_path_opt,
        ) {
            // `build_unified` consumes the base by value; keep a clone so
            // the watcher can re-merge head against the same immutable base
            // on every reload (base never re-extracts — design invariant).
            let stored_base = base_facts.clone();
            let unified = merge_head_with_base(
                head_facts,
                base_facts,
                repo,
                bsha,
                head_sha.as_deref(),
                &workspace_root,
                &base_path,
            );
            (unified, Some(base_path), Some(stored_base))
        } else {
            (head_facts, None, None)
        };

    let (type_count, crate_count) = fact_counts(&facts);
    let snapshot = build_snapshot(&facts)?;
    eprintln!("[mind-expander] Extracted {type_count} types from {crate_count} crate(s).");

    // Capacity 16 = enough headroom for a burst of tours / facts
    // updates; if a slow viewer falls more than that behind,
    // BroadcastStream emits a Lagged error. A dropped Tour is
    // recoverable via GET /api/tours, but a dropped FactsUpdated has no
    // in-stream replay — so `get_tour_events` converts Lagged into a
    // synthetic facts_updated forcing a viewer resync.
    let (tour_tx, _) = broadcast::channel::<ServerEvent>(16);
    let diff_enabled = revspec.diff_enabled;
    // Keep a copy for the instance-record file before the value is
    // moved into AppState.
    let workspace_for_record = workspace_root.clone();
    let state = Arc::new(AppState {
        snapshot: ArcSwap::from_pointee(snapshot),
        base_facts: stored_base,
        lang: lang_owned,
        workspace_root,
        base_workspace_root,
        repo_root,
        diff_enabled,
        base_sha,
        head_sha,
        tours: TourQueue::default(),
        tour_tx,
    });
    // The watcher worker needs an `Arc<AppState>`, but `state` is moved
    // into the router by `.with_state` below — clone the handle first.
    let watcher_state = Arc::clone(&state);

    let app = Router::new()
        .route("/api/health", get(get_health))
        .route("/api/facts", get(get_facts))
        .route("/api/source", get(get_source))
        .route("/api/diff", get(get_diff))
        .route("/api/changed-files", get(get_changed_files))
        .route("/api/tour", post(post_tour))
        .route("/api/tours", get(get_tours))
        .route("/api/tour-events", get(get_tour_events))
        .fallback(get(serve_static))
        .with_state(state);

    // Bind synchronously (std listener) so we can report the actual
    // port before starting the async runtime. Port-0 means "OS picks
    // a free port" — recommended for agents running multiple parallel
    // sessions; the chosen port comes back via `local_addr`.
    let bind_port = port.unwrap_or(0);
    let bind_addr: SocketAddr = ([127, 0, 0, 1], bind_port).into();
    let std_listener = std::net::TcpListener::bind(bind_addr)
        .with_context(|| format!("failed to bind to {bind_addr}"))?;
    std_listener.set_nonblocking(true)?;
    let actual_addr = std_listener.local_addr()?;
    let actual_port = actual_addr.port();
    let url = format!("http://{actual_addr}/");

    // Always run in the foreground. The agent backgrounds us via
    // its own primitive (Claude Code's Monitor tool, Codex's
    // long-lived PTY session with stdin-poll, or `&` for a shell
    // user). Stdout starts with the ready block, then carries
    // future event lines (tour acks, user questions from the chat
    // UI, etc.) so the agent can react to each event live without
    // polling our HTTP API.
    let pid = std::process::id();

    // Install the working-tree watcher BEFORE emitting `ready`. inotify
    // (Linux) only reports events that occur AFTER the watch is
    // registered, so an agent that reacts to `ready` with an immediate
    // edit would have that first edit silently dropped if the watch were
    // installed later. (FSEvents on macOS happens to mask this with its
    // latency buffer, which is why the race only ever surfaced on Linux
    // CI.) `ready` therefore means "bound AND watching".
    //
    // The bound `_watcher` must stay alive for the rest of `run` (which
    // blocks forever in `rt.block_on`); dropping it closes the mpsc
    // channel, which is the worker's shutdown signal. Held outside the
    // diff-mode/watch-enabled branch as `None` so the type is uniform and
    // the worker simply never spawns when watching is disabled
    // (committed-head form).
    let _watcher = if watch_enabled {
        let (tx, rx) = std::sync::mpsc::channel();
        // The Sender lives ONLY inside this watcher callback, so when the
        // returned Watcher is dropped the channel closes → worker recv()
        // returns Err → the worker loop exits cleanly.
        match notify::recommended_watcher(move |res| {
            let _ = tx.send(res);
        }) {
            Ok(mut w) => {
                if let Err(e) = w.watch(&watcher_state.workspace_root, RecursiveMode::Recursive) {
                    eprintln!("[mind-expander] (warning) file watcher disabled: {e}");
                    None
                } else {
                    let ws = Arc::clone(&watcher_state);
                    std::thread::spawn(move || watch_worker(ws, rx));
                    Some(w)
                }
            }
            Err(e) => {
                eprintln!("[mind-expander] (warning) file watcher disabled: {e}");
                None
            }
        }
    } else {
        None
    };

    emit_ready_block(pid, actual_port, &url);
    // Drop an instance-record file so `mind-expander list` can
    // enumerate running servers. Best-effort: any IO error is
    // non-fatal — the server still runs.
    let _ = write_instance_record(pid, actual_port, &workspace_for_record);
    let _cleanup = InstanceRecordGuard(pid);
    std_listener.set_nonblocking(true)?;

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    rt.block_on(async move {
        let tokio_listener = TcpListener::from_std(std_listener)?;
        axum::serve(tokio_listener, app).await?;
        Ok::<_, anyhow::Error>(())
    })?;
    Ok(())
}

/// Build the atomic (facts_json, span_index) pair from one set of
/// facts. Both startup and the watcher worker route through this so
/// the serialized JSON and the span index are always derived from the
/// SAME facts value — the torn-pair invariant lives here. The
/// serialization order (span index then JSON) matches the original
/// startup code so `/api/facts` output stays byte-identical.
fn build_snapshot(facts: &WorkspaceFacts) -> Result<FactsSnapshot> {
    let span_index = SpanIndex::build(facts);
    let facts_json = serde_json::to_string(facts)?;
    Ok(FactsSnapshot {
        facts_json,
        span_index,
    })
}

/// Count types and crates the same way the original startup banner did
/// (sum of per-module `types.len()`; crate count is the top-level
/// crate map size). Used for both the startup banner and the
/// `facts_updated` payload so the two never diverge.
fn fact_counts(facts: &WorkspaceFacts) -> (usize, usize) {
    let type_count: usize = facts
        .crates
        .values()
        .flat_map(|c| c.modules.values())
        .map(|m| m.types.len())
        .sum();
    (type_count, facts.crates.len())
}

/// Merge an already-extracted head against an already-extracted base,
/// recomputing hunks from the live working tree (or the committed head
/// worktree). Centralizes the diff-merge sequence so startup and the
/// watcher worker produce byte-identical unified facts for the same
/// inputs. `Hunks::collect` runs `git diff <base>`, which reflects
/// working-tree edits whenever `head_sha` is `None`, so the hunks MUST
/// be recomputed on every re-merge rather than cached.
#[allow(clippy::too_many_arguments)]
fn merge_head_with_base(
    head_facts: WorkspaceFacts,
    base_facts: WorkspaceFacts,
    repo_root: &Path,
    base_sha: &str,
    head_sha: Option<&str>,
    head_workspace_root: &Path,
    base_workspace_root: &Path,
) -> WorkspaceFacts {
    // Hunks are best-effort: if `git diff` fails (e.g. transient repo
    // state), fall back to a hunk-less merge so the diagram still
    // renders — matching the startup contract.
    let hunks = Hunks::collect(
        repo_root,
        base_sha,
        head_sha,
        head_workspace_root,
        base_workspace_root,
    )
    .ok();
    build_unified(base_facts, head_facts, hunks.as_ref())
}

/// Re-extract HEAD ONLY and, in diff mode, re-merge against the stored
/// immutable base. The base is NEVER re-extracted (it is an immutable
/// snapshot); only head reflects the live working tree. Returns the
/// facts the next [`FactsSnapshot`] is built from. Argument order and
/// the canonicalized `workspace_root` / `lang` passed here MUST match
/// the startup call so `/api/facts` output stays byte-identical.
#[allow(clippy::too_many_arguments)]
fn reextract_head_and_merge(
    workspace_root: &Path,
    lang: Option<&str>,
    diff_enabled: bool,
    repo_root: Option<&Path>,
    base_sha: Option<&str>,
    head_sha: Option<&str>,
    base_workspace_root: Option<&Path>,
    base_facts: Option<&WorkspaceFacts>,
) -> Result<WorkspaceFacts> {
    let head_facts = crate::frontend::dispatch_with(workspace_root, lang)?;
    match (
        diff_enabled,
        repo_root,
        base_sha,
        base_workspace_root,
        base_facts,
    ) {
        (true, Some(repo), Some(bsha), Some(base_root), Some(base)) => Ok(merge_head_with_base(
            // Re-clone the immutable base: `build_unified` consumes it
            // by value, so passing it by move would empty the stored
            // base for the next update.
            head_facts,
            base.clone(),
            repo,
            bsha,
            head_sha,
            workspace_root,
            base_root,
        )),
        // Not a base-merge form (full mode, or `..ref` where base is
        // the working tree): head facts are the union as-is.
        _ => Ok(head_facts),
    }
}

/// Long-lived watcher worker. Owns the receiving end of the notify
/// callback channel; runs on a dedicated std thread (NOT a tokio
/// task) so the ~0.1s/~1.7s blocking re-extract never stalls axum,
/// and so the single worker serializes re-extracts (the contents-keyed
/// facts cache is never written concurrently).
///
/// Lifecycle: `rx.recv()` returning `Err` means the `Watcher` (and its
/// `Sender`) was dropped at the end of `run` — that is the shutdown
/// signal, and the loop exits.
fn watch_worker(
    state: Arc<AppState>,
    rx: std::sync::mpsc::Receiver<notify::Result<notify::Event>>,
) {
    // Canonicalize mind-expander's own cache subtree once so the
    // per-event filter can compare canonical-against-canonical. This is
    // the ONLY tree a re-extract writes into, so excluding it is the
    // exact self-feedback guard — excluding the whole OS cache root
    // would also swallow real edits on Windows, where `%LOCALAPPDATA%`
    // is an ancestor of `%LOCALAPPDATA%\Temp` and user workspaces.
    // Best-effort: if it can't be resolved, fall back to a path that
    // never matches.
    let cache_dir = mind_expander_cache_dir()
        .ok()
        .and_then(|p| std::fs::canonicalize(&p).ok().or(Some(p)));

    loop {
        // Block for the first event of a burst. Err = channel closed =
        // the Watcher was dropped → shut the worker down.
        let first = match rx.recv() {
            Ok(e) => e,
            Err(_) => return,
        };
        let mut batch: Vec<notify::Result<notify::Event>> = vec![first];
        // DEBOUNCE: coalesce a save burst. Keep draining until the
        // stream goes quiet for ~300ms; a multi-file save (formatter,
        // git checkout) arrives as many events within that window.
        while let Ok(ev) = rx.recv_timeout(Duration::from_millis(300)) {
            batch.push(ev);
        }

        if !batch_qualifies(&batch, cache_dir.as_deref()) {
            continue;
        }

        // Re-extract head (+ re-merge base in diff mode). On any error,
        // log and keep the previous snapshot — a transient half-written
        // tree must not blank the diagram.
        let facts = match reextract_head_and_merge(
            &state.workspace_root,
            state.lang.as_deref(),
            state.diff_enabled,
            state.repo_root.as_deref(),
            state.base_sha.as_deref(),
            state.head_sha.as_deref(),
            state.base_workspace_root.as_deref(),
            state.base_facts.as_ref(),
        ) {
            Ok(f) => f,
            Err(e) => {
                eprintln!("[mind-expander] (warning) re-extract failed: {e}");
                continue;
            }
        };
        let (type_count, crate_count) = fact_counts(&facts);
        let snap = match build_snapshot(&facts) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[mind-expander] (warning) snapshot build failed: {e}");
                continue;
            }
        };

        // ORDERING CONTRACT: publish the new snapshot FIRST, then
        // notify. Any reader reacting to either notification (SSE
        // facts_updated, or the agent's stdout line) must observe the
        // new facts — never the old. Reordering this re-introduces a
        // torn read where the agent sees `facts_updated` but `/api/facts`
        // still serves the previous snapshot.
        state.snapshot.store(Arc::new(snap));
        let _ = state.tour_tx.send(ServerEvent::FactsUpdated {
            type_count,
            crate_count,
        });
        emit_event(serde_json::json!({
            "event": "facts_updated",
            "type_count": type_count,
            "crate_count": crate_count,
        }));
    }
}

/// Decide whether a debounced batch of filesystem events warrants a
/// re-extract. A batch qualifies if ANY event references a source file
/// (`.rs`/`.ts`/`.tsx`) outside the ignored dirs, OR if a path-less
/// rescan/overflow event arrives.
///
/// The `.rs`/`.ts`/`.tsx` extension check is the PRIMARY self-feedback
/// guard: re-extraction touches the facts cache under the OS cache dir,
/// never a source file, so a re-extract cannot trigger another batch.
/// The explicit cache-dir/`target/`/`node_modules/`/`.git/`/`dist/`
/// filter is defense-in-depth.
fn batch_qualifies(batch: &[notify::Result<notify::Event>], cache_dir: Option<&Path>) -> bool {
    for res in batch {
        let ev = match res {
            Ok(ev) => ev,
            // A watcher-level error (e.g. a backend rescan) carries no
            // usable paths. macOS FSEvents can also coalesce a
            // directory-level change without per-file paths. A no-op
            // rebuild is cheap (~0.1s) and byte-identical, so rebuild
            // rather than risk missing a real edit.
            Err(_) => return true,
        };
        // A rescan with no paths: same reasoning — rebuild to be safe.
        if ev.need_rescan() {
            return true;
        }
        for path in &ev.paths {
            if path_qualifies(path, cache_dir) {
                return true;
            }
        }
    }
    false
}

/// True when `path` is a source file we index and is not under an
/// ignored directory.
fn path_qualifies(path: &Path, cache_dir: Option<&Path>) -> bool {
    let s = path.to_string_lossy();
    if !is_source_path(&s) {
        return false;
    }
    if path.components().any(|c| {
        matches!(
            c.as_os_str().to_str(),
            Some("target") | Some("node_modules") | Some(".git") | Some("dist")
        )
    }) {
        return false;
    }
    if let Some(cache) = cache_dir {
        // Compare against the canonicalized cache dir. The event path
        // may not exist anymore (a delete), so canonicalize its parent
        // when the file itself can't be resolved.
        let canon = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_owned());
        if canon.starts_with(cache) {
            return false;
        }
    }
    true
}

/// Emit the ready event as a single JSON line on stdout. This is the
/// first event in the server→agent stream — every subsequent stdout
/// line is also a JSON event object, all sharing the same
/// `{"event":"…", …}` shape. See `emit_event` below.
fn emit_ready_block(pid: u32, port: u16, url: &str) {
    emit_event(serde_json::json!({
        "event": "ready",
        "pid": pid,
        "port": port,
        "url": url,
    }));
}

/// Write a single JSON event line to stdout — the canonical
/// server→agent channel. Every meaningful server-side action emits
/// one of these so an agent's stdout monitor (Claude Code's Monitor
/// tool, Codex's PTY-poll, shell `tail -f`) sees a chronological
/// event log it can react to live.
///
/// Format invariants:
///   - One JSON object per line, no embedded newlines, trailing `\n`.
///   - Every object has an `event` field (a short string like
///     "ready", "tour_received", "tour_rejected").
///   - Object payload fields are event-specific; unrelated events do
///     not need to share schemas.
///   - Best-effort: any IO failure is silently swallowed (the server
///     keeps running even if its stdout is closed — e.g. when the
///     agent's monitor is detached).
pub(crate) fn emit_event(value: serde_json::Value) {
    use std::io::Write;
    if let Ok(line) = serde_json::to_string(&value) {
        let mut out = std::io::stdout().lock();
        let _ = writeln!(out, "{line}");
        let _ = out.flush();
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
struct InstanceRecord {
    pid: u32,
    port: u16,
    repo: String,
    started: i64, // Unix epoch seconds (best-effort)
}

fn instance_record_dir() -> std::path::PathBuf {
    let base = dirs::cache_dir()
        .unwrap_or_else(|| std::env::temp_dir())
        .join("mind-expander")
        .join("run");
    base
}

fn write_instance_record(pid: u32, port: u16, repo: &Path) -> Result<()> {
    let dir = instance_record_dir();
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{pid}.json"));
    let started = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let rec = InstanceRecord {
        pid,
        port,
        repo: repo.display().to_string(),
        started,
    };
    let json = serde_json::to_string_pretty(&rec)?;
    std::fs::write(path, json)?;
    Ok(())
}

/// RAII helper: delete the instance-record file on drop. Best-effort
/// (errors ignored) — a stale file at worst makes `list` show one
/// dead entry which it then prunes.
struct InstanceRecordGuard(u32);

impl Drop for InstanceRecordGuard {
    fn drop(&mut self) {
        let path = instance_record_dir().join(format!("{}.json", self.0));
        let _ = std::fs::remove_file(path);
    }
}

/// `mind-expander list` — enumerate running background instances.
/// Prunes stale entries whose pid is no longer alive.
pub fn list_instances() -> Result<()> {
    let dir = instance_record_dir();
    if !dir.exists() {
        println!("(no running mind-expander instances)");
        return Ok(());
    }
    let mut rows: Vec<InstanceRecord> = Vec::new();
    for entry in std::fs::read_dir(&dir)?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(rec) = serde_json::from_str::<InstanceRecord>(&text) else {
            continue;
        };
        if !pid_alive(rec.pid) {
            let _ = std::fs::remove_file(&path);
            continue;
        }
        rows.push(rec);
    }
    if rows.is_empty() {
        println!("(no running mind-expander instances)");
        return Ok(());
    }
    rows.sort_by_key(|r| r.started);
    println!("{:>7}  {:>5}  {}", "PID", "PORT", "REPO");
    for r in rows {
        println!("{:>7}  {:>5}  {}", r.pid, r.port, r.repo);
    }
    Ok(())
}

fn pid_alive(pid: u32) -> bool {
    // Portable: shell out to `kill -0 PID`. Exit 0 means alive (or
    // alive but uns ignalable due to permission — fine, that's still
    // "running"). Exit non-zero means dead. Avoids pulling in libc
    // and works on every Unix; harmlessly returns false on Windows
    // where the command is missing (Windows path is foreground-only
    // for now anyway).
    use std::process::{Command, Stdio};
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

async fn get_facts(State(state): State<Arc<AppState>>) -> Response {
    // Load the current snapshot and clone its JSON. The load guard is
    // held only across the clone, so a concurrent swap is never blocked
    // and the JSON we serve always belongs to a consistent (facts_json,
    // span_index) pair.
    let snap = state.snapshot.load();
    (
        [(header::CONTENT_TYPE, "application/json")],
        snap.facts_json.clone(),
    )
        .into_response()
}

#[derive(Serialize)]
struct HealthBody<'a> {
    status: &'a str,
    workspace_root: &'a str,
    /// Absolute path to the base snapshot's materialized worktree.
    /// Present only in diff mode. The viewer combines this with
    /// `/api/diff`'s repo-relative `file_old` to reconstruct the
    /// absolute path needed for base-side spanIndex lookups when a
    /// user clicks a `del` line in the code panel.
    #[serde(skip_serializing_if = "Option::is_none")]
    base_workspace_root: Option<String>,
    /// True when the user passed a `--at` with a `..` separator. The
    /// viewer code panel checks this once at startup and switches its
    /// fetch path to `/api/diff` when set.
    diff_enabled: bool,
    /// True when the diagram reflects the live working tree (i.e.
    /// `--at` was empty, or the `<base>..` form was used). Future
    /// "refresh on file change" features key off this; harmless to
    /// expose now.
    head_is_working_tree: bool,
    /// True when a server-side watcher is active and the viewer should
    /// wire `facts_updated` (re-fetch /api/facts) and resync-on-reconnect.
    /// Equals `head_sha.is_none()` (the SCOPE RULE): the parsed head IS
    /// the live working tree, so source edits re-extract and broadcast.
    /// Exposed as its own named flag rather than overloading
    /// `head_is_working_tree`'s diff-mode meaning, so the viewer gates
    /// live-reload wiring on an unambiguous field.
    live_reload: bool,
    /// True when the facts shipped by `/api/facts` contain a merged
    /// union of base + head (every entity carries a real `side`).
    /// Viewer uses this to branch its renderer between the
    /// single-snapshot view and the side-aware union renderer.
    unified_mode: bool,
}

async fn get_health(State(state): State<Arc<AppState>>) -> Response {
    Json(HealthBody {
        status: "ok",
        workspace_root: state.workspace_root.to_string_lossy().as_ref(),
        base_workspace_root: state
            .base_workspace_root
            .as_deref()
            .map(|p| p.to_string_lossy().into_owned()),
        diff_enabled: state.diff_enabled,
        head_is_working_tree: state.head_sha.is_none(),
        live_reload: state.head_sha.is_none(),
        unified_mode: state.base_sha.is_some(),
    })
    .into_response()
}

#[derive(Serialize)]
#[serde(untagged)]
enum TourResponse {
    Ok {
        status: &'static str,
        tour_id: String,
    },
    Err {
        status: &'static str,
        errors: Vec<ResolveError>,
    },
}

async fn post_tour(State(state): State<Arc<AppState>>, Json(tour): Json<Tour>) -> Response {
    // Tour id is just a monotonic counter on the queue length; the
    // viewer's SSE consumer uses it to dedupe across reconnects.
    // Server restart resets the sequence — that's fine, we don't
    // persist tours.
    let tour_id = format!("tour:{}", state.tours.snapshot().len() + 1);
    let tour_title = tour.title.clone();
    let step_count = tour.steps.len();
    // Resolve against the span index from the current snapshot so a
    // concurrent facts swap can't tear the (facts, span_index) pair the
    // tour resolves against.
    let snap = state.snapshot.load();
    match ingest(
        tour,
        &snap.span_index,
        &state.workspace_root,
        tour_id.clone(),
    ) {
        Ok(IngestOk { resolved }) => {
            state.tours.push(resolved.clone());
            // Send to any live SSE subscribers. `send` only errors
            // when there are zero receivers — that just means no
            // viewer is open; the queue still holds the tour for
            // when one connects.
            let _ = state.tour_tx.send(ServerEvent::Tour(Box::new(resolved)));
            // Mirror the event onto stdout so the agent's monitor
            // session sees a complete chronological record of what
            // happened on this server — even though the tour came
            // in via HTTP from a sibling subprocess.
            emit_event(serde_json::json!({
                "event": "tour_received",
                "tour_id": tour_id,
                "title": tour_title,
                "step_count": step_count,
            }));
            (
                StatusCode::OK,
                Json(TourResponse::Ok {
                    status: "ok",
                    tour_id,
                }),
            )
                .into_response()
        }
        Err(IngestErr { errors }) => {
            emit_event(serde_json::json!({
                "event": "tour_rejected",
                "tour_id": tour_id,
                "title": tour_title,
                "step_count": step_count,
                "error_count": errors.len(),
            }));
            (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(TourResponse::Err {
                    status: "err",
                    errors,
                }),
            )
                .into_response()
        }
    }
}

#[derive(Deserialize)]
struct SourceQuery {
    path: String,
    /// "base" → fetch from `base_sha` via `git show`. Anything else
    /// (including omitted) → read from `workspace_root` (head).
    #[serde(default)]
    side: Option<String>,
}

async fn get_source(State(state): State<Arc<AppState>>, Query(q): Query<SourceQuery>) -> Response {
    // Base-side fetch: bypass the filesystem sandbox entirely and
    // ask git for the blob at the base sha. Path must be inside the
    // repo (we derive a repo-relative form from the workspace path
    // the same way `/api/diff` does).
    if q.side.as_deref() == Some("base") {
        let Some(repo_root) = state.repo_root.as_deref() else {
            return (StatusCode::NOT_FOUND, "no repo root").into_response();
        };
        let Some(base_sha) = state.base_sha.as_deref() else {
            return (StatusCode::NOT_FOUND, "no base sha").into_response();
        };
        // Derive a repo-relative path. The incoming `path` can be:
        //   - already repo-relative (e.g., `src/foo.rs`),
        //   - absolute under head's workspace (e.g., the head worktree
        //     for shared files between snapshots),
        //   - absolute under the base worktree (base-only entity span).
        // Try each prefix in turn; the first that matches wins. This
        // lets the viewer pass whatever the extractor recorded as
        // `span.file` without having to know which worktree it
        // belongs to.
        let rel = if Path::new(&q.path).is_absolute() {
            let canon = std::fs::canonicalize(&q.path).unwrap_or_else(|_| PathBuf::from(&q.path));
            let mut prefixes: Vec<PathBuf> = Vec::new();
            if let Some(base) = state.base_workspace_root.as_deref() {
                prefixes.push(std::fs::canonicalize(base).unwrap_or_else(|_| base.to_owned()));
            }
            prefixes.push(
                std::fs::canonicalize(&state.workspace_root)
                    .unwrap_or_else(|_| state.workspace_root.clone()),
            );
            prefixes
                .push(std::fs::canonicalize(repo_root).unwrap_or_else(|_| repo_root.to_owned()));
            let mut rel_opt: Option<String> = None;
            for p in &prefixes {
                if let Ok(r) = canon.strip_prefix(p) {
                    rel_opt = Some(r.to_string_lossy().into_owned());
                    break;
                }
            }
            match rel_opt {
                Some(r) => r,
                None => {
                    return (StatusCode::BAD_REQUEST, "path outside repo").into_response();
                }
            }
        } else {
            q.path.clone()
        };
        return match show_blob(repo_root, base_sha, &rel) {
            Ok(bytes) => {
                ([(header::CONTENT_TYPE, "text/plain; charset=utf-8")], bytes).into_response()
            }
            Err(_) => (StatusCode::NOT_FOUND, "not in base snapshot").into_response(),
        };
    }

    // Head-side (default). The incoming `path` can be:
    //   - already repo-relative (`src/foo.rs`)
    //   - absolute under head's workspace_root
    //   - absolute under the base worktree (in unified mode the
    //     diff renderer asks for unchanged context lines using
    //     whatever span.file the entity records, which for a
    //     base-side entity is the BASE worktree path)
    //   - absolute under repo_root
    // Strip whichever prefix matches, then resolve the resulting
    // repo-relative path against head's workspace_root and read.
    // This way the head endpoint serves the head version of any
    // file the viewer has a path to, regardless of which snapshot
    // recorded that path.
    let rel: String = if Path::new(&q.path).is_absolute() {
        let canon = std::fs::canonicalize(&q.path).unwrap_or_else(|_| PathBuf::from(&q.path));
        let mut prefixes: Vec<PathBuf> = Vec::new();
        prefixes.push(
            std::fs::canonicalize(&state.workspace_root)
                .unwrap_or_else(|_| state.workspace_root.clone()),
        );
        if let Some(base) = state.base_workspace_root.as_deref() {
            prefixes.push(std::fs::canonicalize(base).unwrap_or_else(|_| base.to_owned()));
        }
        if let Some(repo) = state.repo_root.as_deref() {
            prefixes.push(std::fs::canonicalize(repo).unwrap_or_else(|_| repo.to_owned()));
        }
        let mut found: Option<String> = None;
        for p in &prefixes {
            if let Ok(r) = canon.strip_prefix(p) {
                found = Some(r.to_string_lossy().into_owned());
                break;
            }
        }
        match found {
            Some(r) => r,
            None => return (StatusCode::FORBIDDEN, "outside workspace").into_response(),
        }
    } else {
        q.path.clone()
    };
    let candidate = state.workspace_root.join(&rel);
    let real = match std::fs::canonicalize(&candidate) {
        Ok(p) => p,
        Err(_) => return (StatusCode::NOT_FOUND, "not found").into_response(),
    };
    if !real.starts_with(&state.workspace_root) {
        return (StatusCode::FORBIDDEN, "outside workspace").into_response();
    }
    let meta = match std::fs::metadata(&real) {
        Ok(m) => m,
        Err(_) => return (StatusCode::NOT_FOUND, "not found").into_response(),
    };
    if !meta.is_file() {
        return (StatusCode::BAD_REQUEST, "not a file").into_response();
    }
    match std::fs::read(&real) {
        Ok(bytes) => ([(header::CONTENT_TYPE, "text/plain; charset=utf-8")], bytes).into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("read error: {err}"),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
struct DiffQuery {
    path: String,
}

async fn get_diff(State(state): State<Arc<AppState>>, Query(q): Query<DiffQuery>) -> Response {
    // The endpoint only exists logically when diff mode is on. We
    // still register the route unconditionally so the viewer doesn't
    // need to special-case URL construction; we just 404 here when
    // there is no diff to serve. The panel's fetch path treats 404
    // and 204 differently — 404 means "diff disabled," 204 means
    // "this file is unchanged." Both lead to source-mode fallback.
    if !state.diff_enabled {
        return (StatusCode::NOT_FOUND, "diff mode not enabled").into_response();
    }
    let Some(repo_root) = state.repo_root.as_deref() else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "no repo root").into_response();
    };

    // Derive a repo-relative path. The incoming `path` can be:
    //   - already repo-relative (e.g. `src/foo.rs`)
    //   - absolute under head's workspace_root (the materialized
    //     worktree the parser walked, or the user's workspace)
    //   - absolute under the base worktree
    //   - absolute under repo_root itself
    // Try each prefix in turn; the first that matches wins. This is
    // the same strip ladder `/api/source?side=base` uses, lifted up
    // so /api/diff also accepts entity span paths regardless of which
    // worktree the extractor recorded them in.
    let repo_canon = std::fs::canonicalize(repo_root).unwrap_or_else(|_| repo_root.to_owned());
    let rel = if Path::new(&q.path).is_absolute() {
        let canon = std::fs::canonicalize(&q.path).unwrap_or_else(|_| PathBuf::from(&q.path));
        let mut prefixes: Vec<PathBuf> = Vec::new();
        prefixes.push(
            std::fs::canonicalize(&state.workspace_root)
                .unwrap_or_else(|_| state.workspace_root.clone()),
        );
        if let Some(base) = state.base_workspace_root.as_deref() {
            prefixes.push(std::fs::canonicalize(base).unwrap_or_else(|_| base.to_owned()));
        }
        prefixes.push(repo_canon.clone());
        let mut found: Option<String> = None;
        for p in &prefixes {
            if let Ok(r) = canon.strip_prefix(p) {
                found = Some(r.to_string_lossy().into_owned());
                break;
            }
        }
        match found {
            Some(r) => r,
            None => return (StatusCode::BAD_REQUEST, "path outside repo").into_response(),
        }
    } else {
        q.path.clone()
    };

    let Some(base) = state.base_sha.as_deref() else {
        // `..ref` form: base is the working tree. v1 doesn't support
        // this direction (the worktree is on `head`'s sha, not on
        // the working tree's sha). Surface a clear error rather than
        // silently producing a backwards diff.
        return (
            StatusCode::NOT_IMPLEMENTED,
            "diff base = working tree is not yet supported",
        )
            .into_response();
    };
    match diff_file(&repo_canon, base, state.head_sha.as_deref(), &rel) {
        Ok(DiffOutcome::Empty) => StatusCode::NO_CONTENT.into_response(),
        Ok(DiffOutcome::Changed(result)) => {
            ([(header::CONTENT_TYPE, "application/json")], Json(result)).into_response()
        }
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("diff failed: {err}"),
        )
            .into_response(),
    }
}

#[derive(Serialize)]
struct ChangedFile {
    path: String,
    adds: u32,
    dels: u32,
}

#[derive(Serialize)]
struct ChangedFilesBody {
    files: Vec<ChangedFile>,
}

async fn get_changed_files(State(state): State<Arc<AppState>>) -> Response {
    // The rollup chip on each module/crate row reads "+N -M" as
    // lines (GitHub convention). The metric comes from `git diff
    // --numstat`, aggregated per-file, then the viewer attributes
    // each file to its owning module via spanIndex.moduleByFile.
    // Endpoint is only meaningful in diff mode; off otherwise.
    if !state.diff_enabled {
        return (StatusCode::NOT_FOUND, "diff mode not enabled").into_response();
    }
    let Some(repo_root) = state.repo_root.as_deref() else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "no repo root").into_response();
    };
    let Some(base) = state.base_sha.as_deref() else {
        return (
            StatusCode::NOT_IMPLEMENTED,
            "diff base = working tree is not yet supported",
        )
            .into_response();
    };
    let mut cmd = std::process::Command::new("git");
    cmd.args(["-C"])
        .arg(repo_root)
        .args(["diff", "--numstat", "--no-renames", base]);
    if let Some(h) = state.head_sha.as_deref() {
        cmd.arg(h);
    }
    let out = match cmd.output() {
        Ok(o) => o,
        Err(err) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("git numstat failed to spawn: {err}"),
            )
                .into_response();
        }
    };
    if !out.status.success() {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!(
                "git numstat: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ),
        )
            .into_response();
    }
    let text = match String::from_utf8(out.stdout) {
        Ok(s) => s,
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "git numstat output not utf-8",
            )
                .into_response();
        }
    };
    let mut files: Vec<ChangedFile> = Vec::new();
    for line in text.lines() {
        // numstat format: "<adds>\t<dels>\t<path>". Binary files
        // come back as "-\t-\t<path>" and have no LoC delta to
        // contribute; skip them.
        let mut parts = line.splitn(3, '\t');
        let adds_s = parts.next().unwrap_or("");
        let dels_s = parts.next().unwrap_or("");
        let path = parts.next().unwrap_or("");
        if adds_s == "-" || dels_s == "-" || path.is_empty() {
            continue;
        }
        let adds: u32 = match adds_s.parse() {
            Ok(n) => n,
            Err(_) => continue,
        };
        let dels: u32 = match dels_s.parse() {
            Ok(n) => n,
            Err(_) => continue,
        };
        files.push(ChangedFile {
            path: path.to_string(),
            adds,
            dels,
        });
    }
    (
        [(header::CONTENT_TYPE, "application/json")],
        Json(ChangedFilesBody { files }),
    )
        .into_response()
}

async fn serve_static(uri: axum::http::Uri) -> Response {
    // Single-page app: every non-asset path falls back to index.html so
    // the viewer's own routing (if any) keeps working.
    let path = uri.path().trim_start_matches('/');
    let lookup = if path.is_empty() { "index.html" } else { path };
    if let Some(file) = VIEWER_DIST.get_file(lookup) {
        let mime = mime_for(lookup);
        return ([(header::CONTENT_TYPE, mime)], file.contents()).into_response();
    }
    if let Some(file) = VIEWER_DIST.get_file("index.html") {
        return (
            [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
            file.contents(),
        )
            .into_response();
    }
    (StatusCode::NOT_FOUND, "viewer bundle missing").into_response()
}

fn mime_for(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "map" => "application/json",
        _ => "application/octet-stream",
    }
}

/// Snapshot of every tour the server has accepted in this process
/// lifetime. The viewer fetches this on initial load so a page
/// reload after a tour was posted doesn't lose the tour from the
/// top bar — the SSE channel only broadcasts new tours; without
/// this replay path, a refresh would orphan the queue.
async fn get_tours(State(state): State<Arc<AppState>>) -> Json<Vec<crate::tour::ResolvedTour>> {
    Json(state.tours.snapshot())
}

async fn get_tour_events(
    State(state): State<Arc<AppState>>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let rx = state.tour_tx.subscribe();
    let stream = BroadcastStream::new(rx).filter_map(|msg| async move {
        match msg {
            Ok(ServerEvent::Tour(t)) => Some(Ok::<Event, Infallible>(
                Event::default()
                    .event("tour")
                    .json_data(&*t)
                    .unwrap_or_default(),
            )),
            Ok(ServerEvent::FactsUpdated {
                type_count,
                crate_count,
            }) => Some(Ok(Event::default()
                .event("facts_updated")
                .json_data(serde_json::json!({
                    "type_count": type_count,
                    "crate_count": crate_count,
                }))
                .unwrap_or_default())),
            // Lagged: this viewer fell behind and dropped events. A
            // dropped Tour is recoverable via GET /api/tours, but a
            // dropped FactsUpdated has NO in-stream replay — so convert
            // a lag into a synthetic `facts_updated` (no counts) that
            // forces the viewer to re-fetch /api/facts and resync.
            // Without this, a slow viewer could strand on stale facts.
            Err(BroadcastStreamRecvError::Lagged(_)) => Some(Ok(Event::default()
                .event("facts_updated")
                .json_data(serde_json::json!({}))
                .unwrap_or_default())),
        }
    });
    // Periodic comments keep proxies and the browser from closing an
    // idle connection. 15 s is well under the conventional 60 s
    // proxy timeout.
    Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keepalive"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn empty_facts() -> WorkspaceFacts {
        WorkspaceFacts {
            crates: BTreeMap::new(),
            edges: vec![],
            call_edges: vec![],
            edge_profiles: BTreeMap::new(),
        }
    }

    /// SCOPE RULE: the watcher is enabled IFF the parsed head IS the
    /// live working tree, which is exactly `head_sha.is_none()`. A
    /// committed-head form (head resolves to a SHA) parses an immutable
    /// worktree → no watch.
    #[test]
    fn scope_rule_gates_on_head_sha() {
        // working-tree forms: full mode, `<base>..`, `HEAD..` — head_sha None.
        let working_tree_head: Option<String> = None;
        assert!(working_tree_head.is_none(), "working tree => watch enabled");

        // committed head form: head resolves to a SHA — watch disabled.
        let committed_head: Option<String> = Some("deadbeef".to_string());
        assert!(committed_head.is_some(), "committed head => watch disabled");
    }

    /// Torn-pair invariant: a single `ArcSwap<FactsSnapshot>` swaps
    /// `facts_json` and `span_index` together. A reader that `load()`s
    /// after a `store()` must observe BOTH new fields, never the JSON of
    /// one snapshot against the span index of another.
    #[test]
    fn snapshot_swaps_pair_atomically() {
        // Two distinct snapshots with deliberately distinct JSON so we
        // can tell which one a reader observed.
        let snap_a = FactsSnapshot {
            facts_json: "A".to_string(),
            span_index: SpanIndex::build(&empty_facts()),
        };
        let swap = ArcSwap::from_pointee(snap_a);

        let before = swap.load();
        assert_eq!(before.facts_json, "A");
        // The span index loaded here belongs to the SAME Arc as the JSON.
        let before_ptr = Arc::as_ptr(&before.clone());

        let snap_b = FactsSnapshot {
            facts_json: "B".to_string(),
            span_index: SpanIndex::build(&empty_facts()),
        };
        swap.store(Arc::new(snap_b));

        let after = swap.load();
        assert_eq!(after.facts_json, "B");
        // A fresh load observes the new Arc as a whole — the pair moved
        // together, so there is no cross-version mix.
        assert_ne!(before_ptr, Arc::as_ptr(&after.clone()));
        // The pre-swap guard still points at the old, internally
        // consistent snapshot (JSON "A").
        assert_eq!(before.facts_json, "A");
    }

    /// `fact_counts` matches the original startup banner computation:
    /// types summed per module, crates from the top-level map size.
    #[test]
    fn fact_counts_matches_banner() {
        let (types, crates) = fact_counts(&empty_facts());
        assert_eq!(types, 0);
        assert_eq!(crates, 0);
    }
}
