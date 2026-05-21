---
name: mind-expander
description: |
  mind-expander turns a plan, code review, or codebase walkthrough into a
  guided tour through a live interactive diagram of the user's Rust
  workspace. The agent reads source code normally (Read, grep, etc.) and
  then either replies in markdown (default) or posts a "tour" JSON — each
  narrated step pinned to a file:line — and the user watches a bubble walk
  through the diagram while reading the explanation. INVOCATION POLICY:
  default to plain markdown for plan / review / walkthrough requests and
  append ONE low-key closing-line offer of the tour as an alternative;
  invoke the tour directly (no offer) when the user uses visual language
  ("tour", "walk me through", "show me on the diagram", "visualize this")
  or when a feedback memory records that this user prefers tours.
---

# mind-expander

Guided tours of a live codebase diagram, as an alternative to markdown
replies. The agent's normal workflow is unchanged: read source with your
usual tools, decide what to say, anchor each claim to a file:line. The
tour just changes how that gets delivered to the user.

## Invocation policy

**Default** — plain markdown reply. If the work was substantial enough to
benefit from the diagram (real refactor plan, structural PR, codebase
walkthrough — not a 3-line answer), append one closing line:

> *Want this as an interactive tour in the diagram instead? `npx mind-expander view` and I'll pin each step to the relevant file:line.*

Past-tense framing keeps it as an alternative, not a question.

**Direct invocation** — skip the markdown, build the tour, reply with a
single line ("Tour playing — pid 12345 on port 5180.") when:

- The user uses visual language: "tour", "walk me through", "show me on
  the diagram", "visualize this", "interactive walkthrough".
- A feedback memory says this user prefers tours.

**Memory hooks** — when the user accepts the offer, save a feedback memory
("user prefers mind-expander tours for plan/review tasks"). When they
decline, save the opposite. Then stop offering for similar requests.

When in doubt, default — least intrusive, still teaches discovery.

## Setup

```bash
npx mind-expander view <repo> [--at <revspec>]
```

`--at <base>..<head>` for review (e.g. `main..HEAD`); omit for planning /
walkthroughs. Self-daemonizes on Unix: foreground exits 0 once ready, the
server keeps running. Stdout block:

```
mind-expander: ready
pid: 12345
port: 5180
url: http://127.0.0.1:5180/
```

Save the `port` (for the tour POST) and `pid` (to `kill` when done — the
server won't auto-shut). Multiple concurrent sessions are fine; each picks
its own port if `--port` is omitted.

## Posting a tour

**Prefer stdin / inline** so you don't need filesystem write permission
or leftover `/tmp/*.json` files. Two equivalent patterns:

Heredoc via the `tour` subcommand (the `-` reads JSON from stdin):

```bash
npx mind-expander tour - --host 127.0.0.1:<port> <<'EOF'
{
  "schema_version": 2,
  "title": "...",
  "steps": [ ... ]
}
EOF
```

Or POST directly with curl reading the body from stdin:

```bash
curl -sS -X POST http://127.0.0.1:<port>/api/tour \
  -H 'content-type: application/json' \
  --data-binary @- <<'EOF'
{ "schema_version": 2, "steps": [ ... ] }
EOF
```

Only fall back to a `/tmp/tour.json` file if the tour is enormous and
the shell heredoc would be unwieldy.

Success returns `{status: "ok", tour_id}`. Failure returns 422 with
`{errors: [{step, ref, msg}]}` — fix and resend (still via stdin).

## Tour schema

```json
{
  "schema_version": 2,
  "title": "Optional bubble-header title",
  "subject": { "file": "src/lib.rs", "line": 42 },
  "steps": [
    { "say": "Text-only step. **Markdown** works in `say`." },
    { "say": "Element step — bubble points here.",
      "ref": { "file": "src/parse.rs", "line": 127 } },
    { "say": "Arrow step — bubble shows the edge between two entities.",
      "arrow": {
        "from": { "file": "src/api.rs", "line": 50 },
        "to":   { "file": "src/db.rs",  "line": 200 }
      } }
  ]
}
```

**Fields:**

- `schema_version` — required, must be `2`.
- `title` — optional. Shown in the bubble header.
- `subject` — optional `Reference`. Displayed as the **banner at the top
  of the viewer window** when the tour starts — the tour's headline anchor.
- `steps` — required array.

**Each step:**

- `say` — required. **Rendered as Markdown** in the bubble (`**bold**`,
  `` `code` ``, lists, links). Keep each `say` tight; a wall of text in
  one step loses the bubble's punch.
- `ref` *or* `arrow` — mutually exclusive; both optional (omit both for a
  text-only step).
- `Reference = {file, line?}`. `file` is **repo-relative**. Omitting
  `line` references the whole module.

### The arrow contract — IMPORTANT

`arrow` is **not** a free-form "draw a line between any two file:lines."
The viewer only models two structural edges:

1. **Ownership / reference** between types (struct/enum fields, trait
   impls). Direction: `owner → owned`.
2. **Function calls** between function or method bodies. Direction:
   `caller → callee`.

An arrow is rejected (422) unless `(from, to)` matches one of those, in
that direction. The resolver hints if the edge exists backwards.

✅ `Server` (struct) → `Handler` (its field's type) — ownership edge.
✅ `init` → `parse_byte_size` — function call.
❌ A constant → its use site (uses aren't modelled).
❌ A comment → the code it explains.
❌ Two unrelated functions, just to suggest "look at A, then B" — that's
two consecutive `ref` steps, not an arrow.

When the connection you want isn't an ownership/call edge, use two `ref`
steps and explain the relationship in prose. The arrow primitive only
makes sense when there's a real edge the viewer can draw.

### Resolver quirks

- Citing a line *inside a call expression* resolves to the **callee**.
  `line: 50` on `foo(bar())` lands on `bar`. Useful: cite the line where
  the interesting thing is INVOKED.

## Use cases

### Planning (the highest-detail use case)

A planning tour should cover the entire plan — every file the user
will touch, every function they'll modify, the order of changes, and the
why. A 4-step "tour" is not a plan.

**Structure that consistently works:**

1. Opening text-only step — state the goal, announce the phases.
2. One **phase per concern** (data model, core logic, callers, tests).
   Introduce each with `── Phase N: <name> ──`.
3. One element step per concrete change. File:line + a sentence on what
   to do AND why.
4. Surface the **deliberately untouched** — places where the user might
   expect a change but you've ruled it out. Don't gloss.
5. Closing step with commit order, size estimate, and one concrete
   question to give the user something to respond to.

**Example** — user asks to plan a retry policy for an HTTP client:

```json
{
  "schema_version": 2,
  "title": "Add retry policy to HTTP client",
  "subject": { "file": "src/http.rs", "line": 120 },
  "steps": [
    { "say": "Goal: configurable retry-on-5xx on every outbound request. Four phases: config type, send loop, callers (no signature break), tests." },

    { "say": "── Phase 1: config type ──" },
    { "say": "Add a `RetryPolicy` struct here, next to `Config` — same module so consumers import from one place. Fields: `max_attempts` (u8), `backoff` (Duration), `retryable_status` (Vec<u16>).",
      "ref": { "file": "src/config.rs", "line": 14 } },
    { "say": "Add `Config::retry: RetryPolicy` to the existing struct. Default = `max_attempts: 1` so this stays a zero-behavior-change addition until callers opt in.",
      "ref": { "file": "src/config.rs", "line": 8 } },

    { "say": "── Phase 2: send loop ──" },
    { "say": "The method I'll wrap. Keep the signature; add a retry loop around the body.",
      "ref": { "file": "src/http.rs", "line": 120 } },
    { "say": "Pull the 5xx-detection out of this branch into `is_retryable(&err, &policy)` so the loop body stays readable.",
      "ref": { "file": "src/http.rs", "line": 158 } },
    { "say": "Backoff: `policy.backoff * 2^attempt`. Use `tokio::time::sleep` so tests can fast-forward virtual time." },

    { "say": "── Phase 3: callers ──" },
    { "say": "All 8 callers go through `send`. Signature unchanged, so no code change required. But callers with ad-hoc retries need their loops removed — otherwise we double-retry. This is one.",
      "ref": { "file": "src/sync.rs", "line": 47 } },
    { "say": "Same pattern — delete the manual 503 retry; set `config.retry.retryable_status = vec![503]` at the call site.",
      "ref": { "file": "src/poll.rs", "line": 92 } },
    { "say": "**Deliberately untouched:** this caller's retry interacts with a transaction. Leave it; default `max_attempts: 1` keeps us from double-firing.",
      "ref": { "file": "src/tx.rs", "line": 30 } },

    { "say": "── Phase 4: tests ──" },
    { "say": "Existing send test. Add three cases below: 500-retried-twice-then-succeeds, 500-retried-max-then-errors, 200-no-retry.",
      "ref": { "file": "tests/http.rs", "line": 64 } },
    { "say": "Property test — random RetryPolicy + response sequence, assert HTTP calls = min(max_attempts, attempts_until_2xx). Proptest is already a dep.",
      "ref": { "file": "tests/http.rs", "line": 200 } },

    { "say": "── Done ──" },
    { "say": "Commit order: config → core loop → caller cleanup (bundle) → tests. ~250 LoC, no public API break. Want me to start with Phase 1?" }
  ]
}
```

The review and walkthrough patterns below reuse this structure — opening
overview, sectioned body with `──` headers, anchored steps, closing
question.

### Code review

Tour through structural diff changes. Skip cosmetic edits. Use the
opening step to summarize counts ("3 entities changed: 1 added, 1
modified, 1 deleted"). Order sections deletions → modifications → additions
(reads naturally). Use an `arrow` step when a change introduces a new
call edge. Close with verdict + the one thing worth raising in the PR.

```json
{
  "schema_version": 2,
  "title": "Review main..HEAD",
  "steps": [
    { "say": "3 entities changed: 1 added, 1 modified (mixed body), 1 deleted. No public signature changes. Walking in dependency order." },
    { "say": "── Deletion ──" },
    { "say": "`old_parse` was only called from `init` (also rewritten) — safe to drop.",
      "ref": { "file": "src/cli.rs", "line": 88 } },
    { "say": "── Modified ──" },
    { "say": "`init` was rewritten: inline parser replaced with a call to the new `parse_byte_size`. Cleaner, but the new edge introduces test coverage you should verify.",
      "ref": { "file": "src/cli.rs", "line": 36 } },
    { "say": "Here's the new call edge.",
      "arrow": {
        "from": { "file": "src/cli.rs", "line": 36 },
        "to":   { "file": "src/parse.rs", "line": 10 }
      } },
    { "say": "── Added ──" },
    { "say": "`parse_byte_size` handles strings like `\"64KiB\"`. Match arms cover lowercase suffixes only — capitalized inputs silently hit `_ => None`. Worth knowing whether that's intentional.",
      "ref": { "file": "src/parse.rs", "line": 10 } },
    { "say": "── Verdict ──" },
    { "say": "Clean structurally. Surface the parse_byte_size case-sensitivity in the PR description; otherwise good to merge." }
  ]
}
```

### General walkthrough

Orient a newcomer in 5–10 minutes. Anchor 6–10 entities along the
lifecycle (request flow, compile pipeline, whatever metaphor fits).
Resist exhaustiveness — a tour is a curated narrative, not an index.
End with "where to start making changes."

```json
{
  "schema_version": 2,
  "title": "Tour of `tinyhttp`",
  "steps": [
    { "say": "Small HTTP/1.1 server. ~2000 LoC, 6 modules. I'll follow the request lifecycle." },
    { "say": "Entry point: `Server::bind` — SocketAddr + Handler in, runnable Server out.",
      "ref": { "file": "src/lib.rs", "line": 20 } },
    { "say": "Handler is the trait users implement. Routing lives in user code; this crate is wire-level plumbing.",
      "ref": { "file": "src/handler.rs", "line": 8 } },
    { "say": "Accept loop — spawns a tokio task per connection.",
      "ref": { "file": "src/server.rs", "line": 45 } },
    { "say": "Per-connection: parse request → call handler → write response → close. No keep-alive in v1.",
      "ref": { "file": "src/server.rs", "line": 80 } },
    { "say": "Parser is hand-rolled (no nom, no httparse). Read here when debugging weird-encoding requests.",
      "ref": { "file": "src/parse.rs", "line": 1 } },
    { "say": "Where to start making changes: routing API for user-facing changes, parser for protocol fixes. The accept loop rarely needs touching." }
  ]
}
```

## Pitfalls

- **Don't dump prose with a tour as afterthought.** If you go the tour
  route, the tour IS the reply — your text before/after should be one or
  two lines max.
- **Pin every concrete claim.** A `say` without a `ref` is fine for
  transitions and `── headers ──`. But "we should refactor this module"
  with no pointer is wasted breath.
- **Don't fabricate arrows.** A rejected arrow kills the whole tour (422).
  If unsure the edge exists, use `ref` steps + prose.
- **Repo-relative paths only.** `src/foo.rs` ✓, absolute paths ✗.
- **End with a question or next action.** The user just watched the tour
  and is expecting to respond — give them something to respond to.

## Lifecycle

- `npx mind-expander list` enumerates running instances.
- `kill <pid>` stops one. If you started a server, clean it up when the
  user's task is done.
- Auto-daemonize is Unix-only. Pass `--foreground` on Windows or in CI.

## Limitations

- Rust workspaces only today (TS/Go planned).
- Diff/review mode needs a git repo with valid base+head SHAs.
