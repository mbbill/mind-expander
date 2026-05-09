// Two-area renderer: indented module tree on the left, per-module type bands
// on the right. Layout is precomputed by layout; this module
// translates Layout objects into SVG and wires click handlers.
//
// Rendering uses a persistent DOM with d3 data-join and stable keys so that
// elements existing in both the previous and current render *tween* between
// their old and new positions instead of being wiped and rebuilt. This is
// what powers the smooth focus-mode toggle animation. Elements that appear
// fade in; elements that disappear fade out before removal.

import { type Selection, pointer, select, zoomTransform } from 'd3';
import { type ArrowHit, pickArrowsAtPoint } from '../analysis/arrow_hit.ts';
import type { DriftClass } from '../analysis/drift.ts';
import {
  BASE_FONT_SIZE,
  HIT_MIN_W,
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
// `ARROW_HEAD_PX` is generous because going back along an arrow is the
// less obvious half of the click affordance — making it forgiving means
// users who aim for "the arrowhead" don't accidentally land on body.
const ARROW_HIT_PX = 8;
const ARROW_HEAD_PX = 20;

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
const FONT_SIZE_MODULE_PREFIX = 11; // smaller than the leaf, to keep the row tight
const FONT_SIZE_MODULE_CHEVRON = 14; // bumped above the base + bold so the
// "+/-" expand affordance reads clearly without changing direction-neutral
// semantics (modules expand both vertically and horizontally).

const COLOR_LABEL = '#1e293b';
const COLOR_MODULE_PREFIX = '#60a5fa'; // blue-400, dimmed parent path
const COLOR_CHEVRON = '#94a3b8';
const COLOR_FIELD_NAME = '#334155';
const COLOR_FIELD_TY = '#94a3b8'; // slate-400, grey for the on-hover type hint
// Slate-500 — readable italic but visually subordinate to field rows
// and bucket headers. Lighter than COLOR_FIELD_NAME, darker than
// COLOR_FIELD_TY so method names actually stand out instead of fading.
const COLOR_METHOD_NAME = '#64748b';
const TY_HIDE_DELAY = 0; // ms — type-hint hides immediately on mouse-out (only the 200ms fade-out transition still plays)
const TY_TEXT_GAP = 4;
const TY_BG_PAD_X = 4;
const TY_BG_PAD_Y = 2;
const COLOR_TY_BG = '#ffffff';
const METHOD_BUCKET_CHEVRON_OFFSET = 12;
const METHOD_BUCKET_CHEVRON_FONT_SIZE = 14;
const EDGE_SHADOW_GRADIENT_ID = 'sf-edge-shadow';
const EDGE_SHADOW_W = 16; // data-units; scales with zoom (small but visible)
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
  // Method arrows always render in the neutral canonical grey. The
  // target's drift class describes its STRUCTURAL placement and isn't
  // a property of the method using it — colouring a method-arrow red
  // because its target happens to be drift_above misleads the reader
  // into thinking the method itself is anomalous.
  if (a.kind === 'method') return COLOR_ARROW_CANONICAL;
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
  /** Click on a type header chevron → toggle expansion and select/deselect
   *  every member row that can emit an arrow for that type. */
  readonly onToggleTypeMembers: (typePath: string) => void;
  /** Click on a field name → toggle its selection. */
  readonly onSelectField: (typePath: string, fieldName: string, kind: FieldKeyKind) => void;
  /** Set of "typePath::fieldName" keys currently selected. */
  readonly selectedFields: ReadonlySet<string>;
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

/** Row-kind half of a fieldKey. Methods and fields can share names
 *  on the same type (struct field `exn_heap` + method `exn_heap()`),
 *  so the selection key needs both `(typePath, name)` AND the kind. */
export type FieldKeyKind = 'field' | 'method';

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
  if (parts.length >= 3 && (parts[1] === 'field' || parts[1] === 'method')) {
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

export function chainArrowsFromMany(
  layout: Layout,
  fields: ReadonlyArray<{ typePath: string; fieldName: string; kind: FieldKeyKind }>,
): Set<Layout['arrows'][number]> {
  const out = new Set<Layout['arrows'][number]>();
  for (const f of fields) {
    const c = chainArrowsFrom(layout, f.typePath, f.fieldName, f.kind);
    for (const a of c) out.add(a);
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
  const frozenBandG = ensureGroup(frozenLayer, 'frozen-band-bg');
  const moduleG = ensureGroup(frozenLayer, 'modules');

  renderBandBackgrounds(bandG, layout);
  renderLayoutDebug(debugG, layout);
  renderFrozenBandBackgrounds(frozenBandG, layout);
  renderArrows(arrowG, layout, opts.selectedArrows);
  renderTypes(typeG, zoomLayer, layout, opts);
  renderModules(moduleG, layout, opts);
  sizeFrozenBackdrop(layers.backdrop, frozenLayer, layout);
  renderEdgeShadowsImpl(frozenLayer, layout);
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
    const hits = pickArrowsAtPoint({ x, y }, layout.arrows, {
      hitTolerance: ARROW_HIT_PX / k,
      headRadius: ARROW_HEAD_PX / k,
    });
    if (hits.length === 0) return;
    event.stopPropagation();
    opts.onArrowNavigate(hits, { x: event.clientX, y: event.clientY });
  });
}

/**
 * Per-band edge shadow on the frozen pane's right edge. Shows up only on
 * bands whose types have any portion hidden behind the frozen module
 * column. Caller invokes this from both `renderTree` (after layout) and
 * from the zoom callback (after each pan/zoom). Cheap: O(types) per call.
 */
export function renderEdgeShadows(
  layers: ZoomLayers,
  layout: Layout,
  transform: { x: number; k: number },
): void {
  renderEdgeShadowsImpl(select(layers.frozenLayer), layout, transform);
}

function renderEdgeShadowsImpl(
  frozenLayer: Selection<SVGGElement, unknown, null, undefined>,
  layout: Layout,
  transform?: { x: number; k: number },
): void {
  // Read the frozen pane's right-edge data-x from the separator line
  // (sizeFrozenBackdrop has set it just before this call). If no
  // separator exists yet (very first draw before sizeFrozenBackdrop ran)
  // bail — there are no shadows to render meaningfully.
  const sepLine = frozenLayer.select<SVGLineElement>('line.frozen-separator');
  if (sepLine.empty()) return;
  const rightEdge = Number(sepLine.attr('x1'));
  if (!Number.isFinite(rightEdge)) return;

  // If transform isn't supplied (called from renderTree's first pass
  // before zoom has fired), fall back to identity. The zoom callback
  // will refresh shadows shortly after with the real transform.
  const tx = transform?.x ?? 0;
  const tk = transform?.k ?? 1;
  if (tk <= 0) return;

  // Data-x at which the frozen pane's right edge sits (back-projected
  // from the screen). Anything to the LEFT of this is hidden.
  // Frozen layer transform is `translate(0, t.y) scale(t.k)` so the
  // frozen pane's right edge in screen space is at `rightEdge * tk`.
  // For the zoom layer (transform `translate(t.x, t.y) scale(t.k)`), a
  // type at data-x px renders at screen-x `px * tk + tx`. A type is fully
  // hidden if its right edge `(px + w) * tk + tx < rightEdge * tk`, which
  // simplifies to `(px + w) < rightEdge - tx/tk`.
  const viewLeftDataX = rightEdge - tx / tk;

  // Per-module: minimum type-right-edge. If the leftmost-finishing type
  // is still right of viewLeftDataX, no type is hidden in this band.
  const minRightByPath = new Map<string, number>();
  for (const t of layout.types) {
    const right = t.x + t.width;
    const cur = minRightByPath.get(t.modulePath);
    if (cur === undefined || right < cur) minRightByPath.set(t.modulePath, right);
  }

  // Module rows have id = `crate::path` (or just `crate` for the root);
  // types' modulePath = `path` (no crate prefix). Strip the crate prefix
  // off of the row id to join the two.
  const cratePrefixIdx = (id: string): string => {
    const idx = id.indexOf('::');
    return idx >= 0 ? id.slice(idx + 2) : '';
  };

  // d3 join keyed on the module id. Width is constant in data-units
  // (scales with zoom — fine, the cue stays proportional). Visibility
  // is toggled via `visibility` rather than DOM add/remove so transitions
  // don't fire on every zoom event.
  const shadowG = ensureGroup(frozenLayer, 'edge-shadows');
  const sel = shadowG
    .selectAll<SVGRectElement, Layout['modules'][number]>('rect.edge-shadow')
    .data(layout.modules, (m) => m.id);

  sel.exit().remove();

  const enter = sel
    .enter()
    .append('rect')
    .attr('class', 'edge-shadow')
    .attr('x', rightEdge)
    .attr('width', EDGE_SHADOW_W)
    .attr('fill', `url(#${EDGE_SHADOW_GRADIENT_ID})`)
    .attr('pointer-events', 'none');

  const merged = enter.merge(sel);
  merged
    .attr('x', rightEdge)
    .attr('width', EDGE_SHADOW_W)
    .attr('y', (m) => m.y)
    .attr('height', (m) => m.bandHeight)
    .style('visibility', (m) => {
      const path = cratePrefixIdx(m.id);
      const minRight = minRightByPath.get(path);
      if (minRight === undefined) return 'hidden';
      return minRight < viewLeftDataX ? 'visible' : 'hidden';
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

function renderFrozenBandBackgrounds(
  g: Selection<SVGGElement, unknown, null, undefined>,
  layout: Layout,
): void {
  // Mirror the zoom-layer alternating tint inside the frozen module column so
  // bands flow visually uninterrupted across the separator. Width is a
  // placeholder here; sizeFrozenBackdrop later trims it to the backdrop's
  // right edge.
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

function sizeFrozenBackdrop(
  backdrop: SVGRectElement,
  frozen: Selection<SVGGElement, unknown, null, undefined>,
  layout: Layout,
): void {
  let maxX = 0;
  for (const m of layout.modules) {
    const right = m.labelX + m.hitWidth;
    if (right > maxX) maxX = right;
  }
  const rightEdge = Math.max(maxX + 12, 80);
  backdrop.setAttribute('width', String(rightEdge + 10000));

  // Trim the alternating-tint rects to the same right edge so they end at
  // the separator line and don't bleed into the type area.
  frozen
    .selectAll<SVGRectElement, unknown>('g.frozen-band-bg rect')
    .attr('width', rightEdge + 10000);

  // Separator line at the right edge of the frozen pane. `non-scaling-stroke`
  // keeps the line 1px regardless of zoom level. Persistent: created once,
  // updated in place so tweens keep working across draws.
  let sep = frozen.select<SVGLineElement>('line.frozen-separator');
  if (sep.empty()) {
    sep = frozen
      .append('line')
      .attr('class', 'frozen-separator')
      .attr('y1', -10000)
      .attr('y2', 10000)
      .attr('stroke', '#cbd5e1')
      .attr('stroke-width', 1)
      .attr('vector-effect', 'non-scaling-stroke');
  }
  sep.attr('x1', rightEdge).attr('x2', rightEdge);
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

  // Edge-shadow gradient — used by per-band shadows on the frozen pane's
  // right edge to signal "this band has type content currently hidden
  // behind the column."
  const grad = defs
    .append('linearGradient')
    .attr('id', EDGE_SHADOW_GRADIENT_ID)
    .attr('x1', '0')
    .attr('y1', '0')
    .attr('x2', '1')
    .attr('y2', '0');
  grad.append('stop').attr('offset', '0').attr('stop-color', 'rgba(15,23,42,0.22)');
  grad.append('stop').attr('offset', '1').attr('stop-color', 'rgba(15,23,42,0)');
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
  return `${a.fromTypeId}::${a.fromRowKind}::${a.fromFieldName}::${a.toTypeId}::${ys}`;
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
    .data(layout.arrows, arrowKey);

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
      if (a.kind === 'method') return METHOD_DASH;
      return null;
    })
    .attr('marker-end', (a) => `url(#${ARROW_MARKER_IDS[a.driftClass]})`)
    .classed('canonical', (a) => a.driftClass === 'at_lca' || a.driftClass === 'within_budget')
    .classed('reexport', (a) => a.kind === 'reexport')
    .classed('method', (a) => a.kind === 'method')
    .classed('highlighted', (a) => selectedArrows.has(a));

  enter.transition('enter').duration(ANIM_MS).style('opacity', 1);

  // Update: refresh `highlighted` on the inner visible path of every
  // arrow group (entering + persisting). Other classes are stable per
  // arrow id and don't change once set on enter.
  enter
    .merge(sel)
    .select<SVGPathElement>('path.visible')
    .classed('highlighted', (a) => selectedArrows.has(a));
}

function chainArrowsFrom(
  layout: Layout,
  fromTypeId: string,
  fieldName: string,
  fromKind: FieldKeyKind,
): Set<Layout['arrows'][number]> {
  const typesByPath = new Map(layout.types.map((t) => [t.fullPath, t]));
  const arrowsByFrom = new Map<string, Layout['arrows'][number][]>();
  for (const a of layout.arrows) {
    let list = arrowsByFrom.get(a.fromTypeId);
    if (!list) {
      list = [];
      arrowsByFrom.set(a.fromTypeId, list);
    }
    list.push(a);
  }

  const inChain = new Set<Layout['arrows'][number]>();
  const visitedTypes = new Set<string>();
  const queue: string[] = [];

  // Seed: arrows from the (type, row) the user clicked. Match on
  // both name AND row kind so a struct field and a method that share
  // a name (e.g. `exn_heap` field + `exn_heap()` getter) don't both
  // light up when only one was clicked.
  for (const a of arrowsByFrom.get(fromTypeId) ?? []) {
    if (a.fromFieldName !== fieldName) continue;
    if (a.fromRowKind !== fromKind) continue;
    inChain.add(a);
    const tgt = typesByPath.get(a.toTypeId);
    if (tgt?.expanded && !visitedTypes.has(a.toTypeId)) {
      visitedTypes.add(a.toTypeId);
      queue.push(a.toTypeId);
    }
  }

  // Walk the chain through any expanded targets.
  while (queue.length > 0) {
    const tid = queue.shift();
    if (tid === undefined) break;
    for (const a of arrowsByFrom.get(tid) ?? []) {
      if (inChain.has(a)) continue;
      inChain.add(a);
      const tgt = typesByPath.get(a.toTypeId);
      if (tgt?.expanded && !visitedTypes.has(a.toTypeId)) {
        visitedTypes.add(a.toTypeId);
        queue.push(a.toTypeId);
      }
    }
  }
  return inChain;
}

function applyChainHighlight(
  layer: Selection<SVGGElement, unknown, null, undefined>,
  inChain: ReadonlySet<Layout['arrows'][number]>,
): void {
  // Each arrow is a `<g class="arrow">` containing a `.hit` and a
  // `.visible` path. Highlight class lives on the visible path (which
  // CSS targets); skip the hit path so the wide transparent stroke
  // doesn't accidentally pick up styling.
  layer
    .selectAll<SVGPathElement, Layout['arrows'][number]>('g.arrows path.visible')
    .classed('highlighted', (d) => inChain.has(d));
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

  // Update chevron text (expansion state may have changed).
  merged
    .filter((d) => d.hasChildren)
    .select<SVGTextElement>('text.chevron')
    .text((d) => (d.expanded ? '-' : '+'));

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

  sizeModuleExpandHit(merged);
}

function sizeModuleExpandHit(
  sel: Selection<SVGGElement, Layout['modules'][number], SVGGElement, unknown>,
): void {
  // Layout owns module label measurement so toggling a band does not force SVG
  // text layout across every visible module row before the animation frame.
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
    .data(fields, (f) => `${f.kind}:${f.name}`);

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
    .style('pointer-events', 'none');

  enter.transition('enter').duration(ANIM_MS).style('opacity', 1);

  const merged = enter.merge(sel);

  merged.each(function (f) {
    const fg = select(this);
    const localX = f.x - d.x;
    const localY = f.y - groupTopY;
    const isBorrow =
      f.ownership === 'borrow_immut' ||
      f.ownership === 'borrow_mut' ||
      f.ownership === 'indirection';
    // The selection set is keyed by (typePath, rowKind, name) so a
    // struct field and a method with the same name on the same type
    // each toggle independently. f.kind is one of 'field' |
    // 'method_bucket' | 'method'; only field/method participate in
    // selection (bucket headers are handled by the bucket-toggle
    // branch above), so coerce method_bucket → 'field' for the
    // lookup (it returns false either way; the explicit narrow keeps
    // TypeScript happy).
    const rowKind: FieldKeyKind = f.kind === 'method' ? 'method' : 'field';
    const isSelected = opts.selectedFields.has(fieldKey(d.fullPath, f.name, rowKind));
    const isBucketHeader = f.kind === 'method_bucket';
    const isMethod = f.kind === 'method';

    // Visual differentiation by row kind:
    //   - field        → default styling, italic for borrow ownership.
    //   - method_bucket → separate chevron before the aligned label so
    //                     it reads as foldable without shifting the text.
    //   - method       → italic + slightly dimmer to read as
    //                     "subordinate to the bucket above."
    const display = fieldRowDisplayParts(f, opts.expandedBucketIds);
    const fontWeight = isBucketHeader ? 600 : isSelected ? 600 : 400;
    const fontStyle = isMethod ? 'italic' : isBorrow ? 'italic' : 'normal';
    // Field rows expose drift at the member label. Canonical arrows stay
    // subdued grey in the canvas, but canonical members use blue so normal
    // ownership rows stand out from rows with no emitted ownership arrow.
    const memberColor = f.kind === 'field' ? memberColorForDriftClass(f.memberDriftClass) : null;
    const fillColor = isMethod ? COLOR_METHOD_NAME : (memberColor ?? COLOR_FIELD_NAME);
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
      } else if (f.kind === 'field' || f.kind === 'method') {
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
      const hover = chainArrowsFrom(layout, d.fullPath, f.name, rowKind);
      const union = new Set<Layout['arrows'][number]>(opts.selectedArrows);
      for (const a of hover) union.add(a);
      applyChainHighlight(zoomLayer, union);
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
      applyChainHighlight(zoomLayer, opts.selectedArrows);
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

function hoveredTextRight(text: Selection<SVGTextElement, unknown, null, undefined>): number {
  const node = text.node();
  if (!node) return 0;
  const bbox = node.getBBox();
  return bbox.x + bbox.width;
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
