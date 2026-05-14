// Geometry pass: deterministic physical placement of visible module bands.
// The placement plan owns logical ranks and ownership predecessors; this
// module measures visible items, places snapped rectangles, and adapts them to
// renderer-facing boxes.

import type { FunctionCallIndex, FunctionCallRef, FunctionRowRef } from '../analysis/calls.ts';
import type { DriftClass, DriftIndex } from '../analysis/drift.ts';
import {
  DRIFT_DOT_OFFSET,
  DRIFT_DOT_PORT_GAP,
  DRIFT_DOT_RADIUS,
  FIELD_LABEL_INSET,
  FIELD_ROW_H,
  FUNCTION_GROUP_LABEL_INSET,
  INDENT_PX,
  LAYOUT_GRID,
  LAYOUT_GRID_CELL_H,
  LAYOUT_GRID_CELL_W,
  LEFT_PAD,
  type LeafBgSegment,
  METHOD_INDENT,
  MIN_TYPE_BOX_W,
  MODULE_BAND_X_GAP,
  MODULE_GLYPH_W,
  type PrefixSegment,
  ROW_H,
  TOP_PAD,
  TYPE_X_GAP,
  computeLeafSegment,
  computePrefixSegments,
  measureModuleHitWidth,
  measureTypeHeaderMetrics,
} from '../analysis/layout_metrics.ts';
import {
  type LayoutDebugGrid,
  type LayoutDebugLabel,
  type LayoutInputs,
  callArrowKey,
  rowArrowKey,
} from '../analysis/layout_model.ts';
import {
  type ModuleNode,
  type TreeNode,
  type TypeNode,
  WORKSPACE_ROOT_ID,
  methodBucketId,
} from '../analysis/module_tree.ts';
import type { OwnershipIndex } from '../analysis/ownership.ts';
import { BUCKET_LABEL, type VisibilityBucket } from '../analysis/visibility.ts';
import type { FnFacts, Ownership } from '../data/schema.ts';
import type { ViewState } from '../state/view_state.ts';
import {
  type BandLayoutGridItem,
  type BandLayoutItem,
  type PreparedBandLayout,
  prepareModuleBandLayout,
} from './band_layout.ts';
import { type GridSpec, gridRectToPx } from './grid.ts';
import {
  type PlacedGridFragment,
  type PlacedGridItem,
  placeGridItemsTopToBottom,
} from './grid_placement.ts';
import type { ExtraGap } from './placement_gaps.ts';
import {
  type PlacementLayoutPlan,
  buildPlacementLayoutPlan,
  isNonRankType,
  requirePlacement,
} from './placement_plan.ts';
import type {
  PlacedFragmentRect,
  PositionedModule,
  PositionedRow,
  PositionedType,
  RankAssignment,
} from './types.ts';

export { FIELD_ROW_H, INDENT_PX, LEFT_PAD, ROW_H, TOP_PAD } from '../analysis/layout_metrics.ts';
/** Legacy nominal column width retained for routing/gutter compatibility
 *  while physical type placement moves to the band-local grid planner. */
export const COL_W = 240;
export { TYPE_X_GAP } from '../analysis/layout_metrics.ts';
/** Legacy dense-depth cap retained as public geometry metadata for older
 *  tests/consumers; the new band planner owns same-rank spreading. */
export const DEPTH_COLUMN_CAP = 3;
export const MIN_BOX_W = MIN_TYPE_BOX_W;
export { TYPE_GLYPH_W } from '../analysis/layout_metrics.ts';
/** Approximate character width used as a fallback when no measureText is
 *  provided (tests). Real renders pass a canvas-backed measurer. */
export const CHAR_W = 7;

export const BAND_GRID_CELL_W = LAYOUT_GRID_CELL_W;
export const BAND_GRID_CELL_H = LAYOUT_GRID_CELL_H;
const BAND_GRID: GridSpec = {
  cellWidth: LAYOUT_GRID.cellWidth,
  cellHeight: LAYOUT_GRID.cellHeight,
};
const BAND_ITEM_RIGHT_CLEARANCE_CELLS = Math.ceil(TYPE_X_GAP / BAND_GRID.cellWidth);
const BAND_ITEM_BOTTOM_CLEARANCE_CELLS = 1;
const BAND_BOTTOM_PAD = 0;
const BAND_PLACEMENT_SEARCH = { maxCols: 2048, maxRows: 4096 } as const;

export interface Geometry {
  readonly types: readonly PositionedType[];
  readonly modules: readonly PositionedModule[];
  readonly placedFragments: readonly PlacedFragmentRect[];
  readonly ranks: ReadonlyMap<string, RankAssignment>;
  readonly typesById: ReadonlyMap<string, PositionedType>;
  readonly debugLabels?: readonly LayoutDebugLabel[];
  readonly debugGrid: LayoutDebugGrid;
  readonly globalXStart: number;
  readonly columnStride: number;
  readonly totalWidth: number;
  readonly totalHeight: number;
}

export interface GeometryOptions {
  readonly extraGaps?: readonly ExtraGap[];
  readonly placementPlan?: PlacementLayoutPlan;
}

export function computeGeometry(inputs: LayoutInputs, options: GeometryOptions = {}): Geometry {
  const placementPlan =
    options.placementPlan ??
    buildPlacementLayoutPlan(inputs.staticRoot, inputs.depth, inputs.ownership);
  const allTypes = placementPlan.types;
  const ranks = placementPlan.ranks;
  const measure = inputs.measureText ?? ((s: string) => s.length * CHAR_W);
  const measureBold = inputs.measureBoldText ?? measure;
  const globalXStart = computeGlobalXStart(inputs.staticRoot, inputs.state, measure, measureBold);
  const columnStride = computeColumnStride(allTypes, measure);
  const extraGaps = options.extraGaps ?? [];

  const moduleBands = collectVisibleModuleBands(
    inputs.staticRoot,
    0,
    /* parentExpanded */ true,
    inputs.state,
    inputs.focusModules,
    inputs.ownership,
    inputs.drift,
    inputs.methodsHidden ?? false,
    inputs.fieldArrowsShown,
    inputs.callArrowsShown,
    inputs.calls,
    placementPlan,
    measure,
    measureBold,
  );
  const preparedBands = prepareVisibleBands(moduleBands);
  const placedGrid = placeGridItemsTopToBottom(
    preparedBands.flatMap((band) => band.gridItems),
    {
      ...BAND_PLACEMENT_SEARCH,
      extraGaps,
      rankLayerGapCells: BAND_ITEM_RIGHT_CLEARANCE_CELLS,
      // Prelude placement is scoped to each module band. Cross-band rank floors
      // start at real ownership ranks so one module's function groups cannot
      // push unrelated sibling modules far to the right.
      firstRankLayerOrder: 1,
    },
  );
  const assembled = assembleGeometryFromPlacedBands(
    preparedBands,
    placedGrid.items,
    placedGrid.fragments,
    globalXStart,
  );

  let totalWidth = globalXStart;
  for (const t of assembled.types) {
    const right = t.x + t.width;
    if (right > totalWidth) totalWidth = right;
    for (const row of t.visibleRows) {
      const rowRight = row.arrowSourceX + (row.tyText ? 6 + measure(row.tyText) : 0);
      if (rowRight > totalWidth) totalWidth = rowRight;
    }
  }
  for (const fragment of assembled.placedFragments) {
    const right = fragment.x + fragment.width;
    if (right > totalWidth) totalWidth = right;
  }
  const typesById = new Map(assembled.types.map((t) => [t.node.id, t] as const));

  return {
    types: assembled.types,
    modules: assembled.modules,
    placedFragments: assembled.placedFragments,
    ranks,
    typesById,
    debugLabels: assembled.debugLabels,
    debugGrid: {
      originX: globalXStart,
      originY: TOP_PAD,
      cellWidth: BAND_GRID.cellWidth,
      cellHeight: BAND_GRID.cellHeight,
      width: Math.max(0, totalWidth - globalXStart),
      height: Math.max(0, assembled.totalHeight - TOP_PAD),
    },
    globalXStart,
    columnStride,
    totalWidth,
    totalHeight: assembled.totalHeight,
  };
}

function computeColumnStride(types: readonly TypeNode[], measure: (s: string) => number): number {
  let stride = COL_W;
  for (const t of types) {
    // Header labels are always visible, so their width is part of the
    // stable data-derived column contract. Detail rows can protrude
    // per-row, but headers must never overlap the next sub-column.
    const hasHeaderArrow = hasDetailRows(t);
    stride = Math.max(
      stride,
      measureTypeHeaderMetrics(t.label, hasHeaderArrow, measure).width + TYPE_X_GAP,
    );
  }
  return stride;
}

interface ModuleBandSpec {
  readonly node: ModuleNode;
  readonly modDepth: number;
  readonly labelX: number;
  readonly hitWidth: number;
  readonly hasChildren: boolean;
  readonly expanded: boolean;
  readonly semanticItems: readonly SemanticBandItem[];
  readonly prefixSegments: readonly PrefixSegment[];
  readonly leafBg: LeafBgSegment;
}

interface PreparedModuleBand extends ModuleBandSpec {
  readonly prepared: PreparedBandLayout | null;
  readonly gridItems: readonly BandLayoutGridItem[];
}

interface AssembledGeometry {
  readonly types: readonly PositionedType[];
  readonly modules: readonly PositionedModule[];
  readonly placedFragments: readonly PlacedFragmentRect[];
  readonly debugLabels: readonly LayoutDebugLabel[];
  readonly totalHeight: number;
}

function collectVisibleModuleBands(
  node: TreeNode,
  modDepth: number,
  parentExpanded: boolean,
  state: ViewState,
  focusModules: ReadonlySet<string> | undefined,
  ownership: OwnershipIndex,
  drift: DriftIndex,
  methodsHidden: boolean,
  fieldArrowsShown: ReadonlySet<string> | undefined,
  callArrowsShown: ReadonlySet<string> | undefined,
  calls: FunctionCallIndex | undefined,
  placementPlan: PlacementLayoutPlan,
  measure: (s: string) => number,
  measureBold: (s: string) => number,
): readonly ModuleBandSpec[] {
  if (!parentExpanded || node.kind !== 'module') return [];
  if (focusModules !== undefined && !focusModules.has(node.id)) return [];

  const expanded = state.isExpanded(node.id);

  // The workspace root is structural, not a real module — it just wraps
  // crate trees so the layout pipeline has a single root. Don't emit a
  // band for it; recurse into its children (the crates) at modDepth 0
  // so they act as the top tier in the rendered hierarchy.
  if (node.id === WORKSPACE_ROOT_ID) {
    const out: ModuleBandSpec[] = [];
    if (expanded) {
      for (const child of node.children) {
        if (child.kind !== 'module') continue;
        out.push(
          ...collectVisibleModuleBands(
            child,
            modDepth,
            /* parentExpanded */ true,
            state,
            focusModules,
            ownership,
            drift,
            methodsHidden,
            fieldArrowsShown,
            callArrowsShown,
            calls,
            placementPlan,
            measure,
            measureBold,
          ),
        );
      }
    }
    return out;
  }

  const hasChildren = node.children.length > 0;
  const labelX = LEFT_PAD + modDepth * INDENT_PX + MODULE_GLYPH_W;
  let semanticItems: readonly SemanticBandItem[] = [];
  if (expanded) {
    const ownTypes: TypeNode[] = [];
    for (const child of node.children) {
      if (child.kind === 'type') ownTypes.push(child);
    }
    semanticItems = buildSemanticBandItems(
      ownTypes,
      placementPlan,
      state,
      ownership,
      drift,
      methodsHidden,
      fieldArrowsShown,
      callArrowsShown,
      calls,
      measure,
      measureBold,
    );
  }

  const prefixSegments = computePrefixSegments(node.id, measure);
  // Every row gets a leaf chip; isParent decides whether the renderer hashes
  // the leaf name to a palette colour (so parent rows match the prefix in
  // their descendants) or falls back to a neutral fill for leaf-only rows.
  const hasModuleChildren =
    node.kind === 'module' && node.children.some((c) => c.kind === 'module');
  const leafBg = computeLeafSegment(node.id, prefixSegments, measureBold, hasModuleChildren);

  const out: ModuleBandSpec[] = [
    {
      node,
      modDepth,
      labelX,
      hitWidth: measureModuleHitWidth(node.id, measure, measureBold),
      hasChildren,
      expanded,
      semanticItems,
      prefixSegments,
      leafBg,
    },
  ];

  if (expanded) {
    for (const child of node.children) {
      if (child.kind !== 'module') continue;
      out.push(
        ...collectVisibleModuleBands(
          child,
          modDepth + 1,
          /* parentExpanded */ true,
          state,
          focusModules,
          ownership,
          drift,
          methodsHidden,
          fieldArrowsShown,
          callArrowsShown,
          calls,
          placementPlan,
          measure,
          measureBold,
        ),
      );
    }
  }

  return out;
}

function prepareVisibleBands(
  moduleBands: readonly ModuleBandSpec[],
): readonly PreparedModuleBand[] {
  return moduleBands.map((band) => {
    if (band.semanticItems.length === 0) {
      return { ...band, prepared: null, gridItems: [] };
    }

    const prepared = prepareModuleBandLayout(band.semanticItems.map((item) => item.bandItem));
    return {
      ...band,
      prepared,
      gridItems: prepared.gridItems.map((item) => ({
        ...item,
        regionId: band.node.id,
      })),
    };
  });
}

interface SemanticBandItem {
  readonly node: TypeNode;
  readonly bandItem: BandLayoutItem;
  readonly headerWidth: number;
  readonly headerArrowX: number | null;
  readonly headerHitWidth: number;
  readonly visualHeight: number;
  readonly expanded: boolean;
  readonly rowSpecs: readonly LocalRowSpec[];
  readonly depthMarker: number;
  readonly subrank: number;
  readonly rank: number;
}

function assembleGeometryFromPlacedBands(
  bands: readonly PreparedModuleBand[],
  placedItems: readonly PlacedGridItem[],
  placedFragments: readonly PlacedGridFragment[],
  globalXStart: number,
): AssembledGeometry {
  const out: PositionedType[] = [];
  const outFragments: PlacedFragmentRect[] = [];
  const debugLabels: LayoutDebugLabel[] = [];
  const modules: PositionedModule[] = [];
  const placementByItemId = new Map(placedItems.map((item) => [item.id, item] as const));
  const placedFragmentsByRegion = new Map<string, PlacedGridFragment[]>();

  for (const fragment of placedFragments) {
    const regionFragments = placedFragmentsByRegion.get(fragment.regionId) ?? [];
    regionFragments.push(fragment);
    placedFragmentsByRegion.set(fragment.regionId, regionFragments);
  }

  let cursorY = TOP_PAD;
  for (const band of bands) {
    const bandFragments = placedFragmentsByRegion.get(band.node.id) ?? [];
    const bandHeight = Math.max(ROW_H, placedBandHeightPx(bandFragments));
    modules.push({
      node: band.node,
      y: cursorY,
      bandHeight,
      modDepth: band.modDepth,
      labelX: band.labelX,
      hitWidth: band.hitWidth,
      hasChildren: band.hasChildren,
      expanded: band.expanded,
      prefixSegments: band.prefixSegments,
      leafBg: band.leafBg,
    });

    const byId = new Map(band.semanticItems.map((item) => [item.node.id, item] as const));
    for (const semantic of band.semanticItems) {
      const placedItem = placementByItemId.get(semantic.node.id);
      if (placedItem === undefined) {
        throw new Error(`Missing placed item for visible type: ${semantic.node.id}`);
      }

      const x = globalXStart + placedItem.origin.col * BAND_GRID.cellWidth;
      const headerY = cursorY + placedItem.origin.row * BAND_GRID.cellHeight + ROW_H / 2;
      out.push({
        node: semantic.node,
        bandId: band.node.id,
        bandOrder: placedItem.groupOrder,
        indexInBandOrder: placedItem.indexInGroup,
        x,
        y: headerY,
        width: semantic.headerWidth,
        headerArrowX: semantic.headerArrowX,
        headerHitWidth: semantic.headerHitWidth,
        height: semantic.visualHeight,
        depth: semantic.depthMarker,
        subrank: semantic.subrank,
        rank: semantic.rank,
        expanded: semantic.expanded,
        visibleRows: positionRows(semantic.rowSpecs, x, headerY),
      });
    }

    if (band.prepared !== null) {
      for (const fragment of bandFragments) {
        if (!byId.has(fragment.ownerId)) {
          throw new Error(`Band planner returned unknown type fragment: ${fragment.ownerId}`);
        }
        const original = restorePreparedFragment(fragment, band.prepared);
        const placement = placementByItemId.get(fragment.itemId);
        if (placement === undefined) {
          throw new Error(`Missing placed item for fragment: ${fragment.fragmentId}`);
        }
        const px = gridRectToPx(fragment.own, BAND_GRID);
        const obstacleWidth = original.measuredWidthPx;
        const obstacleHeight = original.measuredHeightPx;
        // Packing uses snapped grid cells, but the exported fragment is the
        // visible/routable rectangle. Keeping those separate prevents one
        // hidden snap cell from becoming a debug box, hit target, or obstacle.
        outFragments.push({
          typeId: fragment.ownerId,
          bandId: band.node.id,
          // Routing pressure addresses these band-local display groups. They
          // come from the same placement items as the real fragments, so debug
          // and routing never use approximate rectangles.
          bandOrder: original.groupOrder,
          indexInBandOrder: original.indexInGroup,
          fragmentId: original.fragmentId,
          fragmentIndex: original.fragmentIndex,
          fragmentKind: original.kind,
          rowIds: original.rowIds,
          x: globalXStart + px.x,
          y: cursorY + px.y,
          width: obstacleWidth,
          height: obstacleHeight,
        });
        debugLabels.push({
          id: `${band.node.id}:${fragment.ownerId}:${fragment.fragmentId}`,
          x: globalXStart + px.x + obstacleWidth - 4,
          y: cursorY + px.y + 12,
          // Rank is the stable logical tier; bandOrder is the same-rank
          // display group used by physical packing in this band.
          label: `R${placement.rankOrder}/B${placement.groupOrder}`,
        });
      }
    }

    cursorY += bandHeight;
  }

  return { types: out, modules, placedFragments: outFragments, debugLabels, totalHeight: cursorY };
}

function restorePreparedFragment(fragment: PlacedGridFragment, prepared: PreparedBandLayout) {
  const fragments = prepared.fragmentsById.get(fragment.ownerId);
  const original = fragments?.fragments.find(
    (candidate) => candidate.fragmentId === fragment.fragmentId,
  );
  if (original === undefined) {
    throw new Error(`Missing prepared fragment for placed fragment: ${fragment.fragmentId}`);
  }
  const placement = prepared.gridItems.find((item) => item.id === fragment.itemId);
  if (placement === undefined) {
    throw new Error(`Missing prepared placement item for fragment: ${fragment.itemId}`);
  }
  return { ...original, groupOrder: placement.groupOrder, indexInGroup: placement.indexInGroup };
}

function buildSemanticBandItems(
  types: readonly TypeNode[],
  placementPlan: PlacementLayoutPlan,
  state: ViewState,
  ownership: OwnershipIndex,
  drift: DriftIndex,
  methodsHidden: boolean,
  fieldArrowsShown: ReadonlySet<string> | undefined,
  callArrowsShown: ReadonlySet<string> | undefined,
  calls: FunctionCallIndex | undefined,
  measure: (s: string) => number,
  measureBold: (s: string) => number,
): readonly SemanticBandItem[] {
  return types.map((node): SemanticBandItem => {
    const expanded = state.isExpanded(node.id);
    const rowSpecs = expanded
      ? buildRowSpecs(
          node,
          state,
          ownership,
          drift,
          methodsHidden,
          fieldArrowsShown,
          callArrowsShown,
          calls,
          measure,
          measureBold,
        )
      : [];
    const hasHeaderArrow = hasDetailRows(node);
    const headerMetrics = measureTypeHeaderMetrics(node.label, hasHeaderArrow, measure);
    const headerWidth = headerMetrics.width;
    const placement = requirePlacement(placementPlan, node.id);
    const rank = placementPlan.ranks.get(node.id);
    const nonRank = isNonRankType(node);
    const depthMarker = nonRank ? -1 : (rank?.depth ?? 0);

    return {
      node,
      bandItem: {
        id: node.id,
        name: node.label,
        depth: placement.depth,
        rankOrder: placement.rankOrder,
        predecessorIds: placement.forwardPredecessors,
        // Physical same-rank spreading consumes the placement plan's stable
        // order. Measurement and expansion can change box size, but they must
        // not change which item is earlier within its logical tier.
        stableOrder: placement.stableOrder,
        // Module-level function groups live in the reserved leftmost column;
        // every other item (real types AND ghosts) is floored past the global
        // fn-column width so types align in column 2+ across all bands.
        isFnColumn: node.typeKind === 'function_group',
        header: {
          measuredWidthPx: headerWidth,
          measuredHeightPx: ROW_H,
        },
        rows: rowSpecs.map((row, index) => ({
          id: `${node.id}:row:${index}`,
          name: row.name,
          measuredWidthPx: measuredRowWidth(row),
          measuredHeightPx: FIELD_ROW_H,
        })),
        grid: BAND_GRID,
        clearance: {
          main: bandItemClearance(),
          body: bandItemClearance(),
          splitRow: bandItemClearance(),
        },
      },
      headerWidth,
      headerArrowX: headerMetrics.arrowX,
      headerHitWidth: headerMetrics.hitWidth,
      visualHeight: ROW_H + rowSpecs.length * FIELD_ROW_H,
      expanded,
      rowSpecs,
      depthMarker,
      subrank: nonRank ? -1 : (rank?.subrank ?? 0),
      rank: nonRank ? -1 : (rank?.rank ?? 0),
    };
  });
}

function measuredRowWidth(row: LocalRowSpec): number {
  // Row type/signature suffixes are hover/detail annotations, not part of
  // the stable member-name footprint. Counting them here makes one verbose
  // Rust type force the whole layout box wide even when the readable anchor
  // is just the field or method name.
  //
  // The locality `→` glyph (inlineSuffixWidth + the trailing gap before it),
  // however, IS a permanent part of the row — its space is reserved
  // regardless of whether the glyph is currently drawn. Excluding it
  // pushed the type-box right edge inside the glyph, so callable rows
  // with outgoing calls rendered the arrow OUTSIDE the box.
  const suffix = row.inlineSuffixWidth ?? 0;
  const trailing = suffix > 0 ? ROW_NAME_TRAILING_GAP : 0;
  return row.labelInset + row.textWidth + trailing + suffix;
}

function bandItemClearance() {
  return {
    top: 0,
    right: BAND_ITEM_RIGHT_CLEARANCE_CELLS,
    bottom: BAND_ITEM_BOTTOM_CLEARANCE_CELLS,
    left: 0,
  };
}

function placedBandHeightPx(
  fragments: readonly { readonly clearance: { readonly row: number; readonly rows: number } }[],
): number {
  let bottomRows = 0;
  for (const fragment of fragments) {
    bottomRows = Math.max(bottomRows, fragment.clearance.row + fragment.clearance.rows);
  }
  return bottomRows * BAND_GRID.cellHeight + BAND_BOTTOM_PAD;
}

interface LocalRowSpec {
  readonly name: string;
  readonly tyText: string;
  readonly ownership: Ownership;
  readonly labelInset: number;
  readonly textWidth: number;
  /** Reserve in pixels for the `→` locality glyph painted after callable
   *  row names. `arrowSourceX` is computed as
   *  `x + textWidth + 4 + (inlineSuffixWidth ?? 0)` so outgoing call arrows
   *  start past the glyph rather than slicing through it. */
  readonly inlineSuffixWidth?: number;
  readonly targets: readonly string[];
  readonly callTargets: readonly FunctionRowRef[];
  readonly callRefs: readonly FunctionCallRef[];
  readonly incomingCallRefs: readonly FunctionCallRef[];
  readonly functionFullPath: string | null;
  readonly callsOutsideModule: boolean;
  readonly hasExternalCalls: boolean;
  readonly hasUnresolvedCalls: boolean;
  readonly hasOutgoingCalls: boolean;
  readonly hasIncomingCalls: boolean;
  readonly kind: 'field' | 'method_bucket' | 'method' | 'function' | 'signature_arg';
  readonly bucketId: string | null;
  readonly memberDriftClass: DriftClass | null;
  /** Self-receiver shape, propagated from FnFacts for callable rows only
   *  so the renderer can color the name by ownership flavor without
   *  re-parsing the formatted signature. */
  readonly selfKind?: 'none' | 'by_value' | 'ref' | 'ref_mut';
}

function buildRowSpecs(
  t: TypeNode,
  state: ViewState,
  ownership: OwnershipIndex,
  drift: DriftIndex,
  methodsHidden: boolean,
  fieldArrowsShown: ReadonlySet<string> | undefined,
  callArrowsShown: ReadonlySet<string> | undefined,
  calls: FunctionCallIndex | undefined,
  measure: (s: string) => number,
  measureBold: (s: string) => number,
): LocalRowSpec[] {
  const rows: LocalRowSpec[] = [];
  if (t.typeKind === 'function_group') {
    for (const f of t.functions) {
      pushCallableRow(rows, {
        fn: f.fn,
        functionFullPath: f.fullPath,
        kind: 'function',
        labelInset: FUNCTION_GROUP_LABEL_INSET,
        parentTypeId: t.id,
        state,
        callArrowsShown,
        calls,
        measure,
        measureBold,
      });
    }
    return rows;
  }

  const fieldTargets = ownership.fieldTargets.get(t.fullPath);
  for (const f of t.fields) {
    const targets = fieldTargets?.get(f.name) ?? [];
    const memberDriftClass = strongestDriftClassForTargets(targets, drift);
    // Canonical ownership arrows are background structure and remain visible
    // by default. Drifted member arrows stay opt-in so orange/red routes only
    // appear when the user asks to inspect that anomalous row.
    const showThisArrow =
      fieldArrowsShown === undefined ||
      isCanonicalMemberDrift(memberDriftClass) ||
      fieldArrowsShown.has(rowArrowKey(t.fullPath, f.name));
    rows.push({
      name: f.name,
      tyText: f.ty_text,
      ownership: f.ownership,
      labelInset: labelInsetForRows(t),
      textWidth: measure(f.name),
      targets: showThisArrow ? targets : [],
      callTargets: [],
      callRefs: [],
      incomingCallRefs: [],
      functionFullPath: null,
      callsOutsideModule: false,
      hasExternalCalls: false,
      hasUnresolvedCalls: false,
      hasOutgoingCalls: false,
      hasIncomingCalls: false,
      kind: 'field',
      bucketId: null,
      memberDriftClass,
    });
  }
  if (methodsHidden) return rows;

  for (const mb of t.methodBuckets) {
    const bucketId = methodBucketId(t.fullPath, mb.bucket);
    const headerName = bucketHeaderText(mb);
    rows.push({
      name: headerName,
      tyText: '',
      ownership: 'primitive',
      labelInset: FIELD_LABEL_INSET,
      textWidth: measure(headerName),
      targets: [],
      callTargets: [],
      callRefs: [],
      incomingCallRefs: [],
      functionFullPath: null,
      callsOutsideModule: false,
      hasExternalCalls: false,
      hasUnresolvedCalls: false,
      hasOutgoingCalls: false,
      hasIncomingCalls: false,
      kind: 'method_bucket',
      bucketId,
      memberDriftClass: null,
    });
    if (!state.isExpanded(bucketId)) continue;
    for (const fn of mb.methods) {
      pushCallableRow(rows, {
        fn,
        functionFullPath: `${t.fullPath}::${fn.name}`,
        kind: 'method',
        labelInset: FIELD_LABEL_INSET + METHOD_INDENT,
        parentTypeId: t.id,
        state,
        callArrowsShown,
        calls,
        measure,
        measureBold,
      });
    }
  }
  return rows;
}

function pushCallableRow(
  rows: LocalRowSpec[],
  args: {
    readonly fn: FnFacts;
    readonly functionFullPath: string;
    readonly kind: 'method' | 'function';
    readonly labelInset: number;
    /** TypeNode id of the parent type / function group. Used to derive the
     *  callArrowKey for selection-state lookup. */
    readonly parentTypeId: string;
    readonly state: ViewState;
    readonly callArrowsShown: ReadonlySet<string> | undefined;
    readonly calls: FunctionCallIndex | undefined;
    readonly measure: (s: string) => number;
    /** Bold measurer used when this row is currently selected — the
     *  renderer paints selected names bold, and the `→` glyph sits at
     *  `x + textWidth + 4`. Switching the measurer with selection keeps
     *  unselected rows tight while ensuring a selected bold name never
     *  spills past the glyph. */
    readonly measureBold: (s: string) => number;
  },
): void {
  // Module-level functions and type-member functions are both executable
  // callables. Keep their row contract identical so rendering and routing
  // cannot drift based on where Rust declared the function.
  const callRefs = args.calls?.callsByFunction.get(args.functionFullPath) ?? [];
  const hasExternalCalls = callRefs.some((call) => call.locality === 'other_module');
  const hasUnresolvedCalls = callRefs.some((call) => call.locality === 'unresolved');
  const callsOutsideModule = hasExternalCalls || hasUnresolvedCalls;
  const callTargets = args.calls?.callTargetsByFunction.get(args.functionFullPath) ?? [];
  const incomingCallRefs = args.calls?.incomingCallsByFunction.get(args.functionFullPath) ?? [];
  const localityGlyphW = args.measure(LOCALITY_GLYPH);
  // Bold measurement only when the row is selected — selection drives
  // the bold render. Unselected rows use the regular measurer so the `→`
  // glyph sits tight against the row name. Toggling selection rebuilds
  // the layout, so the glyph slides smoothly via the renderer's `move`
  // transition rather than jumping.
  const isSelected =
    args.callArrowsShown?.has(callArrowKey(args.parentTypeId, args.fn.name, args.kind)) ?? false;
  const nameMeasure = isSelected ? args.measureBold : args.measure;
  rows.push({
    name: args.fn.name,
    tyText: formatCallableSignature(args.fn),
    ownership: 'primitive',
    labelInset: args.labelInset,
    textWidth: nameMeasure(args.fn.name),
    // Reserve room for the `→` locality glyph (rendered after the row
    // name) so outgoing call arrows start past it. Reserved unconditionally
    // even when the glyph isn't currently drawn — a row can gain/lose
    // outgoing calls across redraws, and arrowSourceX must stay stable for
    // the same row identity.
    inlineSuffixWidth: localityGlyphW + LOCALITY_GAP,
    targets: [],
    callTargets,
    callRefs,
    incomingCallRefs,
    functionFullPath: args.functionFullPath,
    callsOutsideModule,
    hasExternalCalls,
    hasUnresolvedCalls,
    hasOutgoingCalls: callRefs.length > 0,
    hasIncomingCalls: incomingCallRefs.length > 0,
    kind: args.kind,
    bucketId: null,
    memberDriftClass: null,
    ...(args.fn.self_kind !== undefined ? { selfKind: args.fn.self_kind } : {}),
  });

  // Signature expansion: when the user clicks the (..) glyph next to a
  // function name, ViewState records sig::<fullPath>. The expanded rows are
  // pure detail — no arrows, no markers, no chevron. They participate in
  // obstacles like normal rows so call arrows route around them.
  if (args.state.isExpanded(signatureExpansionId(args.functionFullPath))) {
    pushSignatureRows(rows, args.fn, args.functionFullPath, args.labelInset, args.measure);
  }
}

const SIGNATURE_ARG_INDENT = METHOD_INDENT;
// Gap between the row name and the first inline element to its right —
// either the locality `→` glyph on callable rows or the arrow exit
// (arrowSourceX) on other rows. Kept small so the glyph hugs the name
// without crowding the letterforms.
const ROW_NAME_TRAILING_GAP = 2;
// Locality indicator glyph: a small `→` painted after the callable row
// name. Clicking it toggles arrow-selection for that callable; clicking
// the name itself toggles the signature expansion. The glyph encodes
// local/external/unresolved via color. Space is reserved unconditionally
// so call arrows from a row land at the same x relative to its name
// regardless of whether the glyph is currently drawn (rows can gain/lose
// outgoing calls across redraws).
export const LOCALITY_GLYPH = '→';
// Gap between the glyph and the arrow exit point — same value as the
// name trailing gap so the glyph sits symmetrically between name and exit.
const LOCALITY_GAP = 2;

export function signatureExpansionId(functionFullPath: string): string {
  return `sig::${functionFullPath}`;
}

function pushSignatureRows(
  rows: LocalRowSpec[],
  fn: FnFacts,
  parentFunctionFullPath: string,
  parentLabelInset: number,
  measure: (s: string) => number,
): void {
  const indent = parentLabelInset + SIGNATURE_ARG_INDENT;
  const push = (name: string, tyText: string): void => {
    rows.push({
      name,
      tyText,
      ownership: 'primitive',
      labelInset: indent,
      textWidth: measure(name),
      targets: [],
      callTargets: [],
      callRefs: [],
      incomingCallRefs: [],
      // Stamp the parent function path on each signature row so the
      // renderer's data-join can key signature rows by (parent, name).
      // Without this, two functions sharing a param name (or both having a
      // `-> ` return row) collide on the global `kind:name` key and d3
      // animates only one shared DOM element.
      functionFullPath: parentFunctionFullPath,
      callsOutsideModule: false,
      hasExternalCalls: false,
      hasUnresolvedCalls: false,
      hasOutgoingCalls: false,
      hasIncomingCalls: false,
      kind: 'signature_arg',
      bucketId: null,
      memberDriftClass: null,
    });
  };

  switch (fn.self_kind) {
    case 'by_value':
      push('self', '');
      break;
    case 'ref':
      push('&self', '');
      break;
    case 'ref_mut':
      push('&mut self', '');
      break;
  }
  for (const p of fn.params ?? []) {
    push(p.name, p.ty_text);
  }
  const ret = fn.return_ty_text;
  if (ret !== undefined && ret !== '' && ret !== '()') {
    // Return row uses '->' as the leading glyph; the renderer treats
    // signature_arg rows uniformly (name black, tyText grey), and '->' reads
    // naturally even when coloured the same as a param name.
    push('->', ret);
  }
}

function strongestDriftClassForTargets(
  targets: readonly string[],
  drift: DriftIndex,
): DriftClass | null {
  let strongest: DriftClass | null = null;
  let strongestRank = 0;
  for (const target of targets) {
    const driftClass = drift.typeClass.get(target) ?? 'at_lca';
    const rank = driftSeverity(driftClass);
    if (rank > strongestRank) {
      strongest = driftClass;
      strongestRank = rank;
    }
  }
  return strongest;
}

function isCanonicalMemberDrift(driftClass: DriftClass | null): boolean {
  return driftClass === 'at_lca' || driftClass === 'within_budget';
}

// Field rows with non-canonical drift render a small dot to the left of
// the name. Geometry needs to know this to push the row's left-side
// arrow port past the dot. Other row kinds (callables, buckets, signature
// args) never carry a dot.
function rowHasDriftDot(spec: LocalRowSpec): boolean {
  return (
    spec.kind === 'field' &&
    spec.memberDriftClass !== null &&
    !isCanonicalMemberDrift(spec.memberDriftClass)
  );
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

function positionRows(
  specs: readonly LocalRowSpec[],
  typeX: number,
  headerY: number,
): PositionedRow[] {
  const rows: PositionedRow[] = [];
  let rowY = headerY + ROW_H / 2 + FIELD_ROW_H / 2;
  for (const spec of specs) {
    const x = typeX + spec.labelInset;
    // The `→` locality glyph sits immediately after the row name on
    // callable rows. Only callable specs reserve `inlineSuffixWidth`, so
    // that's a sufficient signal to compute its position.
    const localityGlyphX =
      spec.inlineSuffixWidth !== undefined
        ? x + spec.textWidth + ROW_NAME_TRAILING_GAP
        : undefined;
    // Field rows with non-canonical drift carry a small dot to the left
    // of the name; the row's left-side arrow port has to start past the
    // dot or a left-going outgoing arrow draws through it.
    const leftPortX = rowHasDriftDot(spec)
      ? x - (DRIFT_DOT_OFFSET + DRIFT_DOT_RADIUS + DRIFT_DOT_PORT_GAP)
      : x;
    rows.push({
      name: spec.name,
      tyText: spec.tyText,
      ownership: spec.ownership,
      x,
      y: rowY,
      textWidth: spec.textWidth,
      leftPortX,
      ...(localityGlyphX !== undefined ? { localityGlyphX } : {}),
      ...(spec.selfKind !== undefined ? { selfKind: spec.selfKind } : {}),
      arrowSourceX: x + spec.textWidth + ROW_NAME_TRAILING_GAP + (spec.inlineSuffixWidth ?? 0),
      targets: spec.targets,
      callTargets: spec.callTargets,
      callRefs: spec.callRefs,
      incomingCallRefs: spec.incomingCallRefs,
      functionFullPath: spec.functionFullPath,
      callsOutsideModule: spec.callsOutsideModule,
      hasExternalCalls: spec.hasExternalCalls,
      hasUnresolvedCalls: spec.hasUnresolvedCalls,
      hasOutgoingCalls: spec.hasOutgoingCalls,
      hasIncomingCalls: spec.hasIncomingCalls,
      kind: spec.kind,
      bucketId: spec.bucketId,
      memberDriftClass: spec.memberDriftClass,
    });
    rowY += FIELD_ROW_H;
  }
  return rows;
}

function labelInsetForRows(t: TypeNode): number {
  return t.typeKind === 'function_group' ? FUNCTION_GROUP_LABEL_INSET : FIELD_LABEL_INSET;
}

function hasDetailRows(t: TypeNode): boolean {
  return t.fields.length > 0 || t.functions.length > 0 || t.methodBuckets.length > 0;
}

function bucketHeaderText(mb: {
  readonly bucket: VisibilityBucket;
  readonly methods: readonly unknown[];
}): string {
  return `${BUCKET_LABEL[mb.bucket]} (${mb.methods.length})`;
}

/** Callable rows need the same signature tail wherever Rust declared them.
 *  Keeping this in geometry makes row height, hit source, and rendered text
 *  agree instead of making routing infer function details later. */
function formatCallableSignature(fn: FnFacts): string {
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
  }
  for (const p of fn.params ?? []) {
    args.push(`${p.name}: ${p.ty_text}`);
  }
  parts.push(`(${args.join(', ')})`);
  const ret = fn.return_ty_text;
  if (ret !== undefined && ret !== '' && ret !== '()') parts.push(` -> ${ret}`);
  return parts.join('');
}

function computeGlobalXStart(
  root: ModuleNode,
  state: ViewState,
  measure: (s: string) => number,
  measureBold: (s: string) => number,
): number {
  // Walk only the CURRENTLY VISIBLE modules — a module is visible when
  // all its ancestors are expanded; the root is always visible. Using
  // the visible set keeps the type pane snug against the actually-rendered
  // module column. Tradeoff: expanding a deeply-nested module with a
  // long path can grow globalXStart and shift the type pane right; the
  // alternative (walking the whole tree to pre-reserve worst-case space)
  // produces a giant default gap when no long-path modules are open.
  let maxLabelEnd = 0;
  const walk = (n: TreeNode, modDepth: number, parentExpanded: boolean): void => {
    if (n.kind !== 'module') return;
    if (modDepth > 0 && !parentExpanded) return;
    const labelX = LEFT_PAD + modDepth * INDENT_PX + MODULE_GLYPH_W;
    const chipWidth = measureModuleHitWidth(n.id, measure, measureBold);
    if (labelX + chipWidth > maxLabelEnd) maxLabelEnd = labelX + chipWidth;
    const expanded = state.isExpanded(n.id);
    for (const c of n.children) walk(c, modDepth + 1, expanded);
  };
  walk(root, 0, /* root parent is implicitly expanded */ true);
  return maxLabelEnd + MODULE_BAND_X_GAP;
}
