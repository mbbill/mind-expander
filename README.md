<div align="center">
  <h1>mind-expander</h1>
  <p>
    <strong>A human-AI collaboration tool for understanding and changing large codebases.</strong>
  </p>
  <p>
    It gives software architects and AI coding agents a shared visual workspace:
    structure, relationships, diffs, source context, and guided walkthroughs,
    all anchored to real code.
  </p>
  <p>
    <a href="#how-to-use-it">How to Use</a>
    ·
    <a href="#what-it-does">What It Does</a>
    ·
    <a href="#agent-native-workflow">Agent Workflow</a>
    ·
    <a href="docs/demo-videos.md">Demos</a>
    ·
    <a href="#manual-cli">Manual CLI</a>
  </p>
  <p>
    <img alt="AI-native" src="https://img.shields.io/badge/AI--native-collaboration-111827?style=flat-square">
    <img alt="Local-first" src="https://img.shields.io/badge/local--first-architecture%20workspace-2563eb?style=flat-square">
    <img alt="Source-grounded" src="https://img.shields.io/badge/source--grounded-file%3Aline%20tours-059669?style=flat-square">
    <img alt="License" src="https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-7c3aed?style=flat-square">
  </p>
</div>

<p align="center">
  <a href="assets/mind-expander-showoff.mp4"><strong>Watch the demo</strong></a>
  ·
  <a href="docs/demo-videos.md">Browse all demo clips</a>
</p>

<!-- After uploading assets/mind-expander-showoff.mp4 to GitHub, replace the
     link above with the generated github.com/user-attachments URL on its own
     line so GitHub renders the embedded video player. -->

## Why It Exists

AI coding tools can edit quickly, but collaboration breaks down when the
human and the agent do not share the same model of the system.

mind-expander gives both sides a shared architecture surface. Instead of
passing long markdown explanations back and forth, the agent can open a live
diagram, anchor every claim to source, and guide the human through the exact
modules, symbols, relationships, and changes that matter.

## How To Use It

mind-expander is designed to be used through an AI coding agent.

Ask naturally:

> Use mind-expander to walk me through this codebase.

> Show me the architecture of this feature on the diagram.

> Review my current changes visually and explain the important relationships.

> Turn your refactor plan into an interactive tour.

> Walk me through the last few commits and pin each step to the relevant code.

The agent decides whether to open a full-repository view or a diff-focused
view, starts mind-expander, and posts a guided tour into the running viewer.
The result is an interactive walkthrough where each step is pinned to a real
`file:line` location or to a verified relationship in the graph.

## What It Does

<table>
  <tr>
    <td width="50%">
      <h3>Shared Architecture View</h3>
      <p>
        See modules, symbols, ownership/reference relationships, and call paths
        as one navigable workspace.
      </p>
    </td>
    <td width="50%">
      <h3>Source-Grounded Context</h3>
      <p>
        Open the source panel from the diagram, inspect code, then click a line
        to navigate back to the corresponding element.
      </p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <h3>Diff-Aware Review</h3>
      <p>
        Review additions, removals, unchanged entities, and modified bodies in
        the same architecture view used for whole-codebase orientation.
      </p>
    </td>
    <td width="50%">
      <h3>Guided Tours</h3>
      <p>
        Convert a plan, code review, or explanation into a step-by-step visual
        walkthrough anchored to real code.
      </p>
    </td>
  </tr>
</table>

## Agent-Native Workflow

mind-expander is built around the way AI coding agents already work:

1. The agent reads the code and decides what needs to be explained.
2. It launches a local viewer for the workspace or for a specific diff.
3. It writes a tour as structured steps anchored to `file:line` references.
4. The server resolves those references into canonical diagram elements.
5. The human gets a live walkthrough instead of a detached wall of text.

The included skill file, [skill/mind-expander.md](skill/mind-expander.md),
documents the agent workflow: when to use a full-repository view, when to use
diff mode, how to post a tour, and how to keep every step grounded in the
actual code.

The agent-facing package is intended to be launched through `npx`. Until the
package is published, the manual CLI section below shows local source usage for
development and testing.

## Typical Use Cases

- **Codebase orientation:** build a map of the important modules before making
  changes.
- **Architectural planning:** turn a refactor plan into a navigable sequence of
  source-grounded steps.
- **Code review:** inspect changed entities in their structural context instead
  of reading hunks in isolation.
- **Agent handoff:** let an AI agent explain what it found with pointers,
  arrows, and source locations.
- **Design discussion:** use the same visual workspace while deciding where a
  behavior belongs.

## Manual CLI

Manual CLI use is available for development and debugging, but the intended
workflow is through an AI agent.

```sh
# Install from source.
cargo install --path .

# Open a workspace manually.
mind-expander view /path/to/workspace

# Open a diff-oriented view.
mind-expander view /path/to/workspace --at main..
```

Useful commands:

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
