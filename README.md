<div align="center">
  <h1>mind-expander</h1>
  <p>
    <strong>An infinite-canvas workspace for coding with AI agents.</strong>
  </p>
  <p>
    mind-expander turns a codebase into an infinite-canvas workspace for
    developers coding with AI agents. Instead of reading another long
    explanation, you and the agent can work on the same source-backed
    graph: modules, types, calls, dependencies, ownership-like
    relationships, and the parts of the system changed by a refactor or
    PR. It supports Rust and TypeScript today, with more language
    frontends planned. The goal is a better workspace for understanding
    architecture, planning changes, reviewing PRs, and steering code
    that is increasingly written with AI.
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
  —
  code maps · caller/callee chains · diff review · planning tours
</p>

## Why It Exists

Code review and design work are rarely about one file. The hard part is
usually the shape of the system: who owns what, which API boundary is
moving, which function calls which, and whether a change crosses the
wrong module boundary.

That is especially true when an AI agent is involved. Agents are good at
producing code and long explanations, but long markdown is a poor medium
for checking architecture. You need to see the same structure the agent
is talking about, inspect the source behind each claim, and decide
whether the plan is actually right.

mind-expander gives you that infinite-canvas surface. It extracts
structural facts from Rust and TypeScript, renders them as an
interactive browser diagram, and lets an agent turn a review, plan, or
walkthrough into a source-backed tour.

## How To Use It

mind-expander is designed to be driven by an AI coding agent.

1. **Install the skill in your agent.** Copy this into your AI coding
   agent:

   ```text
   Install the mind-expander skill by downloading the raw file at:
   https://raw.githubusercontent.com/mbbill/mind-expander/refs/heads/main/skill/mind-expander.md

   Install the exact downloaded contents as the skill file. Do not
   summarize, rewrite, or paraphrase the file.
   ```

   If you prefer a local installer, run:

   ```sh
   npx mind-expander install-skill
   ```


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

- **AI-guided PR review.** Open a diff view and ask your agent to walk
  through the changed entities in structural context instead of reading
  isolated hunks.
- **Refactor planning.** Turn an agent's plan into an interactive tour
  where every step points to the source it depends on.
- **Codebase orientation.** Give yourself or a teammate a guided map of
  the important modules, types, functions, and relationships.
- **Architecture discussions.** Use the same visual context while
  deciding where behavior belongs or how a boundary should move.
- **Language-aware details.** Use Rust ownership/lifetime signals and
  TypeScript class/interface/module relationships where available, with
  more language frontends planned.

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

### Build from source

For unsupported platforms (musl Linux, BSD) or developing on the tool
itself:

```sh
cargo install --git https://github.com/mbbill/mind-expander
```
