// Two-area renderer: module tree floats as a transparent overlay on the left,
// per-module type bands fill the canvas on the right. Layout is precomputed
// by layout; this module translates Layout objects into SVG and wires click
// handlers. There is no opaque pane between the two — module labels overlay
// the diagram and rely on a white text halo for legibility where they cross
// type content.
//
// Rendering uses a persistent DOM with d3 data-join and stable keys so that
// elements existing in both the previous and current render *tween* between
// their old and new positions instead of being wiped and rebuilt. This is
// what powers the smooth focus-mode toggle animation. Elements that appear
// fade in; elements that disappear fade out before removal.

import { type Selection, pointer, select } from 'd3';
import { type ArrowHit, pickArrowsAtPoint } from '../analysis/arrow_hit.ts';
import { type BorrowFlavor, borrowFlavor } from '../analysis/borrow_flavor.ts';
import type { DriftClass } from '../analysis/drift.ts';
import {
  BASE_FONT_SIZE,
  DRIFT_DOT_OFFSET,
  DRIFT_DOT_RADIUS,
  FIELD_ROW_H,
  HIT_MIN_W,
  INCOMING_CALL_MARKER_OFFSET,
  KIND_MARKER_FONT_SIZE,
  KIND_MARKER_X,
  LAYOUT_GRID_CELL_W,
  MODULE_LABEL_X,
  TYPE_EXPAND_ARROW_CLOSED,
  TYPE_EXPAND_ARROW_FONT_SIZE,
  TYPE_EXPAND_ARROW_OPEN,
  TYPE_LABEL_FONT_SIZE,
  TYPE_LABEL_X,
  moduleLeafLabel,
} from '../analysis/layout_metrics.ts';
import { type Layout, ROW_H } from '../analysis/layout_model.ts';
import type { OwnershipIndex } from '../analysis/ownership.ts';
import { LOCALITY_GLYPH } from '../layout/geometry.ts';
import { colorForVisibility } from './encoding.ts';
import { ANIM_MS, type ZoomLayers } from './zoom.ts';

// Screen-space hit tolerance for arrow click navigation. Converted to
// data-space by dividing by the current zoom scale, so the on-screen hit
// area stays roughly constant regardless of zoom level. The zone split
// (first half / second half of arc length) lives in `arrow_hit.ts` and
// doesn't need a separate threshold.
const ARROW_HIT_PX = 8;

// Module rows still use a left chevron for expand/collapse.
const CHEVRON_X = 6;
// KIND_MARKER_X / KIND_MARKER_FONT_SIZE describe the bold uppercase
// kind letter (S/E/U/T/A/F) at the type-box header. They live in
// analysis/layout_metrics so layout can derive a type's content inset
// (visible-ink left edge) from the same numbers the renderer paints
// with — a single source of truth across producer and consumer.
// Header-click hit rect starts past the marker so the marker owns its
// own pointer events without depending on DOM paint order.
const HEADER_HIT_X = 20;
// Hover-revealed owner-count badge floats just outside the row's left
// edge — anchored end, so its right edge sits at this x.
const OWNER_COUNT_BADGE_X = -2;

// Exported so other modules (e.g. the canvas-backed text measurer) can
// match the rendered font exactly. Keep these in sync with the SVG.
export const FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const FONT_SIZE = BASE_FONT_SIZE;
export const FONT_SIZE_FIELD = BASE_FONT_SIZE;
// Module leaf and type header bumped slightly above the base so the
// "main thing on this row" reads more prominently than ancillary text.
// Stays within the grid-derived band height — at 14px the
// cap-height plus descender comfortably fits.
const FONT_SIZE_MODULE_LEAF = 14;
// Crate names sit one tier above plain modules in the hierarchy. Slightly
// bigger leaf type + bold + their own band-background tint visually
// separate them from the chip-style module rows below. Kept modest so a
// crate name doesn't dominate the canvas next to its module chips.
const FONT_SIZE_CRATE_LEAF = 15;
const FONT_SIZE_MODULE_PREFIX = 12; // base size — bumped to read clearly when the label sits over diagram content
const FONT_SIZE_MODULE_CHEVRON = 14; // bumped above the base + bold so the
// "+/-" expand affordance reads clearly without changing direction-neutral
// semantics (modules expand both vertically and horizontally).

const COLOR_LABEL = '#1e293b';
// Crate-tier label sits one shade lighter than COLOR_LABEL so bold +
// near-black doesn't shout under the slate-200 crate band tint. Stops
// short of slate-600 (which is the dimmed module-prefix grey) so crate
// headers stay heavier than the modules they group.
const COLOR_CRATE_LABEL = '#334155';
const COLOR_MODULE_PREFIX = '#475569'; // slate-600, dark grey for the dimmed parent path

// Pastel palette for the per-segment chip colours behind the dimmed prefix.
// Each ancestor name (`vm`, `middle`, `ssa_ir`, ...) hashes into one slot so
// adjacent rows that share a parent share a colour. Tints are light enough
// for the slate-600 prefix text to stay readable.
const SEGMENT_PALETTE: readonly string[] = [
  '#99f6e4', // teal-200
  '#bae6fd', // sky-200
  '#c7d2fe', // indigo-200
  '#ddd6fe', // violet-200
  '#fbcfe8', // pink-200
  '#a7f3d0', // emerald-200
  '#fde68a', // amber-200
  '#fecdd3', // rose-200
];

function colorForSegment(name: string): string {
  // djb2-style hash; we only need stable distribution across the palette.
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h) ^ name.charCodeAt(i);
  const idx = (h >>> 0) % SEGMENT_PALETTE.length;
  return SEGMENT_PALETTE[idx] ?? SEGMENT_PALETTE[0] ?? '#e2e8f0';
}
const COLOR_CHEVRON = '#94a3b8';
// `+` (expand) reads as add → green; `-` (collapse) reads as remove → red.
// Colours match the visibility legend swatches used elsewhere in the UI.
const COLOR_CHEVRON_EXPAND = '#22c55e'; // green-500
const COLOR_CHEVRON_COLLAPSE = '#ef4444'; // red-500
const COLOR_FIELD_NAME = '#334155';
const COLOR_FIELD_TY = '#94a3b8'; // slate-400, grey for the on-hover type hint
// Ownership-flavor palette for signature rows. Encodes how a parameter or
// return crosses the function boundary. Moves are the common case in
// idiomatic Rust signatures, so they render in the same neutral grey as
// non-signature type hints — the eye scans past them. Borrows are the
// interesting non-default case (caller retains ownership), so they get a
// hue shift: orange for shared, violet for exclusive mutation.
const COLOR_BORROW_MOVE = COLOR_FIELD_TY; // neutral grey: the common baseline
const COLOR_BORROW_SHARED = '#c2410c'; // orange-700: temporary read-only handoff
const COLOR_BORROW_MUT = '#7c3aed'; // violet-600: exclusive write borrow
const COLOR_BORROW_RAW = '#dc2626'; // red-600: unsafe raw pointer

function borrowFlavorColor(flavor: BorrowFlavor): string {
  switch (flavor) {
    case 'move':
      return COLOR_BORROW_MOVE;
    case 'shared':
      return COLOR_BORROW_SHARED;
    case 'mut':
      return COLOR_BORROW_MUT;
    case 'raw':
      return COLOR_BORROW_RAW;
  }
}

// Callable rows expose the receiver's ownership flavor via the name color
// — no need to expand the signature to tell `&self` from `&mut self`.
// Free / associated fns and consuming `self` methods fall through to
// 'move' (neutral grey), the common-case baseline.
function selfKindFlavor(
  selfKind: FieldRowLike['selfKind'] | undefined,
): BorrowFlavor {
  switch (selfKind) {
    case 'ref':
      return 'shared';
    case 'ref_mut':
      return 'mut';
    case 'by_value':
    case 'none':
    case undefined:
      return 'move';
  }
}

// Locality indicator color for the `→` glyph after `(..)`. Blue for
// cross-module, orange for unresolved, grey for local-only — the same
// three buckets the call-arrow stroke uses, so a row's `→` and its
// outgoing arrows agree on color.
function localityGlyphColor(row: {
  readonly hasExternalCalls?: boolean;
  readonly hasUnresolvedCalls?: boolean;
}): string {
  if (row.hasExternalCalls === true) return '#2563eb';
  if (row.hasUnresolvedCalls === true) return '#f97316';
  return COLOR_FIELD_TY;
}

// Drift dot color for field rows. Canonical placements (at_lca,
// within_budget) get no dot — the absence is the signal "this row is
// where structural ownership expected it". Drifted placements get a
// small colored circle to the left of the field name.
function driftDotColor(driftClass: DriftClass | null | undefined): string | null {
  switch (driftClass) {
    case 'drift_below':
      return COLOR_MEMBER_DRIFT_BELOW;
    case 'drift_above':
    case 'drift_sideways':
      return COLOR_ARROW_HARD;
    default:
      return null;
  }
}

type FieldRowLike = Layout['types'][number]['fields'][number];
const TY_HIDE_DELAY = 0; // ms — type-hint hides immediately on mouse-out (only the 200ms fade-out transition still plays)
const TY_TEXT_GAP = 4;
const TY_BG_PAD_X = 4;
const TY_BG_PAD_Y = 2;
const COLOR_TY_BG = '#ffffff';
const DEBUG_PANEL_MARGIN = 8;
const CALLABLE_DEBUG_MAX_CALLS = 24;
const METHOD_BUCKET_CHEVRON_OFFSET = 12;
const METHOD_BUCKET_CHEVRON_FONT_SIZE = 14;
const INCOMING_CALL_MARKER_FONT_SIZE = 11;
// On hover the call markers grow to draw attention to the affordance
// and to expose the call count alongside. The non-hover size is the
// canonical row metric so click hit areas stay predictable.
const CALL_MARKER_HOVER_FONT_SIZE = 14;
const CALL_MARKER_HOVER_DURATION_MS = 80;
// Gap between a hover count badge `(N)` and its anchor glyph.
const CALL_COUNT_BADGE_GAP = 4;
const COLOR_ARROW_CANONICAL = '#94a3b8'; // slate-400: at_lca / within_budget — neutral context
// Highlighted-canonical color (#3b82f6 blue) is applied via CSS in
// index.html (`.canonical.highlighted { stroke: ... }`) so the marker
// arrowhead can pick it up via context-stroke without per-state JS.
const COLOR_ARROW_SOFT = '#f59e0b'; // amber: drift_below
const COLOR_ARROW_HARD = '#ef4444'; // red:   drift_above / drift_sideways
const COLOR_MEMBER_DRIFT_BELOW = '#d97706'; // amber-600: drift_below dot color
// Re-exports get their own dedicated color and dashed style so they read
// as a separate edge category — they're not ownership, they're naming.
// The violet stroke alone is enough identity, so re-exports can afford
// the subtler short-symmetric pattern.
const COLOR_ARROW_REEXPORT = '#a855f7'; // violet-500
// Blue for cross-module call arrows. Matches the locality-glyph color
// for rows that have any external outgoing call, so a row's `→` indicator
// and its outgoing arrows render in the same blue.
const COLOR_CALL_EXTERNAL = '#2563eb';
const REEXPORT_DASH = '2 2';
// Method-reference arrows show up far more often than re-exports and
// render in plain canonical grey, so they need the higher pixel
// density to actually read against the canvas tint. Asymmetric
// pattern keeps them rhythmically distinct from re-export's symmetric
// short dashes. Saves animation for a future data-flow layer.
const METHOD_DASH = '4 3';
// Cross-crate arrows: a Morse-code style dash-dot-dot pattern. Reads as
// "boundary-crossing" without competing with the call/reexport dash
// rhythms. Same stroke color as intra-crate — the user's color logic
// (canonical / drift / locality) keeps applying.
const CROSS_CRATE_DASH = '6 2 1 2 1 2';

const ARROW_MARKER_IDS: Readonly<Record<DriftClass, string>> = {
  at_lca: 'sf-arrow-canonical',
  within_budget: 'sf-arrow-canonical',
  drift_below: 'sf-arrow-soft',
  drift_above: 'sf-arrow-hard',
  drift_sideways: 'sf-arrow-hard',
};

function arrowColor(a: Layout['arrows'][number]): string {
  if (a.kind === 'reexport') return COLOR_ARROW_REEXPORT;
  // Call arrows are colored by locality, matching the locality-glyph
  // color shown on the source row: cross-module calls draw attention in
  // blue, same-module calls recede into the canonical grey background.
  // Locality is set at routing time so the renderer doesn't recompute it.
  if (a.kind === 'call') {
    return a.locality === 'external' ? COLOR_CALL_EXTERNAL : COLOR_ARROW_CANONICAL;
  }
  const c = a.driftClass;
  if (c === 'at_lca' || c === 'within_budget') return COLOR_ARROW_CANONICAL;
  if (c === 'drift_below') return COLOR_ARROW_SOFT;
  return COLOR_ARROW_HARD;
}

/** One-character kind marker rendered to the left of the type label.
 *  Doubles as the visibility indicator: the letter itself is colored by
 *  visibility (so it replaces what the dot used to convey) and re-exports
 *  render the letter in italic (replacing the hollow-ring distinction).
 *  Bold uppercase reads as an icon rather than an abbreviation.
 *
 *  Function-groups get 'F' — their label ("pub fn (N)" / "local fn (N)")
 *  is already self-describing, but a uniform marker keeps the column
 *  visually aligned and lets one code path handle every row's marker. */
function kindMarker(d: Layout['types'][number]): string {
  switch (d.typeKind) {
    case 'struct':
      return 'S';
    case 'enum':
      return 'E';
    case 'union':
      return 'U';
    case 'trait':
      return 'T';
    case 'type_alias':
      return 'A';
    case 'function_group':
      return 'F';
  }
}

export interface TreeRenderOptions {
  /** Single-row click on a module or type → toggle expansion. Expansion is
   *  the only "focus" concept — there is no separate selected-types set. */
  readonly onToggle: (id: string) => void;
  /** Click on a sticky-breadcrumb row → pan vertically so that module's
   *  in-canvas row lands at the top of the viewport, just below any
   *  remaining sticky rows. */
  readonly onScrollToModule: (moduleId: string) => void;
  /** Cmd/Ctrl+click on a diagram element → open the code panel and
   *  scroll to that element's source span. `id` is the same form used
   *  by `onToggle`/`onSelectField`; `kind` disambiguates a struct
   *  field from a method with the same name on the same type, since
   *  both share the canonical id. */
  readonly onShowCode: (
    id: string,
    kind: 'module' | 'type' | 'field' | 'method' | 'function',
  ) => void;
  /** Click on a type header chevron → toggle expansion. Opening selects
   *  field rows by default and expands callable buckets without selecting
   *  function rows; closing deselects hidden member rows. */
  readonly onToggleTypeMembers: (typePath: string) => void;
  /** Click on a field name → toggle its selection. */
  readonly onSelectField: (typePath: string, fieldName: string, kind: FieldKeyKind) => void;
  /** Click on a function/method row's `(..)` glyph → toggle whether that
   *  function's signature is expanded into indented argument rows. */
  readonly onToggleSignature: (functionFullPath: string) => void;
  /** Click on the right `→` locality glyph of a callable row. If the
   *  callable has 0 outgoing calls, no-op. If exactly 1, toggle it
   *  directly. If 2+, the host opens the floating call-target picker
   *  fanning right from the cursor so the user picks one callee. */
  readonly onPickOutgoingCall: (
    callerFullPath: string,
    anchor: { readonly x: number; readonly y: number },
  ) => void;
  /** Symmetric for the left `→` marker — opens the picker fanning
   *  leftward (callers flow into the row from the left). */
  readonly onPickIncomingCaller: (
    calleeFullPath: string,
    anchor: { readonly x: number; readonly y: number },
  ) => void;
  /** Currently revealed per-edge call arrows. Keys are
   *  `specificCallArrowKey(caller, callee)`. The picker bolds rows
   *  whose key is in this set so the user sees current state. */
  readonly specificCallArrowsShown: ReadonlySet<string>;
  /** Union-diff side per element id, populated only in unified mode.
   *  Keys mirror `data-element-id` written by the renderer:
   *  method/function `functionFullPath`,
   *  `${typeFullPath}::${fieldName}` for struct fields. Used to
   *  paint the left-edge color bar + row tint on field-row-g
   *  groups. Only `head`/`base` are stored; `both` (regardless of
   *  body edits) is never marked — member-row bars carry structural
   *  delta only. */
  readonly sideByElementId?: ReadonlyMap<string, 'base' | 'head'>;
  /** Per-type bar state, populated only in unified mode. Keyed by
   *  type fullPath (real types) or function-group synthetic id
   *  `${moduleId}::__fn_${bucket}`. Drives the type-box's vertical
   *  bar: `add` = green full-height, `del` = red full-height,
   *  `split` = green top half + red bottom half. Absent = no bar. */
  readonly typeBarStateById?: ReadonlyMap<string, 'add' | 'del' | 'split'>;
  /** Set of "typePath::fieldName" keys currently selected. */
  readonly selectedFields: ReadonlySet<string>;
  readonly incomingCallTargetsShown: ReadonlySet<string>;
  /** Method-bucket ids (`typeFullPath::__methods_pub` etc.) currently
   *  expanded. The renderer reads this to flip a bucket header's
   *  chevron between `▸` (closed) and `▾` (open) on every redraw,
   *  including when the same bucket id appears across crate switches. */
  readonly expandedBucketIds: ReadonlySet<string>;
  /** Arrows in any selected field's chain — drawn highlighted by default. */
  readonly selectedArrows: ReadonlySet<Layout['arrows'][number]>;
  /** Static ownership index. Read by the type debug overlay to expose
   *  what the analysis says about owners/owns, so the user can compare
   *  against the routed (rendered) counts and spot routing gaps. */
  readonly ownership: OwnershipIndex;
  /** Click on a type's dot → open the owner picker for that type. The
   *  picker mirrors the call-edge picker: 0 owners no-ops, 1 owner is
   *  toggled directly, 2+ owners show a fan with show-all / hide-all
   *  controls. `anchor` is the click position in screen coords so the
   *  picker can position itself next to the dot. */
  readonly onPickOwner: (
    typePath: string,
    anchor: { readonly x: number; readonly y: number },
  ) => void;
  /** Click on a ghost re-export's dot or row → toggle whether that
   *  ghost's violet arrow is rendered. The viewer holds the toggle
   *  state per ghost id (`ghostId`); when first revealing an arrow it
   *  also expands the target's ancestors so the arrow has somewhere to
   *  end. The viewport does NOT pan — this is purely a visibility
   *  toggle, not a navigation gesture (clicking the arrow itself is
   *  what navigates, see `onArrowNavigate`). */
  readonly onFollowGhost: (ghostId: string, ghostTargetPath: string) => void;
  /** Fired when the user clicks somewhere within tolerance of one or more
   *  arrows. The renderer hands back every candidate sorted by distance,
   *  along with the screen-space anchor for any disambiguation popover.
   *  No hits → handler not called at all. */
  readonly onArrowNavigate: (hits: readonly ArrowHit[], anchor: { x: number; y: number }) => void;
  /** When the code panel is open, the host pushes the currently-shown
   *  element's canonical `(id, kind)` here so the diagram can paint a
   *  matching selection. `kind` matters because a struct field and a
   *  method on the same type can share the canonical id — only one
   *  row should light up. Both null = nothing selected. */
  readonly selectedElementId: string | null;
  readonly selectedElementKind:
    | 'module'
    | 'type'
    | 'field'
    | 'method'
    | 'function'
    | null;
}

// Separator for fieldKey. We can't use `::` because both parts may
// contain it: typePath has it as the module separator, and field names
// for enum variant payloads are encoded as `Variant::payload` (e.g.
// `Global::.0`). ASCII unit-separator (\x1F) is reserved for exactly
// this kind of structural delimiter and never appears in identifiers
// or extractor output.
const FIELD_KEY_SEP = '\x1F';
let callableDebugHideTimer: number | undefined;

// Selection matching. The host pushes a canonical `(id, kind)` pair
// and the renderer asks two questions per draw: (1) does this row
// represent that element? (2) does this type-box contain that
// element? Centralising the matcher means types, fields, methods,
// and free functions all resolve through the same logic. `kind`
// matters because Rust allows a field and a method to share a name
// on the same type — both have the same canonical id; only one row
// should be highlighted.
type SelectedKind = 'module' | 'type' | 'field' | 'method' | 'function';
function rowMatchesSelection(
  type: Layout['types'][number],
  row: Layout['types'][number]['fields'][number],
  selectedId: string,
  selectedKind: SelectedKind,
): boolean {
  if (row.kind === 'method_bucket' || row.kind === 'signature_arg') return false;
  if (selectedKind === 'method' || selectedKind === 'function') {
    if (row.kind !== 'method' && row.kind !== 'function') return false;
    return row.functionFullPath === selectedId;
  }
  if (selectedKind === 'field') {
    if (row.kind !== 'field') return false;
    return `${type.fullPath}::${row.name}` === selectedId;
  }
  // Selected kind is 'type': a type-box matches by id; no individual
  // row should light up.
  return false;
}

function typeMatchesSelection(
  type: Layout['types'][number],
  selectedId: string,
  selectedKind: SelectedKind,
): boolean {
  if (selectedKind === 'type' && type.fullPath === selectedId) return true;
  return type.fields.some((row) =>
    rowMatchesSelection(type, row, selectedId, selectedKind),
  );
}

/** Row-kind half of a fieldKey. Fields, methods, and free-function rows can
 *  share labels inside different row groups, so the selection key needs both
 *  `(typePath, name)` AND the kind. */
export type FieldKeyKind = 'field' | 'method' | 'function';

export function fieldKey(
  typePath: string,
  fieldName: string,
  kind: FieldKeyKind = 'field',
): string {
  return `${typePath}${FIELD_KEY_SEP}${kind}${FIELD_KEY_SEP}${fieldName}`;
}

export function parseFieldKey(key: string): {
  typePath: string;
  kind: FieldKeyKind;
  fieldName: string;
} {
  const parts = key.split(FIELD_KEY_SEP);
  // 3-part key: typePath, kind, fieldName.
  if (
    parts.length >= 3 &&
    (parts[1] === 'field' || parts[1] === 'method' || parts[1] === 'function')
  ) {
    return {
      typePath: parts[0] ?? '',
      kind: parts[1] as FieldKeyKind,
      fieldName: parts.slice(2).join(FIELD_KEY_SEP),
    };
  }
  // Defensive fallback for any 2-part key that slipped through —
  // assume field. Real callers always go through the 3-part shape now.
  return {
    typePath: parts[0] ?? '',
    kind: 'field',
    fieldName: parts.slice(1).join(FIELD_KEY_SEP),
  };
}

export function directArrowsFromMany(
  layout: Layout,
  fields: ReadonlyArray<{ typePath: string; fieldName: string; kind: FieldKeyKind }>,
): Set<Layout['arrows'][number]> {
  const out = new Set<Layout['arrows'][number]>();
  for (const f of fields) {
    const direct = directArrowsFrom(layout, f.typePath, f.fieldName, f.kind);
    for (const a of direct) out.add(a);
  }
  return out;
}

export function renderTree(layers: ZoomLayers, layout: Layout, opts: TreeRenderOptions): void {
  const zoomLayer = select(layers.zoomLayer);
  const frozenLayer = select(layers.frozenLayer);

  zoomLayer.attr('font-family', FONT_FAMILY);
  frozenLayer.attr('font-family', FONT_FAMILY);
  ensureArrowMarker(zoomLayer);

  // Persistent parent groups — ensured once, then re-used across renders so
  // children with stable keys can tween rather than be wiped + rebuilt.
  const bandG = ensureGroup(zoomLayer, 'band-bg');
  const debugG = ensureGroup(zoomLayer, 'layout-debug');
  const arrowG = ensureGroup(zoomLayer, 'arrows');
  arrowG.attr('fill', 'none').attr('stroke-width', 1);
  const typeG = ensureGroup(zoomLayer, 'types');

  renderBandBackgrounds(bandG, layout);
  renderLayoutDebug(debugG, layout);
  if (!layoutDebugEnabled()) hideCallableDebugPanelNow();
  renderArrows(arrowG, layout, opts.selectedArrows);
  renderTypes(typeG, zoomLayer, layout, opts);
  // Module column is rendered as HTML in html_tree.ts; nothing to do
  // here for the SVG module overlay anymore.
  installArrowClickHandler(layers, layout, opts);
}

function renderLayoutDebug(
  g: Selection<SVGGElement, unknown, null, undefined>,
  layout: Layout,
): void {
  if (!layoutDebugEnabled() || layout.debug === undefined) {
    g.selectAll('*').remove();
    return;
  }

  g.attr('pointer-events', 'none');
  const routing = layout.debug.routing;

  renderDebugGrid(g, routing.layoutGrid);

  const obstacleSel = g
    .selectAll<SVGRectElement, (typeof routing.obstacles)[number]>('rect.debug-obstacle')
    .data(routing.obstacles, (d) => `${d.left}:${d.right}:${d.top}:${d.bottom}`);
  obstacleSel.exit().remove();
  obstacleSel
    .enter()
    .append('rect')
    .attr('class', 'debug-obstacle')
    .attr('fill', 'rgba(249,115,22,0.07)')
    .attr('stroke', '#f97316')
    .attr('stroke-width', 0.75)
    .attr('stroke-dasharray', '3 2')
    .merge(obstacleSel)
    .attr('x', (d) => d.left)
    .attr('y', (d) => d.top)
    .attr('width', (d) => d.right - d.left)
    .attr('height', (d) => d.bottom - d.top);

  const labels = routing.layoutLabels ?? [];
  const labelSel = g
    .selectAll<SVGTextElement, (typeof labels)[number]>('text.debug-layout-label')
    .data(labels, (d) => d.id);
  labelSel.exit().remove();
  labelSel
    .enter()
    .append('text')
    .attr('class', 'debug-layout-label')
    .attr('font-size', 10)
    .attr('fill', '#6d28d9')
    .attr('stroke', 'white')
    .attr('stroke-width', 3)
    .attr('paint-order', 'stroke fill')
    .attr('text-anchor', 'end')
    .merge(labelSel)
    .attr('x', (d) => d.x)
    .attr('y', (d) => d.y)
    .text((d) => d.label);
}

const DEBUG_GRID_PATTERN_ID = 'mind-expander-debug-grid-pattern';
const DEBUG_GRID_DOT_R = 0.55;
const DEBUG_GRID_DOT_OPACITY = 0.25;

function renderDebugGrid(
  g: Selection<SVGGElement, unknown, null, undefined>,
  grid: NonNullable<Layout['debug']>['routing']['layoutGrid'] | undefined,
): void {
  renderDebugGridPattern(g, grid);

  const rectSel = g
    .selectAll<SVGRectElement, DebugLayoutGrid>('rect.debug-grid')
    .data(
      grid === undefined ? [] : [grid],
      (d) => `${d.originX}:${d.originY}:${d.cellWidth}:${d.cellHeight}:${d.width}:${d.height}`,
    );
  rectSel.exit().remove();
  rectSel
    .enter()
    .append('rect')
    .attr('class', 'debug-grid')
    .attr('pointer-events', 'none')
    .attr('fill', `url(#${DEBUG_GRID_PATTERN_ID})`)
    .merge(rectSel)
    .attr('x', (d) => d.originX)
    .attr('y', (d) => d.originY)
    .attr('width', (d) => d.width)
    .attr('height', (d) => d.height)
    .lower();
}

type DebugLayoutGrid = NonNullable<NonNullable<Layout['debug']>['routing']['layoutGrid']>;

export function debugGridPatternTile(grid: DebugLayoutGrid): {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
} {
  return {
    x: grid.originX,
    y: grid.originY,
    width: grid.cellWidth,
    height: grid.cellHeight,
  };
}

export function fieldRowDisplayParts(
  row: Pick<Layout['types'][number]['fields'][number], 'kind' | 'name' | 'bucketId'>,
  expandedBucketIds: ReadonlySet<string>,
): { readonly label: string; readonly chevron: string | null } {
  if (row.kind !== 'method_bucket') return { label: row.name, chevron: null };

  // Bucket chevrons are rendered as a separate affordance before the label.
  // Keeping the label text as exactly `pub fn (...)` aligns it with normal
  // member rows and keeps layout's measured row width honest.
  const open = row.bucketId !== null && expandedBucketIds.has(row.bucketId);
  return { label: row.name, chevron: open ? '▾' : '▸' };
}

function renderDebugGridPattern(
  g: Selection<SVGGElement, unknown, null, undefined>,
  grid: DebugLayoutGrid | undefined,
): void {
  const defs = ensureDebugDefs(g);
  const patternSel = defs
    .selectAll<SVGPatternElement, DebugLayoutGrid>(`pattern#${DEBUG_GRID_PATTERN_ID}`)
    .data(grid === undefined ? [] : [grid]);
  patternSel.exit().remove();

  const patternEnter = patternSel
    .enter()
    .append('pattern')
    .attr('id', DEBUG_GRID_PATTERN_ID)
    .attr('patternUnits', 'userSpaceOnUse');

  const merged = patternEnter.merge(patternSel);
  if (grid !== undefined) {
    const tile = debugGridPatternTile(grid);
    merged
      .attr('x', tile.x)
      .attr('y', tile.y)
      .attr('width', tile.width)
      .attr('height', tile.height);
  }
  merged.each(function (d) {
    const dotSel = select(this)
      .selectAll<SVGCircleElement, { readonly x: number; readonly y: number }>(
        'circle.debug-grid-pattern-dot',
      )
      .data(debugGridPatternCornerDots(d));
    dotSel.exit().remove();
    dotSel
      .enter()
      .append('circle')
      .attr('class', 'debug-grid-pattern-dot')
      .attr('r', DEBUG_GRID_DOT_R)
      .attr('fill', '#64748b')
      .attr('opacity', DEBUG_GRID_DOT_OPACITY)
      .merge(dotSel)
      .attr('cx', (dot) => dot.x)
      .attr('cy', (dot) => dot.y);
  });
}

function ensureDebugDefs(
  g: Selection<SVGGElement, unknown, null, undefined>,
): Selection<SVGDefsElement, unknown, null, undefined> {
  let defs = g.select<SVGDefsElement>('defs.debug-defs');
  if (defs.empty()) {
    defs = g.append('defs').attr('class', 'debug-defs');
  }
  return defs;
}

function debugGridPatternCornerDots(
  grid: DebugLayoutGrid,
): readonly { readonly x: number; readonly y: number }[] {
  // SVG patterns clip each tile. Drawing all four tile corners makes each
  // repeated grid intersection render as a full dot while still using a
  // single pattern-filled rect instead of per-grid-point DOM nodes.
  return [
    { x: 0, y: 0 },
    { x: grid.cellWidth, y: 0 },
    { x: 0, y: grid.cellHeight },
    { x: grid.cellWidth, y: grid.cellHeight },
  ];
}

export const LAYOUT_DEBUG_STORAGE_KEY = 'mind-expander:debugLayout';

export function layoutDebugEnabled(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    const stored = window.localStorage.getItem(LAYOUT_DEBUG_STORAGE_KEY);
    if (stored === '1') return true;
    if (stored === '0') return false;
    return params.has('debugLayout');
  } catch {
    return false;
  }
}

/**
 * Install (or refresh) a single click handler on the zoom layer that runs
 * arrow hit-testing for every click. Inner handlers (modules, types,
 * fields, dots) call `event.stopPropagation()` already, so clicks on those
 * don't reach this listener — only "empty area" clicks do, which is the
 * surface where the user could plausibly mean "click this arrow".
 *
 * `.on('click.arrow-nav', ...)` namespaces the handler so each call REPLACES
 * the previous one rather than stacking, even though we re-render the
 * tree on every state change.
 */
function installArrowClickHandler(
  layers: ZoomLayers,
  layout: Layout,
  opts: TreeRenderOptions,
): void {
  const zoomLayer = select(layers.zoomLayer);
  // (svgEl access not needed — k is read via layers.getTransform())
  zoomLayer.on('click.arrow-nav', (event: MouseEvent) => {
    // pointer(event, container) returns the click in `container`'s local
    // coords — for the zoom layer that IS data-space, since the layer
    // itself carries the zoom transform.
    const [x, y] = pointer(event, layers.zoomLayer);
    const k = layers.getTransform().k || 1;
    const hits = pickArrowsAtPoint({ x, y }, hitTestableArrows(layout), {
      hitTolerance: ARROW_HIT_PX / k,
    });
    if (hits.length === 0) return;
    event.stopPropagation();
    opts.onArrowNavigate(hits, { x: event.clientX, y: event.clientY });
  });
}

function ensureGroup(
  parent: Selection<SVGGElement, unknown, null, undefined>,
  className: string,
): Selection<SVGGElement, unknown, null, undefined> {
  let g = parent.select<SVGGElement>(`g.${className}`);
  if (g.empty()) g = parent.append('g').attr('class', className);
  return g;
}

// Band backgrounds — a modern white theme. Crate-tier rows render on
// near-white with a subtle off-white module stripe; the section break
// reads via the hairline divider drawn between adjacent crate rows
// rather than a darker tint. Sub-modules use the lighter stripe to
// trace types back to their module without competing with the crate
// boundary visually.
const COLOR_BAND_BG_MODULE = '#fafbfc'; // near-white wash for sub-module stripes
const COLOR_BAND_BG_CRATE = '#ffffff'; // pure white for crate-tier rows
const COLOR_BAND_DIVIDER = '#e5e7eb'; // slate-200 — hairline rule between crates
const BAND_DIVIDER_HEIGHT = 1;

function renderBandBackgrounds(
  g: Selection<SVGGElement, unknown, null, undefined>,
  layout: Layout,
): void {
  // Build a per-band fill: always tint crate bands; among module-tier
  // bands, tint every other one. Drawn first so types and arrows paint
  // on top; rect stretched far past the visible viewport so panning
  // never reveals an unfilled edge.
  const tinted: { row: Layout['modules'][number]; fill: string }[] = [];
  let moduleAlternation = 0;
  for (const m of layout.modules) {
    if (m.modDepth === 0) {
      tinted.push({ row: m, fill: COLOR_BAND_BG_CRATE });
      moduleAlternation = 0; // reset stripe phase under each crate so
      // submodule bands always start un-tinted next to the crate header
    } else {
      moduleAlternation += 1;
      if (moduleAlternation % 2 === 0) tinted.push({ row: m, fill: COLOR_BAND_BG_MODULE });
    }
  }
  // Layer 1: tinted background rects.
  const bgGroup = ensureGroup(g, 'band-bg-fills');
  const sel = bgGroup
    .selectAll<SVGRectElement, { row: Layout['modules'][number]; fill: string }>('rect')
    .data(tinted, (entry) => entry.row.id);
  sel.exit().transition('exit').duration(ANIM_MS).style('opacity', 0).remove();
  const enter = sel
    .enter()
    .append('rect')
    .attr('x', -10000)
    .attr('y', (entry) => entry.row.y)
    .attr('width', 20000)
    .attr('height', (entry) => entry.row.bandHeight)
    .attr('fill', (entry) => entry.fill)
    .style('opacity', 0);
  enter.transition('enter').duration(ANIM_MS).style('opacity', 1);
  sel
    .attr('fill', (entry) => entry.fill)
    .transition('move')
    .duration(ANIM_MS)
    .attr('y', (entry) => entry.row.y)
    .attr('height', (entry) => entry.row.bandHeight);

  // Layer 2: hairline dividers ONLY between adjacent crate-tier bands.
  // Module-tier bands already separate via their alternating slate/white
  // stripes; crates share the slate-200 tint and would blend without an
  // explicit line. Anchor each divider on the LOWER crate band's id so
  // d3's data-join keeps the same DOM element when crates re-order.
  const dividers: { id: string; y: number }[] = [];
  for (let i = 1; i < layout.modules.length; i++) {
    const prev = layout.modules[i - 1];
    const cur = layout.modules[i];
    if (prev !== undefined && cur !== undefined && prev.modDepth === 0 && cur.modDepth === 0) {
      dividers.push({ id: cur.id, y: cur.y });
    }
  }
  const dividerGroup = ensureGroup(g, 'band-dividers');
  const divSel = dividerGroup
    .selectAll<SVGRectElement, { id: string; y: number }>('rect')
    .data(dividers, (d) => d.id);
  divSel.exit().remove();
  const divEnter = divSel
    .enter()
    .append('rect')
    .attr('x', -10000)
    .attr('width', 20000)
    .attr('height', BAND_DIVIDER_HEIGHT)
    .attr('fill', COLOR_BAND_DIVIDER)
    .attr('pointer-events', 'none')
    .attr('y', (d) => d.y);
  divEnter.style('opacity', 0).transition('enter').duration(ANIM_MS).style('opacity', 1);
  divSel.transition('move').duration(ANIM_MS).attr('y', (d) => d.y);
}

function ensureArrowMarker(layer: Selection<SVGGElement, unknown, null, undefined>): void {
  // Idempotent: skip if we've already set up <defs>. Markers live there.
  if (!layer.select('defs').empty()) return;

  const defs = layer.append('defs');
  const define = (
    id: string,
    options: { readonly markerUnits?: 'userSpaceOnUse'; readonly size?: number } = {},
  ): void => {
    // `context-stroke` makes the arrowhead's fill follow the path's
    // current stroke color. So when a canonical path's stroke is overridden
    // (grey by default → blue when .highlighted), the arrowhead changes
    // colour with it — no need to swap marker-end via JS.
    const marker = defs
      .append('marker')
      .attr('id', id)
      .attr('viewBox', '0 -4 8 8')
      .attr('refX', 7)
      .attr('refY', 0)
      .attr('markerWidth', options.size ?? 8)
      .attr('markerHeight', options.size ?? 8)
      .attr('orient', 'auto');
    if (options.markerUnits !== undefined) marker.attr('markerUnits', options.markerUnits);
    marker.append('path').attr('d', 'M0,-4L8,0L0,4Z').attr('fill', 'context-stroke');
  };
  define('sf-arrow-canonical');
  define('sf-arrow-soft');
  define('sf-arrow-hard');
  define('sf-arrow-hover', { markerUnits: 'userSpaceOnUse', size: 10 });
}

function arrowKey(a: Layout['arrows'][number]): string {
  // Identifies an arrow by endpoints + waypoint y-coords (capturing the
  // routing). Different routing under focus-toggle ⇒ different key, so the
  // old arrow exits (fade-out) and the new one enters (fade-in) — a true
  // path-tween would be nice but is brittle when path command counts differ.
  // fromRowKind is part of the identity so a struct field and a method
  // sharing a name produce distinct DOM elements (otherwise the d3 join
  // would coalesce them and one would silently disappear).
  const ys = a.waypoints.map((w) => `${w.x},${w.y}`).join('|');
  const toRow = `${a.toRowKind ?? ''}::${a.toFieldName ?? ''}`;
  return `${a.kind}::${a.fromTypeId}::${a.fromRowKind}::${a.fromFieldName}::${a.toTypeId}::${toRow}::${ys}`;
}

// Width of the transparent "hit" stroke per arrow. Wide enough to make
// thin visible strokes easy to land on; the visible stroke is unchanged.
const ARROW_HIT_STROKE_W = 14;

function renderArrows(
  g: Selection<SVGGElement, unknown, null, undefined>,
  layout: Layout,
  selectedArrows: ReadonlySet<Layout['arrows'][number]>,
): void {
  // Each arrow renders as a parent <g> containing two paths:
  //   .hit     — transparent, wide stroke; cursor: pointer; catches
  //              clicks via stroke (set in CSS).
  //   .visible — the painted stroke we actually see.
  // Splitting hit-zone from paint lets thin styling stay readable while
  // the click target stays generous. A single arrow per <g> keeps the
  // exit/enter join straightforward.
  const sel = g
    .selectAll<SVGGElement, Layout['arrows'][number]>('g.arrow')
    .data(renderableArrows(layout), arrowKey);

  sel
    .exit()
    .classed('highlighted', false)
    .transition('exit')
    .duration(ANIM_MS)
    .style('opacity', 0)
    .remove();

  const enter = sel.enter().append('g').attr('class', 'arrow').style('opacity', 0);
  // Raise the hovered arrow to the top of g.arrows so the bright
  // purple hover stroke is never visually covered by a sibling arrow
  // painted later. SVG paint order = DOM order; .raise() moves this
  // <g> to the end of its parent, putting it on top. Attached on
  // enter only -- d3's keyed data join preserves the handler across
  // redraws, and each fresh layout rebuilds the natural arrow order
  // (so without re-hovering, the canvas returns to its default
  // stacking next draw).
  enter.on('mouseenter', function () {
    select(this).raise();
  });

  // Stable endpoint identifiers on every arrow `<g>` so external
  // callers (the tour bubble's arrow-step anchor) can locate the
  // routed path without re-walking the layout. Full element id for
  // a row endpoint is `typeId::fieldName`; for a type endpoint
  // (toFieldName undefined) it's just the typeId.
  //
  // Free functions are special: the diagram nests them inside a
  // `function_group` pseudo-type whose id is `${moduleId}::__fn_*`,
  // but the rest of the system (tour resolver, callgraph index,
  // facts.json) addresses them by their natural module path
  // `${moduleId}::${name}`. Strip the pseudo-segment when the row
  // is a function so the attribute matches the natural id and
  // external lookups succeed without round-tripping through the
  // layout.
  const stripFunctionGroup = (typeId: string): string =>
    typeId.replace(/::__fn_[^:]+$/, '');
  const endpointId = (
    typeId: string,
    field: string | undefined,
    rowKind: 'field' | 'method' | 'function' | undefined,
  ): string => {
    const base = rowKind === 'function' ? stripFunctionGroup(typeId) : typeId;
    return field === undefined ? base : `${base}::${field}`;
  };
  enter.attr('data-arrow-from', (a) =>
    endpointId(a.fromTypeId, a.fromFieldName, a.fromRowKind),
  );
  enter.attr('data-arrow-to', (a) =>
    endpointId(a.toTypeId, a.toFieldName ?? undefined, a.toRowKind),
  );

  enter
    .append('path')
    .attr('class', 'hit')
    .attr('d', (a) => polylinePath(a.waypoints))
    .attr('stroke', 'transparent')
    .attr('stroke-width', ARROW_HIT_STROKE_W)
    .attr('fill', 'none')
    .attr('pointer-events', 'stroke');

  enter
    .append('path')
    .attr('class', 'visible')
    .attr('d', (a) => polylinePath(a.waypoints))
    .attr('stroke', (a) => arrowColor(a))
    .attr('stroke-dasharray', (a) => {
      // Cross-crate wins regardless of kind — the boundary-crossing
      // pattern is more important than the kind-specific rhythm.
      if (a.isCrossCrate === true) return CROSS_CRATE_DASH;
      if (a.kind === 'reexport') return REEXPORT_DASH;
      if (a.kind === 'call') return METHOD_DASH;
      return null;
    })
    .attr('marker-end', (a) => `url(#${ARROW_MARKER_IDS[a.driftClass]})`)
    .classed(
      'canonical',
      (a) =>
        a.kind === 'ownership' && (a.driftClass === 'at_lca' || a.driftClass === 'within_budget'),
    )
    .classed('reexport', (a) => a.kind === 'reexport')
    .classed('call', (a) => a.kind === 'call')
    .classed('highlighted', (a) => selectedArrows.has(a));

  enter.transition('enter').duration(ANIM_MS).style('opacity', 1);

  // Update: refresh `highlighted` on the inner visible path of every
  // arrow group (entering + persisting). Other classes are stable per
  // arrow id and don't change once set on enter.
  enter
    .merge(sel)
    .select<SVGPathElement>('path.visible')
    .classed('highlighted', (a) => selectedArrows.has(a));
  enter.merge(sel).select<SVGPathElement>('path.hit').attr('pointer-events', 'stroke');
}

function renderableArrows(layout: Layout): readonly Layout['arrows'][number][] {
  return layout.arrowLayers.flatMap((layer) => layer.arrows);
}

function hitTestableArrows(layout: Layout): readonly Layout['arrows'][number][] {
  return layout.arrowLayers.filter((layer) => layer.hitTestable).flatMap((layer) => layer.arrows);
}

function directArrowsFrom(
  layout: Layout,
  fromTypeId: string,
  fieldName: string,
  fromKind: FieldKeyKind,
): Set<Layout['arrows'][number]> {
  const out = new Set<Layout['arrows'][number]>();
  // Match on both name AND row kind so a struct field and a method that share
  // a name (e.g. `exn_heap` field + `exn_heap()` getter) don't both light up
  // when only one was selected.
  for (const a of renderableArrows(layout)) {
    if (a.fromTypeId !== fromTypeId) continue;
    if (a.fromFieldName !== fieldName) continue;
    if (a.fromRowKind !== fromKind) continue;
    out.add(a);
  }
  return out;
}

function applyArrowHighlight(
  layer: Selection<SVGGElement, unknown, null, undefined>,
  highlighted: ReadonlySet<Layout['arrows'][number]>,
): void {
  // Each arrow is a `<g class="arrow">` containing a `.hit` and a
  // `.visible` path. Highlight class lives on the visible path (which
  // CSS targets); skip the hit path so the wide transparent stroke
  // doesn't accidentally pick up styling.
  layer
    .selectAll<SVGPathElement, Layout['arrows'][number]>('g.arrows path.visible')
    .classed('highlighted', (d) => highlighted.has(d));
}

const CORNER_OFFSET = LAYOUT_GRID_CELL_W / 2;

export function polylinePath(waypoints: readonly { x: number; y: number }[]): string {
  const points = compactStraightThroughWaypoints(waypoints);
  if (points.length < 2) return '';
  const head = points[0];
  const tail = points[points.length - 1];
  if (!head || !tail) return '';

  // Round each interior corner with a quadratic bezier: trim back from the
  // corner along each adjacent segment by CORNER_OFFSET (or half-segment if
  // the segment is too short), then use the corner itself as the Q control
  // point. This smooths the bend without specifying an explicit radius.
  let d = `M${head.x},${head.y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    const next = points[i + 1];
    if (!prev || !cur || !next) continue;

    const inLen = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const outLen = Math.hypot(next.x - cur.x, next.y - cur.y);
    const inOff = Math.min(CORNER_OFFSET, inLen / 2);
    const outOff = Math.min(CORNER_OFFSET, outLen / 2);
    if (inLen === 0 || outLen === 0) continue;
    const inUx = (cur.x - prev.x) / inLen;
    const inUy = (cur.y - prev.y) / inLen;
    const outUx = (next.x - cur.x) / outLen;
    const outUy = (next.y - cur.y) / outLen;

    const ax = cur.x - inUx * inOff;
    const ay = cur.y - inUy * inOff;
    const ex = cur.x + outUx * outOff;
    const ey = cur.y + outUy * outOff;

    d += `L${ax},${ay}Q${cur.x},${cur.y} ${ex},${ey}`;
  }
  d += `L${tail.x},${tail.y}`;
  return d;
}

function compactStraightThroughWaypoints(
  waypoints: readonly { x: number; y: number }[],
): readonly { x: number; y: number }[] {
  if (waypoints.length < 3) return waypoints;

  const out: { x: number; y: number }[] = [];
  const first = waypoints[0];
  if (!first) return [];
  out.push(first);

  for (let i = 1; i < waypoints.length - 1; i += 1) {
    const prev = out[out.length - 1];
    const cur = waypoints[i];
    const next = waypoints[i + 1];
    if (!prev || !cur || !next) continue;

    // Some polylines include semantic boundary ports that sit on the same
    // straight segment as the next real corner. Rounding those as corners
    // visually distorts upward/downward turns.
    if (isStraightThrough(prev, cur, next)) continue;
    out.push(cur);
  }

  const last = waypoints[waypoints.length - 1];
  if (last) out.push(last);
  return out;
}

function isStraightThrough(
  prev: { readonly x: number; readonly y: number },
  cur: { readonly x: number; readonly y: number },
  next: { readonly x: number; readonly y: number },
): boolean {
  const dxIn = cur.x - prev.x;
  const dyIn = cur.y - prev.y;
  const dxOut = next.x - cur.x;
  const dyOut = next.y - cur.y;

  if ((dxIn === 0 && dyIn === 0) || (dxOut === 0 && dyOut === 0)) return true;

  const horizontal = dyIn === 0 && dyOut === 0 && Math.sign(dxIn) === Math.sign(dxOut);
  const vertical = dxIn === 0 && dxOut === 0 && Math.sign(dyIn) === Math.sign(dyOut);
  return horizontal || vertical;
}

function renderModules(
  g: Selection<SVGGElement, unknown, null, undefined>,
  layout: Layout,
  opts: TreeRenderOptions,
): void {
  const sel = g
    .selectAll<SVGGElement, Layout['modules'][number]>('g.module-row')
    .data(layout.modules, (d) => d.id);

  sel.exit().transition('exit').duration(ANIM_MS).style('opacity', 0).remove();

  const enter = sel
    .enter()
    .append('g')
    .attr('class', 'module-row')
    .attr('transform', (d) => `translate(${d.labelX},${d.y})`)
    .style('opacity', 0);

  enter
    .filter((d) => d.hasChildren)
    .append('text')
    .attr('class', 'chevron')
    .attr('x', CHEVRON_X)
    .attr('y', ROW_H / 2)
    .attr('dy', '0.32em')
    .attr('text-anchor', 'middle')
    .attr('font-size', FONT_SIZE_MODULE_CHEVRON)
    .attr('font-weight', 600)
    .attr('fill', COLOR_CHEVRON);

  // Leaf-only label — depth is conveyed by the row's labelX, so the
  // text is just this module's own name. Crate rows (modDepth 0 under
  // the hidden workspace root) get a bigger, bold leaf so they read as
  // section headers. Submodule rows use the default size and weight;
  // the chip background (rendered separately) carries their identity.
  enter
    .append('text')
    .attr('class', 'name')
    .attr('x', MODULE_LABEL_X)
    .attr('y', ROW_H / 2)
    .attr('dy', '0.32em')
    .attr('font-size', (d) => (d.modDepth === 0 ? FONT_SIZE_CRATE_LEAF : FONT_SIZE_MODULE_LEAF))
    .attr('font-weight', (d) => (d.modDepth === 0 ? 700 : 400))
    // Crate leaves lighten to slate-700 so bold+near-black doesn't
    // overpower the slate-200 band tint behind them. Module leaves
    // keep the default COLOR_LABEL (slate-800) on the lighter striped
    // background.
    .attr('fill', (d) => (d.modDepth === 0 ? COLOR_CRATE_LABEL : COLOR_LABEL));

  // Expand-hit rect starts past the marker (HEADER_HIT_X) so the marker
  // owns its own pointer events without depending on DOM paint order.
  // Width still spans HIT_MIN_W so the label area is the header-click
  // target.
  enter
    .append('rect')
    .attr('class', 'expand-hit')
    .attr('x', HEADER_HIT_X)
    .attr('y', 0)
    .attr('width', HIT_MIN_W)
    .attr('height', ROW_H)
    .attr('fill', 'transparent');

  enter.transition('enter').duration(ANIM_MS).style('opacity', 1);

  const merged = enter.merge(sel);

  // Tween position to new (labelX, y).
  merged
    .transition('move')
    .duration(ANIM_MS)
    .attr('transform', (d) => `translate(${d.labelX},${d.y})`);

  // Update chevron text + colour. Refreshed each draw because expansion
  // state changes and so should the +/- glyph and its red/green fill.
  merged
    .filter((d) => d.hasChildren)
    .select<SVGTextElement>('text.chevron')
    .text((d) => (d.expanded ? '-' : '+'))
    .attr('fill', (d) => (d.expanded ? COLOR_CHEVRON_COLLAPSE : COLOR_CHEVRON_EXPAND));

  // Refresh the module label each draw — content can shift across
  // redraws when crates change or focus mode collapses ancestors.
  merged
    .select<SVGTextElement>('text.name')
    .text((d) => moduleLeafLabel(d.id));

  // Refresh click handler with current closure each draw.
  merged
    .select<SVGRectElement>('rect.expand-hit')
    .attr('cursor', (d) => (d.hasChildren ? 'pointer' : 'default'))
    .on('click', (event: MouseEvent, d) => {
      event.stopPropagation();
      if (event.metaKey || event.ctrlKey) {
        opts.onShowCode(d.id, 'module');
        return;
      }
      if (d.hasChildren) opts.onToggle(d.id);
    });

  // Leaf chip: a single rounded rect behind the label, colored by the
  // module's own name when this module has submodule children
  // (matching the hashed palette its descendants' chips reference),
  // otherwise a neutral fill so leaf-only modules still get a chip
  // without burning a palette slot. Crate-tier rows (modDepth 0) get
  // no chip — they render as plain bold headings on the band tint.
  const CHIP_OUTER_PAD = 4;
  merged.each(function (d) {
    const rowG = select(this);

    if (d.modDepth === 0) {
      rowG.select<SVGRectElement>('rect.leaf-chip').remove();
      rowG.select<SVGRectElement>('rect.cluster-border').remove();
      return;
    }

    const chipX = d.leafBg.xStart - CHIP_OUTER_PAD;
    const chipWidth = d.leafBg.width + CHIP_OUTER_PAD * 2;
    // Half-step between slate-100 (band tint) and slate-200 for the
    // neutral fill — reads as "no palette slot" without disappearing
    // into the band background.
    const chipFill = d.leafBg.isParent ? colorForSegment(d.leafBg.name) : '#eaeef4';

    let chip = rowG.select<SVGRectElement>('rect.leaf-chip');
    if (chip.empty()) {
      chip = rowG.insert<SVGRectElement>('rect', 'text.name');
      chip
        .attr('class', 'leaf-chip')
        .attr('y', 0)
        .attr('height', ROW_H)
        .attr('rx', 4)
        .attr('pointer-events', 'none');
    }
    chip.attr('x', chipX).attr('width', chipWidth).attr('fill', chipFill);

    let border = rowG.select<SVGRectElement>('rect.cluster-border');
    if (border.empty()) {
      border = rowG.insert<SVGRectElement>('rect', 'text.name');
      border
        .attr('class', 'cluster-border')
        .attr('y', 0)
        .attr('height', ROW_H)
        .attr('rx', 4)
        .attr('fill', 'none')
        .attr('stroke', '#cbd5e1')
        .attr('stroke-width', 1)
        .attr('pointer-events', 'none');
    }
    border.attr('x', chipX).attr('width', chipWidth);
  });

  sizeModuleExpandHit(merged);
}

function sizeModuleExpandHit(
  sel: Selection<SVGGElement, Layout['modules'][number], SVGGElement, unknown>,
): void {
  // Layout owns module label measurement so toggling a band does not force
  // SVG text layout across every visible module row before the animation
  // frame. The hit-rect catches clicks on top of the colored segment chips.
  sel.each(function (d) {
    select(this).select<SVGRectElement>('rect.expand-hit').attr('width', d.hitWidth);
  });
}

/** Pick the ancestor chain of `dataYTop` from the module list, in
 *  parent-first order. A module is sticky when its full row has scrolled
 *  above `dataYTop` (its bottom edge sits above the viewport top). The
 *  algorithm walks bands in y-order, maintaining a stack of currently
 *  active ancestors; popping siblings as deeper rows arrive keeps the
 *  stack equal to "the modules currently containing dataYTop". */
export function computeStickyModuleChain(
  modules: ReadonlyArray<Layout['modules'][number]>,
  dataYTop: number,
): ReadonlyArray<Layout['modules'][number]> {
  const stack: Array<Layout['modules'][number]> = [];
  for (const m of modules) {
    // m's row is still (at least partially) on-screen → stack contains
    // the ancestors of dataYTop, nothing further to add.
    if (m.y + ROW_H > dataYTop) return stack;
    while (stack.length > 0 && (stack[stack.length - 1]?.modDepth ?? -1) >= m.modDepth) {
      stack.pop();
    }
    stack.push(m);
  }
  return stack;
}

/** Render the breadcrumb stack of ancestor module rows pinned to the
 *  top-left corner of the viewport. Mirrors `renderModules` styling so
 *  a sticky row looks identical to its in-canvas counterpart at k=1,
 *  except that:
 *   • the row sits at sticky_y (a multiple of ROW_H) instead of d.y,
 *   • an opaque background paints behind the stack so canvas content
 *     scrolling below stays hidden — sized to the widest sticky row,
 *     not the whole viewport, so it doesn't waste space.
 *   • the click handler scrolls back to that module's in-canvas row
 *     instead of toggling expansion.
 *  The stickyLayer is rendered in viewport coordinates (no transform):
 *  the breadcrumb is a fixed-size HUD that does not pan with the canvas
 *  or scale with zoom. */
export function renderStickyModules(
  stickyLayer: Selection<SVGGElement, unknown, null, undefined>,
  layout: Layout,
  dataYTop: number,
  opts: TreeRenderOptions,
): void {
  const chain = computeStickyModuleChain(layout.modules, dataYTop);

  // Opaque backdrop just under the sticky rows. Sized to the widest
  // sticky row so the HUD doesn't extend across the whole viewport
  // (which would block canvas interactions and waste space). Kept first
  // in DOM order so it paints under every row. Removed when the chain
  // is empty so we don't leave a stray white strip after scrolling back
  // up.
  let bgWidth = 0;
  for (const m of chain) {
    const right = m.labelX + m.hitWidth;
    if (right > bgWidth) bgWidth = right;
  }
  const bgSel = stickyLayer.selectAll<SVGRectElement, null>('rect.sticky-bg').data(
    chain.length === 0 ? [] : [null],
  );
  bgSel.exit().remove();
  bgSel
    .enter()
    .append('rect')
    .attr('class', 'sticky-bg')
    .attr('x', 0)
    .attr('y', 0)
    .attr('fill', '#ffffff')
    .attr('pointer-events', 'none')
    .merge(bgSel)
    .attr('width', bgWidth)
    .attr('height', chain.length * ROW_H);

  const sel = stickyLayer
    .selectAll<SVGGElement, Layout['modules'][number]>('g.sticky-row')
    .data(chain, (d) => d.id);

  sel.exit().remove();

  const enter = sel.enter().append('g').attr('class', 'sticky-row');

  // Chip + border for non-crate rows. We always append both elements so
  // the merge step can refresh them; for crate-tier rows we'll wipe the
  // chip/border (no visual chip on crate rows in-canvas).
  enter
    .filter((d) => d.hasChildren)
    .append('text')
    .attr('class', 'chevron')
    .attr('x', CHEVRON_X)
    .attr('y', ROW_H / 2)
    .attr('dy', '0.32em')
    .attr('text-anchor', 'middle')
    .attr('font-size', FONT_SIZE_MODULE_CHEVRON)
    .attr('font-weight', 600)
    .attr('fill', COLOR_CHEVRON);

  enter
    .append('text')
    .attr('class', 'name')
    .attr('x', MODULE_LABEL_X)
    .attr('y', ROW_H / 2)
    .attr('dy', '0.32em')
    .attr('font-size', (d) => (d.modDepth === 0 ? FONT_SIZE_CRATE_LEAF : FONT_SIZE_MODULE_LEAF))
    .attr('font-weight', (d) => (d.modDepth === 0 ? 700 : 400))
    .attr('fill', (d) => (d.modDepth === 0 ? COLOR_CRATE_LABEL : COLOR_LABEL));

  // Transparent click-catcher covering the whole sticky-row width. Sized
  // from d.hitWidth so the clickable area matches the in-canvas row.
  enter
    .append('rect')
    .attr('class', 'sticky-hit')
    .attr('x', 0)
    .attr('y', 0)
    .attr('height', ROW_H)
    .attr('fill', 'transparent')
    .style('cursor', 'pointer');

  const merged = enter.merge(sel);

  merged.attr('transform', (d, i) => `translate(${d.labelX},${i * ROW_H})`);

  merged
    .filter((d) => d.hasChildren)
    .select<SVGTextElement>('text.chevron')
    .text((d) => (d.expanded ? '-' : '+'))
    .attr('fill', (d) => (d.expanded ? COLOR_CHEVRON_COLLAPSE : COLOR_CHEVRON_EXPAND));

  merged.select<SVGTextElement>('text.name').text((d) => moduleLeafLabel(d.id));

  const CHIP_OUTER_PAD = 4;
  merged.each(function (d) {
    const rowG = select(this);

    if (d.modDepth === 0) {
      rowG.select<SVGRectElement>('rect.leaf-chip').remove();
      rowG.select<SVGRectElement>('rect.cluster-border').remove();
    } else {
      const chipX = d.leafBg.xStart - CHIP_OUTER_PAD;
      const chipWidth = d.leafBg.width + CHIP_OUTER_PAD * 2;
      const chipFill = d.leafBg.isParent ? colorForSegment(d.leafBg.name) : '#eaeef4';

      let chip = rowG.select<SVGRectElement>('rect.leaf-chip');
      if (chip.empty()) {
        chip = rowG.insert<SVGRectElement>('rect', 'text.name');
        chip
          .attr('class', 'leaf-chip')
          .attr('y', 0)
          .attr('height', ROW_H)
          .attr('rx', 4)
          .attr('pointer-events', 'none');
      }
      chip.attr('x', chipX).attr('width', chipWidth).attr('fill', chipFill);

      let border = rowG.select<SVGRectElement>('rect.cluster-border');
      if (border.empty()) {
        border = rowG.insert<SVGRectElement>('rect', 'text.name');
        border
          .attr('class', 'cluster-border')
          .attr('y', 0)
          .attr('height', ROW_H)
          .attr('rx', 4)
          .attr('fill', 'none')
          .attr('stroke', '#cbd5e1')
          .attr('stroke-width', 1)
          .attr('pointer-events', 'none');
      }
      border.attr('x', chipX).attr('width', chipWidth);
    }

    // Hit rect spans the row's full hitWidth, expressed in the row
    // group's local coords (just like the in-canvas expand-hit).
    rowG
      .select<SVGRectElement>('rect.sticky-hit')
      .attr('width', d.hitWidth)
      .on('click', (event: MouseEvent) => {
        event.stopPropagation();
        opts.onScrollToModule(d.id);
      });
  });
}

function renderTypes(
  typeG: Selection<SVGGElement, unknown, null, undefined>,
  zoomLayer: Selection<SVGGElement, unknown, null, undefined>,
  layout: Layout,
  opts: TreeRenderOptions,
): void {
  const sel = typeG
    .selectAll<SVGGElement, Layout['types'][number]>('g.type-box')
    .data(layout.types, (d) => `${d.modulePath}::${d.id}`);

  sel.exit().transition('exit').duration(ANIM_MS).style('opacity', 0).remove();

  const enter = sel
    .enter()
    .append('g')
    .attr('class', 'type-box')
    .attr('data-element-id', (d) => d.fullPath)
    .attr('data-element-kind', 'type')
    .attr('transform', (d) => `translate(${d.x},${d.y - ROW_H / 2})`)
    .style('opacity', 0);

  // Selection ring: a transparent rect appended first so it renders
  // BEHIND every other type-box child. CSS gives it a glowing purple
  // outline when the parent `.type-box` carries `.selected`. Sized
  // on the merged pass each render, since `d.height` changes when
  // the type expands or collapses.
  enter
    .append('rect')
    .attr('class', 'selection-ring')
    .attr('x', 0)
    .attr('y', 0)
    .attr('rx', 6)
    .attr('ry', 6)
    .attr('fill', 'none')
    .attr('pointer-events', 'none');

  // Union-diff bar — two stacked rects on the type-box's left edge
  // (flush with the obstacle border, extending into the box). Their
  // heights are set on the merged pass from `typeBarStateById`:
  //   • `add`   → top rect = green full-height, bot = 0.
  //   • `del`   → top rect = red full-height, bot = 0.
  //   • `split` → top = green half, bot = red half (joined).
  // The bar reflects the type's *structural rollup*: any member that
  // was added or removed contributes; a Both type with only body
  // edits gets no bar at all. Function-group pseudo-types use the
  // same state by their synthetic id.
  enter
    .append('rect')
    .attr('class', 'side-bar-top')
    .attr('y', 0)
    .attr('width', 4)
    .attr('fill', '#56C271')
    .attr('pointer-events', 'none');
  enter
    .append('rect')
    .attr('class', 'side-bar-bot')
    .attr('width', 4)
    .attr('fill', '#FF6B6B')
    .attr('pointer-events', 'none');

  enter
    .append('text')
    .attr('class', 'header-label name')
    .attr('x', TYPE_LABEL_X)
    .attr('y', ROW_H / 2)
    .attr('dy', '0.32em')
    .attr('font-size', TYPE_LABEL_FONT_SIZE)
    .attr('fill', COLOR_LABEL)
    .attr('font-style', (d) => (d.isGhost ? 'italic' : 'normal'))
    .text((d) => d.label);

  enter
    .filter((d) => d.hasFields)
    .append('text')
    .attr('class', 'expand-arrow')
    .attr('y', ROW_H / 2)
    .attr('dy', '0.32em')
    .attr('font-size', TYPE_EXPAND_ARROW_FONT_SIZE)
    .attr('fill', COLOR_CHEVRON);

  enter
    .append('rect')
    .attr('class', 'expand-hit')
    .attr('x', 0)
    .attr('y', 0)
    .attr('width', HIT_MIN_W)
    .attr('height', ROW_H)
    .attr('fill', 'transparent');

  enter
    .filter((d) => d.hasFields)
    .append('rect')
    .attr('class', 'expand-arrow-hit')
    .attr('y', 0)
    .attr('height', ROW_H)
    .attr('fill', 'transparent');

  // Kind letter — the single marker for every type row. Acts as the
  // visibility indicator (fill = visibility color) and the re-export
  // indicator (italic for ghosts). Positioned just left of the label so
  // marker+name read as a unit. Pointer events are handled directly on
  // this element; the expand-hit rect is offset to start past the marker
  // so they don't fight over events.
  enter
    .append('text')
    .attr('class', 'kind-marker')
    .attr('x', KIND_MARKER_X)
    .attr('y', ROW_H / 2)
    .attr('dy', '0.32em')
    .attr('text-anchor', 'middle')
    .attr('font-size', KIND_MARKER_FONT_SIZE)
    .attr('font-weight', 700)
    .style('cursor', 'pointer')
    .attr('pointer-events', 'all')
    .text((d) => kindMarker(d));

  enter.transition('enter').duration(ANIM_MS).style('opacity', 1);

  const merged = enter.merge(sel);

  // Selection state: dashed purple ring around the matching type.
  // Uses the same obstacle-block rect the debug overlay draws, so the
  // ring and the debug box agree by construction — single source of
  // truth for "this is the visual extent of one type". Box is in
  // world coords; the type-box group is translated to (d.x, headerY),
  // so we subtract that translation to land in local coords.
  const SELECTION_PAD = 4;
  const headerTopFor = (d: Layout['types'][number]) => d.y - ROW_H / 2;
  // A type-box is "selected" when its own fullPath matches the host's
  // selected element id, OR when one of its rows does. The latter
  // covers free functions, whose owning visible structure is a
  // function_group pseudo-type — the function's id alone never matches
  // the pseudo-type's fullPath, so we have to consult the rows.
  const selectedId = opts.selectedElementId;
  const selectedKind = opts.selectedElementKind;
  merged.classed('selected', (d) =>
    selectedId !== null && selectedKind !== null && typeMatchesSelection(d, selectedId, selectedKind),
  );
  merged
    .select<SVGRectElement>('rect.selection-ring')
    .attr('x', (d) => d.boxX - d.x - SELECTION_PAD)
    .attr('y', (d) => d.boxY - headerTopFor(d) - SELECTION_PAD)
    .attr('width', (d) => Math.max(0, d.boxWidth + SELECTION_PAD * 2))
    .attr('height', (d) => Math.max(0, d.boxHeight + SELECTION_PAD * 2));

  // Union-diff side bar on the type box. Span the FULL height of the
  // box (header + expanded fields if any) so the bar is unmistakable
  // at the type level. The CSS rule keys off the `data-side` attribute
  // on `.type-box`, so we just set the attribute and size the rect
  // here; CSS owns the color and visibility.
  // Type's own side (head/base) drives label color via `.side-*`
  // class. Separate from the rollup bar state on `data-side`, which
  // reflects what's *inside* the type. A `Both` type carries
  // neither class — its label stays neutral and the bar (if any)
  // tells the story.
  merged
    .classed('side-head', (d) => opts.sideByElementId?.get(d.fullPath) === 'head')
    .classed('side-base', (d) => opts.sideByElementId?.get(d.fullPath) === 'base');

  // Drive the two stacked side-bar rects from `typeBarStateById`.
  // For `add`/`del`/`split` we set heights and y on each rect; for
  // anything else (no entry) we set heights to 0 so the rects
  // vanish without a CSS hide rule.
  merged
    .attr('data-side', (d) => opts.typeBarStateById?.get(d.fullPath) ?? null)
    .each(function (d) {
      const state = opts.typeBarStateById?.get(d.fullPath);
      // Bar lives only at the type-box header (ROW_H tall), not
      // spanning expanded member rows. Reasons:
      //   • Unchanged members shouldn't look flagged just because
      //     they happen to live inside a type whose siblings changed.
      //   • Changed members already carry their own row-side-bar +
      //     row-side-bg, so the rollup is communicated at the type
      //     header without competing with per-row signal below.
      //   • Split bars stay readable at a fixed 24px (12/12 split),
      //     instead of becoming a tiny-red-under-big-green smear on
      //     tall expanded types.
      const barH = ROW_H;
      const x = d.boxX - d.x;
      const top = d.boxY - headerTopFor(d);
      const topRect = this.querySelector<SVGRectElement>('rect.side-bar-top');
      const botRect = this.querySelector<SVGRectElement>('rect.side-bar-bot');
      if (!topRect || !botRect) return;
      topRect.setAttribute('x', String(x));
      botRect.setAttribute('x', String(x));
      if (state === 'add') {
        topRect.setAttribute('y', String(top));
        topRect.setAttribute('height', String(barH));
        botRect.setAttribute('height', '0');
      } else if (state === 'del') {
        topRect.setAttribute('height', '0');
        botRect.setAttribute('y', String(top));
        botRect.setAttribute('height', String(barH));
        botRect.setAttribute('fill', '#FF6B6B');
      } else if (state === 'split') {
        const half = Math.round(barH / 2);
        topRect.setAttribute('y', String(top));
        topRect.setAttribute('height', String(half));
        botRect.setAttribute('y', String(top + half));
        botRect.setAttribute('height', String(barH - half));
        botRect.setAttribute('fill', '#FF6B6B');
      } else {
        topRect.setAttribute('height', '0');
        botRect.setAttribute('height', '0');
      }
    });

  // Tween group position (carries fields along inside).
  merged
    .transition('move')
    .duration(ANIM_MS)
    .attr('transform', (d) => `translate(${d.x},${d.y - ROW_H / 2})`);

  // Update expand-arrow text (expansion state may have changed).
  merged
    .filter((d) => d.hasFields)
    .select<SVGTextElement>('text.expand-arrow')
    .text((d) => (d.expanded ? TYPE_EXPAND_ARROW_OPEN : TYPE_EXPAND_ARROW_CLOSED));

  // Refresh click handler each draw. Name/header click semantics:
  //   - real type with fields → toggle expansion (current behaviour)
  //   - ghost re-export → reveal canonical target so the violet arrow
  //     becomes visible (same action as the dot click)
  //   - real type without fields → no action, default cursor.
  // Header-level hover hooks fire the debug panel anywhere in the type
  // header, not just on the label glyphs or the dot. The transparent
  // expand-hit rect is rendered AFTER the label (so it paints on top of
  // it) with a transparent fill, which under SVG's default
  // `visiblePainted` pointer rule catches events the label would
  // otherwise see. Attaching the hover here means hovering anywhere in
  // the header — including the gaps between label glyphs — triggers
  // the panel. The label and dot hovers below still fire too, so moving
  // smoothly across the header keeps the panel visible via the shared
  // hide timer.
  const headerDebugMouseenter = function (this: SVGRectElement, _event: MouseEvent, d: Layout['types'][number]): void {
    if (!layoutDebugEnabled()) return;
    showTypeDebugPanel(layout, opts.ownership, d, this);
  };
  const headerDebugMouseleave = (): void => {
    if (layoutDebugEnabled()) hideCallableDebugPanel();
  };
  merged
    .select<SVGRectElement>('rect.expand-hit')
    .attr('cursor', (d) => (d.hasFields || d.isGhost ? 'pointer' : 'default'))
    .on('click', (event: MouseEvent, d) => {
      event.stopPropagation();
      if (event.metaKey || event.ctrlKey) {
        opts.onShowCode(d.fullPath, 'type');
        return;
      }
      if (d.isGhost && d.ghostTarget !== null) {
        opts.onFollowGhost(d.id, d.ghostTarget);
      } else if (d.hasFields) {
        opts.onToggle(d.id);
      }
    })
    .on('mouseenter', headerDebugMouseenter)
    .on('mouseleave', headerDebugMouseleave);

  // Chevron click is intentionally stronger than name click: it toggles the
  // type and selects/deselects all member rows that can emit arrows.
  merged
    .select<SVGRectElement>('rect.expand-arrow-hit')
    .attr('cursor', 'pointer')
    .on('click', (event: MouseEvent, d) => {
      event.stopPropagation();
      if (d.hasFields) opts.onToggleTypeMembers(d.fullPath);
    })
    .on('mouseenter', headerDebugMouseenter)
    .on('mouseleave', headerDebugMouseleave);

  // Marker click + hover wiring. One DOM element (text.kind-marker) per
  // row carries both responsibilities:
  //   - ghost re-export → follow the canonical target, expanding
  //     ancestors so the violet arrow becomes visible.
  //   - real row → open the owner picker so the user can reveal incoming
  //     ownership arrows individually (or via show-all / hide-all).
  // Hover wires the debug overlay AND a count badge showing how many
  // owner arrows clicking would surface; ghosts skip the badge because
  // their click follows the re-export, not the owner set.
  merged
    .select<SVGTextElement>('text.kind-marker')
    .attr('fill', (d) => colorForVisibility(d.visibility))
    .attr('font-style', (d) => (d.isGhost ? 'italic' : 'normal'))
    .on('click', (event: MouseEvent, d) => {
      event.stopPropagation();
      if (d.isGhost && d.ghostTarget !== null) {
        opts.onFollowGhost(d.id, d.ghostTarget);
      } else {
        opts.onPickOwner(d.fullPath, { x: event.clientX, y: event.clientY });
      }
    })
    .on('mouseenter', function (_event: MouseEvent, d) {
      const node = this as SVGTextElement;
      if (layoutDebugEnabled()) showTypeDebugPanel(layout, opts.ownership, d, node);
      if (d.isGhost) return;
      const ownerCount = opts.ownership.ownedBy.get(d.fullPath)?.length ?? 0;
      const group = select(node.parentNode as Element);
      let badge = group.select<SVGTextElement>('text.owner-count-badge');
      if (badge.empty()) {
        badge = group
          .append('text')
          .attr('class', 'owner-count-badge')
          .attr('y', ROW_H / 2)
          .attr('dy', '0.32em')
          .attr('text-anchor', 'end')
          .attr('font-size', 10)
          .attr('font-weight', 600)
          .attr('paint-order', 'stroke fill')
          .attr('stroke', '#ffffff')
          .attr('stroke-width', 3)
          .style('pointer-events', 'none')
          .style('opacity', 0);
      }
      badge
        .text(`(${ownerCount})`)
        .attr('x', OWNER_COUNT_BADGE_X)
        .attr('fill', colorForVisibility(d.visibility))
        .transition('owner-badge-hover')
        .duration(CALL_MARKER_HOVER_DURATION_MS)
        .style('opacity', 1);
    })
    .on('mouseleave', function () {
      if (layoutDebugEnabled()) hideCallableDebugPanel();
      select((this as SVGTextElement).parentNode as Element)
        .select<SVGTextElement>('text.owner-count-badge')
        .transition('owner-badge-hover')
        .duration(CALL_MARKER_HOVER_DURATION_MS)
        .style('opacity', 0);
    });

  // Debug overlay also fires on the type's label text — the dot is a
  // small target, the label covers the rest of the header. Same panel,
  // same hide timer, so moving between dot and label feels continuous.
  merged
    .select<SVGTextElement>('text.header-label')
    .on('mouseenter', function (_event: MouseEvent, d) {
      if (!layoutDebugEnabled()) return;
      showTypeDebugPanel(layout, opts.ownership, d, this as SVGTextElement);
    })
    .on('mouseleave', () => {
      if (layoutDebugEnabled()) hideCallableDebugPanel();
    });

  // Sub-data-join for field rows inside each type group.
  merged.each(function (d) {
    renderFieldsForType(select(this), zoomLayer, layout, d, opts);
  });

  sizeTypeHits(merged);
}

function renderFieldsForType(
  typeNode: Selection<SVGGElement, Layout['types'][number], null, undefined>,
  zoomLayer: Selection<SVGGElement, unknown, null, undefined>,
  layout: Layout,
  d: Layout['types'][number],
  opts: TreeRenderOptions,
): void {
  // Field rows are children of the type group so they pan with the parent's
  // transform. When the type is collapsed, fieldData is empty and the d3
  // join exits all field rows. Sub-key by row kind + name so a bucket
  // header (`method_bucket`) and a field of the same name can't collide.
  const fields = d.expanded ? d.fields : [];
  const groupTopY = d.y - ROW_H / 2;

  const sel = typeNode
    .selectAll<SVGGElement, Layout['types'][number]['fields'][number]>('g.field-row-g')
    .data(fields, (f) =>
      // Signature_arg rows belong to a specific function and must include
      // the parent function path so two functions sharing a param name
      // (or both having a `->` return row) produce distinct DOM nodes.
      // Other row kinds are unique per type by (kind, name) already.
      f.kind === 'signature_arg' && f.functionFullPath !== null
        ? `${f.kind}:${f.functionFullPath}:${f.name}`
        : `${f.kind}:${f.name}`,
    );

  // Fast collapse -> expand can re-bind rows that still have a pending
  // named exit transition from the collapse render. Cancel that removal
  // explicitly; otherwise the type header expands but the old exit's
  // `.remove()` fires afterward and leaves an empty detail area.
  sel.interrupt('exit').style('opacity', 1);

  sel
    .exit()
    .interrupt('enter')
    .interrupt('move')
    .transition('exit')
    .duration(ANIM_MS)
    .style('opacity', 0)
    .remove();

  const enter = sel.enter().append('g').attr('class', 'field-row-g').style('opacity', 0);

  // Tour anchors. Each row gets a stable `data-element-id` + kind so
  // the tour bubble can `querySelector` it and compute a pointer
  // position via getBoundingClientRect().
  enter
    .attr('data-element-id', (f) =>
      f.kind === 'method' || f.kind === 'function'
        ? f.functionFullPath ?? `${d.fullPath}::${f.name}`
        : `${d.fullPath}::${f.name}`,
    )
    .attr('data-element-kind', (f) =>
      f.kind === 'method'
        ? 'method'
        : f.kind === 'function'
          ? 'function'
          : f.kind === 'field'
            ? 'field'
            : f.kind,
    );

  // Member-selection background. Sits as the first child so all other
  // row art paints on top of it. CSS fills it when the parent
  // `.field-row-g` is `.selected-member`. Sized on the merged pass
  // below alongside row positioning.
  enter
    .append('rect')
    .attr('class', 'member-bg')
    .attr('fill', 'transparent')
    .style('pointer-events', 'none');

  // Union-diff side markers on each method/field row. Two layers:
  //   • `row-side-bg` paints a faint full-row tint behind everything
  //     else so changes are scannable inside a long type body.
  //   • `row-side-bar` paints a wider left-edge tab (4px) so the
  //     change-side is unmistakable even when the row's label color
  //     blends with surrounding text.
  // Both rects exist on every row; CSS controls visibility via the
  // group's `data-side` attribute, so a row with no side ships them
  // hidden.
  enter
    .append('rect')
    .attr('class', 'row-side-bg')
    .attr('pointer-events', 'none');
  enter
    .append('rect')
    .attr('class', 'row-side-bar')
    .attr('width', 4)
    .attr('height', FIELD_ROW_H)
    .attr('rx', 2)
    .attr('ry', 2)
    .attr('pointer-events', 'none');

  // Append the field name + the (hidden by default) type-text hint once on
  // enter. Crucially, x/y are also set HERE synchronously (in addition
  // to the merged-pass transition below) so that any synchronous
  // measurement done in the same render — most importantly the
  // selection-background's getBBox sizing — sees the text already at
  // its final position. Without this, freshly entered rows measure
  // against a `(0, 0)` default bbox and the selection pills draw far
  // from the row they should hug. The merged transition then has
  // nothing to animate for entering rows (start ≈ end), which is the
  // desired behaviour anyway since the row is also fading in via its
  // group-level opacity tween.
  enter
    .append('text')
    .attr('class', 'field-row')
    .attr('dy', '0.32em')
    .attr('font-size', FONT_SIZE_FIELD)
    .attr('fill', COLOR_FIELD_NAME)
    .attr('x', (f) => f.x - d.x)
    .attr('y', (f) => f.y - groupTopY);

  enter
    .append('rect')
    .attr('class', 'field-ty-bg')
    .attr('rx', 3)
    .attr('ry', 3)
    .attr('fill', COLOR_TY_BG)
    .style('opacity', 0)
    .style('pointer-events', 'none');

  enter
    .append('text')
    .attr('class', 'field-ty')
    .attr('dy', '0.32em')
    .attr('font-size', FONT_SIZE_FIELD)
    .attr('fill', COLOR_FIELD_TY)
    .style('opacity', 0)
    .style('pointer-events', 'none')
    // Stamp the correct initial x/y at enter time. Non-signature rows hide
    // the type via opacity 0 (only fades in on hover), so any default x/y
    // is invisible anyway — but signature_arg rows show it immediately,
    // and without an initial position they animate diagonally from (0,0)
    // to their final spot, looking like a "drop from above".
    .attr('x', (f) =>
      f.kind === 'signature_arg' ? f.x - d.x + f.textWidth + 4 : f.arrowSourceX - d.x,
    )
    .attr('y', (f) => f.y - groupTopY);

  enter.transition('enter').duration(ANIM_MS).style('opacity', 1);

  const merged = enter.merge(sel);

  // Member-selection: highlight the row whose canonical id matches
  // the host's `selectedElementId`. The matcher handles all row
  // shapes uniformly — callables use their pre-resolved
  // `functionFullPath`, fields fall back to `${typePath}::${name}`.
  // Bucket headers and signature args have no element id of their
  // own, so they never match.
  const selId = opts.selectedElementId;
  const selKind = opts.selectedElementKind;
  merged.classed('selected-member', (f) =>
    selId !== null && selKind !== null && rowMatchesSelection(d, f, selId, selKind),
  );

  // Union-diff side markers per row. Tag the group's data-side from
  // the sideByElementId lookup; CSS paints both the left-edge bar and
  // the full-row tint via the rects appended on enter. Same lookup
  // keys the renderer wrote into data-element-id above (so the row's
  // identity for selection and for diff side match).
  merged.attr('data-side', (f) => {
    const elemId =
      f.kind === 'method' || f.kind === 'function'
        ? f.functionFullPath ?? `${d.fullPath}::${f.name}`
        : `${d.fullPath}::${f.name}`;
    const s = opts.sideByElementId?.get(elemId);
    return s === 'base' || s === 'head' ? s : null;
  });
  merged
    .select<SVGRectElement>('rect.row-side-bar')
    // Flush with the obstacle border, matching the type-box side-bar
    // above for a continuous left edge.
    .attr('x', d.boxX - d.x)
    .attr('y', (f) => f.y - groupTopY - ROW_H / 2 + 2);
  // The row-side-bg uses the type-box's obstacle width so the tint
  // spans the same horizontal extent as the member-bg (selection
  // background). That keeps the two layers consistent on a row that
  // is BOTH side-tagged AND selected.
  merged
    .select<SVGRectElement>('rect.row-side-bg')
    .attr('x', d.boxX - d.x)
    .attr('y', (f) => f.y - groupTopY - ROW_H / 2 + 1)
    .attr('width', d.boxWidth)
    .attr('height', Math.max(0, ROW_H - 2));
  // Highlighter band spanning the type's full obstacle width (same
  // extent the selection ring uses). Vertical bounds are inset from
  // ROW_H so the brush stroke hugs the row's text instead of bleeding
  // into the neighbouring rows above and below. The fade gradient
  // tapers both horizontal ends to transparent.
  const MARK_VERTICAL_INSET = 5;
  merged
    .select<SVGRectElement>('rect.member-bg')
    .attr('x', d.boxX - d.x)
    .attr('y', (f) => f.y - groupTopY - ROW_H / 2 + MARK_VERTICAL_INSET)
    .attr('width', d.boxWidth)
    .attr('height', Math.max(0, ROW_H - MARK_VERTICAL_INSET * 2));

  merged.each(function (f) {
    const fg = select(this);
    const localX = f.x - d.x;
    const localY = f.y - groupTopY;

    // Signature argument rows are pure detail with no interactions: just a
    // black name + grey type, always visible. Bail out early so the rest of
    // the row pipeline (selection, chevron, markers, hover) never wires up.
    if (f.kind === 'signature_arg') {
      renderSignatureArgRow(fg, f, localX, localY);
      return;
    }

    const isBorrow =
      f.ownership === 'borrow_immut' ||
      f.ownership === 'borrow_mut' ||
      f.ownership === 'indirection';
    // The selection set is keyed by (typePath, rowKind, name) so a
    // struct field and a method/function with the same name on the same type
    // each toggle independently. f.kind is one of 'field' |
    // 'method_bucket' | 'method' | 'function'; only non-bucket rows participate in
    // selection (bucket headers are handled by the bucket-toggle
    // branch above), so coerce method_bucket → 'field' for the
    // lookup (it returns false either way; the explicit narrow keeps
    // TypeScript happy).
    const rowKind: FieldKeyKind =
      f.kind === 'method' ? 'method' : f.kind === 'function' ? 'function' : 'field';
    const isSelected = opts.selectedFields.has(fieldKey(d.fullPath, f.name, rowKind));
    const isBucketHeader = f.kind === 'method_bucket';
    const isMethod = f.kind === 'method';
    const isFunction = f.kind === 'function';
    const isCallable = isMethod || isFunction;
    const callableKind: 'method' | 'function' | null = isMethod
      ? 'method'
      : isFunction
        ? 'function'
        : null;

    // Visual differentiation by row kind:
    //   - field        → default styling, italic for borrow ownership.
    //   - method_bucket → separate chevron before the aligned label so
    //                     it reads as foldable without shifting the text.
    //   - callable     → italic, regardless of whether Rust declared it at
    //                     module scope or as a type member.
    const display = fieldRowDisplayParts(f, opts.expandedBucketIds);
    const fontWeight = isBucketHeader ? 600 : isSelected ? 600 : 400;
    const fontStyle = isCallable ? 'italic' : isBorrow ? 'italic' : 'normal';
    // Row name color encodes ownership flavor at the boundary the row
    // represents:
    //  - Field rows: color follows the field's type (`&T` → shared,
    //    `&mut T` → mut, `*const/*mut T` → raw, otherwise move).
    //  - Callable rows: color follows the receiver shape (`&self` → shared,
    //    `&mut self` → mut, otherwise move). Locality is a separate
    //    glyph; drift is a separate dot. Buckets keep the default name color.
    let fillColor: string;
    if (f.kind === 'field') {
      fillColor = borrowFlavorColor(borrowFlavor(f.tyText));
    } else if (isCallable) {
      fillColor = borrowFlavorColor(selfKindFlavor(f.selfKind));
    } else {
      fillColor = COLOR_FIELD_NAME;
    }
    // Method indent is baked into f.x by the layout, so localX already
    // reflects it — no renderer-side offset to apply.

    const text = fg
      .select<SVGTextElement>('text.field-row')
      .attr('font-style', fontStyle)
      .attr('font-weight', fontWeight)
      .attr('fill', fillColor)
      .text(display.label);

    text.transition('move').duration(ANIM_MS).attr('x', localX).attr('y', localY);

    let chevron = fg.select<SVGTextElement>('text.method-bucket-chevron');
    if (display.chevron !== null) {
      if (chevron.empty()) {
        chevron = fg
          .insert('text', 'text.field-row')
          .attr('class', 'method-bucket-chevron')
          .attr('dy', '0.32em')
          .attr('fill', COLOR_CHEVRON)
          .style('cursor', 'pointer');
      }
      chevron
        .attr('font-size', METHOD_BUCKET_CHEVRON_FONT_SIZE)
        .attr('font-weight', 700)
        .text(display.chevron)
        .transition('move')
        .duration(ANIM_MS)
        .attr('x', localX - METHOD_BUCKET_CHEVRON_OFFSET)
        .attr('y', localY);
    } else if (!chevron.empty()) {
      chevron.remove();
    }

    // Drift dot: a small filled circle to the left of the field name.
    // Only field rows carry drift; callables and buckets never get a dot.
    // Canonical placements (at_lca / within_budget) render no dot — the
    // absence is the signal "this row is where structural ownership
    // expected it". Drift below = amber, drift above/sideways = red.
    let driftDot = fg.select<SVGCircleElement>('circle.drift-dot');
    const driftColor = f.kind === 'field' ? driftDotColor(f.memberDriftClass) : null;
    if (driftColor !== null) {
      if (driftDot.empty()) {
        driftDot = fg
          .insert('circle', 'text.field-row')
          .attr('class', 'drift-dot')
          .attr('r', DRIFT_DOT_RADIUS)
          .style('pointer-events', 'none');
      }
      driftDot
        .attr('fill', driftColor)
        .transition('move')
        .duration(ANIM_MS)
        .attr('cx', localX - DRIFT_DOT_OFFSET)
        .attr('cy', localY);
    } else if (!driftDot.empty()) {
      driftDot.remove();
    }

    const incomingActive =
      f.functionFullPath !== null && opts.incomingCallTargetsShown.has(f.functionFullPath);
    let incomingMarker = fg.select<SVGTextElement>('text.incoming-call-marker');
    if (isCallable && f.hasIncomingCalls && f.functionFullPath !== null) {
      if (incomingMarker.empty()) {
        incomingMarker = fg
          .insert('text', 'text.field-row')
          .attr('class', 'incoming-call-marker')
          .attr('dy', '0.32em')
          .style('cursor', 'pointer');
      }
      const markerColor = incomingActive ? '#2563eb' : COLOR_CHEVRON;
      incomingMarker
        .attr('font-size', INCOMING_CALL_MARKER_FONT_SIZE)
        .attr('font-weight', incomingActive ? 700 : 500)
        .attr('fill', markerColor)
        .text('→')
        .transition('move')
        .duration(ANIM_MS)
        .attr('x', localX - INCOMING_CALL_MARKER_OFFSET)
        .attr('y', localY);
      const functionFullPath = f.functionFullPath;
      incomingMarker.on('click', (event: MouseEvent) => {
        event.stopPropagation();
        if (callableKind === null) return;
        // Picker fans LEFT (callers flow into the row). Host handles
        // 0/1/many. Same model as the right `→` glyph but mirrored.
        opts.onPickIncomingCaller(functionFullPath, { x: event.clientX, y: event.clientY });
      });
      // Hover: grow the marker and reveal a count badge to its left so
      // the user can see how many incoming calls there are without
      // clicking. The badge is pointer-events: none so it never steals
      // hover from the marker itself.
      const incomingCount = f.incomingCallRefs?.length ?? 0;
      const fgSel = fg;
      incomingMarker
        .on('mouseenter', function () {
          select(this)
            .transition('marker-hover')
            .duration(CALL_MARKER_HOVER_DURATION_MS)
            .attr('font-size', CALL_MARKER_HOVER_FONT_SIZE);
          let badge = fgSel.select<SVGTextElement>('text.incoming-count-badge');
          if (badge.empty()) {
            badge = fgSel
              .insert('text', 'text.field-row')
              .attr('class', 'incoming-count-badge')
              .attr('dy', '0.32em')
              .attr('font-size', INCOMING_CALL_MARKER_FONT_SIZE)
              .attr('text-anchor', 'end')
              .style('pointer-events', 'none')
              .style('opacity', 0);
          }
          badge
            .text(`(${incomingCount})`)
            .attr('fill', markerColor)
            .attr('x', localX - INCOMING_CALL_MARKER_OFFSET - CALL_COUNT_BADGE_GAP)
            .attr('y', localY)
            .transition('marker-hover')
            .duration(CALL_MARKER_HOVER_DURATION_MS)
            .style('opacity', 1);
        })
        .on('mouseleave', function () {
          select(this)
            .transition('marker-hover')
            .duration(CALL_MARKER_HOVER_DURATION_MS)
            .attr('font-size', INCOMING_CALL_MARKER_FONT_SIZE);
          fgSel
            .select<SVGTextElement>('text.incoming-count-badge')
            .transition('marker-hover')
            .duration(CALL_MARKER_HOVER_DURATION_MS)
            .style('opacity', 0);
        });
    } else if (!incomingMarker.empty()) {
      incomingMarker.remove();
      fg.select<SVGTextElement>('text.incoming-count-badge').remove();
    }

    // Locality glyph: a small `→` painted after the callable row name.
    // Color encodes local-only (grey), touches-external (blue), or
    // has-unresolved (orange). CLICK target for arrow selection — the
    // glyph IS the affordance "this row has outgoing call arrows; click
    // to show/hide them". Hidden when the row has no outgoing calls; the
    // reserved space remains so arrowSourceX is stable across redraws.
    let localityGlyph = fg.select<SVGTextElement>('text.locality-glyph');
    if (isCallable && f.hasOutgoingCalls && f.localityGlyphX !== undefined) {
      if (localityGlyph.empty()) {
        localityGlyph = fg
          .insert('text', 'text.field-ty')
          .attr('class', 'locality-glyph')
          .attr('dy', '0.32em')
          .attr('font-size', INCOMING_CALL_MARKER_FONT_SIZE)
          .attr('font-weight', 600)
          .style('cursor', 'pointer')
          .text(LOCALITY_GLYPH);
      }
      const glyphColor = localityGlyphColor(f);
      const glyphX = f.localityGlyphX - d.x;
      localityGlyph
        .attr('fill', glyphColor)
        .transition('move')
        .duration(ANIM_MS)
        .attr('x', glyphX)
        .attr('y', localY);
      if (callableKind !== null && f.functionFullPath !== null) {
        const callerFullPath = f.functionFullPath;
        localityGlyph.on('click', (event: MouseEvent) => {
          event.stopPropagation();
          // Picker opens (or auto-toggles a single edge) instead of
          // flipping the whole row's "show all outgoing" toggle. The
          // host decides 0/1/many handling — we just pass the click
          // anchor in screen coords so the picker can fan rightward.
          opts.onPickOutgoingCall(callerFullPath, { x: event.clientX, y: event.clientY });
        });
      }
      // Hover: grow + reveal outgoing-count badge. Anchored to the
      // glyph's right edge; placed past arrowSourceX (only visible while
      // hovering, so overlapping arrow-exit space is acceptable).
      const outgoingCount = f.callRefs?.length ?? 0;
      const fgSel = fg;
      const glyphRight = (f.arrowSourceX ?? glyphX) - d.x;
      localityGlyph
        .on('mouseenter', function () {
          select(this)
            .transition('marker-hover')
            .duration(CALL_MARKER_HOVER_DURATION_MS)
            .attr('font-size', CALL_MARKER_HOVER_FONT_SIZE);
          let badge = fgSel.select<SVGTextElement>('text.locality-count-badge');
          if (badge.empty()) {
            badge = fgSel
              .insert('text', 'text.field-row')
              .attr('class', 'locality-count-badge')
              .attr('dy', '0.32em')
              .attr('font-size', INCOMING_CALL_MARKER_FONT_SIZE)
              .style('pointer-events', 'none')
              .style('opacity', 0);
          }
          badge
            .text(`(${outgoingCount})`)
            .attr('fill', glyphColor)
            .attr('x', glyphRight + CALL_COUNT_BADGE_GAP)
            .attr('y', localY)
            .transition('marker-hover')
            .duration(CALL_MARKER_HOVER_DURATION_MS)
            .style('opacity', 1);
        })
        .on('mouseleave', function () {
          select(this)
            .transition('marker-hover')
            .duration(CALL_MARKER_HOVER_DURATION_MS)
            .attr('font-size', INCOMING_CALL_MARKER_FONT_SIZE);
          fgSel
            .select<SVGTextElement>('text.locality-count-badge')
            .transition('marker-hover')
            .duration(CALL_MARKER_HOVER_DURATION_MS)
            .style('opacity', 0);
        });
    } else if (!localityGlyph.empty()) {
      localityGlyph.remove();
      fg.select<SVGTextElement>('text.locality-count-badge').remove();
    }

    const tyText = fg
      .select<SVGTextElement>('text.field-ty')
      .attr('x', f.arrowSourceX - d.x)
      .attr('y', localY)
      .text(f.tyText);
    const tyBg = fg.select<SVGRectElement>('rect.field-ty-bg');

    const handleRowClick = (event: MouseEvent): void => {
      event.stopPropagation();
      if (event.metaKey || event.ctrlKey) {
        // Cmd/Ctrl+click on a row opens the code panel at the member's
        // span. Bucket headers ("pub fn (5)" etc.) don't have their
        // own span, so skip them. For callable rows we prefer the
        // pre-resolved `functionFullPath` because free functions live
        // under a `function_group` pseudo-type — its `fullPath` is the
        // bucket id, not the module path, so `${d.fullPath}::${f.name}`
        // would miss the span-index entry.
        if (!isBucketHeader) {
          if (f.kind === 'method' && f.functionFullPath !== null) {
            opts.onShowCode(f.functionFullPath, 'method');
          } else if (f.kind === 'function' && f.functionFullPath !== null) {
            opts.onShowCode(f.functionFullPath, 'function');
          } else if (f.kind === 'field') {
            opts.onShowCode(`${d.fullPath}::${f.name}`, 'field');
          }
        }
        return;
      }
      if (isBucketHeader) {
        if (f.bucketId !== null) opts.onToggle(f.bucketId);
      } else if (isCallable && f.functionFullPath !== null) {
        // Callable name click: ONLY expand the signature. Arrow selection
        // moved to the `→` glyph on the row's right side, so each
        // affordance owns exactly one effect and never side-effects the
        // other.
        opts.onToggleSignature(f.functionFullPath);
      } else if (f.kind === 'field') {
        // Field rows keep name-click → selection. Fields have no
        // signature to expand and selecting them is the only useful row
        // action.
        opts.onSelectField(d.fullPath, f.name, 'field');
      }
    };
    text.on('click', handleRowClick);
    if (display.chevron === null) {
      chevron.on('click', null);
    } else {
      chevron.on('click', handleRowClick);
    }

    // Type-hint stays for TY_HIDE_DELAY ms after mouse-out, so a glance
    // away doesn't immediately erase what the user just looked at. Re-entry
    // within the delay cancels the pending hide. Timer is stashed on the
    // DOM node so it survives re-renders (data-join keeps the same element).
    const node = text.node() as (SVGTextElement & { __sfTyTimer?: number | undefined }) | null;
    text.on('mouseenter', () => {
      if (callableKind === null) {
        const hover = directArrowsFrom(layout, d.fullPath, f.name, rowKind);
        const union = new Set<Layout['arrows'][number]>(opts.selectedArrows);
        for (const a of hover) union.add(a);
        applyArrowHighlight(zoomLayer, union);
      }
      // Debug overlay: hover any expanded row to inspect its layout facts.
      // Callable rows get the call-graph variant, field rows get the
      // ownership variant. method_bucket headers get no panel.
      if (layoutDebugEnabled()) {
        if (isCallable) {
          showCallableDebugPanel(layout, d, f, rowKind, text.node());
        } else if (f.kind === 'field') {
          showFieldDebugPanel(layout, d, f, text.node());
        }
      }
      // Callable rows no longer flash their signature on hover — the
      // signature is now an explicit click affordance via the (..) toggle.
      // Field rows keep the hover-type-hint because their type is short
      // and there is no equivalent click affordance.
      if (isCallable) return;
      if (node?.__sfTyTimer !== undefined) {
        clearTimeout(node.__sfTyTimer);
        node.__sfTyTimer = undefined;
      }
      tyText.attr('x', hoveredTextRight(text) + TY_TEXT_GAP);
      sizeTypeHintBackground(tyText, tyBg);
      tyBg.transition('ty').duration(120).style('opacity', 1);
      tyText.transition('ty').duration(120).style('opacity', 1);
    });
    text.on('mouseleave', () => {
      if (callableKind === null) {
        applyArrowHighlight(zoomLayer, opts.selectedArrows);
      }
      // Hide whichever debug variant was showing — both callable and
      // field rows route through the same panel + hide timer.
      if (isCallable || f.kind === 'field') hideCallableDebugPanel();
      if (isCallable) return;
      if (!node) return;
      if (node.__sfTyTimer !== undefined) clearTimeout(node.__sfTyTimer);
      node.__sfTyTimer = window.setTimeout(() => {
        tyBg.transition('ty').duration(200).style('opacity', 0);
        tyText.transition('ty').duration(200).style('opacity', 0);
        node.__sfTyTimer = undefined;
      }, TY_HIDE_DELAY);
    });

    // Selection now matches hover: bold text plus selected arrows, without a
    // background pill competing with the member's drift color.
    fg.select<SVGRectElement>('rect.focus-bg').remove();
  });
}

function renderSignatureArgRow(
  fg: Selection<SVGGElement, unknown, null, undefined>,
  row: { name: string; tyText: string; textWidth: number },
  localX: number,
  localY: number,
): void {
  // Ownership flavor drives color. For self rows the ownership annotation
  // lives on the NAME (`&mut self` / `&self` / `self`); for params and the
  // return row it lives on the TYPE text. The single borrowFlavor helper
  // handles both because both shapes start with `&` or not.
  const isReturn = row.name === '->';
  const isSelf = !isReturn && row.tyText === '';
  const flavor = borrowFlavor(isSelf ? row.name : row.tyText);
  const flavorColor = borrowFlavorColor(flavor);
  // Param/return row names stay in their baseline colors so the user's eye
  // can still scan a column of names quickly. The flavor decoration lives
  // on the type half. Self rows get the flavor on the name itself because
  // there is no type text to carry it.
  const nameColor = isSelf ? flavorColor : isReturn ? COLOR_FIELD_TY : COLOR_FIELD_NAME;
  const text = fg
    .select<SVGTextElement>('text.field-row')
    .attr('font-style', 'normal')
    .attr('font-weight', 400)
    .attr('fill', nameColor)
    .text(row.name);
  text.on('click', null).on('mouseenter', null).on('mouseleave', null);
  text.transition('move').duration(ANIM_MS).attr('x', localX).attr('y', localY);

  const ty = fg.select<SVGTextElement>('text.field-ty');
  ty.text(row.tyText)
    .attr('fill', flavorColor)
    .style('opacity', row.tyText === '' ? 0 : 1)
    .style('pointer-events', 'none');
  ty.transition('move')
    .duration(ANIM_MS)
    .attr('x', localX + row.textWidth + 4)
    .attr('y', localY);

  // Keep the ty background hidden — signature rows render plain text on the
  // type-box background, not a hover pill.
  fg.select<SVGRectElement>('rect.field-ty-bg').style('opacity', 0);

  // Sweep up any inline glyphs left over from a previous render where this
  // DOM node carried a callable or field row instead of a signature arg.
  fg.select<SVGTextElement>('text.method-bucket-chevron').remove();
  fg.select<SVGTextElement>('text.incoming-call-marker').remove();
  fg.select<SVGTextElement>('text.locality-glyph').remove();
  fg.select<SVGTextElement>('text.incoming-count-badge').remove();
  fg.select<SVGTextElement>('text.locality-count-badge').remove();
  fg.select<SVGCircleElement>('circle.drift-dot').remove();
}

function hoveredTextRight(text: Selection<SVGTextElement, unknown, null, undefined>): number {
  const node = text.node();
  if (!node) return 0;
  const bbox = node.getBBox();
  return bbox.x + bbox.width;
}

function showCallableDebugPanel(
  layout: Layout,
  typeNode: Layout['types'][number],
  row: Layout['types'][number]['fields'][number],
  rowKind: FieldKeyKind,
  anchorNode: SVGTextElement | null,
): void {
  if (anchorNode === null) return;
  cancelCallableDebugPanelHide();

  const panel = ensureCallableDebugPanel();
  panel.replaceChildren();

  appendDiv(
    panel,
    'cd-kicker',
    row.kind === 'method' ? 'method call facts' : 'function call facts',
  );
  appendDiv(panel, 'cd-title', row.name);
  appendDiv(panel, 'cd-path', row.functionFullPath ?? `${typeNode.fullPath}::${row.name}`);

  const summary = appendDiv(panel, 'cd-grid');
  appendDebugPair(summary, 'signature', row.tyText === '' ? '(none)' : row.tyText);
  appendDebugPair(summary, 'container', typeNode.fullPath);
  appendDebugPair(summary, 'module', typeNode.modulePath || '(crate root)');
  appendDebugPair(summary, 'row kind', rowKind);
  appendDebugPair(summary, 'text color', callableDebugColorLabel(row));
  appendDebugPair(summary, 'outgoing calls', String(row.callRefs.length));
  appendDebugPair(summary, 'incoming calls', String(row.incomingCallRefs.length));
  appendDebugPair(summary, 'known target rows', String(row.callTargets.length));

  const routedOutgoingCallArrows = renderableArrows(layout).filter(
    (arrow) =>
      arrow.kind === 'call' &&
      arrow.fromTypeId === typeNode.fullPath &&
      arrow.fromFieldName === row.name &&
      arrow.fromRowKind === rowKind,
  );
  const routedIncomingCallArrows = renderableArrows(layout).filter(
    (arrow) =>
      arrow.kind === 'call' &&
      arrow.toTypeId === typeNode.fullPath &&
      arrow.toFieldName === row.name &&
      arrow.toRowKind === rowKind,
  );
  appendDebugPair(summary, 'routed outgoing', String(routedOutgoingCallArrows.length));
  appendDebugPair(summary, 'routed incoming', String(routedIncomingCallArrows.length));

  appendArrowSection(panel, 'Routed outgoing call arrows', routedOutgoingCallArrows, 'outgoing');
  appendArrowSection(panel, 'Routed incoming call arrows', routedIncomingCallArrows, 'incoming');
  appendCallSection(panel, layout, 'Outgoing call facts', row.callRefs, 'outgoing');
  appendCallSection(panel, layout, 'Incoming call facts', row.incomingCallRefs, 'incoming');

  panel.style.display = 'block';
  positionCallableDebugPanel(panel, anchorNode.getBoundingClientRect());
}

// Debug overlay for a hovered field row. Shares panel + hide/show
// machinery with the callable variant — only the content differs.
// Renders when layoutDebugEnabled(); off by default.
function showFieldDebugPanel(
  layout: Layout,
  typeNode: Layout['types'][number],
  row: Layout['types'][number]['fields'][number],
  anchorNode: SVGTextElement | null,
): void {
  if (anchorNode === null) return;
  cancelCallableDebugPanelHide();

  const panel = ensureCallableDebugPanel();
  panel.replaceChildren();

  appendDiv(panel, 'cd-kicker', 'field facts');
  appendDiv(panel, 'cd-title', row.name);
  appendDiv(panel, 'cd-path', `${typeNode.fullPath}::${row.name}`);

  const summary = appendDiv(panel, 'cd-grid');
  appendDebugPair(summary, 'type', row.tyText === '' ? '(none)' : row.tyText);
  appendDebugPair(summary, 'ownership', row.ownership);
  appendDebugPair(summary, 'container', typeNode.fullPath);
  appendDebugPair(summary, 'module', typeNode.modulePath || '(crate root)');
  appendDebugPair(summary, 'kind', row.kind);
  appendDebugPair(summary, 'drift class', row.memberDriftClass ?? '(none)');
  appendDebugPair(
    summary,
    'borrow flavor',
    row.tyText === '' ? '(no type)' : borrowFlavor(row.tyText),
  );

  const outgoingOwnership = renderableArrows(layout).filter(
    (arrow) =>
      arrow.kind === 'ownership' &&
      arrow.fromTypeId === typeNode.fullPath &&
      arrow.fromFieldName === row.name &&
      arrow.fromRowKind === 'field',
  );
  const incomingOwnership = renderableArrows(layout).filter(
    (arrow) =>
      arrow.kind === 'ownership' &&
      arrow.toTypeId === typeNode.fullPath &&
      arrow.toFieldName === row.name,
  );
  appendDebugPair(summary, 'routed outgoing', String(outgoingOwnership.length));
  appendDebugPair(summary, 'routed incoming', String(incomingOwnership.length));

  appendArrowSection(panel, 'Outgoing ownership arrows', outgoingOwnership, 'outgoing');
  appendArrowSection(panel, 'Incoming ownership arrows', incomingOwnership, 'incoming');

  panel.style.display = 'block';
  positionCallableDebugPanel(panel, anchorNode.getBoundingClientRect());
}

// Debug overlay for a hovered type header. Anchored to whichever element
// fires the hover — typically the header label, the hit rect, or the
// dot. Shows the type identity facts plus the static ownership counts
// (how many types own this one / how many it owns) so the user can
// compare against routed arrows to spot routing gaps.
function showTypeDebugPanel(
  layout: Layout,
  ownership: OwnershipIndex,
  typeNode: Layout['types'][number],
  anchorNode: SVGGraphicsElement | null,
): void {
  if (anchorNode === null) return;
  cancelCallableDebugPanelHide();

  const panel = ensureCallableDebugPanel();
  panel.replaceChildren();

  appendDiv(panel, 'cd-kicker', typeNode.isGhost ? 're-export facts' : 'type facts');
  appendDiv(panel, 'cd-title', typeNode.label);
  appendDiv(panel, 'cd-path', typeNode.fullPath);

  const summary = appendDiv(panel, 'cd-grid');
  appendDebugPair(summary, 'kind', typeNode.typeKind);
  appendDebugPair(summary, 'visibility', typeNode.visibility);
  appendDebugPair(summary, 'module', typeNode.modulePath || '(crate root)');
  appendDebugPair(summary, 'fields', String(typeNode.fields.length));
  appendDebugPair(summary, 'total fields', String(typeNode.totalFieldCount));
  appendDebugPair(summary, 'expanded', typeNode.expanded ? 'yes' : 'no');
  appendDebugPair(summary, 'has fields', typeNode.hasFields ? 'yes' : 'no');
  appendDebugPair(summary, 'is ghost', typeNode.isGhost ? 'yes' : 'no');
  if (typeNode.ghostTarget !== null) {
    appendDebugPair(summary, 'ghost target', typeNode.ghostTarget);
  }

  // Static ownership counts come from the analysis index — they don't
  // depend on what's currently expanded or routed. Comparing them with
  // the rendered arrow lists below makes routing gaps visible: "5 owners
  // exist but only 2 incoming arrows routed → 3 owners are collapsed".
  const owners = ownership.ownedBy.get(typeNode.fullPath) ?? [];
  const owns = ownership.owns.get(typeNode.fullPath) ?? [];
  appendDebugPair(summary, 'owners', String(owners.length));
  appendDebugPair(summary, 'owns', String(owns.length));

  appendTypeListSection(panel, 'Owners (analysis)', owners);
  appendTypeListSection(panel, 'Owns (analysis)', owns);

  const outgoing = renderableArrows(layout).filter((arrow) => arrow.fromTypeId === typeNode.id);
  const incoming = renderableArrows(layout).filter((arrow) => arrow.toTypeId === typeNode.id);
  appendArrowSection(panel, 'Outgoing arrows (routed)', outgoing, 'outgoing');
  appendArrowSection(panel, 'Incoming arrows (routed)', incoming, 'incoming');

  panel.style.display = 'block';
  positionCallableDebugPanel(panel, anchorNode.getBoundingClientRect());
}

// Renders a list of type fullPaths under a section title. Caps the
// displayed entries to keep the panel scannable; if the analysis records
// more, the cap line shows the overflow count.
function appendTypeListSection(
  panel: HTMLDivElement,
  title: string,
  typePaths: readonly string[],
): void {
  appendDiv(panel, 'cd-section-title', title);
  if (typePaths.length === 0) {
    appendDiv(panel, 'cd-empty', 'none');
    return;
  }
  const list = appendDiv(panel, 'cd-list');
  for (const path of typePaths.slice(0, CALLABLE_DEBUG_MAX_CALLS)) {
    appendDiv(list, 'cd-line', path);
  }
  appendMoreIfNeeded(panel, typePaths.length);
}

function hideCallableDebugPanel(): void {
  if (callableDebugHideTimer !== undefined) clearTimeout(callableDebugHideTimer);
  callableDebugHideTimer = window.setTimeout(() => {
    hideCallableDebugPanelNow();
    callableDebugHideTimer = undefined;
  }, 80);
}

function hideCallableDebugPanelNow(): void {
  const panel = document.getElementById('callable-debug');
  if (panel instanceof HTMLDivElement) {
    panel.style.display = 'none';
  }
}

function cancelCallableDebugPanelHide(): void {
  if (callableDebugHideTimer === undefined) return;
  clearTimeout(callableDebugHideTimer);
  callableDebugHideTimer = undefined;
}

function ensureCallableDebugPanel(): HTMLDivElement {
  const existing = document.getElementById('callable-debug');
  if (existing instanceof HTMLDivElement) return existing;

  const panel = document.createElement('div');
  panel.id = 'callable-debug';
  panel.style.position = 'fixed';
  panel.style.pointerEvents = 'auto';
  panel.style.zIndex = '23';
  panel.style.display = 'none';
  panel.addEventListener('mouseenter', cancelCallableDebugPanelHide);
  panel.addEventListener('mouseleave', hideCallableDebugPanelNow);
  document.body.appendChild(panel);
  return panel;
}

function positionCallableDebugPanel(panel: HTMLDivElement, anchor: DOMRect): void {
  panel.style.left = '0px';
  panel.style.top = '0px';
  const rect = panel.getBoundingClientRect();

  let left = anchor.right + DEBUG_PANEL_MARGIN;
  let top = anchor.top;
  if (left + rect.width > window.innerWidth - DEBUG_PANEL_MARGIN) {
    left = Math.max(DEBUG_PANEL_MARGIN, anchor.left - rect.width - DEBUG_PANEL_MARGIN);
  }
  if (top + rect.height > window.innerHeight - DEBUG_PANEL_MARGIN) {
    top = Math.max(DEBUG_PANEL_MARGIN, window.innerHeight - rect.height - DEBUG_PANEL_MARGIN);
  }
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}

function appendArrowSection(
  panel: HTMLDivElement,
  title: string,
  arrows: readonly Layout['arrows'][number][],
  direction: 'outgoing' | 'incoming',
): void {
  appendDiv(panel, 'cd-section-title', title);
  if (arrows.length === 0) {
    appendDiv(panel, 'cd-empty', 'none currently routed');
    return;
  }

  const list = appendDiv(panel, 'cd-list');
  for (const arrow of arrows.slice(0, CALLABLE_DEBUG_MAX_CALLS)) {
    const endpoint =
      direction === 'outgoing'
        ? arrow.toFieldName === undefined
          ? arrow.toTypeId
          : `${arrow.toTypeId}.${arrow.toFieldName}${callableSuffix(arrow.toRowKind)}`
        : `${arrow.fromTypeId}.${arrow.fromFieldName}${callableSuffix(
            arrow.fromRowKind === 'field' ? undefined : arrow.fromRowKind,
          )}`;
    appendDiv(list, 'cd-line', `${direction === 'outgoing' ? '->' : '<-'} ${endpoint}`);
  }
  appendMoreIfNeeded(panel, arrows.length);
}

function appendCallSection(
  panel: HTMLDivElement,
  layout: Layout,
  title: string,
  calls: Layout['types'][number]['fields'][number]['callRefs'],
  direction: 'outgoing' | 'incoming',
): void {
  appendDiv(panel, 'cd-section-title', title);
  if (calls.length === 0) {
    appendDiv(
      panel,
      'cd-empty',
      direction === 'outgoing'
        ? 'no outgoing call edges attached'
        : 'no incoming call edges attached',
    );
    return;
  }

  const list = appendDiv(panel, 'cd-list');
  for (const call of calls.slice(0, CALLABLE_DEBUG_MAX_CALLS)) {
    const item = appendDiv(list, 'cd-call');
    const endpointRow = direction === 'outgoing' ? call.calleeRow : call.callerRow;
    const endpoint =
      endpointRow === null
        ? call.callee
        : `${endpointRow.typeId}.${endpointRow.rowName}${callableSuffix(endpointRow.rowKind)}`;
    appendDiv(
      item,
      'cd-call-main',
      `${direction === 'outgoing' ? '->' : '<-'} ${localityGlyph(call.locality)} ${endpoint}`,
    );
    appendDiv(
      item,
      'cd-call-meta',
      `${call.locality} | ${call.kind} | ${call.resolution} | ${targetRowVisibility(layout, endpointRow)}`,
    );
    if (call.origin !== '') {
      appendDiv(item, 'cd-call-origin', `origin: ${call.origin}`);
    }
  }
  appendMoreIfNeeded(panel, calls.length);
}

function appendMoreIfNeeded(panel: HTMLDivElement, total: number): void {
  const hidden = total - CALLABLE_DEBUG_MAX_CALLS;
  if (hidden > 0) appendDiv(panel, 'cd-more', `+${hidden} more`);
}

function callableDebugColorLabel(row: {
  readonly callsOutsideModule: boolean;
  readonly hasExternalCalls: boolean;
  readonly hasUnresolvedCalls: boolean;
  readonly hasOutgoingCalls: boolean;
}): string {
  if (row.hasExternalCalls) return 'blue: has resolved calls outside this module';
  if (row.hasUnresolvedCalls) return 'orange: has unresolved calls and no external targets';
  if (row.hasOutgoingCalls) return 'black: calls only inside this module';
  return 'grey: leaf/no outgoing calls';
}

function targetRowVisibility(
  layout: Layout,
  row: Layout['types'][number]['fields'][number]['callRefs'][number]['calleeRow'],
): string {
  if (row === null) return 'no matched graph row';
  const targetType = layout.types.find((typeNode) => typeNode.fullPath === row.typeId);
  if (targetType === undefined) return 'target type not in current layout';
  if (!targetType.expanded) return 'target type collapsed';
  const targetRow = targetType.fields.find(
    (candidate) => candidate.kind === row.rowKind && candidate.name === row.rowName,
  );
  return targetRow === undefined ? 'target row hidden' : 'target row visible';
}

function localityGlyph(locality: 'same_module' | 'other_module' | 'unresolved'): string {
  switch (locality) {
    case 'same_module':
      return 'local';
    case 'other_module':
      return 'external';
    case 'unresolved':
      return 'unresolved';
  }
}

function callableSuffix(kind: 'method' | 'function' | undefined): string {
  return kind === undefined ? '' : '()';
}

function appendDebugPair(parent: HTMLElement, key: string, value: string): void {
  appendDiv(parent, 'cd-key', key);
  appendDiv(parent, 'cd-value', value);
}

function appendDiv(parent: HTMLElement, className: string, text?: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  if (text !== undefined) el.textContent = text;
  parent.appendChild(el);
  return el;
}

function sizeTypeHintBackground(
  tyText: Selection<SVGTextElement, unknown, null, undefined>,
  tyBg: Selection<SVGRectElement, unknown, null, undefined>,
): void {
  const node = tyText.node();
  if (!node) return;
  const bbox = node.getBBox();
  tyBg
    .attr('x', bbox.x - TY_BG_PAD_X)
    .attr('y', bbox.y - TY_BG_PAD_Y)
    .attr('width', bbox.width + 2 * TY_BG_PAD_X)
    .attr('height', bbox.height + 2 * TY_BG_PAD_Y);
}

function sizeTypeHits(
  sel: Selection<SVGGElement, Layout['types'][number], SVGGElement, unknown>,
): void {
  // Type header sizing is produced by layout from the same text measurer used
  // for placement. Consuming that contract here avoids SVG getBBox() calls in
  // the click redraw path, where they force a browser layout before animation.
  sel.each(function (d) {
    const gg = select(this);
    if (d.headerArrowX !== null) {
      gg.select<SVGTextElement>('text.expand-arrow').attr('x', d.headerArrowX);
      gg.select<SVGRectElement>('rect.expand-hit').attr('width', d.headerArrowX);
      gg.select<SVGRectElement>('rect.expand-arrow-hit')
        .attr('x', d.headerArrowX)
        .attr('width', Math.max(16, d.headerHitWidth - d.headerArrowX));
    } else {
      gg.select<SVGRectElement>('rect.expand-hit').attr('width', d.headerHitWidth);
    }
  });
}
