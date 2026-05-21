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
use axum::{
    Json, Router,
    extract::{Query, State},
    http::{StatusCode, header},
    response::{
        IntoResponse, Response,
        sse::{Event, KeepAlive, Sse},
    },
    routing::{get, post},
};
use futures::stream::{Stream, StreamExt};
use std::convert::Infallible;
use std::time::Duration;
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;
use include_dir::{Dir, include_dir};
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;

use crate::diff::{DiffOutcome, diff_file};
use crate::git_view::{
    RevSpec, find_repo_root, materialize_head, prune_worktrees, resolve_sha, show_blob,
};
use crate::tour::{IngestErr, IngestOk, ResolveError, SpanIndex, Tour, TourQueue, ingest};
use crate::unified_facts::{Hunks, build_unified};

// Embed the built viewer at compile time. `build.rs` checks that
// `viewer/dist/index.html` exists and fails the build with a helpful
// message if it's missing.
static VIEWER_DIST: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/viewer/dist");

struct AppState {
    facts_json: String,
    /// The directory the extractor parsed for head. When `--at`
    /// selects a head ref, this is the materialized worktree under
    /// the cache dir; otherwise the user's workspace path. The
    /// `/api/source` sandbox is anchored here for head-side reads.
    workspace_root: PathBuf,
    /// Materialized base worktree, present iff `base_sha` is also
    /// present. Held so we know diff mode is fully wired; actual
    /// base-side source reads go through `git show` against
    /// `base_sha` (no filesystem access required), so we only need
    /// this path for diagnostics / future use.
    #[allow(dead_code)]
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
    /// Pre-built index used by `/api/tour` to resolve `{file, line}`
    /// refs in a tour to canonical `(elementId, kind)` pairs. Built
    /// once at startup so per-tour validation stays cheap.
    span_index: SpanIndex,
    tours: TourQueue,
    /// Fan-out for SSE subscribers. Each successful POST /api/tour
    /// is broadcast here; every active /api/tour-events stream pulls
    /// a fresh receiver and forwards events to its viewer.
    tour_tx: broadcast::Sender<crate::tour::ResolvedTour>,
}

pub fn run(workspace: &Path, revspec: RevSpec, port: u16, open_browser: bool) -> Result<()> {
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
                    eprintln!("Materializing worktree at {sha} ...");
                    materialize_head(&repo, sha)?
                }
                None => user_workspace.clone(),
            };
            (parsed_path, Some(repo), base_sha, head_sha)
        };

    eprintln!("Extracting facts from {} ...", workspace_root.display());
    let head_facts = crate::extract::extract_workspace(&workspace_root)?;

    // When diff mode is on AND a base sha is set, materialize the
    // base worktree too and parse it as a separate snapshot. We then
    // merge both into the union facts the viewer renders. The base
    // worktree path is held in AppState so /api/source?side=base can
    // service files via `git show` (no need to read from the
    // worktree once parsed).
    let (facts, base_workspace_root) = if let (Some(repo), Some(bsha)) =
        (repo_root.as_deref(), base_sha.as_deref())
    {
        eprintln!("Materializing base worktree at {bsha} ...");
        let base_path = materialize_head(repo, bsha)?;
        eprintln!("Extracting base facts from {} ...", base_path.display());
        let base_facts = crate::extract::extract_workspace(&base_path)?;
        // Precompute base+head hunk ranges per file before the merge
        // so the union pass can decide split-vs-Both per entity in a
        // single sweep — no second post-pass needed. If hunk
        // collection fails (transient git error), fall back to
        // hunkless merge: same-name entities collapse into Both
        // without split-on-change, which is the safer no-info default.
        eprintln!("Collecting diff hunks for split-on-change ...");
        let hunks = match Hunks::collect(repo, bsha, head_sha.as_deref(), &workspace_root, &base_path) {
            Ok(h) => Some(h),
            Err(err) => {
                eprintln!("(warning) hunk collection failed; merging without split: {err}");
                None
            }
        };
        eprintln!("Merging base + head into union facts ...");
        let unified = build_unified(base_facts, head_facts, hunks.as_ref());
        (unified, Some(base_path))
    } else {
        (head_facts, None)
    };

    let type_count: usize = facts
        .crates
        .values()
        .flat_map(|c| c.modules.values())
        .map(|m| m.types.len())
        .sum();
    let span_index = SpanIndex::build(&facts);
    let facts_json = serde_json::to_string(&facts)?;
    eprintln!(
        "Extracted {} types from {} crate(s).",
        type_count,
        facts.crates.len()
    );

    // Capacity 16 = enough headroom for a burst of tours; if a
    // slow viewer falls more than that behind, BroadcastStream emits
    // a Lagged error which we drop silently (viewer can re-request
    // the latest tour later).
    let (tour_tx, _) = broadcast::channel::<crate::tour::ResolvedTour>(16);
    let diff_enabled = revspec.diff_enabled;
    let state = Arc::new(AppState {
        facts_json,
        workspace_root,
        base_workspace_root,
        repo_root,
        diff_enabled,
        base_sha,
        head_sha,
        span_index,
        tours: TourQueue::default(),
        tour_tx,
    });

    let app = Router::new()
        .route("/api/health", get(get_health))
        .route("/api/facts", get(get_facts))
        .route("/api/source", get(get_source))
        .route("/api/diff", get(get_diff))
        .route("/api/changed-files", get(get_changed_files))
        .route("/api/tour", post(post_tour))
        .route("/api/tour-events", get(get_tour_events))
        .fallback(get(serve_static))
        .with_state(state);

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    rt.block_on(async move {
        let addr: SocketAddr = ([127, 0, 0, 1], port).into();
        let listener = TcpListener::bind(addr)
            .await
            .with_context(|| format!("failed to bind to {addr}"))?;
        let url = format!("http://{addr}/");
        eprintln!("mind-expander serving at {url}");
        if open_browser {
            if let Err(err) = opener::open_browser(&url) {
                eprintln!("(could not auto-open browser: {err})");
            }
        }
        axum::serve(listener, app).await?;
        Ok::<_, anyhow::Error>(())
    })?;
    Ok(())
}

async fn get_facts(State(state): State<Arc<AppState>>) -> Response {
    (
        [(header::CONTENT_TYPE, "application/json")],
        state.facts_json.clone(),
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

async fn post_tour(
    State(state): State<Arc<AppState>>,
    Json(tour): Json<Tour>,
) -> Response {
    // Tour id is just a monotonic counter on the queue length; the
    // viewer's SSE consumer uses it to dedupe across reconnects.
    // Server restart resets the sequence — that's fine, we don't
    // persist tours.
    let tour_id = format!("tour:{}", state.tours.snapshot().len() + 1);
    match ingest(tour, &state.span_index, &state.workspace_root, tour_id.clone()) {
        Ok(IngestOk { resolved }) => {
            state.tours.push(resolved.clone());
            // Send to any live SSE subscribers. `send` only errors
            // when there are zero receivers — that just means no
            // viewer is open; the queue still holds the tour for
            // when one connects.
            let _ = state.tour_tx.send(resolved);
            (
                StatusCode::OK,
                Json(TourResponse::Ok {
                    status: "ok",
                    tour_id,
                }),
            )
                .into_response()
        }
        Err(IngestErr { errors }) => (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(TourResponse::Err {
                status: "err",
                errors,
            }),
        )
            .into_response(),
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

async fn get_source(
    State(state): State<Arc<AppState>>,
    Query(q): Query<SourceQuery>,
) -> Response {
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
            let canon =
                std::fs::canonicalize(&q.path).unwrap_or_else(|_| PathBuf::from(&q.path));
            let mut prefixes: Vec<PathBuf> = Vec::new();
            if let Some(base) = state.base_workspace_root.as_deref() {
                prefixes.push(
                    std::fs::canonicalize(base).unwrap_or_else(|_| base.to_owned()),
                );
            }
            prefixes.push(
                std::fs::canonicalize(&state.workspace_root)
                    .unwrap_or_else(|_| state.workspace_root.clone()),
            );
            prefixes.push(
                std::fs::canonicalize(repo_root)
                    .unwrap_or_else(|_| repo_root.to_owned()),
            );
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
            Ok(bytes) => (
                [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
                bytes,
            )
                .into_response(),
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
        let canon =
            std::fs::canonicalize(&q.path).unwrap_or_else(|_| PathBuf::from(&q.path));
        let mut prefixes: Vec<PathBuf> = Vec::new();
        prefixes.push(
            std::fs::canonicalize(&state.workspace_root)
                .unwrap_or_else(|_| state.workspace_root.clone()),
        );
        if let Some(base) = state.base_workspace_root.as_deref() {
            prefixes.push(
                std::fs::canonicalize(base).unwrap_or_else(|_| base.to_owned()),
            );
        }
        if let Some(repo) = state.repo_root.as_deref() {
            prefixes.push(
                std::fs::canonicalize(repo).unwrap_or_else(|_| repo.to_owned()),
            );
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
        Ok(bytes) => (
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            bytes,
        )
            .into_response(),
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

async fn get_diff(
    State(state): State<Arc<AppState>>,
    Query(q): Query<DiffQuery>,
) -> Response {
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
    let repo_canon =
        std::fs::canonicalize(repo_root).unwrap_or_else(|_| repo_root.to_owned());
    let rel = if Path::new(&q.path).is_absolute() {
        let canon =
            std::fs::canonicalize(&q.path).unwrap_or_else(|_| PathBuf::from(&q.path));
        let mut prefixes: Vec<PathBuf> = Vec::new();
        prefixes.push(
            std::fs::canonicalize(&state.workspace_root)
                .unwrap_or_else(|_| state.workspace_root.clone()),
        );
        if let Some(base) = state.base_workspace_root.as_deref() {
            prefixes.push(
                std::fs::canonicalize(base).unwrap_or_else(|_| base.to_owned()),
            );
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
            ([(header::CONTENT_TYPE, "application/json")], Json(result))
                .into_response()
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
    ([(header::CONTENT_TYPE, "application/json")], Json(ChangedFilesBody { files }))
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

async fn get_tour_events(
    State(state): State<Arc<AppState>>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let rx = state.tour_tx.subscribe();
    let stream = BroadcastStream::new(rx).filter_map(|msg| async move {
        // Drop Lagged errors silently — they mean the viewer is too
        // slow to keep up. The viewer can hit GET /api/tours later if
        // we need a recovery path; for the notification feature
        // missing a tick is harmless.
        let tour = msg.ok()?;
        Some(Ok::<Event, Infallible>(
            Event::default()
                .event("tour")
                .json_data(&tour)
                .unwrap_or_else(|_| Event::default()),
        ))
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
