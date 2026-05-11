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

import { type Selection, pointer, select, zoomTransform } from 'd3';
import { type ArrowHit, pickArrowsAtPoint } from '../analysis/arrow_hit.ts';
import { type BorrowFlavor, borrowFlavor } from '../analysis/borrow_flavor.ts';
import type { DriftClass } from '../analysis/drift.ts';
import {
  BASE_FONT_SIZE,
  HIT_MIN_W,
  INCOMING_CALL_MARKER_OFFSET,
  LAYOUT_GRID_CELL_W,
  MODULE_LABEL_X,
  TYPE_EXPAND_ARROW_CLOSED,
  TYPE_EXPAND_ARROW_FONT_SIZE,
  TYPE_EXPAND_ARROW_OPEN,
  TYPE_LABEL_FONT_SIZE,
  TYPE_LABEL_X,
  splitModuleDisplayLabel,
} from '../analysis/layout_metrics.ts';
import { type Layout, ROW_H } from '../analysis/layout_model.ts';
import { colorForVisibility } from './encoding.ts';
import { ANIM_MS, type ZoomLayers } from './zoom.ts';

// Screen-space hit tolerances for arrow click navigation. Converted to
// data-space by dividing by the current zoom scale, so the on-screen hit
// area stays roughly constant regardless of zoom level.
// `ARROW_ENDPOINT_PX` defines the arc-length window at each end of the
// polyline that counts as a direct-nav zone (source / target). Beyond
// that window, the click falls into the middle and opens the disambig
// popup so the user picks a direction explicitly.
const ARROW_HIT_PX = 8;
const ARROW_ENDPOINT_PX = 50;

const TYPE_RADIUS = 4;
// Module rows still use a left chevron for expand/collapse.
const CHEVRON_X = 6;
// Type box layout: dot at x=6, a small italic kind marker (𝑠/𝑒/𝑢/𝑡/𝑎)
// at x=14, then the label at x=24. The kind marker replaces the deleted
// hover tooltip — kind is now inline. Tight spacing because the math
// italic glyphs are narrow.
const TYPE_CIRCLE_X = 6;
const TYPE_KIND_MARKER_X = 14;

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
const FONT_SIZE_MODULE_PREFIX = 12; // base size — bumped to read clearly when the label sits over diagram content
const FONT_SIZE_MODULE_CHEVRON = 14; // bumped above the base + bold so the
// "+/-" expand affordance reads clearly without changing direction-neutral
// semantics (modules expand both vertically and horizontally).

const COLOR_LABEL = '#1e293b';
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

function borrowFlavorColor(flavor: BorrowFlavor): string {
  switch (flavor) {
    case 'move':
      return COLOR_BORROW_MOVE;
    case 'shared':
      return COLOR_BORROW_SHARED;
    case 'mut':
      return COLOR_BORROW_MUT;
  }
}
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
const COLOR_ARROW_CANONICAL = '#94a3b8'; // slate-400: at_lca / within_budget — neutral context
// Highlighted-canonical color (#3b82f6 blue) is applied via CSS in
// index.html (`.canonical.highlighted { stroke: ... }`) so the marker
// arrowhead can pick it up via context-stroke without per-state JS.
const COLOR_ARROW_SOFT = '#f59e0b'; // amber: drift_below
const COLOR_ARROW_HARD = '#ef4444'; // red:   drift_above / drift_sideways
const COLOR_MEMBER_CANONICAL = '#3b82f6'; // blue-500: canonical ownership member
const COLOR_MEMBER_DRIFT_BELOW = '#d97706'; // amber-600: deeper label for drift_below
// Re-exports get their own dedicated color and dashed style so they read
// as a separate edge category — they're not ownership, they're naming.
// The violet stroke alone is enough identity, so re-exports can afford
// the subtler short-symmetric pattern.
const COLOR_ARROW_REEXPORT = '#a855f7'; // violet-500
// Blue for cross-module call arrows. Matches the row-name color used by
// callableRowColor() for rows that have any external outgoing call, so a
// row labeled in blue draws blue arrows to its callees in other modules.
const COLOR_CALL_EXTERNAL = '#2563eb';
const REEXPORT_DASH = '2 2';
// Method-reference arrows show up far more often than re-exports and
// render in plain canonical grey, so they need the higher pixel
// density to actually read against the canvas tint. Asymmetric
// pattern keeps them rhythmically distinct from re-export's symmetric
// short dashes. Saves animation for a future data-flow layer.
const METHOD_DASH = '4 3';

const ARROW_MARKER_IDS: Readonly<Record<DriftClass, string>> = {
  at_lca: 'sf-arrow-canonical',
  within_budget: 'sf-arrow-canonical',
  drift_below: 'sf-arrow-soft',
  drift_above: 'sf-arrow-hard',
  drift_sideways: 'sf-arrow-hard',
};

function arrowColor(a: Layout['arrows'][number]): string {
  if (a.kind === 'reexport') return COLOR_ARROW_REEXPORT;
  // Call arrows are colored by locality, matching the row-name color
  // policy in callableRowColor: cross-module calls draw attention in blue,
  // same-module calls recede into the canonical grey background. Locality
  // is set at routing time so the renderer doesn't recompute it.
  if (a.kind === 'call') {
    return a.locality === 'external' ? COLOR_CALL_EXTERNAL : COLOR_ARROW_CANONICAL;
  }
  const c = a.driftClass;
  if (c === 'at_lca' || c === 'within_budget') return COLOR_ARROW_CANONICAL;
  if (c === 'drift_below') return COLOR_ARROW_SOFT;
  return COLOR_ARROW_HARD;
}

export function memberRowColorForArrows(
  arrows: readonly Layout['arrows'][number][],
): string | null {
  let strongest: Layout['arrows'][number] | null = null;
  let strongestRank = 0;
  for (const arrow of arrows) {
    if (arrow.kind !== 'ownership') continue;
    const rank = driftSeverity(arrow.driftClass);
    if (rank > strongestRank) {
      strongest = arrow;
      strongestRank = rank;
    }
  }
  return strongest === null ? null : memberColorForDriftClass(strongest.driftClass);
}

export function memberColorForDriftClass(driftClass: DriftClass | null): string | null {
  if (driftClass === null) return null;
  switch (driftClass) {
    case 'at_lca':
    case 'within_budget':
      return COLOR_MEMBER_CANONICAL;
    case 'drift_below':
      return COLOR_MEMBER_DRIFT_BELOW;
    case 'drift_above':
    case 'drift_sideways':
      return COLOR_ARROW_HARD;
  }
}

export function callableRowColor(row: {
  readonly callsOutsideModule: boolean;
  readonly hasExternalCalls?: boolean;
  readonly hasUnresolvedCalls?: boolean;
  readonly hasOutgoingCalls: boolean;
}): string {
  if (row.hasExternalCalls ?? row.callsOutsideModule) return '#2563eb';
  if (row.hasUnresolvedCalls === true) return '#f97316';
  return row.hasOutgoingCalls ? COLOR_FIELD_NAME : COLOR_FIELD_TY;
}

function driftSeverity(driftClass: DriftClass): number {
  switch (driftClass) {
    case 'drift_above':
    case 'drift_sideways':
      return 3;
    case 'drift_below':
      return 2;
    case 'at_lca':
    case 'within_budget':
      return 1;
  }
}

/** One-character kind marker rendered between the visibility dot and the
 *  type label. Replaces the deleted hover tooltip — kind is now inline.
 *
 *  We use the Unicode "Mathematical Italic Small" block so the glyph
 *  renders as a serif italic across every platform without needing a
 *  font-style override or a serif font in the family stack. Reads like
 *  the variable letters in a math formula — small, italic, secondary —
 *  which is exactly the visual register we want for an annotation
 *  alongside the more prominent label.
 *
 *  Function-groups self-identify via their "pub fn (N)" / "local fn (N)" label,
 *  so they get no marker. Ghosts inherit the canonical's TypeKind via
 *  the extractor's `re.target_kind` field, so they get the same marker
 *  as the type they alias — italic label + hollow ring still
 *  distinguish ghost from real. */
function kindMarker(d: Layout['types'][number]): string | null {
  switch (d.typeKind) {
    case 'struct':
      return '𝑠';
    case 'enum':
      return '𝑒';
    case 'union':
      return '𝑢';
    case 'trait':
      return '𝑡';
    case 'type_alias':
      return '𝑎';
    case 'function_group':
      return null;
    default:
      return null;
  }
}

export interface TreeRenderOptions {
  /** Single-row click on a module or type → toggle expansion. Expansion is
   *  the only "focus" concept — there is no separate selected-types set. */
  readonly onToggle: (id: string) => void;
  /** Click on a type header chevron → toggle expansion. Opening selects
   *  field rows by default and expands callable buckets without selecting
   *  function rows; closing deselects hidden member rows. */
  readonly onToggleTypeMembers: (typePath: string) => void;
  /** Click on a field name → toggle its selection. */
  readonly onSelectField: (typePath: string, fieldName: string, kind: FieldKeyKind) => void;
  readonly onToggleIncomingCalls: (
    typePath: string,
    fieldName: string,
    kind: 'method' | 'function',
    functionFullPath: string,
  ) => void;
  /** Click on a function/method row's `(..)` glyph → toggle whether that
   *  function's signature is expanded into indented argument rows. */
  readonly onToggleSignature: (functionFullPath: string) => void;
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
  /** Hover on a type's dot → show the incoming-ownership popover. The
   *  callback receives the type's full path and a `getDotScreenPos`
   *  closure that returns the dot's current screen-space center. The
   *  overlay calls it on each pan/zoom while pinned, so the panel stays
   *  anchored to the moving dot. `onHideOwners` is fired when the cursor
   *  leaves the dot — the overlay handles the post-leave grace period. */
  readonly onShowOwners: (
    typePath: string,
    getDotScreenPos: () => { x: number; y: number },
  ) => void;
  readonly onHideOwners: () => void;
  /** Click on a type's dot → expand every type that owns it (and the
   *  modules containing those owners), so all incoming arrows render. */
  readonly onExpandAllOwners: (typePath: string) => void;
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
}

// Separator for fieldKey. We can't use `::` because both parts may
// contain it: typePath has it as the module separator, and field names
// for enum variant payloads are encoded as `Variant::payload` (e.g.
// `Global::.0`). ASCII unit-separator (\x1F) is reserved for exactly
// this kind of structural delimiter and never appears in identifiers
// or extractor output.
const FIELD_KEY_SEP = '\x1F';
let callableDebugHideTimer: number | undefined;

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
  const moduleG = ensureGroup(frozenLayer, 'modules');

  renderBandBackgrounds(bandG, layout);
  renderLayoutDebug(debugG, layout);
  if (!layoutDebugEnabled()) hideCallableDebugPanelNow();
  renderArrows(arrowG, layout, opts.selectedArrows);
  renderTypes(typeG, zoomLayer, layout, opts);
  renderModules(moduleG, layout, opts);
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
  const svgEl = layers.zoomLayer.ownerSVGElement;
  if (!svgEl) return;
  zoomLayer.on('click.arrow-nav', (event: MouseEvent) => {
    // pointer(event, container) returns the click in `container`'s local
    // coords — for the zoom layer that IS data-space, since the layer
    // itself carries the zoom transform.
    const [x, y] = pointer(event, layers.zoomLayer);
    const k = zoomTransform(svgEl).k || 1;
    const hits = pickArrowsAtPoint({ x, y }, hitTestableArrows(layout), {
      hitTolerance: ARROW_HIT_PX / k,
      endpointRadius: ARROW_ENDPOINT_PX / k,
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

function renderBandBackgrounds(
  g: Selection<SVGGElement, unknown, null, undefined>,
  layout: Layout,
): void {
  // Subtle alternating tint per module band so the user can trace a horizontal
  // lane from any type back to its module label on the left frozen column.
  // Drawn first (so types and arrows render on top) and stretched far past
  // the visible viewport so panning never reveals an unfilled edge.
  const tinted = layout.modules.filter((_m, i) => i % 2 === 1);
  const sel = g
    .selectAll<SVGRectElement, Layout['modules'][number]>('rect')
    .data(tinted, (m) => m.id);
  sel.exit().transition('exit').duration(ANIM_MS).style('opacity', 0).remove();
  const enter = sel
    .enter()
    .append('rect')
    .attr('x', -10000)
    .attr('y', (m) => m.y)
    .attr('width', 20000)
    .attr('height', (m) => m.bandHeight)
    .attr('fill', '#f1f5f9')
    .style('opacity', 0);
  enter.transition('enter').duration(ANIM_MS).style('opacity', 1);
  sel
    .transition('move')
    .duration(ANIM_MS)
    .attr('y', (m) => m.y)
    .attr('height', (m) => m.bandHeight);
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

  // Per-ancestor colour rects covering the dimmed prefix portion. Painted
  // on top of `rect.bg` and below the prefix tspan so the prefix text reads
  // as a coloured chip per parent module.
  enter.append('g').attr('class', 'prefix-bgs').attr('pointer-events', 'none');

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

  // Module label is split into a dimmed/smaller "prefix" tspan (the
  // parent module path, e.g. "vm::wasm::") and a normal "leaf" tspan
  // (the module's own name). The prefix on every row makes it visually
  // unambiguous that this pane is a Rust module hierarchy — no file/dir
  // pretense — while staying scannable by leaf.
  const moduleText = enter
    .append('text')
    .attr('class', 'name')
    .attr('x', MODULE_LABEL_X)
    .attr('y', ROW_H / 2)
    .attr('dy', '0.32em')
    .attr('font-size', FONT_SIZE)
    .attr('fill', COLOR_LABEL);
  moduleText
    .append('tspan')
    .attr('class', 'prefix')
    .attr('font-size', FONT_SIZE_MODULE_PREFIX)
    .attr('fill', COLOR_MODULE_PREFIX);
  // The crate-root row gets a bolder leaf so the crate name stands out
  // as the top of the hierarchy. Submodules use the default weight.
  moduleText
    .append('tspan')
    .attr('class', 'leaf')
    .attr('font-size', FONT_SIZE_MODULE_LEAF)
    .attr('font-weight', (d) => (d.modDepth === 0 ? 700 : 400));

  enter
    .append('rect')
    .attr('class', 'expand-hit')
    .attr('x', 0)
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

  // Refresh the module label tspans each draw — content may shift when
  // crates are switched or filters are applied (focus mode collapses
  // some intermediate modules out of the visible tree).
  merged
    .select<SVGTSpanElement>('text.name tspan.prefix')
    .text((d) => splitModuleDisplayLabel(d.id).prefix);
  merged
    .select<SVGTSpanElement>('text.name tspan.leaf')
    .text((d) => splitModuleDisplayLabel(d.id).leaf);

  // Refresh click handler with current closure each draw.
  merged
    .select<SVGRectElement>('rect.expand-hit')
    .attr('cursor', (d) => (d.hasChildren ? 'pointer' : 'default'))
    .on('click', (event: MouseEvent, d) => {
      event.stopPropagation();
      if (d.hasChildren) opts.onToggle(d.id);
    });

  // Cluster rendering: a per-row clipPath defines the rounded outer shape;
  // colored segment rects sit inside that clip so their boundaries between
  // each parent and the leaf are flush. A single outer border rect with
  // fill=none + slate-300 stroke draws the rounded chip outline on top.
  // Outer edges (left of first, right of last) get padding so glyphs don't
  // sit flush against the rounded border.
  const SEG_OUTER_PAD = 4;
  type RowSeg = (
    | Layout['modules'][number]['prefixSegments'][number]
    | Layout['modules'][number]['leafBg']
  ) & {
    readonly fill: string;
  };
  merged.each(function (d) {
    const rowG = select(this);
    const prefixSegs: RowSeg[] = d.prefixSegments.map((s) => ({
      ...s,
      fill: colorForSegment(s.name),
    }));
    const leafSeg: RowSeg = {
      ...d.leafBg,
      // Half-step between slate-100 (band tint) and slate-200 — light enough
      // to read as "neutral" but distinct from both the white viewport and
      // the tinted band stripes.
      fill: d.leafBg.isParent ? colorForSegment(d.leafBg.name) : '#eaeef4',
    };
    const all = [...prefixSegs, leafSeg];
    const lastIdx = all.length - 1;
    const firstSeg = all[0];
    const lastSeg = all[lastIdx];
    if (firstSeg === undefined || lastSeg === undefined) return;
    const clusterX = firstSeg.xStart - SEG_OUTER_PAD;
    const clusterWidth = lastSeg.xStart + lastSeg.width - clusterX + SEG_OUTER_PAD;
    const clipId = `cc-${d.id.replace(/[^a-zA-Z0-9-]/g, '_')}`;

    // ClipPath: rounded outer cluster shape. The id has to be unique in the
    // document so the clip-path URL resolves to this row's shape, not some
    // other row's. Inserted before g.prefix-bgs so the def precedes uses.
    let clipPath = rowG.select<SVGClipPathElement>('clipPath');
    if (clipPath.empty()) {
      clipPath = rowG.insert<SVGClipPathElement>('clipPath', 'g.prefix-bgs');
      clipPath.append('rect').attr('y', 0).attr('height', ROW_H).attr('rx', 4);
    }
    clipPath.attr('id', clipId);
    clipPath.select<SVGRectElement>('rect').attr('x', clusterX).attr('width', clusterWidth);

    // Inner segment rects: no stroke, no rx — the clipPath handles the
    // rounded outer shape, and the per-row outer border draws the edge.
    const segGroup = rowG.select<SVGGElement>('g.prefix-bgs').attr('clip-path', `url(#${clipId})`);
    const segs = segGroup
      .selectAll<SVGRectElement, RowSeg>('rect.seg')
      .data(all, (s, i) => `${i === lastIdx ? 'leaf' : 'pre'}:${s.name}`);
    segs.exit().remove();
    segs
      .enter()
      .append('rect')
      .attr('class', 'seg')
      .attr('y', 0)
      .attr('height', ROW_H)
      .merge(segs)
      .attr('x', (s, i) => s.xStart - (i === 0 ? SEG_OUTER_PAD : 0))
      .attr(
        'width',
        (s, i) => s.width + (i === 0 ? SEG_OUTER_PAD : 0) + (i === lastIdx ? SEG_OUTER_PAD : 0),
      )
      .attr('fill', (s) => s.fill);

    // Outer cluster border. Inserted before text.name (always present) so it
    // paints over the colored zones but under the chevron and label glyphs.
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
    border.attr('x', clusterX).attr('width', clusterWidth);
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
    .attr('transform', (d) => `translate(${d.x},${d.y - ROW_H / 2})`)
    .style('opacity', 0);

  // Kind marker — small italic letter (𝑠 / 𝑒 / 𝑢 / 𝑡 / 𝑎) between dot
  // and label. Skipped for nodes where kindMarker returns null (ghosts,
  // function groups). The text element is always created so we don't
  // have to reconcile two enter selections; null markers render empty.
  // A touch smaller than the label so it reads as an annotation, not a
  // peer of the type name.
  enter
    .append('text')
    .attr('class', 'kind-marker')
    .attr('x', TYPE_KIND_MARKER_X)
    .attr('y', ROW_H / 2)
    .attr('dy', '0.32em')
    .attr('font-size', FONT_SIZE_FIELD)
    .attr('fill', COLOR_CHEVRON)
    .text((d) => kindMarker(d) ?? '');

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

  // Dot is appended LAST so it sits on top of the expand-hit rect for
  // pointer events — that lets hover on the dot fire owner-popover
  // handlers separately from row-level expand clicks. Click on the dot
  // still toggles expansion (delegated below) so it stays consistent
  // with the rest of the row.
  // Real types render as a filled dot; ghost re-exports render as a hollow
  // ring (stroke-only, no fill) so the eye instantly distinguishes "this is
  // the real definition" from "this is a re-export pointing elsewhere". The
  // visibility colour drives stroke for ghosts, fill for real types.
  //
  // pointer-events="all" makes the whole circle area clickable regardless
  // of fill — without this, ghost dots (fill="none") only fire events on
  // the thin 1.5px stroke ring, so the cursor barely registers as
  // pointer and clicks miss the dot interior.
  enter
    .append('circle')
    .attr('class', 'type-dot')
    .attr('cx', TYPE_CIRCLE_X)
    .attr('cy', ROW_H / 2)
    .attr('r', TYPE_RADIUS)
    .style('cursor', 'pointer')
    .attr('pointer-events', 'all')
    .attr('fill', (d) => (d.isGhost ? 'none' : colorForVisibility(d.visibility)))
    .attr('stroke', (d) => (d.isGhost ? colorForVisibility(d.visibility) : 'none'))
    .attr('stroke-width', (d) => (d.isGhost ? 1.5 : 0));

  enter.transition('enter').duration(ANIM_MS).style('opacity', 1);

  const merged = enter.merge(sel);

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
  merged
    .select<SVGRectElement>('rect.expand-hit')
    .attr('cursor', (d) => (d.hasFields || d.isGhost ? 'pointer' : 'default'))
    .on('click', (event: MouseEvent, d) => {
      event.stopPropagation();
      if (d.isGhost && d.ghostTarget !== null) {
        opts.onFollowGhost(d.id, d.ghostTarget);
      } else if (d.hasFields) {
        opts.onToggle(d.id);
      }
    });

  // Chevron click is intentionally stronger than name click: it toggles the
  // type and selects/deselects all member rows that can emit arrows.
  merged
    .select<SVGRectElement>('rect.expand-arrow-hit')
    .attr('cursor', 'pointer')
    .on('click', (event: MouseEvent, d) => {
      event.stopPropagation();
      if (d.hasFields) opts.onToggleTypeMembers(d.fullPath);
    });

  // Refresh dot handlers each draw. Click semantics:
  //   - real type dot → expand every owner (and its module ancestors)
  //     so all incoming arrows render.
  //   - ghost re-export dot → follow the re-export to its canonical
  //     target, expanding ancestors so the violet arrow becomes visible.
  merged
    .select<SVGCircleElement>('circle.type-dot')
    .on('click', (event: MouseEvent, d) => {
      event.stopPropagation();
      if (d.isGhost && d.ghostTarget !== null) {
        opts.onFollowGhost(d.id, d.ghostTarget);
      } else {
        opts.onExpandAllOwners(d.fullPath);
      }
    })
    .on('mouseenter', function (_event: MouseEvent, d) {
      const node = this as SVGCircleElement;
      opts.onShowOwners(d.fullPath, () => {
        const r = node.getBoundingClientRect();
        return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
      });
    })
    .on('mouseleave', () => opts.onHideOwners());

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
    // Field rows expose drift at the member label. Canonical arrows stay
    // subdued grey in the canvas, but canonical members use blue so normal
    // ownership rows stand out from rows with no emitted ownership arrow.
    const memberColor = f.kind === 'field' ? memberColorForDriftClass(f.memberDriftClass) : null;
    const fillColor = isCallable ? callableRowColor(f) : (memberColor ?? COLOR_FIELD_NAME);
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
      incomingMarker
        .attr('font-size', INCOMING_CALL_MARKER_FONT_SIZE)
        .attr('font-weight', incomingActive ? 700 : 500)
        .attr('fill', incomingActive ? '#2563eb' : COLOR_CHEVRON)
        .text('→')
        .transition('move')
        .duration(ANIM_MS)
        .attr('x', localX - INCOMING_CALL_MARKER_OFFSET)
        .attr('y', localY);
      const functionFullPath = f.functionFullPath;
      incomingMarker.on('click', (event: MouseEvent) => {
        event.stopPropagation();
        if (callableKind === null) return;
        opts.onToggleIncomingCalls(d.fullPath, f.name, callableKind, functionFullPath);
      });
    } else if (!incomingMarker.empty()) {
      incomingMarker.remove();
    }

    // Signature toggle: callable rows show a small `(..)` glyph right after
    // the function name. Click toggles the expansion. Geometry already
    // reserved room between the name and arrowSourceX for this glyph.
    let sigToggle = fg.select<SVGTextElement>('text.signature-toggle');
    if (isCallable && f.functionFullPath !== null) {
      if (sigToggle.empty()) {
        sigToggle = fg
          .insert('text', 'text.field-ty')
          .attr('class', 'signature-toggle')
          .attr('dy', '0.32em')
          .attr('font-size', INCOMING_CALL_MARKER_FONT_SIZE)
          .attr('font-weight', 600)
          .attr('fill', COLOR_CHEVRON)
          .style('cursor', 'pointer')
          .text('(..)');
      }
      const functionFullPath = f.functionFullPath;
      sigToggle.on('click', (event: MouseEvent) => {
        event.stopPropagation();
        opts.onToggleSignature(functionFullPath);
      });
      // 4px gap matches SIGNATURE_TOGGLE_GAP reserved in geometry.
      sigToggle
        .transition('move')
        .duration(ANIM_MS)
        .attr('x', localX + f.textWidth + 4)
        .attr('y', localY);
    } else if (!sigToggle.empty()) {
      sigToggle.remove();
    }

    const tyText = fg
      .select<SVGTextElement>('text.field-ty')
      .attr('x', f.arrowSourceX - d.x)
      .attr('y', localY)
      .text(f.tyText);
    const tyBg = fg.select<SVGRectElement>('rect.field-ty-bg');

    const handleRowClick = (event: MouseEvent): void => {
      event.stopPropagation();
      if (isBucketHeader) {
        if (f.bucketId !== null) opts.onToggle(f.bucketId);
      } else if (f.kind === 'field' || f.kind === 'method' || f.kind === 'function') {
        // Method rows participate in selection just like fields. The
        // kind is part of the selection key so a struct field and a
        // method with the same name highlight independently.
        opts.onSelectField(d.fullPath, f.name, f.kind);
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
      if (isCallable && layoutDebugEnabled()) {
        showCallableDebugPanel(layout, d, f, rowKind, text.node());
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
      if (isCallable) hideCallableDebugPanel();
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
  fg.select<SVGTextElement>('text.signature-toggle').remove();
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
