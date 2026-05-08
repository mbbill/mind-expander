// Composite layout: left-side module tree + per-module type bands on the
// right. Each module gets a row band whose height is determined by greedy
// 2-D packing of its types — a collapsed type takes one row, an expanded
// type takes 1 + fieldCount rows. Types that don't horizontally collide on
// the same row(s) share rows, so a chain `A→B→C` packs into one row.
//
// Type x is assigned by weighted longest path over the visible structural
// ownership graph. Rank still orders nodes left-to-right, but it no longer
// imposes a single global x per depth: unrelated chains only pay for their
// own widths and incoming-arrow gutters.

import type { FieldFacts, FnFacts, Ownership, TypeKind } from '../data/schema.ts';
import type { ViewState } from '../state/view_state.ts';
import { type DriftClass, type DriftIndex, isCanonicalTarget } from './drift.ts';
import {
  type ChannelDebug,
  type ChannelObstacle,
  LANE_BASE_GAP,
  LANE_SLOT_W,
  allocateIncomingChannels,
  fallbackIncomingLaneX,
  gutterWidth,
  isCanonicalDriftClass,
  isPlacementArrow,
  isReturnArrow,
  routeSourceX,
} from './layout_channels_bak.ts';
import {
  FIELD_LABEL_INSET,
  FIELD_ROW_H,
  FUNCTION_GROUP_LABEL_INSET,
  INDENT_PX,
  LEFT_PAD,
  METHOD_INDENT,
  MODULE_BAND_X_GAP,
  MODULE_GLYPH_W,
  ROW_H,
  TOP_PAD,
  TYPE_GLYPH_W,
  TYPE_X_GAP,
  measureModuleHitWidth,
  measureTypeHeaderMetrics,
} from './layout_metrics.ts';
import {
  type StableRankPlacement,
  computeStableRankPlacement,
  layoutRankOfType,
  rootXForRank,
  semanticDepthOf,
} from './layout_rank_bak.ts';
import type { ModuleNode, TypeNode } from './module_tree.ts';
import type { OwnershipIndex } from './ownership.ts';
import { BUCKET_LABEL, type VisibilityBucket } from './visibility.ts';

export { FIELD_ROW_H, INDENT_PX, LEFT_PAD, ROW_H, TOP_PAD } from './layout_metrics.ts';

const COL_W = 200;
const CHAR_W = 7;
// Free-function rows are not nested members of a type. Keep them tucked
// closer to the function-group header than real field rows.
const ROUTE_OBSTACLE_PAD = 8;
const ROUTE_HULL_ROW_WIDTH_LIMIT = 190;
const ROUTE_LONG_ROW_PROTRUSION = 48;
// Methods are visually indented past the bucket header to mirror how
// Rust source nests impl-block bodies. Living in layout (not the
// renderer) means f.x and f.arrowSourceX both reflect the indent —
// arrow source endpoints, signature-tail x, and selection-pill bounds
// all stay in agreement.

export interface ModuleRow {
  readonly id: string;
  readonly label: string;
  readonly modDepth: number;
  readonly labelX: number;
  /** Row hit width measured by layout, not the renderer, so module-tree
   *  redraws avoid synchronous SVG text measurement. */
  readonly hitWidth: number;
  readonly y: number;
  readonly bandHeight: number;
  readonly expanded: boolean;
  readonly hasChildren: boolean;
}

/** Kind tag for rows inside an expanded type. The layout produces a flat
 *  `rows` list per `TypeBox`; the renderer dispatches per-kind. Keeping
 *  one list (rather than three parallel arrays) means existing arrow
 *  hit-testing and field-row positioning stays uniform. */
export type RowKind = 'field' | 'method_bucket' | 'method';

export interface FieldRow {
  readonly name: string;
  readonly tyText: string;
  readonly ownership: Ownership;
  readonly x: number; // text x within the type box (start of name)
  readonly y: number; // absolute y (row center)
  /**
   * Arrow source x — end of the rendered field name plus a small gap. The
   * type-text portion overflows visually as semi-transparent grey but is not
   * counted toward the type box width or the arrow source.
   */
  readonly arrowSourceX: number;
  readonly targets: readonly string[]; // resolved owned target full_paths
  /** Default `'field'` (struct fields / enum-variant payloads / function-
   *  group function names). `'method_bucket'` for the foldable header row
   *  of a per-type method visibility group; the renderer draws a chevron
   *  + count and toggles its expansion via `bucketId`. `'method'` for
   *  individual method rows shown when their bucket is expanded. */
  readonly kind: RowKind;
  /** Set on `'method_bucket'` rows — the id added to / removed from
   *  `ViewState` when the user clicks the bucket header. Always null
   *  for other row kinds. */
  readonly bucketId: string | null;
}

export interface TypeBox {
  readonly id: string;
  readonly label: string;
  readonly typeKind: TypeKind;
  /** Raw extractor visibility token; encoded into the dot color. */
  readonly visibility: string;
  readonly fullPath: string;
  readonly modulePath: string;
  /** Rank index. Column 0 holds function-group pseudo-types; columns 1+
   *  hold real types at depth `col - 1`. This is ordering metadata only:
   *  x comes from weighted-longest-path placement, so two boxes with
   *  the same rank can legitimately have different x values. */
  readonly col: number;
  readonly x: number;
  readonly y: number; // row center of header
  readonly width: number;
  /** Header-only hit geometry precomputed by layout. Rendering consumes
   *  this directly to avoid synchronous SVG text measurement in the click
   *  path. */
  readonly headerArrowX: number | null;
  readonly headerHitWidth: number;
  readonly height: number; // total rows × ROW_H (1 if collapsed)
  readonly hasFields: boolean;
  readonly expanded: boolean;
  /** Field rows rendered into this layout — populated only when expanded. */
  readonly fields: readonly FieldRow[];
  /** Total field/variant count from the source type (independent of
   *  expanded state). Used by tooltips and aggregations that want the
   *  static count regardless of whether fields are currently rendered. */
  readonly totalFieldCount: number;
  /** True when this is a synthesized ghost row representing a re-export.
   *  The renderer uses this for hollow-ring + italic styling. */
  readonly isGhost: boolean;
  /** When `isGhost` is true, the canonical full path of the original
   *  definition. Used to draw the violet ghost arrow. */
  readonly ghostTarget: string | null;
}

export interface ArrowWaypoint {
  readonly x: number;
  readonly y: number;
}

export type ArrowKind = 'ownership' | 'reexport' | 'method';

export interface Arrow {
  /**
   * Polyline waypoints for orthogonal (Manhattan) routing.
   * Renderer draws straight L segments between them. The marker on the final
   * segment orients along the horizontal entry tangent.
   */
  readonly waypoints: readonly ArrowWaypoint[];
  readonly fromTypeId: string;
  readonly fromFieldName: string;
  /** Discriminates which row on `fromTypeId` produced this arrow. A
   *  struct field and a method can share a name (e.g. `exn_heap` field
   *  + `exn_heap()` getter), so name-only matching highlights both
   *  rows when only one was clicked. `'reexport'` ghosts have no
   *  source row — convention: 'field'. */
  readonly fromRowKind: 'field' | 'method';
  readonly toTypeId: string;
  /** Edge category. `'ownership'` arrows use `driftClass` for color; `'reexport'`
   *  arrows render in the dedicated violet/dashed style and ignore drift. */
  readonly kind: ArrowKind;
  readonly driftClass: DriftClass;
}

export interface Layout {
  readonly modules: readonly ModuleRow[];
  readonly types: readonly TypeBox[];
  readonly arrows: readonly Arrow[];
  readonly totalHeight: number;
  /** Rightmost data-space x coordinate used by the layout (across both the
   *  frozen module pane and the right type pane). Used by the zoom layer
   *  to compute a fit-to-view minimum scale. */
  readonly totalWidth: number;
  readonly debug?: LayoutDebug;
}

export interface LayoutDebug {
  readonly routing: ChannelDebug;
}

export interface LayoutInputs {
  readonly staticRoot: ModuleNode;
  readonly ownership: OwnershipIndex;
  readonly depth: ReadonlyMap<string, number>;
  readonly state: ViewState;
  /**
   * Drift classification per type. Used to (a) filter non-canonical edges out
   * of the barycenter computation so drift'd types don't pull canonical types
   * around, and (b) tag each rendered arrow with its drift class for color.
   */
  readonly drift: DriftIndex;
  /**
   * Optional per-type ordering hint within each (band, depth) cell. Smaller
   * key → earlier in cell. Types without a key fall back to alphabetical.
   * Produced by `buildOptimizedLayout`'s barycenter sweeps.
   */
  readonly sortKey?: ReadonlyMap<string, number>;
  /**
   * Optional per-type header-y stability anchor. `buildOptimizedLayout`
   * seeds this from the first layout for the current view state, then
   * barycenter sweeps optimize around that baseline instead of letting
   * expanded bands pull unrelated neighbors into newly opened slots.
   */
  readonly anchorY?: ReadonlyMap<string, number>;
  /**
   * Focus mode: when present, only modules whose id is in this set are
   * rendered — the rest of the tree is dropped entirely (no row, no name,
   * no children). Modules in the set are treated as effective-expanded by
   * the layout regardless of `state`. Caller must ensure the set is closed
   * under ancestors so the visible subtree stays connected.
   */
  readonly focusModules?: ReadonlySet<string>;
  /**
   * Optional precise text-width measurer for field names. Used to compute
   * `arrowSourceX` (the x where an arrow leaves a field) so the arrow's
   * tail starts exactly at the rendered text's right edge — no visible
   * gap from the proportional-font width mismatch. When omitted, falls
   * back to a flat `length * CHAR_W` approximation (fine for tests).
   */
  readonly measureText?: (text: string) => number;
  /**
   * Set of ghost (re-export) row ids whose violet arrow the user has
   * opted to display. Ghost arrows are off by default (they'd add a lot
   * of visual noise across a full crate), so each must be explicitly
   * shown via the row click. When `undefined`, every ghost arrow renders
   * — used by tests that don't care about toggle state.
   */
  readonly ghostArrowsShown?: ReadonlySet<string>;
  /**
   * When true, suppress the per-type method bucket rows entirely (no
   * bucket headers, no method rows, no method-derived arrows). Default
   * (false / undefined) shows them. Driven by a global keybinding so
   * users can toggle the noise off when they only care about
   * structural ownership.
   */
  readonly methodsHidden?: boolean;
  /**
   * Set of `${typePath}\x1F${methodName}` keys whose method arrows the
   * user has explicitly opted to show. Method arrows are off by
   * default — even when the type is expanded and the bucket is open —
   * because rendering every method's references at once turns the
   * canvas into spaghetti at any non-trivial method count. Clicking a
   * method row both selects it AND adds it here; click again removes
   * it and the arrows vanish. When `undefined`, every method arrow
   * renders (used by tests that don't care about toggle state).
   */
  readonly methodArrowsShown?: ReadonlySet<string>;
}

export function buildLayout(inputs: LayoutInputs): Layout {
  const { staticRoot, ownership, depth, state, sortKey, anchorY, drift, focusModules } = inputs;
  const methodsHidden = inputs.methodsHidden ?? false;
  const methodArrowsShown = inputs.methodArrowsShown;
  const ghostArrowsShown = inputs.ghostArrowsShown;
  // Method-arrow visibility key: `${typePath}\x1F${methodName}`. \x1F
  // matches the separator fieldKey uses in tree.ts so main.ts can
  // build the set straight from selectedFields without a translation
  // step.
  const METHOD_ARROW_KEY_SEP = '\x1F';
  const measureText = inputs.measureText ?? ((s: string) => s.length * CHAR_W);

  const globalXStart = computeGlobalXStart(staticRoot);
  const rankPlacement = computeStableRankPlacement(staticRoot, depth);

  // Weighted-longest-path placement: each visible type's x is computed
  // from its widths and per-target gutter demand, in topological order
  // (depth-ascending). The traditional "global column grid" is gone —
  // unrelated chains across the diagram no longer pull each other
  // around. See `computeNodeXs` for the formula.
  const visibleTypes = enumerateVisibleTypes(staticRoot, state, focusModules);
  const widthByPath = new Map<string, number>();
  const routingWidthByPath = new Map<string, number>();
  for (const t of visibleTypes) {
    widthByPath.set(
      t.fullPath,
      computeTypeBoxWidth(t, state.isExpanded(t.id), state, methodsHidden, measureText, true),
    );
    routingWidthByPath.set(
      t.fullPath,
      computeTypeBoxWidth(t, state.isExpanded(t.id), state, methodsHidden, measureText, false),
    );
  }
  const incomingMap = buildIncomingMap(visibleTypes, ownership, depth, drift);

  // Seed x with min-gutter (slot count = 1 per constrained target).
  // Repeatedly place, measure rendered structural arrows, and recompute x
  // from target-local slot counts. x changes can alter row packing and
  // therefore y-overlaps, so give the inner loop a few deterministic passes.
  let xByPath = computeNodeXs(
    visibleTypes,
    incomingMap,
    routingWidthByPath,
    depth,
    globalXStart,
    rankPlacement,
    null,
  );

  let modules: ModuleRow[] = [];
  let types: TypeBox[] = [];
  let cursorY = TOP_PAD;

  const placeAll = (): void => {
    modules = [];
    types = [];
    cursorY = TOP_PAD;
    visit(staticRoot, 0);
  };

  const visit = (m: ModuleNode, modDepth: number): void => {
    // Focus mode filter: drop any module whose id isn't in the focus set —
    // its row, its name, and its entire subtree are skipped.
    if (focusModules && !focusModules.has(m.id)) return;
    const labelX = LEFT_PAD + modDepth * INDENT_PX;
    // Module expansion is always driven by `state`, even in focus mode —
    // the caller is responsible for making sure relevance-set modules are
    // expanded in state before draw runs. This lets the user collapse a
    // module inside focus mode by clicking its row.
    const expanded = state.isExpanded(m.id);
    const directTypes = expanded ? (m.children.filter((c) => c.kind === 'type') as TypeNode[]) : [];

    const packed = packBand({
      types: directTypes,
      depth,
      globalXStart,
      rankPlacement,
      xByPath,
      widthByPath,
      measureText,
      state,
      bandTopY: cursorY,
      methodsHidden,
      ...(sortKey !== undefined ? { sortKey } : {}),
      ...(anchorY !== undefined ? { anchorY } : {}),
    });
    const bandH = Math.max(ROW_H, packed.bandHeight);

    modules.push({
      id: m.id,
      label: m.label,
      modDepth,
      labelX,
      hitWidth: measureModuleHitWidth(m.id, measureText),
      y: cursorY,
      bandHeight: bandH,
      expanded,
      hasChildren: m.children.length > 0,
    });

    for (const p of packed.boxes) {
      const headerY = cursorY + p.y + ROW_H / 2;
      const fieldRows: FieldRow[] = [];
      if (p.tExpanded) {
        // Row 0..N-1: declared fields.
        let rowIdx = 0;
        for (let i = 0; i < p.t.fields.length; i++) {
          const f = p.t.fields[i] as FieldFacts;
          const nameStart = p.x + labelInsetForRows(p.t);
          fieldRows.push({
            name: f.name,
            tyText: f.ty_text,
            ownership: f.ownership,
            x: nameStart,
            y: cursorY + p.y + ROW_H + (rowIdx + 0.5) * FIELD_ROW_H,
            arrowSourceX: nameStart + measureText(f.name) + 4,
            targets: ownership.fieldTargets.get(p.t.fullPath)?.get(f.name) ?? [],
            kind: 'field',
            bucketId: null,
          });
          rowIdx++;
        }
        // Row N..: per-visibility method buckets. Each non-empty bucket
        // gets a header row (foldable); when expanded, method rows
        // render below it. The whole stretch is suppressed when the
        // user has toggled methods off globally (slice 3 keybinding M).
        if (!methodsHidden) {
          for (const mb of p.t.methodBuckets) {
            const bucketId = methodBucketId(p.t.fullPath, mb.bucket);
            const bucketExpanded = state.isExpanded(bucketId);
            const headerName = bucketHeaderText(mb);
            const headerStart = p.x + FIELD_LABEL_INSET;
            fieldRows.push({
              name: headerName,
              tyText: '',
              ownership: 'primitive',
              x: headerStart,
              y: cursorY + p.y + ROW_H + (rowIdx + 0.5) * FIELD_ROW_H,
              arrowSourceX: headerStart + measureText(headerName) + 4,
              targets: [],
              kind: 'method_bucket',
              bucketId,
            });
            rowIdx++;
            if (bucketExpanded) {
              for (const fn of mb.methods) {
                // Method rows are indented past the bucket header so
                // they read as nested under the impl block. The
                // indent lives on every derived x-coordinate (name
                // start, arrow source) so the renderer doesn't have
                // to know the constant.
                const nameStart = p.x + FIELD_LABEL_INSET + METHOD_INDENT;
                // Method arrows are opt-in: a method's targets only
                // surface when the user has explicitly clicked the
                // row. `undefined` means "show everything" (test
                // path); a Set means "only those listed."
                const showThisArrow =
                  methodArrowsShown === undefined ||
                  methodArrowsShown.has(`${p.t.fullPath}${METHOD_ARROW_KEY_SEP}${fn.name}`);
                const targets = showThisArrow
                  ? (ownership.methodTargets.get(p.t.fullPath)?.get(fn.name) ?? [])
                  : [];
                fieldRows.push({
                  name: fn.name,
                  // Compose the signature into tyText so it surfaces
                  // through the existing field-ty hover hint (faded
                  // grey text past the row name). Same machinery as
                  // a field's `: SomeType` reveal — no new view
                  // component needed.
                  tyText: formatMethodSignature(fn),
                  ownership: 'primitive',
                  x: nameStart,
                  y: cursorY + p.y + ROW_H + (rowIdx + 0.5) * FIELD_ROW_H,
                  arrowSourceX: nameStart + measureText(fn.name) + 4,
                  targets,
                  kind: 'method',
                  bucketId: null,
                });
                rowIdx++;
              }
            }
          }
        }
      }
      const hasHeaderArrow = p.t.fields.length > 0 || p.t.methodBuckets.length > 0;
      const headerMetrics = measureTypeHeaderMetrics(p.t.label, hasHeaderArrow, measureText);
      types.push({
        id: p.t.id,
        label: p.t.label,
        typeKind: p.t.typeKind,
        visibility: p.t.visibility,
        fullPath: p.t.fullPath,
        modulePath: p.t.modulePath,
        col: p.col,
        x: p.x,
        y: headerY,
        width: p.width,
        headerArrowX: headerMetrics.arrowX,
        headerHitWidth: headerMetrics.hitWidth,
        height: p.pixelHeight,
        hasFields: hasHeaderArrow,
        expanded: p.tExpanded,
        fields: fieldRows,
        totalFieldCount: p.t.fields.length,
        isGhost: p.t.isGhost === true,
        ghostTarget: p.t.ghostTarget ?? null,
      });
    }

    cursorY += bandH;

    if (expanded) {
      for (const c of m.children) {
        if (c.kind === 'module') visit(c, modDepth + 1);
      }
    }
  };

  for (let i = 0; i < 5; i++) {
    placeAll();
    const tentativeRaw = collectRawArrows(types, drift, ghostArrowsShown);
    const tentativeObstacles = buildRoutingObstacles(types);
    const slotsByTarget = computeIncomingSlotsByTarget(
      tentativeRaw.filter(isPlacementArrow),
      tentativeObstacles,
    );
    const newXByPath = computeNodeXs(
      visibleTypes,
      incomingMap,
      routingWidthByPath,
      depth,
      globalXStart,
      rankPlacement,
      slotsByTarget,
    );
    if (sameXMaps(xByPath, newXByPath)) break;
    xByPath = newXByPath;
  }
  placeAll();

  const routed = buildArrows(types, drift, ghostArrowsShown);
  const arrows = routed.arrows;

  // Total horizontal extent: the rightmost edge across (a) the type pane
  // (t.x + t.width) and (b) the frozen module pane (estimated label end).
  // globalXStart is a lower bound — it's where the type pane begins.
  let totalWidth = globalXStart;
  for (const t of types) {
    const right = t.x + t.width;
    if (right > totalWidth) totalWidth = right;
    for (const f of t.fields) {
      if (f.arrowSourceX > totalWidth) totalWidth = f.arrowSourceX;
    }
  }
  for (const m of modules) {
    const right = m.labelX + MODULE_GLYPH_W + m.label.length * CHAR_W;
    if (right > totalWidth) totalWidth = right;
  }

  return {
    modules,
    types,
    arrows,
    totalHeight: cursorY + TOP_PAD,
    totalWidth,
    debug: { routing: routed.debug },
  };
}

type IncomingMap = ReadonlyMap<string, readonly string[]>;

function enumerateVisibleTypes(
  root: ModuleNode,
  state: ViewState,
  focusModules: ReadonlySet<string> | undefined,
): TypeNode[] {
  const out: TypeNode[] = [];
  const visit = (m: ModuleNode): void => {
    if (focusModules && !focusModules.has(m.id)) return;
    if (!state.isExpanded(m.id)) return;
    for (const c of m.children) {
      if (c.kind === 'type') out.push(c);
    }
    for (const c of m.children) {
      if (c.kind === 'module') visit(c);
    }
  };
  visit(root);
  return out;
}

function buildIncomingMap(
  visibleTypes: readonly TypeNode[],
  ownership: OwnershipIndex,
  depth: ReadonlyMap<string, number>,
  drift: DriftIndex,
): IncomingMap {
  const visible = new Set(visibleTypes.map((t) => t.fullPath));
  const typeByPath = new Map(visibleTypes.map((t) => [t.fullPath, t]));
  const incoming = new Map<string, string[]>();

  for (const source of visibleTypes) {
    const sourceRank = layoutRankOfType(source, depth);
    for (const targetId of ownership.owns.get(source.fullPath) ?? []) {
      if (!visible.has(targetId)) continue;
      if (!isCanonicalTarget(targetId, drift)) continue;
      const target = typeByPath.get(targetId);
      if (!target) continue;
      if (layoutRankOfType(target, depth) <= sourceRank) continue;
      let list = incoming.get(targetId);
      if (!list) {
        list = [];
        incoming.set(targetId, list);
      }
      if (!list.includes(source.fullPath)) list.push(source.fullPath);
    }
  }

  return incoming;
}

function computeNodeXs(
  visibleTypes: readonly TypeNode[],
  incomingMap: IncomingMap,
  widthByPath: ReadonlyMap<string, number>,
  depth: ReadonlyMap<string, number>,
  globalXStart: number,
  rankPlacement: StableRankPlacement,
  slotsByTarget: ReadonlyMap<string, number> | null,
): ReadonlyMap<string, number> {
  const typeByPath = new Map(visibleTypes.map((t) => [t.fullPath, t]));
  const ordered = [...visibleTypes].sort((a, b) => {
    const ra = layoutRankOfType(a, depth);
    const rb = layoutRankOfType(b, depth);
    if (ra !== rb) return ra - rb;
    return a.fullPath.localeCompare(b.fullPath);
  });

  const xByPath = new Map<string, number>();
  for (const t of ordered) {
    let x = rootXForRank(t, depth, globalXStart, COL_W) + stableRankOffset(t, rankPlacement);
    for (const sourceId of incomingMap.get(t.fullPath) ?? []) {
      const source = typeByPath.get(sourceId);
      if (!source) continue;
      const sourceX =
        xByPath.get(sourceId) ??
        rootXForRank(source, depth, globalXStart, COL_W) + stableRankOffset(source, rankPlacement);
      const sourceW = widthByPath.get(sourceId) ?? 0;
      const slotCount = Math.max(1, slotsByTarget?.get(t.fullPath) ?? 1);
      x = Math.max(x, sourceX + sourceW + gutterWidth(slotCount));
    }
    xByPath.set(t.fullPath, x);
  }
  return xByPath;
}

function stableRankOffset(t: TypeNode, rankPlacement: StableRankPlacement): number {
  return rankPlacement.xOffsetByType.get(t.fullPath) ?? 0;
}

function sameXMaps(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    if (b.get(k) !== v) return false;
  }
  return true;
}

interface PackedBox {
  readonly t: TypeNode;
  readonly tExpanded: boolean;
  readonly col: number;
  readonly x: number;
  readonly y: number; // pixel offset from band top
  readonly width: number;
  readonly pixelHeight: number;
}

interface PlacedRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

interface RelativeRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

interface CollisionShape {
  readonly rects: readonly RelativeRect[];
  readonly height: number;
}

interface PlacedShape {
  readonly y: number;
  readonly rects: readonly PlacedRect[];
}

function packBand(args: {
  readonly types: readonly TypeNode[];
  readonly depth: ReadonlyMap<string, number>;
  readonly globalXStart: number;
  readonly rankPlacement: StableRankPlacement;
  /** Per-type x-positions, computed by `computeNodeXs` from the
   *  weighted-longest-path placement. packBand reads each type's left
   *  edge from this map instead of from a column grid — that's what
   *  decouples unrelated chains at the same depth. */
  readonly xByPath: ReadonlyMap<string, number>;
  /** Per-type display widths, mirrored from the same map computeNodeXs used.
   *  Collision checks use row-shaped geometry; this width is preserved on
   *  the emitted TypeBox for rendering/routing metadata. */
  readonly widthByPath: ReadonlyMap<string, number>;
  readonly measureText: (text: string) => number;
  readonly state: ViewState;
  /** Per-type barycenter (mean y of incoming-arrow source rows). When
   *  provided alongside `bandTopY`, the second pass uses it to place each
   *  type at the row nearest its desired y rather than top-of-band. */
  readonly sortKey?: ReadonlyMap<string, number>;
  /** Optional absolute header-y stability anchor per type. */
  readonly anchorY?: ReadonlyMap<string, number>;
  /** Absolute y of the band's top edge in the layout. Needed to convert
   *  the absolute barycenter targets in `sortKey` into band-local y's. */
  readonly bandTopY?: number;
  /** Mirrors `LayoutInputs.methodsHidden` — when true, packBand skips
   *  method-bucket and method rows in width/height computation. */
  readonly methodsHidden: boolean;
}): { boxes: readonly PackedBox[]; bandHeight: number } {
  const {
    types,
    depth,
    globalXStart,
    rankPlacement,
    xByPath,
    widthByPath,
    measureText,
    state,
    sortKey,
    anchorY,
    bandTopY,
    methodsHidden,
  } = args;

  // Sort by depth, then sortKey (target y), then alphabetical. This drives
  // the column-y order in pass 2 — types with similar barycenters land
  // near each other.
  const sorted = [...types].sort((a, b) => {
    const da = semanticDepthOf(a, depth);
    const db = semanticDepthOf(b, depth);
    if (da !== db) return da - db;
    if (sortKey) {
      const ka = sortKey.get(a.fullPath);
      const kb = sortKey.get(b.fullPath);
      if (ka !== undefined && kb !== undefined && ka !== kb) return ka - kb;
      if (ka !== undefined && kb === undefined) return -1;
      if (kb !== undefined && ka === undefined) return 1;
    }
    return a.label.localeCompare(b.label);
  });

  // Per-type geometry. The column rank (`col`) is kept on each cell so
  // arrow direction code and the "rank" tests can still query it, but
  // it no longer drives placement — `xByPath` does. With per-target
  // gutters, two types at the same `col` can land at different x's
  // depending on their incoming traffic.
  //
  //   - function-group pseudo-types: col 0
  //   - real types: col = effectiveDepth + 1
  //   - ghost re-exports: col = canonical's effectiveDepth + 1
  type Cell = {
    t: TypeNode;
    tExpanded: boolean;
    col: number;
    x: number;
    w: number;
    h: number;
    shape: CollisionShape;
  };
  const cells: Cell[] = sorted.map((t) => {
    const d = semanticDepthOf(t, depth);
    const isFnGroup = t.typeKind === 'function_group';
    const col = isFnGroup ? 0 : d + 1;
    const x = xByPath.get(t.fullPath) ?? globalXStart + stableRankOffset(t, rankPlacement);
    const tExpanded = state.isExpanded(t.id);
    const w =
      widthByPath.get(t.fullPath) ?? computeTypeBoxWidth(t, tExpanded, state, methodsHidden);
    const h = tExpanded ? ROW_H + expandedRowCount(t, state, methodsHidden) * FIELD_ROW_H : ROW_H;
    const shape = buildCollisionShape(t, tExpanded, state, methodsHidden, measureText);
    return { t, tExpanded, col, x, w, h, shape };
  });
  // Pass 1: greedy top-down packing to establish the band's natural height.
  // Used as a hard cap in pass 2 so types don't push the band taller just
  // to land near their barycenter.
  const placed1: PlacedShape[] = [];
  for (const c of cells) {
    const y = findFitY(placed1, c.x, c.shape);
    placed1.push(placeShape(c.x, y, c.shape));
  }
  let bandHeight = 0;
  for (let i = 0; i < placed1.length; i++) {
    const r = placed1[i] as PlacedShape;
    const c = cells[i] as Cell;
    if (r.y + c.shape.height > bandHeight) bandHeight = r.y + c.shape.height;
  }
  const hasExpandedCells = cells.some((c) => c.tExpanded);

  // Without barycenter info (first iteration of buildOptimizedLayout, or
  // direct buildLayout calls without it), pass 1 is the final placement.
  if (!sortKey || bandTopY === undefined) {
    const boxes = cells.map(
      (c, i): PackedBox => ({
        t: c.t,
        tExpanded: c.tExpanded,
        col: c.col,
        x: c.x,
        y: (placed1[i] as PlacedShape).y,
        pixelHeight: c.h,
        width: c.w,
      }),
    );
    return { boxes, bandHeight };
  }

  // Pass 2: place each type at the slot nearest its barycenter target,
  // clamped to the band height established by pass 1. The pass-1 y is
  // also a stability anchor: opening one type should not cause unrelated
  // neighbors to jump upward just because a spare slot appeared.
  const placed2: PlacedShape[] = [];
  const boxes: PackedBox[] = [];
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i] as Cell;
    const naturalY = (placed1[i] as PlacedShape).y;
    const anchoredY = anchorY?.has(c.t.fullPath)
      ? (anchorY.get(c.t.fullPath) as number) - bandTopY - ROW_H / 2
      : naturalY;
    const abs = sortKey.get(c.t.fullPath);
    let targetY = naturalY;
    if (abs !== undefined) {
      // Anchor the header row on the target y. Arrows terminate at the
      // type header dot, not the expanded box's vertical center; centering
      // the whole box makes expanded targets drift upward into existing
      // horizontal arrow tracks.
      targetY = abs - bandTopY - ROW_H / 2;
    }
    targetY = Math.max(0, Math.min(bandHeight - c.shape.height, targetY));
    const floorY = hasExpandedCells && !c.tExpanded ? anchoredY : undefined;
    const y = findFitYNearTarget(placed2, c.x, c.shape, targetY, anchoredY, bandHeight, floorY);
    placed2.push(placeShape(c.x, y, c.shape));
    boxes.push({
      t: c.t,
      tExpanded: c.tExpanded,
      col: c.col,
      x: c.x,
      y,
      pixelHeight: c.h,
      width: c.w,
    });
  }
  // Pass 2 might still grow the band slightly if all in-cap slots
  // conflict; recompute final bandHeight just in case.
  for (let i = 0; i < placed2.length; i++) {
    const r = placed2[i] as PlacedShape;
    const c = cells[i] as Cell;
    if (r.y + c.shape.height > bandHeight) bandHeight = r.y + c.shape.height;
  }
  return { boxes, bandHeight };
}

/** Find a y that fits the given shape closest to `targetY`. Candidates are:
 *  the target itself, the stability anchor, top-of-band (y=0), and
 *  just-below / just-above each x-overlapping placed rect. If nothing fits
 *  within `cap`, falls back to the unbounded greedy `findFitY`. */
function findFitYNearTarget(
  placed: readonly PlacedShape[],
  x: number,
  shape: CollisionShape,
  targetY: number,
  anchorY: number,
  cap: number,
  floorY?: number,
): number {
  const candidates = new Set<number>();
  candidates.add(Math.max(0, targetY));
  candidates.add(Math.max(0, anchorY));
  candidates.add(0);
  for (const r of shape.rects) {
    const rectX = x + r.x;
    for (const placedShape of placed) {
      for (const p of placedShape.rects) {
        if (!xRangesOverlap(rectX, r.w, p.x, p.w, TYPE_X_GAP)) continue;
        candidates.add(p.y + p.h - r.y);
        const above = p.y - r.y - r.h;
        if (above >= 0) candidates.add(above);
      }
    }
  }

  const fitting: number[] = [];
  for (const y of candidates) {
    if (y < 0 || y + shape.height > cap) continue;
    if (floorY !== undefined && y < floorY) continue;
    if (fitsShapeAt(placed, x, y, shape)) fitting.push(y);
  }

  if (fitting.length === 0) return findFitY(placed, x, shape, floorY ?? 0);
  const score = (y: number): number => Math.abs(y - targetY) + Math.abs(y - anchorY) * 0.75;
  fitting.sort((a, b) => score(a) - score(b));
  return fitting[0] as number;
}

function findFitY(
  placed: readonly PlacedShape[],
  x: number,
  shape: CollisionShape,
  startY = 0,
): number {
  // Smallest y >= 0 such that no candidate row-rect overlaps any placed
  // row-rect (with TYPE_X_GAP horizontal margin). Iterates by pushing
  // the whole shape past the lowest conflicting rect; converges in O(N^2)
  // per insertion (fine at our scale).
  let y = Math.max(0, startY);
  for (let safety = 0; safety < 1024; safety++) {
    let pushTo = y;
    let conflict = false;
    for (const r of shape.rects) {
      const rectX = x + r.x;
      const rectY = y + r.y;
      for (const placedShape of placed) {
        for (const p of placedShape.rects) {
          if (!xRangesOverlap(rectX, r.w, p.x, p.w, TYPE_X_GAP)) continue;
          if (!yRangesOverlap(rectY, r.h, p.y, p.h)) continue;
          conflict = true;
          const candidateY = p.y + p.h - r.y;
          if (candidateY > pushTo) pushTo = candidateY;
        }
      }
    }
    if (!conflict) return y;
    if (pushTo === y) return y; // safety: shouldn't happen
    y = pushTo;
  }
  return y;
}

function fitsShapeAt(
  placed: readonly PlacedShape[],
  x: number,
  y: number,
  shape: CollisionShape,
): boolean {
  for (const r of shape.rects) {
    const rectX = x + r.x;
    const rectY = y + r.y;
    for (const placedShape of placed) {
      for (const p of placedShape.rects) {
        if (!xRangesOverlap(rectX, r.w, p.x, p.w, TYPE_X_GAP)) continue;
        if (yRangesOverlap(rectY, r.h, p.y, p.h)) return false;
      }
    }
  }
  return true;
}

function placeShape(x: number, y: number, shape: CollisionShape): PlacedShape {
  return {
    y,
    rects: shape.rects.map((r) => ({ x: x + r.x, y: y + r.y, w: r.w, h: r.h })),
  };
}

function xRangesOverlap(ax: number, aw: number, bx: number, bw: number, gap: number): boolean {
  return !(ax + aw + gap <= bx || bx + bw + gap <= ax);
}

function yRangesOverlap(ay: number, ah: number, by: number, bh: number): boolean {
  return !(ay + ah <= by || by + bh <= ay);
}

function buildCollisionShape(
  t: TypeNode,
  expanded: boolean,
  state: ViewState,
  methodsHidden: boolean,
  measureText: (text: string) => number,
): CollisionShape {
  const rects: RelativeRect[] = [
    {
      x: 0,
      y: 0,
      w: TYPE_GLYPH_W + measureText(t.label) + 4,
      h: ROW_H,
    },
  ];

  let rowIdx = 0;
  if (expanded) {
    for (const f of t.fields) {
      rects.push(rowRect(rowIdx, labelInsetForRows(t), measureText(f.name)));
      rowIdx++;
    }
    if (!methodsHidden) {
      for (const mb of t.methodBuckets) {
        const bucketText = bucketHeaderText(mb);
        rects.push(rowRect(rowIdx, FIELD_LABEL_INSET, measureText(bucketText)));
        rowIdx++;
        if (state.isExpanded(methodBucketId(t.fullPath, mb.bucket))) {
          for (const method of mb.methods) {
            rects.push(
              rowRect(rowIdx, FIELD_LABEL_INSET + METHOD_INDENT, measureText(method.name)),
            );
            rowIdx++;
          }
        }
      }
    }
  }

  return {
    rects,
    height: expanded ? ROW_H + rowIdx * FIELD_ROW_H : ROW_H,
  };
}

function rowRect(rowIdx: number, labelInset: number, textWidth: number): RelativeRect {
  return {
    x: 0,
    y: ROW_H + rowIdx * FIELD_ROW_H,
    w: labelInset + textWidth + 4,
    h: FIELD_ROW_H,
  };
}

function shapeWidth(shape: CollisionShape): number {
  let width = 0;
  for (const r of shape.rects) {
    if (r.x + r.w > width) width = r.x + r.w;
  }
  return width;
}

function computeTypeBoxWidth(
  t: TypeNode,
  expanded: boolean,
  state: ViewState,
  methodsHidden: boolean,
  measureText: (text: string) => number = (s) => s.length * CHAR_W,
  capFunctionGroup = true,
): number {
  // Box width counts the header label and the longest visible row label.
  // The grey `: ty_text` suffix overflows visually and isn't counted, so it
  // doesn't push downstream depth columns rightward. Packing uses the same
  // row geometry as a shape, so long detail rows only block the rows they
  // occupy rather than widening the whole expanded symbol rectangle.
  let w = shapeWidth(buildCollisionShape(t, expanded, state, methodsHidden, measureText));
  // Function-group pseudo-types live in column 0; real types live in
  // column 1+. Keep the emitted box width capped to that first column so
  // function groups do not behave like full-width type boxes. Their long
  // visible rows still participate in collision via CollisionShape above,
  // so they block only the rows they actually occupy.
  if (capFunctionGroup && t.typeKind === 'function_group' && w > COL_W - TYPE_X_GAP) {
    w = COL_W - TYPE_X_GAP;
  }
  return w;
}

function labelInsetForRows(t: TypeNode): number {
  return t.typeKind === 'function_group' ? FUNCTION_GROUP_LABEL_INSET : FIELD_LABEL_INSET;
}

/** Total number of inner rows an expanded type renders. Counts the
 *  static field rows plus, for each method bucket, one header row plus
 *  (when the bucket is expanded) one row per method. Does NOT include
 *  the type's header row itself. */
function expandedRowCount(t: TypeNode, state: ViewState, methodsHidden: boolean): number {
  let n = t.fields.length;
  if (!methodsHidden) {
    for (const mb of t.methodBuckets) {
      n += 1; // bucket header
      if (state.isExpanded(methodBucketId(t.fullPath, mb.bucket))) {
        n += mb.methods.length;
      }
    }
  }
  return n;
}

/** Stable id for a method bucket — added to / removed from the shared
 *  expanded set in `ViewState`. The `__methods_` infix can't collide
 *  with any real type or function-group id. */
export function methodBucketId(typeFullPath: string, bucket: VisibilityBucket): string {
  return `${typeFullPath}::__methods_${bucket}`;
}

/** Text rendered on a method-bucket header row — visibility label
 *  followed by the method count, e.g. `pub fn (3)`. */
function bucketHeaderText(mb: {
  readonly bucket: VisibilityBucket;
  readonly methods: readonly unknown[];
}): string {
  return `${BUCKET_LABEL[mb.bucket]} (${mb.methods.length})`;
}

/** Render a method's signature for the hover-reveal tail. Format
 *  matches Rust source as closely as the available facts allow:
 *
 *    [unsafe ][const ][async ](&self, x: Foo, y: Bar) -> Baz
 *
 *  Receiver, return type, and qualifiers all degrade gracefully: an
 *  older facts file without `params` produces just `()`, a method
 *  with `()` return type drops the `-> ()` since it adds no info.
 *  Body is empty for legacy facts so the hover tail just doesn't
 *  appear (the row still renders normally). */
function formatMethodSignature(fn: FnFacts): string {
  const parts: string[] = [];
  if (fn.is_unsafe === true) parts.push('unsafe ');
  if (fn.is_const === true) parts.push('const ');
  if (fn.is_async === true) parts.push('async ');
  const args: string[] = [];
  switch (fn.self_kind) {
    case 'by_value':
      args.push('self');
      break;
    case 'ref':
      args.push('&self');
      break;
    case 'ref_mut':
      args.push('&mut self');
      break;
    // 'none' or undefined → no receiver
  }
  for (const p of fn.params ?? []) {
    args.push(`${p.name}: ${p.ty_text}`);
  }
  parts.push(`(${args.join(', ')})`);
  // Hide the trailing arrow when return is unit — `() -> ()` is noise.
  // Empty / undefined means the extractor didn't surface a return
  // type for this fn at all, so omit too.
  const ret = fn.return_ty_text;
  if (ret !== undefined && ret !== '' && ret !== '()') {
    parts.push(` -> ${ret}`);
  }
  return parts.join('');
}

interface RawArrow {
  readonly sourceX: number;
  readonly sourceLeftX?: number;
  readonly sourceRightX?: number;
  readonly sourceSide?: 'left' | 'right';
  readonly sourceY: number;
  readonly targetX: number;
  readonly targetY: number;
  /** Source/target rank metadata. Weighted placement uses this only to
   *  decide which ownership arrows are structural forward constraints;
   *  lane x itself is target-local, not column-grid based. */
  readonly sourceCol: number;
  readonly targetCol: number;
  readonly fromTypeId: string;
  readonly fromFieldName: string;
  readonly fromRowKind: 'field' | 'method';
  readonly toTypeId: string;
  readonly driftClass: DriftClass;
  readonly kind: ArrowKind;
}

type ObstacleRect = ChannelObstacle;

function computeIncomingSlotsByTarget(
  arrows: readonly RawArrow[],
  obstacles: readonly ObstacleRect[],
): ReadonlyMap<string, number> {
  return allocateIncomingChannels(arrows, obstacles).slotCountByTarget;
}

function sharedReturnRailX(types: readonly TypeBox[]): number {
  let left = Number.POSITIVE_INFINITY;
  for (const t of types) {
    if (t.x < left) left = t.x;
  }
  return (Number.isFinite(left) ? left : 0) - LANE_BASE_GAP - LANE_SLOT_W / 2;
}

function buildArrows(
  types: readonly TypeBox[],
  drift: DriftIndex,
  ghostArrowsShown: ReadonlySet<string> | undefined,
): { readonly arrows: readonly Arrow[]; readonly debug: ChannelDebug } {
  const raw = collectRawArrows(types, drift, ghostArrowsShown);
  const obstacles = buildRoutingObstacles(types);
  const allocation = allocateIncomingChannels(
    raw.filter((r) => !isReturnArrow(r)),
    obstacles,
  );
  const returnLaneX = sharedReturnRailX(types);
  const arrows: Arrow[] = [];
  for (const r of raw) {
    const laneX = isReturnArrow(r)
      ? returnLaneX
      : (allocation.laneXByArrow.get(r) ?? fallbackIncomingLaneX(r.targetX, 0));
    arrows.push(makeArrow(r, laneX, obstacles));
  }
  return { arrows, debug: allocation.debug };
}

function buildRoutingObstacles(types: readonly TypeBox[]): readonly ObstacleRect[] {
  const out: ObstacleRect[] = [];
  for (const t of types) {
    const top = t.y - ROW_H / 2;
    const bottom = top + t.height;
    const headerWidth = TYPE_GLYPH_W + t.label.length * CHAR_W + 4;
    let hullWidth = Math.max(headerWidth, Math.min(t.width, ROUTE_HULL_ROW_WIDTH_LIMIT));
    for (const f of t.fields) {
      const rowWidth = f.arrowSourceX - t.x + 4;
      if (rowWidth <= ROUTE_HULL_ROW_WIDTH_LIMIT + ROUTE_LONG_ROW_PROTRUSION) {
        hullWidth = Math.max(hullWidth, rowWidth);
      }
    }

    out.push({
      left: t.x - ROUTE_OBSTACLE_PAD,
      right: t.x + hullWidth + ROUTE_OBSTACLE_PAD,
      top,
      bottom,
    });
    for (const f of t.fields) {
      const rowWidth = f.arrowSourceX - t.x + 4;
      if (rowWidth <= hullWidth + ROUTE_LONG_ROW_PROTRUSION) continue;
      out.push({
        left: f.x - ROUTE_OBSTACLE_PAD,
        right: f.arrowSourceX + ROUTE_OBSTACLE_PAD,
        top: f.y - FIELD_ROW_H / 2,
        bottom: f.y + FIELD_ROW_H / 2,
      });
    }
  }
  return out;
}

/** Walk the placed types and emit one `RawArrow` per outgoing
 *  reference: every (field|method) → target plus every visible
 *  ghost → canonical. Used both by the buildLayout driver (to
 *  measure channel demand BEFORE sizing the column grid) and by the
 *  final `buildArrows` pass. Pure — no lane assignment, just
 *  geometry + (sourceCol, targetCol) annotation. */
function collectRawArrows(
  types: readonly TypeBox[],
  drift: DriftIndex,
  ghostArrowsShown: ReadonlySet<string> | undefined,
): RawArrow[] {
  const byFullPath = new Map(types.map((t) => [t.fullPath, t]));
  const out: RawArrow[] = [];

  // Endpoint geometry knobs for ghost arrows — pull each end back to
  // the dot perimeter plus a gap so the line doesn't ride through
  // the dot (which would also let the dot's click handler swallow
  // clicks meant for the arrow).
  const TYPE_DOT_X_OFFSET = 6; // matches TYPE_CIRCLE_X in tree.ts
  const TYPE_DOT_RADIUS = 4; // matches TYPE_RADIUS in tree.ts
  const DOT_EDGE_GAP = 4;
  const dotEdgeBack = TYPE_DOT_RADIUS + DOT_EDGE_GAP;

  for (const t of types) {
    if (t.expanded) {
      for (const f of t.fields) {
        for (const targetId of f.targets) {
          const target = byFullPath.get(targetId);
          if (!target) continue;
          if (target.fullPath === t.fullPath) continue;
          const driftClass = drift.typeClass.get(target.fullPath) ?? 'at_lca';
          // Source side is a physical channel-space decision. A row
          // may be visually wider than its type header, especially for
          // method names, so a semantic "target is to the right" test
          // is only the first gate. If the row text already reaches
          // into the target column, route from the left side of the row
          // instead of drawing a horizontal segment through the text.
          const isForward = t.col < target.col;
          const sourceLeftX = f.x - 4;
          const sourceRightX = f.arrowSourceX;
          const canUseForwardChannel =
            isForward &&
            (f.kind === 'method' || isCanonicalDriftClass(driftClass)) &&
            sourceRightX + 2 * LANE_BASE_GAP <= target.x;
          const sourceSide = canUseForwardChannel ? 'right' : 'left';
          out.push({
            sourceX: sourceSide === 'right' ? sourceRightX : sourceLeftX,
            sourceLeftX,
            sourceRightX,
            sourceSide,
            sourceY: f.y,
            targetX: target.x,
            targetY: target.y,
            sourceCol: t.col,
            targetCol: target.col,
            fromTypeId: t.fullPath,
            fromFieldName: f.name,
            // Methods and fields can share names within a type; tag
            // the arrow so selection-highlight chain matching can
            // disambiguate.
            fromRowKind: f.kind === 'method' ? 'method' : 'field',
            toTypeId: target.fullPath,
            driftClass,
            kind: f.kind === 'method' ? 'method' : 'ownership',
          });
        }
      }
    }
    // Ghost re-export arrows. Source = the ghost row, target = the
    // canonical type's dot. Re-export ghosts inherit the canonical rank,
    // so physical x, not rank, decides whether the arrow heads left or
    // right. When heading right, start after the ghost label so a same-row
    // dashed arrow does not run through the re-export text.
    if (t.isGhost && t.ghostTarget !== null) {
      if (ghostArrowsShown !== undefined && !ghostArrowsShown.has(t.id)) continue;
      const target = byFullPath.get(t.ghostTarget);
      if (!target || target.isGhost) continue;
      const sourceLeftX = t.x + TYPE_DOT_X_OFFSET - dotEdgeBack;
      const sourceRightX = t.x + TYPE_GLYPH_W + t.label.length * CHAR_W + DOT_EDGE_GAP;
      const targetX = target.x + TYPE_DOT_X_OFFSET - dotEdgeBack;
      const sourceSide = targetX >= sourceRightX ? 'right' : 'left';
      out.push({
        sourceX: sourceSide === 'right' ? sourceRightX : sourceLeftX,
        sourceLeftX,
        sourceRightX,
        sourceSide,
        sourceY: t.y,
        targetX,
        targetY: target.y,
        sourceCol: t.col,
        targetCol: target.col,
        fromTypeId: t.fullPath,
        fromFieldName: '',
        fromRowKind: 'field',
        toTypeId: target.fullPath,
        driftClass: 'at_lca',
        kind: 'reexport',
      });
    }
  }
  return out;
}

function makeArrow(
  r: RawArrow,
  targetLaneX: number,
  obstacles: readonly ObstacleRect[] = [],
): Arrow {
  const sourceX = routeSourceX(r, r.targetX);
  if (Math.abs(r.sourceY - r.targetY) < 1) {
    return {
      waypoints: [
        { x: sourceX, y: r.sourceY },
        { x: r.targetX, y: r.targetY },
      ],
      fromTypeId: r.fromTypeId,
      fromFieldName: r.fromFieldName,
      fromRowKind: r.fromRowKind,
      toTypeId: r.toTypeId,
      kind: r.kind,
      driftClass: r.driftClass,
    };
  }

  const laneX = targetLaneX;
  const routedSourceX = routeSourceX(r, laneX);
  const sourceClear = trimmedHorizontalClear(
    r.sourceY,
    routedSourceX,
    laneX,
    LANE_BASE_GAP,
    0,
    obstacles,
  );
  const targetClear = trimmedHorizontalClear(
    r.targetY,
    laneX,
    r.targetX,
    0,
    LANE_BASE_GAP,
    obstacles,
  );
  const yMin = Math.min(r.sourceY, r.targetY);
  const yMax = Math.max(r.sourceY, r.targetY);
  const laneClear = verticalClear(laneX, yMin, yMax, obstacles);
  if (sourceClear && targetClear && laneClear) {
    return {
      waypoints: [
        { x: routedSourceX, y: r.sourceY },
        { x: laneX, y: r.sourceY },
        { x: laneX, y: r.targetY },
        { x: r.targetX, y: r.targetY },
      ],
      fromTypeId: r.fromTypeId,
      fromFieldName: r.fromFieldName,
      fromRowKind: r.fromRowKind,
      toTypeId: r.toTypeId,
      kind: r.kind,
      driftClass: r.driftClass,
    };
  }

  if (!sourceClear && targetClear && laneClear) {
    const sourceStubX =
      laneX >= routedSourceX ? routedSourceX + LANE_BASE_GAP : routedSourceX - LANE_BASE_GAP;
    const trackY = chooseHorizontalTrackY(r, sourceStubX, laneX, obstacles);
    if (trackY !== null) {
      return {
        waypoints: [
          { x: routedSourceX, y: r.sourceY },
          { x: sourceStubX, y: r.sourceY },
          { x: sourceStubX, y: trackY },
          { x: laneX, y: trackY },
          { x: laneX, y: r.targetY },
          { x: r.targetX, y: r.targetY },
        ],
        fromTypeId: r.fromTypeId,
        fromFieldName: r.fromFieldName,
        fromRowKind: r.fromRowKind,
        toTypeId: r.toTypeId,
        kind: r.kind,
        driftClass: r.driftClass,
      };
    }
  }

  return {
    waypoints: [
      { x: routedSourceX, y: r.sourceY },
      { x: laneX, y: r.sourceY },
      { x: laneX, y: r.targetY },
      { x: r.targetX, y: r.targetY },
    ],
    fromTypeId: r.fromTypeId,
    fromFieldName: r.fromFieldName,
    fromRowKind: r.fromRowKind,
    toTypeId: r.toTypeId,
    kind: r.kind,
    driftClass: r.driftClass,
  };
}

function trimmedHorizontalClear(
  y: number,
  xA: number,
  xB: number,
  trimStart: number,
  trimEnd: number,
  obstacles: readonly ObstacleRect[],
): boolean {
  const dx = xB - xA;
  if (Math.abs(dx) < 1) return true;
  const direction = dx > 0 ? 1 : -1;
  const start = xA + direction * trimStart;
  const end = xB - direction * trimEnd;
  if ((direction > 0 && start >= end) || (direction < 0 && start <= end)) return true;
  return horizontalClear(y, start, end, obstacles);
}

function chooseHorizontalTrackY(
  r: RawArrow,
  sourceStubX: number,
  laneX: number,
  obstacles: readonly ObstacleRect[],
): number | null {
  const yMin = Math.min(r.sourceY, r.targetY);
  const yMax = Math.max(r.sourceY, r.targetY);
  const direction = r.sourceY < r.targetY ? 1 : -1;
  const candidates: number[] = [
    r.sourceY + (direction * FIELD_ROW_H) / 2,
    r.targetY - (direction * FIELD_ROW_H) / 2,
  ];
  for (const o of obstacles) {
    const before = o.top - 2;
    const after = o.bottom + 2;
    if (before > yMin && before < yMax) candidates.push(before);
    if (after > yMin && after < yMax) candidates.push(after);
  }
  candidates.sort((a, b) => Math.abs(a - r.sourceY) - Math.abs(b - r.sourceY));

  for (const y of candidates) {
    if (Math.abs(y - r.sourceY) < 1 || Math.abs(y - r.targetY) < 1) continue;
    if (!horizontalClear(y, sourceStubX, laneX, obstacles)) continue;
    if (!verticalClear(sourceStubX, Math.min(r.sourceY, y), Math.max(r.sourceY, y), obstacles)) {
      continue;
    }
    return y;
  }
  return null;
}

function verticalClear(
  x: number,
  yMin: number,
  yMax: number,
  obstacles: readonly ObstacleRect[],
): boolean {
  for (const o of obstacles) {
    if (x <= o.left || x >= o.right) continue;
    if (yMin < o.bottom && o.top < yMax) return false;
  }
  return true;
}

function horizontalClear(
  y: number,
  xA: number,
  xB: number,
  obstacles: readonly ObstacleRect[],
): boolean {
  const xMin = Math.min(xA, xB);
  const xMax = Math.max(xA, xB);
  for (const o of obstacles) {
    if (y <= o.top || y >= o.bottom) continue;
    if (xMin < o.right && o.left < xMax) return false;
  }
  return true;
}

function computeGlobalXStart(root: ModuleNode): number {
  let max = 0;
  const walk = (m: ModuleNode, modDepth: number): void => {
    const labelX = LEFT_PAD + modDepth * INDENT_PX;
    const labelEnd = labelX + estimateModuleLabelWidth(m.label);
    if (labelEnd > max) max = labelEnd;
    for (const c of m.children) {
      if (c.kind === 'module') walk(c, modDepth + 1);
    }
  };
  walk(root, 0);
  return max + MODULE_BAND_X_GAP;
}

function estimateModuleLabelWidth(label: string): number {
  return MODULE_GLYPH_W + label.length * CHAR_W;
}

/**
 * Build a layout, then run iterative barycenter sweeps to reorder types within
 * each (band, depth) cell so arrow crossings are reduced.
 *
 * Each pass: compute one sort-key per type from the mean y of its INCOMING
 * partners (its owners' field-source ys), rebuild the layout. After K passes
 * the ordering has propagated K layers downstream (depth 1 settles first,
 * then depth 2 picks up the new depth-1 positions, etc.).
 *
 * We use one direction (incoming) rather than alternating: the backward sweep
 * was using stale outgoing positions and pulling types back to alphabetical,
 * undoing the forward sweep.
 *
 * Stops when the y-signature stabilizes or `maxSweeps` iterations elapse.
 */
export function buildOptimizedLayout(inputs: LayoutInputs, maxSweeps = 8): Layout {
  let layout = buildLayout(inputs);
  const anchorY = typeHeaderYMap(layout);
  let prevSig = ySignature(layout);
  for (let i = 0; i < maxSweeps; i++) {
    const sortKey = barycenterKeys(layout, inputs.ownership, 'incoming', inputs.drift);
    layout = buildLayout({ ...inputs, sortKey, anchorY });
    const sig = ySignature(layout);
    if (sig === prevSig) break;
    prevSig = sig;
  }
  return layout;
}

function typeHeaderYMap(layout: Layout): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of layout.types) out.set(t.fullPath, t.y);
  return out;
}

function barycenterKeys(
  layout: Layout,
  ownership: OwnershipIndex,
  direction: 'incoming' | 'outgoing',
  drift: DriftIndex,
): Map<string, number> {
  // For incoming, use the y of the SOURCE field row (where the arrow actually
  // starts) inside each owner — not the owner's header. Drift'd targets (i.e.
  // non-canonical) get no incoming contribution: they fall back to current y
  // so anomalous edges don't pull them around.
  const typeByPath = new Map<string, Layout['types'][number]>();
  for (const t of layout.types) typeByPath.set(t.fullPath, t);

  const keys = new Map<string, number>();
  for (const t of layout.types) {
    const ys: number[] = [];
    const targetIsCanonical = isCanonicalTarget(t.fullPath, drift);
    if (direction === 'incoming' && targetIsCanonical) {
      for (const ownerId of ownership.ownedBy.get(t.fullPath) ?? []) {
        const owner = typeByPath.get(ownerId);
        if (!owner) continue;
        let pushedFieldY = false;
        if (owner.expanded) {
          for (const f of owner.fields) {
            if (f.targets.includes(t.fullPath)) {
              ys.push(f.y);
              pushedFieldY = true;
            }
          }
        }
        if (!pushedFieldY) ys.push(owner.y);
      }
    } else if (direction === 'outgoing') {
      for (const ownedId of ownership.owns.get(t.fullPath) ?? []) {
        if (!isCanonicalTarget(ownedId, drift)) continue;
        const owned = typeByPath.get(ownedId);
        if (owned) ys.push(owned.y);
      }
    }
    if (ys.length > 0) {
      keys.set(t.fullPath, ys.reduce((a, b) => a + b, 0) / ys.length);
    } else {
      keys.set(t.fullPath, t.y);
    }
  }
  return keys;
}

function ySignature(layout: Layout): string {
  // Stable identity of the current visual ordering — just per-type y values
  // serialized in a deterministic order.
  const parts: string[] = [];
  for (const t of layout.types) parts.push(`${t.fullPath}=${t.y}`);
  parts.sort();
  return parts.join('|');
}
