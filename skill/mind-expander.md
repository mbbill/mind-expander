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

## Mode — diff vs full-repo

**Decide this BEFORE running `view`.** The diagram itself runs in one of
two modes, and `--at <base>..<head>` selects diff mode. Getting this
wrong is the most common skill failure: the user asks about *changes*
and the agent boots a full-repo diagram, then has to restart.

**Diff mode** (`--at base..head`) — the diagram highlights only entities
touched in the revspec. Use whenever the request is scoped to a set of
changes. Triggers:

- "review this PR", "code review", "review the diff"
- "what changed", "the changes", "what's new since X"
- **"walk me through the last N commits / the last N changes / recent work"**
  — *walkthrough verbs paired with "changes" / "commits" still mean diff mode*
- An explicit revspec, commit range, or PR number is mentioned
- The user just finished work and is asking you to look at it

**Full-repo mode** (no `--at`) — the whole crate graph. Use when the
request is about the codebase as a system, not a specific delta:

- "tour of this codebase", "explain how X works", "show me the architecture"
- Planning a refactor or new feature (the changes don't exist yet)
- General orientation / onboarding

**The tiebreaker:** the word "changes" / "commits" / "diff" / "PR" /
"recent" is a strong diff-mode signal *even when* paired with walkthrough
language. Lean diff. If a request is genuinely ambiguous (e.g. "show me
this repo" right after a series of commits), ask one short question
before starting the server — restarting in the other mode is wasted work
the user sees.

## Setup

```bash
npx mind-expander view <repo> [--at <revspec>]
```

`--at` selects diff vs full-repo mode — see the section above before
running this. Self-daemonizes on Unix: foreground exits 0 once ready, the
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

- `say` — required. **Rendered as Markdown** in the bubble. Full
  CommonMark support: `**bold**`, `*italic*`, `` `code` ``, fenced
  code blocks with language hints, ordered + unordered lists,
  tables, links, `## headings`. Keep tight for **reviews** and
  **walkthroughs** (one bubble = one observation); planning steps
  can be much longer — see the planning use case below for the
  markdown-rich shape.
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
will touch, every function they'll modify, the order of changes, and
the why. A 4-step "tour" is not a plan.

**Structure that consistently works:**

1. **Opening step** — text-only, allowed. Goal, phase list, size
   estimate. This is the *only* step without a `ref`.
2. **Every other step is anchored.** No bare `── Phase ──`
   separator steps — they waste a click and the bubble has nothing
   to point at. Fold phase headers into the **prose** as a `## Phase
   3.2 — name` markdown heading.
3. **Each step is a mini-section** — not a one-liner. Use the
   bubble's full markdown: H2 headings, fenced code blocks (type
   defs, sigs, before/after), tables (mapping rules), nested
   bullets, bold key terms, inline `code` for every symbol.
4. **Anchoring files that don't exist yet:** ref the file you'll
   **mirror** (TS analog when planning Go; existing trait when
   planning a new impl). Lead with "Mirror this for X".
5. **Surface the deliberately untouched** — anchor to a
   representative file you're leaving alone, with prose explaining
   why.
6. **Closing step** — anchored to the CLI / main / invocation
   site. Numbered commit sequence with per-commit LoC budgets,
   total size estimate, and **one concrete open question** the
   user can answer to unblock implementation.

**Example** — three representative step shapes (opening, mid-plan
anchored, closing). A full plan would have ~15–20 such steps; this
shows the markdown patterns they share.

```json
{
  "schema_version": 2,
  "title": "Add retry policy to HTTP client",
  "subject": { "file": "src/http.rs", "line": 120 },
  "steps": [
    { "say": "## Goal\n\nConfigurable retry-on-5xx on every outbound request.\n\n## Phases\n\n1. **Config type** — new `RetryPolicy` struct (~30 LoC)\n2. **Send loop** — wrap with retry + backoff (~80 LoC)\n3. **Caller cleanup** — delete 2 ad-hoc retry loops (~40 LoC)\n4. **Tests** — three unit cases + property test (~120 LoC)\n\n**Size:** ~250 LoC, no public API break." },

    { "say": "## Phase 2.1 — Send loop\n\nThe method to wrap. Keep the signature; add a retry loop around the body:\n\n```rust\npub async fn send(&self, req: Request) -> Result<Response> {\n    let mut attempt = 0;\n    loop {\n        match self.send_once(&req).await {\n            Ok(r) if !is_retryable(&r, &self.cfg.retry) => return Ok(r),\n            _ if attempt + 1 >= self.cfg.retry.max_attempts => /* return last */,\n            _ => { /* back off and retry */ }\n        }\n        attempt += 1;\n    }\n}\n```\n\n### Why a loop, not recursion\n\n- Stack-safe for high `max_attempts`\n- Easier to thread `attempt` for backoff math\n- Use `tokio::time::sleep` so tests can fast-forward via `tokio::time::pause()`",
      "ref": { "file": "src/http.rs", "line": 120 } },

    { "say": "## Deliberately untouched — `src/tx.rs`\n\nThis caller's retry **interacts with a transaction**. The generic retry layer would re-fire the request inside the same transaction context, risking duplicate commits.\n\n### Decision\n\nLeave the ad-hoc retry in place. The default `max_attempts: 1` makes the generic layer a no-op here.\n\n### Follow-up\n\nIf transactional retries become common, add `RetryStrategy::TransactionAware` later. Out of scope.",
      "ref": { "file": "src/tx.rs", "line": 30 } },

    { "say": "## Commit order + sign-off\n\n### Sequence\n\n1. **Config type** (~30 LoC) — defaults make it inert\n2. **Send loop** (~80 LoC) — CI green, no caller behavior change yet\n3. **Caller cleanup** (~40 LoC, bundled) — delete 2 ad-hoc loops\n4. **Tests** (~120 LoC)\n\n### Total\n\n**~250 LoC**, 4 commits, no public API break.\n\n### Open question\n\n**Default `retryable_status`**:\n\n- `[502, 503, 504]` — transient gateway errors only\n- `[502, 503, 504, 429]` — also rate-limit (requires `Retry-After` parsing)\n- empty — opt-in per call site\n\n429 with `Retry-After` is bigger scope. Go with `[502, 503, 504]` and file the 429 work as follow-up?",
      "ref": { "file": "src/http.rs", "line": 120 } }
  ]
}
```

The review and walkthrough patterns below stay tighter — one
observation per step, plain `say` strings, no need for the dense
multi-section structure that planning warrants.

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
