# Authoring a tour for the `mind-expander` viewer

This document is the contract between an LLM (or human) authoring a
tour and the `mind-expander tour` CLI that consumes it.

## What a tour is

A small JSON file that describes a guided walk through a Rust
workspace's code, played back inside the running `mind-expander view`
viewer. Each step gets a sticky-note bubble with explanatory text and
an arrow pointing at the code element the step is about.

## Pipeline at a glance

```
LLM reads source + facts.json
    ↓
LLM writes tour.json (the schema below)
    ↓
mind-expander tour tour.json --host 127.0.0.1:PORT
    ↓
server validates + resolves refs to canonical (id, kind)
    ↓
viewer pops a notification; user clicks Play; bubble walks the steps
```

The server runs the tour through a resolver before queuing it; if
anything fails to resolve, the CLI prints structured errors and exits
non-zero. The LLM can read that output and re-emit a corrected tour.

## Schema (version 1)

```jsonc
{
  "schema_version": 1,            // required
  "title": "string",              // optional, shown in the tour bar
  "subject": Reference,           // optional, the tour's main anchor
  "steps": [ Step, ... ]          // required, ≥1 step
}

// Step
{
  "say": "markdown string",       // the bubble body
  "refs": [ Reference, ... ]      // 0+ entries
}

// Reference — one of two shapes:
{ "file": "path/to.rs", "line": 42 }   // an element at this line
{ "file": "path/to.rs" }               // the module that owns this file
```

### Reference rules

1. `file` is **workspace-relative**. The server prepends its
   workspace root when resolving.

2. `line` is the 1-indexed line number you want to point at. The
   server resolves it to the deepest element that contains the line:

   | Line is on …                                | Resolves to            |
   |---------------------------------------------|------------------------|
   | A type definition (`pub struct Foo {`)      | the type               |
   | A field declaration                         | the field              |
   | A method declaration or its body            | the method             |
   | A free function (signature or body)         | the function           |
   | A **call expression** like `foo(...)`       | the **callee** `foo`   |
   | A whitespace/attribute line near an item    | the nearest item       |

   The call-site rule means you can write *"the line where `invoke`
   calls `runtime::eval`"* and the resolver returns `runtime::eval`,
   not the surrounding `invoke`.

3. Omitting `line` gives the module that owns the file. Use this when
   you want to focus on the whole file as a unit.

4. Paths must be in the index. If you reference a file the extractor
   didn't visit, you'll get `err: file not in index: …`.

### Number of refs per step

| `refs.length` | What the viewer does                                       |
|---------------|------------------------------------------------------------|
| 0             | Text-only step. Bubble shows; no diagram change.           |
| 1             | Focus that element. Select it, pan to it, sync code panel if open. |
| 2+            | Focus the first. If the server detects an edge between `refs[0]` and any later ref, it AUTOMATICALLY inserts a follow-up "arrow stage" pointing at the arrow midpoint with the same text. |

So a two-ref step like `[caller-fn, callee-fn]` becomes two stages:
one focused on the caller, then one focused on the connecting arrow.

### The `say` field is markdown

Use markdown for emphasis and to mark up code:

- backticks for **identifiers and inline code**: `` `Instance::new` ``
- `**bold**` / `*italic*` for emphasis
- fenced code blocks ` ``` ` for short snippets
- `-` bullets for lists
- `## Header` for the occasional section header

Keep individual `say` blocks short — they live in a sticky note. Two
to four lines of text is the sweet spot.

## Authoring workflow

1. Read the source you want to explain. Locate the lines you'd cite
   in a code review.
2. Optional: read `facts.json` (or the slim derivative) to see what
   IDs the workspace exposes. Not required — line references are
   enough.
3. Build the tour: subject + steps, each step with markdown `say` +
   `refs`. Keep refs small (1 ref per step unless you're showing a
   relationship).
4. Send it: `mind-expander tour tour.json --host 127.0.0.1:PORT`.
5. Read the CLI output. `ok (tour:N)` means accepted. `err: …` lines
   tell you which step/ref failed and why.

## Worked example

This tour walks `Instance` in `sf-nano-core`:

```jsonc
{
  "schema_version": 1,
  "title": "How sf-nano-core's Instance is used",
  "subject": { "file": "sf-nano-core/src/vm/instance.rs", "line": 426 },
  "steps": [
    {
      "say": "## Engine walk-through\n\nWe'll cover what `Instance` owns, how it's built, and how it dispatches."
    },
    {
      "say": "`Instance` is a **thin wrapper** — a boxed `Store` plus an exports table.",
      "refs": [
        { "file": "sf-nano-core/src/vm/instance.rs", "line": 426 }
      ]
    },
    {
      "say": "Inside `invoke`, the actual evaluation hands off to `runtime::eval`.",
      "refs": [
        { "file": "sf-nano-core/src/vm/instance.rs", "line": 1365 },
        { "file": "sf-nano-core/src/vm/runtime/mod.rs", "line": 80 }
      ]
    }
  ]
}
```

Notes:

- The two-ref step lets the server pair the caller's call expression
  with the callee. Because line 1365 is inside the `runtime::eval(...)`
  call, the callsite-aware resolver lands ref[0] on `runtime::eval`
  itself. The connection between the two refs triggers an auto-inserted
  arrow stage.
- All `say` blocks use markdown. Backtick the identifiers you reference.

## Anti-patterns

- **Don't** point at attribute / blank lines. The fallback ladder
  picks the nearest element, but it's brittle. Cite the item's
  signature line or its body.
- **Don't** repeat the previous step's element as ref[0] just to
  re-mention it. Tour bar already gives the user `‹ Prev`.
- **Don't** stuff a huge code listing into `say`. Open the code
  panel from the tour bar if the reader wants the full source.
- **Don't** hard-code absolute paths. Always workspace-relative.

## CLI errors you might see

```
err: step=2 ref=1 file not in index: src/missing.rs
err: step=5 ref=0 line out of range (file has 540 lines)
err: step=3 ref=2 no resolvable element near foo.rs:9999
err: schema_version 2 not supported; expected 1
```

Each error tells you which step/ref failed and why. Fix and resend.
