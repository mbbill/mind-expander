# mind-expander

**mind-expander is a human-AI collaboration tool for understanding and
changing large codebases.**

It gives software architects and AI coding agents a shared visual workspace:
structure, relationships, diffs, source context, and guided walkthroughs, all
anchored to real code.

<!-- Demo video placeholder:
     Upload assets/mind-expander-showoff.mp4 to GitHub, then replace this
     comment with the generated github.com/user-attachments URL. -->

## Why

AI coding tools can edit quickly, but collaboration slows down when the human
and the agent do not share the same model of the system.

mind-expander turns a workspace into a navigable architecture surface so a
human and an agent can point at the same module, symbol, call path, diff hunk,
or source line while planning, reviewing, or explaining a change.

Use it to:

- orient around unfamiliar code
- review structural changes visually
- plan refactors with source-grounded context
- follow relationships across modules
- turn an explanation into a guided tour through the code

## Quick Start

```sh
# Build and install the binary. Node 18+ is required when building
# from source because the browser viewer is bundled into the binary.
cargo install --path .

# Open the viewer on a workspace.
mind-expander view /path/to/workspace
```

The `view` command extracts facts, starts a local HTTP server, and opens the
browser when running interactively. The server prints a ready block with the
URL, port, and background process id.

```text
mind-expander: ready
pid: 12345
port: 5180
url: http://127.0.0.1:5180/
```

Useful flags:

- `--at <base>..<head>`: open a diff-oriented view.
- `--at <base>..`: compare the working tree against a base ref.
- `--port <N>`: bind a specific port; otherwise a free port is chosen.
- `--no-open`: do not launch a browser.
- `--foreground`: keep the server attached to the terminal.

## What It Gives You

### A Shared Architecture View

The viewer lays out modules, symbols, ownership/reference relationships, and
call relationships as an interactive graph. Expanding a node reveals the
members or callable rows that participate in those relationships.

### Source In The Same Workspace

Open the source panel from the diagram, inspect the relevant code, then click a
line in the source panel to navigate back to the corresponding element in the
diagram.

### Diff-Aware Review

Run `mind-expander view --at main..` to review local changes against `main`, or
use any revision range accepted by the CLI. Added, removed, unchanged, and
modified entities are carried through the same facts model the viewer uses for
the normal architecture view.

### Guided Tours

Tours are small JSON walkthroughs anchored to workspace-relative `file:line`
references. The server resolves each reference to a canonical diagram element
and verifies requested arrows before the viewer plays the tour.

```sh
mind-expander tour examples/silverfir-instance-tour.json --host 127.0.0.1:5180
```

This makes it possible for an AI agent to turn a review, plan, or explanation
into an interactive walkthrough instead of a long markdown-only answer.

## Commands

- `view`: extract facts and serve the interactive viewer.
- `tour`: send a guided tour to a running viewer.
- `list`: list background viewer instances.
- `extract`: dump the raw facts JSON.
- `survey`: print a compact orientation report.
- `digest`: print a human-readable per-module digest.
- `drift`: report entities whose location differs from their structural owners.
- `arch`: report module-level dependencies and cycles.
- `tree`: print the structural-ownership forest.

Run `mind-expander <command> --help` for details.

## Developing

When iterating on the browser viewer, run the backend and Vite dev server
side-by-side. Vite proxies `/api/*` to the backend, so development and the
bundled binary use the same API paths.

```sh
# Terminal 1: backend API + facts extraction.
cargo run -- view /path/to/workspace --port 5180 --no-open --foreground

# Terminal 2: viewer with HMR.
npm --prefix viewer run dev
```

Set `MIND_EXPANDER_BACKEND=http://host:port` in the viewer environment to point
the proxy at a non-default backend.

For a release build, `cargo build --release` rebuilds the viewer bundle when
the viewer sources are newer than the embedded output.

## Tests

```sh
cargo test
npm --prefix viewer test
```
