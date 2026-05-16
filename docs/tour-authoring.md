# Authoring a tour for the `mind-expander` viewer

This document is the contract between an LLM (or human) authoring a
tour and the `mind-expander tour` CLI that consumes it.

## What a tour is

A small JSON file that describes a guided walk through a Rust
workspace's code, played back inside the running `mind-expander view`
viewer. Each step gets a sticky-note bubble with explanatory text and
(optionally) an arrow pointing at a code element or a relationship.

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

## Schema (version 2)

```jsonc
{
  "schema_version": 2,            // required
  "title": "string",              // optional, shown in the tour bar
  "subject": Reference,           // optional, the tour's main anchor
  "steps": [ Step, ... ]          // required, ≥1 step
}
```

A `Step` is **exactly one** of three shapes, chosen by which of `ref`
/ `arrow` is set:

```jsonc
// (a) narration only — no diagram action
{ "say": "markdown string" }

// (b) focus on one element
{
  "say": "markdown string",
  "ref": Reference
}

// (c) focus on one directed arrow
{
  "say": "markdown string",
  "arrow": {
    "from": Reference,
    "to":   Reference
  }
}
```

Setting both `ref` and `arrow` on the same step is rejected — pick
exactly one shape per step. The author always decides; the resolver
never guesses intent from neighbouring steps.

A `Reference` has two shapes:

```jsonc
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

   The call-site rule means you can cite *"the line where `invoke`
   calls `runtime::eval`"* in a `ref` and the resolver returns
   `runtime::eval`. When you want to focus on `invoke` *itself*, cite
   its signature line instead (or any body line that isn't a call).

3. Omitting `line` gives the module that owns the file. Use this when
   you want to focus on the whole file as a unit.

4. Paths must be in the index. If you reference a file the extractor
   didn't visit, you'll get `err: file not in index: …`.

### Arrow step rules

An `arrow` step requires a **directed edge** `from → to` in the
workspace facts. The resolver checks both call edges
(`caller → callee`) and type-level edges (`owner → owned`,
`source → destination`, …).

- If the edge exists in the **opposite** direction, the error message
  tells you so: `(the reverse direction does exist — did you swap
  from and to?)`. Swap them.
- If neither direction exists, the relationship isn't in the facts
  and the diagram has no arrow to point at — drop the arrow step or
  pick a real edge.
- `from.id == to.id` is rejected — that's not an arrow.

For arrow `from`, prefer the **enclosing function's signature line**
so the resolver doesn't activate the call-site shortcut and land you
on the callee. For arrow `to`, the signature line of the callee is
the safest choice.

### The `say` field is markdown

Use markdown for emphasis and to mark up code:

- backticks for **identifiers and inline code**: `` `Instance::new` ``
- `**bold**` / `*italic*` for emphasis
- fenced code blocks ` ``` ` for short snippets
- `-` bullets for lists
- `## Header` for the occasional section header

Keep individual `say` blocks short — they live in a sticky note. Two
to four lines of text is the sweet spot.

`say` is required on every step, including arrow steps — describe
why the arrow matters; the bubble only points, it doesn't explain
itself.

## Authoring workflow

1. Read the source you want to explain. Locate the lines you'd cite
   in a code review.
2. Optional: read `facts.json` (or the slim derivative) to see what
   IDs the workspace exposes. Not required — line references are
   enough.
3. Build the tour: subject + steps. For each step pick the shape:
   narration, single ref, or directed arrow.
4. Send it: `mind-expander tour tour.json --host 127.0.0.1:PORT`.
5. Read the CLI output. `ok (tour:N)` means accepted. `err: …` lines
   tell you which step/ref failed and why.

## Worked example

```jsonc
{
  "schema_version": 2,
  "title": "How sf-nano-core's Instance is used",
  "subject": { "file": "sf-nano-core/src/vm/instance.rs", "line": 426 },
  "steps": [
    {
      "say": "## Engine walk-through\n\nWhat `Instance` owns, how it's built, and how it dispatches."
    },
    {
      "say": "`Instance` is a **thin wrapper** — a boxed `Store` plus an exports table.",
      "ref": { "file": "sf-nano-core/src/vm/instance.rs", "line": 426 }
    },
    {
      "say": "`invoke` is the call surface — it looks up the exported function and dispatches it.",
      "ref": { "file": "sf-nano-core/src/vm/instance.rs", "line": 1367 }
    },
    {
      "say": "Inside `invoke`, evaluation hands off to `runtime::eval`. The bubble points at the arrow on the diagram.",
      "arrow": {
        "from": { "file": "sf-nano-core/src/vm/instance.rs",      "line": 1367 },
        "to":   { "file": "sf-nano-core/src/vm/runtime/mod.rs",   "line": 80   }
      }
    },
    {
      "say": "Here's `runtime::eval` — the interpreter loop that runs once `invoke` has located the body.",
      "ref": { "file": "sf-nano-core/src/vm/runtime/mod.rs", "line": 80 }
    }
  ]
}
```

Notes:

- The arrow step explicitly states `invoke → eval`. The resolver
  verifies that directed edge exists in the call graph and orders the
  refs as `[from, to]` on the wire, so the viewer can reveal the
  arrow without guessing direction.
- Both element steps cite the function's signature line. Citing a
  body line that contains a call expression would resolve to the
  callee, not the enclosing function.
- All `say` blocks use markdown. Backtick the identifiers you reference.

## Anti-patterns

- **Don't** point at attribute / blank lines. The fallback ladder
  picks the nearest element, but it's brittle. Cite the item's
  signature line or its body.
- **Don't** repeat the previous step's element as a `ref` just to
  re-mention it. Tour bar already gives the user `‹ Prev`.
- **Don't** stuff a huge code listing into `say`. Open the code
  panel from the tour bar if the reader wants the full source.
- **Don't** hard-code absolute paths. Always workspace-relative.
- **Don't** set both `ref` and `arrow` on the same step. If you want
  to focus the element first and then the arrow, write two steps.
- **Don't** infer an arrow's direction from narrative order — write
  it down in the `arrow` step. The diagram and the bubble agree only
  because you tell the resolver which direction you mean.

## CLI errors you might see

```
err: step=2 ref=1 file not in index: src/missing.rs
err: step=5 ref=0 step sets both `ref` and `arrow`; pick exactly one shape
err: step=7 ref=0 no directed edge from `crate::vm::eval` to `crate::vm::invoke` (the reverse direction does exist — did you swap `from` and `to`?)
err: step=3 ref=0 arrow.from and arrow.to resolve to the same element
err: schema_version 1 not supported; expected 2
```

Each error tells you which step/ref failed and why. Fix and resend.
