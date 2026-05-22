<div align="center">
  <h1>mind-expander</h1>
  <p>
    <strong>A human-AI collaboration tool for large codebases.</strong>
  </p>
  <p>
    It gives software architects and AI coding agents a shared visual workspace:
    structure, relationships, diffs, source context, and guided walkthroughs,
    all connected to real code.
  </p>
  <p>
    <a href="#how-to-use-it">How to Use</a>
    ·
    <a href="#agent-native-workflow">Agent Workflow</a>
    ·
    <a href="#manual-cli">Manual CLI</a>
  </p>
  <p>
    <img alt="AI-native" src="https://img.shields.io/badge/AI--native-collaboration-111827?style=flat-square">
    <img alt="Local-first" src="https://img.shields.io/badge/local--first-architecture%20workspace-2563eb?style=flat-square">
    <img alt="Source-grounded" src="https://img.shields.io/badge/source--grounded-real%20code-059669?style=flat-square">
    <img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-7c3aed?style=flat-square">
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
passing long markdown explanations back and forth, the agent can open a live
diagram, show the source behind its claims, and guide the human through the exact
modules, symbols, relationships, and changes that matter.

## How To Use It

mind-expander is designed to be used through an AI coding agent.

First, install the mind-expander skill in your agent. This repository includes
the skill at [skill/mind-expander.md](skill/mind-expander.md); install or import
that file using your agent's skill workflow.

Ask naturally:

> Use mind-expander to walk me through this codebase.

> Show me the architecture of this feature on the diagram.

> Review my current changes visually and explain the important relationships.

> Turn your refactor plan into an interactive tour.

> Walk me through the last few commits and show me where they matter.

Your agent opens the right view for the task, then leads you through the graph,
source, diffs, and relationships in a browser. You can follow the guided
walkthrough, inspect source, click around the diagram, and trace arrows when you
want more detail.

## Agent-Native Workflow

mind-expander is built around the way AI coding agents already work, but the
experience is meant for the human reviewing the work:

1. Install the mind-expander skill in your agent.
2. Ask your agent for a tour, review, plan, or architecture walkthrough.
3. The agent opens a local visual workspace for the repository or the current
   changes.
4. You review the explanation in the diagram, with source and relationships
   available as you need them.
5. Follow-up questions can become another walkthrough without losing the shared
   context.

The included skill file, [skill/mind-expander.md](skill/mind-expander.md),
is for AI agent integrations. Most users should not need to read it.

The agent-facing package is intended to be launched through `npx`. Until the
package is published, the manual CLI section below shows local source usage for
development and testing.

## Typical Use Cases

- **Codebase orientation:** build a map of the important modules before making
  changes.
- **Architectural planning:** turn a refactor plan into a navigable,
  source-backed walkthrough.
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

