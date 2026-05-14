# mind-expander

Interactive visualizer for the structure of a Rust workspace. Parses the
source with `syn`, builds a per-type ownership + reference graph, and
renders it as a navigable SVG diagram with a side-by-side source panel.

## Quick start

```sh
# Build and install the binary. `cargo build` invokes `npm` for you
# (Node 18+ required) — only when the viewer sources are newer than
# the bundled output, so the common case stays fast.
cargo install --path .

# Open the viewer on a workspace.
mind-expander view /path/to/your/rust/workspace
```

The `view` command extracts facts, starts a local HTTP server, and
opens your browser. `Cmd`/`Ctrl`-click any node in the diagram to open
the corresponding source code; clicking a line in the source panel
navigates back to the diagram.

Flags:

- `--port <N>` &mdash; bind a different port (default `5180`).
- `--no-open` &mdash; don't try to launch a browser.

## Other subcommands

The same binary still exposes the analysis subcommands that predate the
viewer:

- `extract` &mdash; dump the raw facts JSON.
- `digest` &mdash; human-readable per-module digest.
- `drift` &mdash; types that live outside the LCA of their owners' modules.
- `arch` &mdash; module-level dependency report with cycle detection.
- `tree` &mdash; structural-ownership forest.
- `survey` &mdash; compact orientation report (counters, rankings, etc.).

All accept `--root <workspace>`. Run `mind-expander <cmd> --help` for
details.

## Developing the viewer

When iterating on the viewer's TypeScript / SVG code, run the Rust
backend and the Vite dev server side-by-side. Vite proxies `/api/facts`
and `/api/source` to the backend so the frontend uses the same URLs in
dev and in the bundled binary.

```sh
# Terminal 1 &mdash; backend (extracts once, then serves the API).
cargo run -- view /path/to/your/rust/workspace --port 5180 --no-open

# Terminal 2 &mdash; viewer with HMR.
npm --prefix viewer run dev
```

Set `MIND_EXPANDER_BACKEND=http://host:port` in the viewer environment
to point the proxy at a non-default backend.

For a fresh release build, `cargo build --release` will rebuild the
viewer bundle automatically if the sources are newer than the embedded
output.

## Tests

```sh
cargo test                 # Rust: extraction, resolution, callgraph.
npm --prefix viewer test   # Viewer: layout / routing invariants.
```
