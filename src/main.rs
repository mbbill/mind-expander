//! Codebase fact extractor.
//!
//! Walks Rust source under one or more crate roots, parses with `syn`, and
//! emits a JSON document of per-type facts plus a global edge graph. The
//! output is deliberately label-free: facts only, the user reads the role.

mod architecture;
mod callgraph;
mod diff;
mod extract;
mod frontend;
mod git_view;
mod install_skill;
mod model;
mod ownership;
mod print;
mod resolve;
mod server;
mod survey;
mod tour;
mod tour_client;
mod unified;
mod unified_facts;

use std::path::PathBuf;

use clap::{CommandFactory, Parser, Subcommand, ValueEnum};

const HELP_GUIDE: &str = r####"
mind-expander is designed to be driven by an AI coding agent.

MODE — DIFF VS FULL-REPO

  Decide BEFORE running `view`. The --at flag selects diff mode.
  Getting this wrong requires restarting the server.

  Diff mode (--at base..head) — highlights only entities touched
  in the revspec. Use whenever the request is scoped to changes:
  - "review this PR", "code review", "review the diff"
  - "what changed", "the changes", "what's new since X"
  - "walk me through the last N commits / recent work"
  - An explicit revspec, commit range, or PR number
  - The user just finished work and is asking you to look at it

  Full-repo mode (no --at) — the whole crate graph. Use when the
  request is about the codebase as a system, not a specific delta:
  - "tour of this codebase", "explain how X works", "architecture"
  - Planning a refactor or new feature (changes don't exist yet)
  - General orientation / onboarding

  Tiebreaker: "changes" / "commits" / "diff" / "PR" / "recent" is
  a strong diff-mode signal even when paired with walkthrough language.
  Lean diff. If genuinely ambiguous, ask one short question before
  starting — restarting in the other mode is wasted work.

SETUP

  npx mind-expander view <workspace> [--at <revspec>]

  Self-daemonizes on Unix: foreground exits 0 once ready, the server
  keeps running. Stdout block:

    mind-expander: ready
    pid: 12345
    port: 5180
    url: http://127.0.0.1:5180/

  Save the port (for the tour POST) and pid (to kill when done).
  Multiple concurrent sessions pick their own port if --port is omitted.
  Pass --foreground to stay in the foreground (useful for CI or
  debugging). The server does not open the browser — see POSTING A
  TOUR for when to open it.

POSTING A TOUR

  Launch a fresh server with the tour (most common):

    npx mind-expander view <repo> [--at <revspec>]   # prints pid + port
    npx mind-expander tour - --host 127.0.0.1:<port> <<'EOF'
    { "schema_version": 2, "steps": [ ... ] }
    EOF

  Then open the browser (after the tour is posted, not before):

    macOS:   open <url>
    Linux:   xdg-open <url>
    Windows: start <url>

  Follow-up — post to a server that's already running. If the user is
  mid-conversation and still has the webpage open, do NOT restart the
  server. Reuse the existing port:

    curl -sS -X POST http://127.0.0.1:<port>/api/tour \
      -H 'content-type: application/json' --data-binary @- <<'EOF'
    { "schema_version": 2, "steps": [ ... ] }
    EOF

  Fall back to a /tmp/tour.json file only if the tour is enormous.

  Success returns {status: "ok", tour_id}. Failure returns 422 with
  {errors: [{step, ref, msg}]} — fix and resend.

TOUR SCHEMA (v2)

  {
    "schema_version": 2,
    "title": "Optional bubble-header title",
    "subject": { "file": "src/lib.rs", "line": 42 },
    "steps": [
      { "say": "Text-only step. **Markdown** works in say." },
      { "say": "Element step — bubble points here.",
        "ref": { "file": "src/parse.rs", "line": 127 } }
    ]
  }

  Fields:
  - schema_version — required, must be 2.
  - title — optional. Shown in the bubble header.
  - subject — optional Reference. Banner at the top of the viewer.
  - steps — required array.

  Each step:
  - say — required. Rendered as Markdown in the bubble. Full CommonMark:
    **bold**, *italic*, `code`, fenced code blocks with language hints,
    ordered + unordered lists, tables, links, ## headings. Keep tight
    for reviews and walkthroughs (one bubble = one observation); planning
    steps can be longer — see use cases below.
  - ref — optional { file, line? }. file is repo-relative. Omitting
    line references the whole module.

USE CASES

  Planning (highest-detail use case):

    A planning tour covers the entire plan — every file to touch, every
    function to modify, the order of changes, and the why. A 4-step
    "tour" is not a plan. Structure:

    1. Opening step — text-only. Goal, phase list, size estimate. This
       is the ONLY step without a ref.
    2. Every other step is anchored. No bare separator steps — fold
       phase headers into prose as `## Phase N — name` markdown headings.
    3. Each step is a mini-section — H2 headings, fenced code blocks
       (type defs, sigs, before/after), tables, nested bullets, bold
       key terms, inline `code` for every symbol.
    4. Anchoring files that don't exist yet: ref the file you'll mirror
       — an existing analog or the existing trait/interface. Lead with
       "Mirror this for X".
    5. Surface the deliberately untouched — anchor to a representative
       file with prose explaining why.
    6. Closing step — anchored to CLI / main / invocation site. Numbered
       commit sequence with per-commit LoC budgets, total size, and one
       concrete open question the user can answer to unblock implementation.

    Example mid-plan step (a real plan has ~15-20 such steps):

      { "say": "## Phase 2.1 — Send loop\n\nKeep the signature; add a
        retry loop around the body:\n\n```rust\npub async fn send(&self,
        req: Request) -> Result<Response> {\n    let mut attempt = 0;\n
            loop {\n        match self.send_once(&req).await {\n
                Ok(r) if !is_retryable(&r) => return Ok(r),\n
                _ if attempt + 1 >= max => /* return last */,\n
                _ => { /* back off */ }\n        }\n        attempt += 1;
        \n    }\n}\n```\n\n### Why a loop, not recursion\n\n- Stack-safe
        for high max_attempts\n- Easier to thread attempt for backoff",
        "ref": { "file": "src/http.rs", "line": 120 } }

  Code review:

    Walk the user through the most important changes, ordered by
    impact. Skip cosmetic edits. Opening step gives a one-line
    summary of scope. Each step explains what changed and why it
    matters. Close with verdict + the one thing worth raising in
    the PR.

    Example:

      {
        "schema_version": 2,
        "title": "Review main..HEAD",
        "steps": [
          { "say": "3 entities changed. Byte-size parsing extracted
            into its own module." },
          { "say": "`init` rewritten: inline parser replaced with a
            call to `parse_byte_size`. This is the key structural
            change — verify test coverage.",
            "ref": { "file": "src/cli.rs", "line": 36 } },
          { "say": "`parse_byte_size` handles `\"64KiB\"`-style
            strings. Match arms cover lowercase only — caps silently
            hit `_ => None`. Intentional?",
            "ref": { "file": "src/parse.rs", "line": 10 } },
          { "say": "`old_parse` removed — only caller was `init`,
            which now uses the new function. Safe to drop.",
            "ref": { "file": "src/cli.rs", "line": 88 } },
          { "say": "**Verdict:** clean structurally. Surface the
            case-sensitivity in the PR description; otherwise good." }
        ]
      }

  General walkthrough:

    Orient a newcomer in 5-10 minutes. Anchor 5-8 entities along the
    lifecycle (request flow, compile pipeline, whatever fits). Resist
    exhaustiveness — a tour is a curated narrative, not an index. End
    with "where to start making changes."

    Example:

      {
        "schema_version": 2,
        "title": "Tour of `tinyhttp`",
        "steps": [
          { "say": "Small HTTP/1.1 server. ~2000 LoC, 6 modules.
            Following the request lifecycle." },
          { "say": "Entry: `Server::bind` — SocketAddr + Handler in,
            runnable Server out.",
            "ref": { "file": "src/lib.rs", "line": 20 } },
          { "say": "Accept loop — spawns a tokio task per connection.",
            "ref": { "file": "src/server.rs", "line": 45 } },
          { "say": "Per-connection: parse -> call handler -> write
            response -> close. No keep-alive in v1.",
            "ref": { "file": "src/server.rs", "line": 80 } },
          { "say": "Parser is hand-rolled. Read here when debugging
            weird-encoding requests.",
            "ref": { "file": "src/parse.rs", "line": 1 } },
          { "say": "Where to start: routing API for user-facing
            changes, parser for protocol fixes." }
        ]
      }

PITFALLS

  - Don't dump prose with a tour as afterthought. If you go the tour
    route, the tour IS the reply — text before/after is 1-2 lines max.
  - Pin every concrete claim. A bare say is fine for the opening step
    and nothing else. Don't insert separator steps — fold phase
    headers into the prose of the next anchored step.
  - Repo-relative paths only. src/foo.rs yes, absolute paths no.
  - End with a question or next action — the user just watched the
    tour and is expecting to respond.

LIFECYCLE

  npx mind-expander list   enumerate running instances + pids
  kill <pid>               stop a server
  Auto-daemonize is Unix-only. Pass --foreground on Windows or in CI.
"####;

#[derive(Parser, Debug)]
#[command(
    name = "mind-expander",
    version,
    about = "A human-AI collaboration tool for large codebases",
    after_long_help = HELP_GUIDE,
    disable_help_subcommand = true,
)]
struct Cli {
    /// Workspace root (defaults to current directory).
    #[arg(long, default_value = ".")]
    root: PathBuf,

    /// Restrict extraction to a single language frontend. Omit the
    /// flag (the default) to run every frontend compiled into this
    /// build and merge results — so a polyglot repo (Cargo.toml +
    /// tsconfig.json) automatically extracts both. Pass `--lang
    /// rust` or `--lang typescript` to filter in a polyglot repo
    /// when you only want one language's facts, or in CI for
    /// deterministic output.
    #[arg(long, value_enum, global = true)]
    lang: Option<LangSelector>,

    #[command(subcommand)]
    cmd: Option<Cmd>,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum LangSelector {
    Rust,
    Typescript,
}

#[derive(Subcommand, Debug)]
enum Cmd {
    /// Extract facts and write JSON to stdout (or --out).
    #[command(hide = true)]
    Extract {
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// Print a human-readable digest filtered by module-path prefix.
    #[command(hide = true)]
    Digest {
        /// Module path prefix, e.g. `my-crate::vm::wasm`. Empty = all.
        #[arg(long, default_value = "")]
        module: String,
        /// Optional: read from previously-extracted JSON instead of re-parsing.
        #[arg(long)]
        from: Option<PathBuf>,
    },
    /// Print the unified module-and-ownership view. Default mode is a
    /// drift report — every type whose actual module disagrees with the
    /// LCA of its owners' modules. Pass --full for the complete outline
    /// with every type's classification annotated.
    #[command(hide = true)]
    Drift {
        /// Optional crate name filter.
        #[arg(long)]
        krate: Option<String>,
        /// Maximum levels a type may live below the LCA before counting
        /// as drift. 0 = strict, 1 = default (one folder of slack).
        #[arg(long, default_value_t = 1)]
        max_below_lca: u32,
        /// Count enum-variant payloads as ownership too. Default false:
        /// sum-composition pulls payload types' LCAs to the crate root,
        /// which is not what the analysis is asking about.
        #[arg(long)]
        include_variants: bool,
        /// Print the full unified outline instead of the drift-only report.
        #[arg(long)]
        full: bool,
        /// Optional: read from previously-extracted JSON instead of re-parsing.
        #[arg(long)]
        from: Option<PathBuf>,
    },
    /// Print the module-level architecture: per-module size, outbound
    /// imports, inbound dependents (with edge counts and kind breakdown),
    /// and any cycles (SCCs of size > 1). Tests modules and inter-crate
    /// edges are excluded.
    #[command(hide = true)]
    Arch {
        /// Optional crate name filter.
        #[arg(long)]
        krate: Option<String>,
        /// Optional: read from previously-extracted JSON instead of re-parsing.
        #[arg(long)]
        from: Option<PathBuf>,
    },
    /// Print the structural-ownership forest. By default uses only struct
    /// and union field edges; pass --include-variants to also follow enum
    /// variant payloads. Marks multi-owned nodes with ⊕ and re-encountered
    /// nodes with ↑. No labels.
    #[command(hide = true)]
    Tree {
        /// Optional crate name filter.
        #[arg(long)]
        krate: Option<String>,
        /// Also follow enum variant payloads when computing the forest.
        #[arg(long)]
        include_variants: bool,
        /// Optional: read from previously-extracted JSON instead of re-parsing.
        #[arg(long)]
        from: Option<PathBuf>,
    },
    /// Extract facts and serve the interactive viewer in your browser.
    /// One-stop command for end users: no separate extract step, no
    /// Node toolchain needed. Workspace path is the same `--root` as
    /// other subcommands, but accepted positionally here for ergonomics.
    ///
    /// Server lifecycle (Unix): after extraction finishes and the
    /// server has bound its port, a machine-readable ready block is
    /// printed to stdout and the process forks itself into the
    /// background. The foreground command exits 0 so an agent can
    /// run this synchronously without trailing `&`. Stop the
    /// background server with `kill <pid>` (the pid is printed in
    /// the ready block; `mind-expander list` enumerates running
    /// instances). Pass `--foreground` to disable daemonization
    /// (useful for `cargo run`, CI, and interactive debugging).
    View {
        /// Workspace root to extract and visualize. Defaults to the
        /// global `--root` if omitted.
        workspace: Option<PathBuf>,
        /// Revision (or revision range) to view and diff against.
        /// Uses git range syntax: `<ref>` to view that revision,
        /// `<base>..<head>` to view <head> with the code panel
        /// showing diffs against <base>. Empty side = working tree
        /// (e.g. `main..` diffs working tree vs main). Default:
        /// working tree, no diff.
        #[arg(long)]
        at: Option<String>,
        /// Port to bind the local server to. Omit to auto-pick a free
        /// port (recommended for agents running multiple sessions).
        #[arg(long)]
        port: Option<u16>,
        /// Stay in the foreground instead of self-daemonizing on ready.
        /// Useful for `cargo run`, CI, and debugging.
        #[arg(long)]
        foreground: bool,
    },
    /// List background `mind-expander view` instances currently
    /// running on this machine. Reads `~/.cache/mind-expander/run/*.json`
    /// and prunes stale entries whose pid is no longer alive.
    List,
    /// Send a tour JSON to a running `mind-expander view` server.
    /// `file` is a path; `-` reads JSON from stdin. The server
    /// validates the schema, resolves every `{file, line}` reference
    /// to a canonical element, and queues the resolved tour for the
    /// viewer to play. Prints `ok` on success or one error per line
    /// from the server's resolution failures.
    Tour {
        /// Path to a tour JSON, or `-` to read from stdin.
        file: PathBuf,
        /// Server to send the tour to, `host:port`. The LLM that
        /// started the server already knows this.
        #[arg(long)]
        host: String,
    },
    /// Print a compact, label-free survey: counters, module table,
    /// rankings, isolated types, lifetime-declaring types, unsafe locations,
    /// trait-impls. Designed for fast orientation without reading source.
    #[command(hide = true)]
    Survey {
        /// Optional crate name filter (matches the [package].name field).
        #[arg(long)]
        krate: Option<String>,
        /// Cap rows in ranking sections.
        #[arg(long, default_value_t = 20)]
        top: usize,
        /// Also print one line per type (suppressed by default — large crates
        /// produce hundreds of lines).
        #[arg(long)]
        types: bool,
        /// Optional: read from previously-extracted JSON instead of re-parsing.
        #[arg(long)]
        from: Option<PathBuf>,
    },
    /// Install the mind-expander skill file into detected AI agent
    /// configurations (Claude Code, Codex, Cursor). Idempotent —
    /// re-run after upgrading to refresh the installed skill.
    InstallSkill {
        /// Skip confirmation prompts and install to all detected agents.
        #[arg(long)]
        yes: bool,
    },
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    let cmd = match cli.cmd {
        Some(cmd) => cmd,
        None => {
            Cli::command().print_long_help()?;
            return Ok(());
        }
    };

    let lang_filter: Option<&'static str> = cli.lang.map(|l| match l {
        LangSelector::Rust => "rust",
        LangSelector::Typescript => "typescript",
    });
    let extract = |root: &std::path::Path| frontend::dispatch_with(root, lang_filter);
    match cmd {
        Cmd::Extract { out } => {
            let facts = extract(&cli.root)?;
            let json = serde_json::to_string_pretty(&facts)?;
            if let Some(path) = out {
                std::fs::write(path, json)?;
            } else {
                println!("{json}");
            }
        }
        Cmd::Digest { module, from } => {
            let facts = if let Some(path) = from {
                let s = std::fs::read_to_string(path)?;
                serde_json::from_str(&s)?
            } else {
                extract(&cli.root)?
            };
            print::digest(&facts, &module);
        }
        Cmd::Drift {
            krate,
            max_below_lca,
            include_variants,
            full,
            from,
        } => {
            let facts = if let Some(path) = from {
                let s = std::fs::read_to_string(path)?;
                serde_json::from_str(&s)?
            } else {
                extract(&cli.root)?
            };
            let policy = unified::Policy {
                max_below_lca,
                include_variants,
            };
            unified::print(&facts, krate.as_deref(), &policy, full);
        }
        Cmd::Arch { krate, from } => {
            let facts = if let Some(path) = from {
                let s = std::fs::read_to_string(path)?;
                serde_json::from_str(&s)?
            } else {
                extract(&cli.root)?
            };
            architecture::print(&facts, krate.as_deref());
        }
        Cmd::Tree {
            krate,
            include_variants,
            from,
        } => {
            let facts = if let Some(path) = from {
                let s = std::fs::read_to_string(path)?;
                serde_json::from_str(&s)?
            } else {
                extract(&cli.root)?
            };
            ownership::print_tree(&facts, krate.as_deref(), include_variants);
        }
        Cmd::View {
            workspace,
            at,
            port,
            foreground,
        } => {
            let path = workspace.unwrap_or(cli.root);
            let revspec = match at {
                Some(s) => git_view::parse_revspec(&s)?,
                None => git_view::RevSpec::working_tree(),
            };
            server::run(server::RunArgs {
                workspace: &path,
                revspec,
                port,
                foreground,
                lang: lang_filter,
            })?;
        }
        Cmd::List => {
            server::list_instances()?;
        }
        Cmd::Tour { file, host } => {
            tour_client::send(&file, &host)?;
        }
        Cmd::Survey {
            krate,
            top,
            types,
            from,
        } => {
            let facts = if let Some(path) = from {
                let s = std::fs::read_to_string(path)?;
                serde_json::from_str(&s)?
            } else {
                extract(&cli.root)?
            };
            survey::survey(&facts, krate.as_deref(), top, types);
        }
        Cmd::InstallSkill { yes } => {
            install_skill::run(yes)?;
        }
    }
    Ok(())
}
