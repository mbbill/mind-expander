<div align="center">
  <h1>mind-expander</h1>
  <p>
    <strong>A human-AI collaboration tool for large codebases.</strong>
  </p>
  <p>
    Pair-programming with an AI falls apart on large codebases — the AI
    can't see what you see, you can't see what it's reasoning about.
    mind-expander is the shared workspace that closes that gap. Today
    it's a live, tourable diagram of any codebase; the goal is the full
    surface for human-AI software engineering.
  </p>
  <p>
    <a href="#why-it-exists">Why It Exists</a>
    ·
    <a href="#how-to-use-it">How To Use</a>
    ·
    <a href="docs/demo-videos.md">Demos</a>
  </p>
  <p>
    <a href="https://www.npmjs.com/package/mind-expander"><img alt="npm version" src="https://img.shields.io/npm/v/mind-expander?style=flat-square&color=2563eb"></a>
    <a href="https://github.com/mbbill/mind-expander/actions/workflows/release.yml"><img alt="release" src="https://img.shields.io/github/actions/workflow/status/mbbill/mind-expander/release.yml?style=flat-square&label=release"></a>
    <a href="LICENSE"><img alt="license" src="https://img.shields.io/npm/l/mind-expander?style=flat-square&color=7c3aed"></a>
  </p>
</div>

https://github.com/user-attachments/assets/0bb41ece-a493-4596-9c34-22d9c4e6dbea

<p align="center">
  <a href="docs/demo-videos.md"><strong>Browse all demo videos</strong></a>
</p>

## Why It Exists

AI coding tools can edit quickly, but collaboration breaks down when the
human and the agent do not share the same model of the system.

mind-expander gives both sides a shared architecture surface. Instead of
passing long markdown explanations back and forth, the agent opens a live
diagram, shows the source behind its claims, and guides the human through
the exact modules, symbols, relationships, and changes that matter.

## How To Use It

mind-expander is designed to be driven by an AI coding agent.

1. **Install the skill in your agent.** Copy
   [skill/mind-expander.md](skill/mind-expander.md) into your agent's
   skills directory (Claude Code, Cursor, etc.).

2. **Ask naturally.** Examples:

   > Use mind-expander to walk me through this codebase.

   > Show me the architecture of this feature on the diagram.

   > Review my current changes visually and explain the important relationships.

   > Turn your refactor plan into an interactive tour.

   > Walk me through the last few commits and show me where they matter.

3. **The agent runs `npx mind-expander`** in the background — no
   install step on your part. It opens a local diagram in your browser,
   anchored to the source, narrated step by step.

4. **You stay in control.** Click anything in the diagram to navigate,
   open source in the side panel, or ask a follow-up question to spawn
   a new walkthrough without losing context.

## Typical Use Cases

- **Codebase orientation:** build a map of the important modules before
  making changes.
- **Architectural planning:** turn a refactor plan into a navigable,
  source-backed walkthrough.
- **Code review:** inspect changed entities in their structural context
  instead of reading hunks in isolation.
- **Agent handoff:** let an AI agent explain what it found with
  pointers, arrows, and source locations.
- **Design discussion:** use the same visual workspace while deciding
  where a behavior belongs.

## CLI

Driving mind-expander by hand instead of through an agent. Requires
Node.js 18+.

```sh
# Open any workspace.
npx mind-expander view /path/to/workspace

# Open with a diff overlay.
npx mind-expander view /path/to/workspace --at main..

# List running instances + their pids.
npx mind-expander list
```

First run downloads ~3 KB of launcher plus the ~20 MB prebuilt binary
matching your platform (macOS arm64/x64, Linux x64/arm64, Windows x64).
Cached after.

### Build from source

For unsupported platforms (musl Linux, BSD) or developing on the tool
itself:

```sh
cargo install --git https://github.com/mbbill/mind-expander
```
