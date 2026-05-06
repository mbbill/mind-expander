# AI Development Guide for mind-expander

This document is for future AI coding sessions working on `tools/mind-expander`.
It is not user documentation. Read it before changing the viewer or extractor.

## Mission and Constraints

`mind-expander` extracts factual Rust ownership/reference data and renders it as an
interactive diagram. The tool surfaces facts; it must not invent architectural
labels or interpretations. Keep the existing discipline from `mind-expander.md`:

- Facts only, no semantic labels like "hub", "core", or "pipeline".
- Drift is computed from ownership/use edges and the LCA rule. Do not add
  carveouts for "library-shaped" or "API-shaped" types.
- Modules are API boundaries. `pub` does not excuse misplaced ownership.
- Tests modules are excluded.
- Keep viewer analysis pure: no DOM, no D3, no mutated domain nodes.

The user iterates visually. Prefer small slices with checks after each slice.
When a UI change is involved, run the dev server and inspect the browser if
possible; tests do not prove the interaction feels right.

## Project Shape

- `src/`: Rust extractor and console analysis.
- `viewer/`: TypeScript + D3 + SVG viewer.
- `viewer/data/facts.json`: cached extractor output consumed by the viewer.
- `src/model.rs`: canonical JSON schema.
- `viewer/src/data/schema.ts`: hand-maintained TypeScript slice of the schema.
- `viewer/src/analysis/`: pure data transforms and layout.
- `viewer/src/view/`: D3/SVG rendering and interaction helpers.
- `viewer/src/main.ts`: orchestration, state transitions, keyboard/input mode.

Useful commands from `tools/mind-expander/viewer`:

```bash
npm run dev
npm run lint
npm run typecheck
npm run test
npm run test -- layout.test.ts arrow_invariants.test.ts arrow_hit.test.ts
```

The full `arrow_invariants.test.ts` path is intentionally slow because it
loads the dense `sf-nano-core` case. Run it after routing/layout changes.

## Viewer Data Flow

`main.ts` loads `facts.json`, builds a static module tree, derives ownership
and drift indexes, then renders one crate at a time.

Core pipeline:

1. `loadFacts` validates JSON.
2. `buildModuleTree` creates module/type nodes and re-export ghost rows.
3. `buildOwnershipIndex` extracts structural ownership and method references.
4. `computeDrift` classifies canonical vs drift placement.
5. `computeOwnershipDepth` computes rank/depth from canonical ownership.
6. `buildOptimizedLayout` creates `Layout`.
7. `renderTree` translates `Layout` to persistent SVG with D3 joins.

View state is `ViewState`, keyed by stable ids. Do not store expansion or UI
state on domain objects. `main.ts` keeps per-crate state: expanded ids,
selected field/method rows, ghost arrows shown, method arrows shown, focus
mode, and method visibility.

## Layout Model

The current layout is not a classic global-column Sugiyama layout. It uses
rank for ordering but not for a globally fixed x-position.

Important rules:

- `TypeBox.col` is rank metadata only.
- Function groups use column `0`.
- Real types use columns `1 + ownershipDepth`.
- Re-export ghosts inherit the canonical target's rank/depth metadata.
- Actual `TypeBox.x` comes from weighted longest-path placement over visible
  ownership paths, so unrelated branches do not pay for a heavy sibling's
  width or traffic.
- If two branches have equal width/traffic profiles they align naturally; if
  one branch is wider/heavier, only that branch spreads out.

Rows are packed per module band. Expanded types take header + field/method
rows; collapsed types take one row. Packing tries to keep content dense while
respecting collisions and row stability anchors so expanding one type does not
unnecessarily pull neighboring rows upward.

Root/top-level crowded modules may shelf-wrap. Do not force all root-level
types into one column if that wastes screen space.

## Routing Model

Arrows are orthogonal polylines. The renderer only draws waypoints emitted by
layout; routing decisions belong in `analysis/layout.ts`.

Current edge categories:

- `ownership`: structural field/enum/union ownership.
- `method`: references from expanded method rows, neutral grey/dashed.
- `reexport`: violet dashed ghost-to-canonical arrows, off by default per
  ghost until toggled.

Routing principles from the recent work:

- Forward/canonical ownership should generally flow left-to-right.
- Backward/return segments are forbidden by invariant tests in the fully
  expanded `sf-nano-core` case.
- Re-export arrows must leave from the side that matches their travel
  direction. Do not let a right-going arrow leave from the left side and cut
  through the label.
- Arrows should not cut through text. The viewer also applies a white text
  halo in CSS, but routing should still avoid element interiors where possible.
- Field arrow sources use measured field-name width (`arrowSourceX`), not
  fixed character counts, so arrows start after the rendered label.
- Method buckets and method rows are included in layout widths and routing.
  Do not route method/function-group arrows through the space occupied by
  long function names.
- Drift/non-placement ownership arrows may share left rails; this is expected
  for dense "return" relations. Canonical forward arrows should remain more
  legible.

Tests that pin routing behavior live mostly in `viewer/tests/layout.test.ts`
and `viewer/tests/arrow_invariants.test.ts`. If a visual routing change is
made, add or update a targeted test before relying on screenshots.

## Rendering Model

`viewer/src/view/tree.ts` renders a two-layer SVG:

- `zoomLayer`: types, fields, arrows; full transform.
- `frozenLayer`: module tree; vertical transform only, locked horizontally.

The renderer uses persistent D3 joins and stable keys. This matters because
layout transitions are animated; avoid wholesale DOM rebuilds unless the
existing join structure cannot represent the feature.

Arrow clicking uses a wide transparent `path.hit` plus
`analysis/arrow_hit.ts`. If multiple arrows are close, `arrow_disambig.ts`
shows a popover. Clicking an arrow body navigates to target; clicking near the
head navigates back toward the source.

Owner popovers are screen-space DOM (`owners_overlay.ts`) and reposition on
pan/zoom while pinned. They are not children of the zoom layer.

The minimap (`view/minimap.ts`) is a separate small SVG in the top-right stack.
It renders modules/types plus the current viewport. Clicking/dragging it
recenters the main canvas.

## Input and Top-Right Controls

Top-right controls are vertically stacked and right-aligned:

1. crate selector
2. minimap, collapsible
3. settings hamburger
4. `?` legend/shortcut panel

Settings currently contain input mode:

- macOS defaults to `trackpad` mode; other platforms default to `mouse`.
- The user override is saved in `localStorage` under `mind-expander.input-mode`.
- Settings panel expansion is saved in `sessionStorage`.

Input behavior:

- Mouse mode: wheel zooms; right-button drag pans the viewport.
- Trackpad mode: two-finger scroll pans; `Shift` + two-finger scroll zooms.
- `Ctrl` + wheel is still allowed to zoom to avoid blocking browser pinch
  events that appear as ctrl-wheel.
- Left-button drag is still d3's normal "grab canvas" drag.
- Right-button viewport pan uses viewport semantics: moving right/down reveals
  content to the right/down, so the canvas transform moves left/up.

Do not reintroduce Space/pointer-lock panning without discussing it. It was
tried and had browser/trackpad edge cases. The chosen model is settings-based.

## Interaction Details

Keyboard:

- `F`: focus mode, render-time filter around selected/expanded relevance.
- `M`: toggle method rows/arrows globally.
- `S`: reset scale to 100%.
- `R`: reset expansion/selection/focus/methods/zoom.
- `?`: toggle legend/shortcuts.

Clicks:

- Module/type row: toggle expansion.
- Type dot: owner expansion/popover behavior.
- Ghost row/dot: toggle the violet re-export arrow.
- Field/method row: select row and show its arrow chain.
- Method arrows are opt-in per method row to avoid visual overload.

Focus mode uses anchoring logic in `main.ts` so toggling focus keeps a visible
selected/expanded item under the same screen y when possible. If you change
layout y behavior, check focus toggling visually.

## Common Pitfalls

- Do not conflate rank with x-position. `col` is metadata; `x` is computed.
- Do not size gutters globally by rank/column. That recreates the old bug where
  a heavy branch pulls unrelated short branches apart.
- Do not count every edge in every gutter it spans. Each edge picks exactly one
  routing channel where applicable.
- Do not add "special case" routing that fixes one screenshot but violates
  arrow invariants. Add a small layout test for the new rule.
- Be careful with source/target side selection. An arrow that starts on the
  right should initially move right; an arrow that starts on the left should
  initially move left.
- Text width matters. Use the existing `measureText` plumbing when endpoint
  placement depends on rendered labels.
- `facts.json` is large and mutable. Do not hand-edit it for tests; create
  small in-memory crate facts in tests unless the invariant test explicitly
  uses the real dataset.
- This repo may have staged "known good" changes and unstaged experimental
  changes. Inspect `git status` before editing and do not revert user work.

## Where to Add Things

- Pure graph/layout logic: `viewer/src/analysis/*.ts`.
- D3 drawing or SVG geometry: `viewer/src/view/*.ts`.
- Cross-cutting UI state/keyboard/input: `viewer/src/main.ts`.
- Static control structure/CSS: `viewer/index.html`.
- Schema additions: update Rust `src/model.rs` first, then the TS schema slice.
- Tests for layout/routing: `viewer/tests/layout.test.ts`.
- Dense real-world arrow invariants: `viewer/tests/arrow_invariants.test.ts`.

## Review Checklist Before Finishing

Run at least:

```bash
npm run lint
npm run typecheck
```

For layout, routing, arrows, or interaction state changes also run:

```bash
npm run test -- layout.test.ts arrow_invariants.test.ts arrow_hit.test.ts
```

For broad viewer changes run:

```bash
npm run test
```

If the change is visual or interaction-heavy, start or reuse the dev server and
verify in the browser. In recent sessions the dev server commonly runs at
`http://127.0.0.1:5173/`, but do not assume it is alive; check first.
