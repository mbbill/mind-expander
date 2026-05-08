// Geometry pass: deterministic physical placement of visible module bands.
// The placement plan owns logical ranks and ownership predecessors; this
// module measures visible items, places snapped rectangles, and adapts them to
// renderer-facing boxes.

import {
  FIELD_LABEL_INSET,
  FIELD_ROW_H,
  FUNCTION_GROUP_LABEL_INSET,
  INDENT_PX,
  LAYOUT_GRID,
  LAYOUT_GRID_CELL_H,
  LAYOUT_GRID_CELL_W,
  LEFT_PAD,
  METHOD_INDENT,
  MIN_TYPE_BOX_W,
  MODULE_BAND_X_GAP,
  MODULE_GLYPH_W,
  ROW_H,
  TOP_PAD,
  TYPE_X_GAP,
  measureModuleHitWidth,
  measureTypeHeaderMetrics,
} from '../analysis/layout_metrics.ts';
import type { LayoutDebugGrid, LayoutDebugLabel, LayoutInputs } from '../analysis/layout_model.ts';
import type { ModuleNode, TreeNode, TypeNode } from '../analysis/module_tree.ts';
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
const METHOD_ARROW_KEY_SEP = '\x1F';
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
  const globalXStart = computeGlobalXStart(inputs.staticRoot, inputs.state, measure);
  const columnStride = computeColumnStride(allTypes, measure);
  const extraGaps = options.extraGaps ?? [];

  const moduleBands = collectVisibleModuleBands(
    inputs.staticRoot,
    0,
    /* parentExpanded */ true,
    inputs.state,
    inputs.focusModules,
    inputs.ownership,
    inputs.methodsHidden ?? false,
    inputs.methodArrowsShown,
    placementPlan,
    measure,
  );
  const preparedBands = prepareVisibleBands(moduleBands);
  const placedGrid = placeGridItemsTopToBottom(
    preparedBands.flatMap((band) => band.gridItems),
    {
      ...BAND_PLACEMENT_SEARCH,
      extraGaps,
      rankLayerGapCells: BAND_ITEM_RIGHT_CLEARANCE_CELLS,
      // Prelude/function groups are intentionally module-local; the global
      // LCA layer floor starts at the first real ownership rank.
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
    const hasHeaderArrow = t.fields.length > 0 || t.methodBuckets.length > 0;
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
  methodsHidden: boolean,
  methodArrowsShown: ReadonlySet<string> | undefined,
  placementPlan: PlacementLayoutPlan,
  measure: (s: string) => number,
): readonly ModuleBandSpec[] {
  if (!parentExpanded || node.kind !== 'module') return [];
  if (focusModules !== undefined && !focusModules.has(node.id)) return [];

  const expanded = state.isExpanded(node.id);
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
      methodsHidden,
      methodArrowsShown,
      measure,
    );
  }

  const out: ModuleBandSpec[] = [
    {
      node,
      modDepth,
      labelX,
      hitWidth: measureModuleHitWidth(node.id, measure),
      hasChildren,
      expanded,
      semanticItems,
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
          methodsHidden,
          methodArrowsShown,
          placementPlan,
          measure,
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
  methodsHidden: boolean,
  methodArrowsShown: ReadonlySet<string> | undefined,
  measure: (s: string) => number,
): readonly SemanticBandItem[] {
  return types.map((node): SemanticBandItem => {
    const expanded = state.isExpanded(node.id);
    const rowSpecs = expanded
      ? buildRowSpecs(node, state, ownership, methodsHidden, methodArrowsShown, measure)
      : [];
    const hasHeaderArrow = node.fields.length > 0 || node.methodBuckets.length > 0;
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
  return row.labelInset + row.textWidth;
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
  readonly targets: readonly string[];
  readonly kind: 'field' | 'method_bucket' | 'method';
  readonly bucketId: string | null;
}

function buildRowSpecs(
  t: TypeNode,
  state: ViewState,
  ownership: OwnershipIndex,
  methodsHidden: boolean,
  methodArrowsShown: ReadonlySet<string> | undefined,
  measure: (s: string) => number,
): LocalRowSpec[] {
  const rows: LocalRowSpec[] = [];
  const fieldTargets = ownership.fieldTargets.get(t.fullPath);
  for (const f of t.fields) {
    rows.push({
      name: f.name,
      tyText: f.ty_text,
      ownership: f.ownership,
      labelInset: labelInsetForRows(t),
      textWidth: measure(f.name),
      targets: fieldTargets?.get(f.name) ?? [],
      kind: 'field',
      bucketId: null,
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
      kind: 'method_bucket',
      bucketId,
    });
    if (!state.isExpanded(bucketId)) continue;
    const methodTargets = ownership.methodTargets.get(t.fullPath);
    for (const fn of mb.methods) {
      const showThisArrow =
        methodArrowsShown === undefined ||
        methodArrowsShown.has(`${t.fullPath}${METHOD_ARROW_KEY_SEP}${fn.name}`);
      rows.push({
        name: fn.name,
        tyText: formatMethodSignature(fn),
        ownership: 'primitive',
        labelInset: FIELD_LABEL_INSET + METHOD_INDENT,
        textWidth: measure(fn.name),
        targets: showThisArrow ? (methodTargets?.get(fn.name) ?? []) : [],
        kind: 'method',
        bucketId: null,
      });
    }
  }
  return rows;
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
    rows.push({
      name: spec.name,
      tyText: spec.tyText,
      ownership: spec.ownership,
      x,
      y: rowY,
      arrowSourceX: x + spec.textWidth + 4,
      targets: spec.targets,
      kind: spec.kind,
      bucketId: spec.bucketId,
    });
    rowY += FIELD_ROW_H;
  }
  return rows;
}

function labelInsetForRows(t: TypeNode): number {
  return t.typeKind === 'function_group' ? FUNCTION_GROUP_LABEL_INSET : FIELD_LABEL_INSET;
}

function methodBucketId(typeFullPath: string, bucket: VisibilityBucket): string {
  return `${typeFullPath}::__methods_${bucket}`;
}

function bucketHeaderText(mb: {
  readonly bucket: VisibilityBucket;
  readonly methods: readonly unknown[];
}): string {
  return `${BUCKET_LABEL[mb.bucket]} (${mb.methods.length})`;
}

/** Method rows need the same signature tail the renderer already supports.
 *  Keeping this in geometry makes row height, hit source, and rendered text
 *  agree instead of making routing infer method details later. */
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
  _state: ViewState,
  measure: (s: string) => number,
): number {
  // Walk the WHOLE module tree (collapsed and all) so the type pane
  // x doesn't shift when modules are toggled. For each module, compute
  // the rendered text width including the dimmed parent-path prefix
  // the renderer injects on rows two-or-more levels below the crate
  // root — without this, deep paths like `vm::entities::deep` get
  // measured as just "deep" and the type pane starts inside the
  // frozen module pane, truncating type labels.
  let maxLabelEnd = 0;
  const walk = (n: TreeNode, modDepth: number): void => {
    if (n.kind !== 'module') return;
    const labelX = LEFT_PAD + modDepth * INDENT_PX + MODULE_GLYPH_W;
    const renderedW = measure(renderedModuleText(n));
    if (labelX + renderedW > maxLabelEnd) maxLabelEnd = labelX + renderedW;
    for (const c of n.children) walk(c, modDepth + 1);
  };
  walk(root, 0);
  return maxLabelEnd + MODULE_BAND_X_GAP;
}

/** Mirror of `splitModuleLabel` in view/tree.ts: rows two or more levels
 *  below the crate root are rendered as `parent::path::leaf`, with the
 *  parent path painted dimmed. */
function renderedModuleText(node: ModuleNode): string {
  const segs = node.id.split('::');
  if (segs.length <= 2) return node.label;
  return `${segs.slice(1, -1).join('::')}::${node.label}`;
}
