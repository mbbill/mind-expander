import { type GridRect, type LayoutBox, conflicts } from './grid.ts';
import type { ExtraGap } from './placement_gaps.ts';

export interface GridPoint {
  readonly col: number;
  readonly row: number;
}

export interface GridPlacementFragment extends LayoutBox {
  readonly ownerId: string;
  readonly fragmentId: string;
}

export interface GridPlacementItem {
  readonly id: string;
  readonly ownerId: string;
  /** Placement region, normally a module-band id. Collision and same-rank
   *  display stacking are local to the region because module bands occupy
   *  separate y ranges. */
  readonly regionId?: string;
  /** Ownership rank from the placement plan. This sorts placement, but it is
   *  not a fixed x column; actual rightward constraints come from
   *  predecessorIds below. */
  readonly rankOrder: number;
  /** Visible direct/forward ownership predecessors that must stay to the left
   *  if they are present in this placement run. This avoids using unrelated
   *  earlier ranks as a global wall. */
  readonly predecessorIds: readonly string[];
  /** Display group produced by same-rank 16:9 spreading. This can affect
   *  local packing, but it must not weaken predecessor constraints above. */
  readonly groupOrder: number;
  readonly indexInGroup: number;
  /** True for module-level function groups. The placer keeps these in the
   *  reserved leftmost column (col 0); every non-fn item is floored to
   *  `fnColumnWidth` so types align in column 2+ across all bands. */
  readonly isFnColumn?: boolean;
  readonly fragments: readonly GridPlacementFragment[];
}

export interface PlacedGridFragment extends GridPlacementFragment {
  readonly itemId: string;
  readonly regionId: string;
  readonly origin: GridPoint;
}

export interface PlacedGridItem extends Omit<GridPlacementItem, 'fragments'> {
  readonly regionId: string;
  readonly origin: GridPoint;
  readonly fragments: readonly PlacedGridFragment[];
}

export interface GridPlacementResult {
  readonly items: readonly PlacedGridItem[];
  readonly fragments: readonly PlacedGridFragment[];
}

export interface GridPlacementOptions {
  readonly maxCols?: number;
  readonly maxRows?: number;
  readonly extraGaps?: readonly ExtraGap[];
  readonly rankLayerGapCells?: number;
  readonly firstRankLayerOrder?: number;
}

interface SearchBounds {
  readonly maxCols: number;
  readonly maxRows: number;
}

interface PlacementRules {
  readonly rankLayerGapCells: number;
  readonly firstRankLayerOrder: number;
}

interface RectBounds {
  readonly col: number;
  readonly row: number;
  readonly cols: number;
  readonly rows: number;
}

interface PreviousFragmentContext {
  readonly indexInGroup: number;
  readonly own: GridRect;
}

interface DisplayGroupTrack {
  readonly regionId: string;
  readonly groupOrder: number;
  // The rank this display group belongs to. A group only floors a LATER group
  // in the SAME rank (same-depth 16:9 spreading); it must never floor a group
  // in a deeper rank, or it becomes a cross-rank layer wall (docs/layout.md
  // Core Rule 1 — inter-rank placement is predecessor-relative, not
  // layer-relative).
  readonly rankOrder: number;
  readonly leftCol: number;
  readonly rightCol: number;
}

interface DisplayGroupTracks {
  readonly byRegionGroup: ReadonlyMap<string, DisplayGroupTrack>;
}

interface GroupExtraOffsets {
  readonly byRegionGroup: ReadonlyMap<string, number>;
}

interface XAfterOrderExtraGap {
  readonly bandId: string;
  readonly afterOrder: number;
  readonly cells: number;
}

const DEFAULT_MAX_SEARCH_COLS = 256;
const DEFAULT_MAX_SEARCH_ROWS = 256;

export class GridPlacementFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GridPlacementFailure';
  }
}

export function placeGridItemsTopToBottom(
  items: readonly GridPlacementItem[],
  options: GridPlacementOptions = {},
): GridPlacementResult {
  const bounds = normalizeSearchBounds(options);
  const rules = normalizePlacementRules(options);
  const orderedItems = normalizeItems(items);
  const groupExtraOffsets = buildGroupExtraOffsets(orderedItems, options.extraGaps ?? []);
  // Global fn-column width: widest fn-column item's clearance right edge in
  // cells, across all bands. Every non-fn item is floored to this so types
  // start in column 2+ even in bands that contain no function group.
  const fnColumnWidth = computeFnColumnWidth(items);
  const placedItems: PlacedGridItem[] = [];
  const placedFragments: PlacedGridFragment[] = [];
  const nextGroupRowByKey = new Map<string, number>();
  const groupTracks = new Map<string, DisplayGroupTrack>();

  for (const item of orderedItems) {
    const regionId = regionIdForItem(item);
    const groupKey = regionGroupKey(regionId, item.groupOrder);
    const nextGroupRow = nextGroupRowByKey.get(groupKey) ?? 0;

    const placedItem = placeOneItem(
      item,
      nextGroupRow,
      placedItems,
      placedFragments,
      bounds,
      rules,
      groupExtraOffsets,
      { byRegionGroup: groupTracks },
      fnColumnWidth,
    );
    placedItems.push(placedItem);
    placedFragments.push(...placedItem.fragments);
    nextGroupRowByKey.set(groupKey, itemClearanceBottom(placedItem));
    rememberDisplayGroupTrack(placedItem, groupExtraOffsets, groupTracks);
  }

  return {
    items: placedItems,
    fragments: placedFragments,
  };
}

function computeFnColumnWidth(items: readonly GridPlacementItem[]): number {
  // Reads each fn-column item's right clearance edge in item-local cells.
  // Fragments are item-local with own.col == 0, so the clearance right edge
  // doubles as the per-item width. Taking the max yields the global column
  // width every other item must clear.
  let width = 0;
  for (const item of items) {
    if (!item.isFnColumn) continue;
    for (const fragment of item.fragments) {
      const right = fragment.clearance.col + fragment.clearance.cols;
      if (right > width) width = right;
    }
  }
  return width;
}

function placeOneItem(
  item: GridPlacementItem,
  minimumTopRow: number,
  placedItems: readonly PlacedGridItem[],
  placedFragments: readonly PlacedGridFragment[],
  bounds: SearchBounds,
  rules: PlacementRules,
  groupExtraOffsets: GroupExtraOffsets,
  groupTracks: DisplayGroupTracks,
  fnColumnWidth: number,
): PlacedGridItem {
  const localOwnBounds = boundsOf(item.fragments.map((fragment) => fragment.own));
  const firstTopRow = Math.max(0, minimumTopRow);
  const lastTopRow = bounds.maxRows - localOwnBounds.rows;

  const firstLeftCol = Math.max(
    0,
    minimumLeftColForItem(
      item,
      localOwnBounds,
      placedItems,
      groupExtraOffsets,
      groupTracks,
      rules.rankLayerGapCells,
      rules.firstRankLayerOrder,
      fnColumnWidth,
    ),
  );
  const lastLeftCol = bounds.maxCols - localOwnBounds.cols;
  const hasEstablishedGroupTrack = groupTracks.byRegionGroup.has(
    regionGroupKey(regionIdForItem(item), item.groupOrder),
  );
  // Search column-major (try every row at the floor column before moving
  // right) when the item is anchored to a column — either an established
  // display-group track OR a forward predecessor. A predecessor-floored item
  // must pack DOWN at its owner's column, never slide RIGHT past unrelated
  // same-depth items (docs/layout.md Core Rule 1 + "expansion pushes down
  // before sideways"). Items with no anchor (a fresh rank-0 spreading group)
  // keep the row-major search so a new group finds its column to the right.
  const columnMajor = hasEstablishedGroupTrack || item.predecessorIds.length > 0;

  if (columnMajor) {
    // Established display groups are true column tracks: every item in the
    // group first tries the same x, while the next group starts after the
    // widest item seen in this group.
    for (let leftCol = firstLeftCol; leftCol <= lastLeftCol; leftCol += 1) {
      for (let topRow = firstTopRow; topRow <= lastTopRow; topRow += 1) {
        const candidate = tryPlaceCandidate(item, localOwnBounds, leftCol, topRow, placedFragments);
        if (candidate !== null) {
          return candidate;
        }
      }
    }
  } else {
    for (let topRow = firstTopRow; topRow <= lastTopRow; topRow += 1) {
      for (let leftCol = firstLeftCol; leftCol <= lastLeftCol; leftCol += 1) {
        const candidate = tryPlaceCandidate(item, localOwnBounds, leftCol, topRow, placedFragments);
        if (candidate !== null) {
          return candidate;
        }
      }
    }
  }

  // Placement is intentionally bounded for this staged strategy. Silent overlap
  // would hide a real layout invariant failure from later routing/rendering.
  throw new GridPlacementFailure(
    `Unable to place item ${item.id} within search window ${bounds.maxCols}x${bounds.maxRows}.`,
  );
}

function tryPlaceCandidate(
  item: GridPlacementItem,
  localOwnBounds: RectBounds,
  leftCol: number,
  topRow: number,
  placedFragments: readonly PlacedGridFragment[],
): PlacedGridItem | null {
  const origin = {
    col: leftCol - localOwnBounds.col,
    row: topRow - localOwnBounds.row,
  };
  const candidateFragments = translateItemFragments(item, origin);

  if (!candidateFits(candidateFragments, placedFragments)) {
    return null;
  }

  return {
    id: item.id,
    ownerId: item.ownerId,
    regionId: regionIdForItem(item),
    rankOrder: item.rankOrder,
    predecessorIds: item.predecessorIds,
    groupOrder: item.groupOrder,
    indexInGroup: item.indexInGroup,
    origin,
    fragments: candidateFragments,
  };
}

function normalizeSearchBounds(options: GridPlacementOptions): SearchBounds {
  const maxCols = options.maxCols ?? DEFAULT_MAX_SEARCH_COLS;
  const maxRows = options.maxRows ?? DEFAULT_MAX_SEARCH_ROWS;

  if (!Number.isInteger(maxCols) || maxCols < 1 || !Number.isInteger(maxRows) || maxRows < 1) {
    throw new Error('Grid placement search bounds must be positive integer cell counts.');
  }

  return { maxCols, maxRows };
}

function normalizePlacementRules(options: GridPlacementOptions): PlacementRules {
  const rankLayerGapCells = options.rankLayerGapCells ?? 0;
  const firstRankLayerOrder = options.firstRankLayerOrder ?? 0;

  if (!Number.isInteger(rankLayerGapCells) || rankLayerGapCells < 0) {
    throw new Error('Grid placement rank layer gap must be a non-negative integer cell count.');
  }
  if (!Number.isInteger(firstRankLayerOrder) || firstRankLayerOrder < 0) {
    throw new Error('Grid placement first rank layer order must be a non-negative integer.');
  }

  return { rankLayerGapCells, firstRankLayerOrder };
}

function buildGroupExtraOffsets(
  items: readonly GridPlacementItem[],
  extraGaps: readonly ExtraGap[],
): GroupExtraOffsets {
  const gaps = extraGaps.map(normalizeSupportedExtraGap);
  const regionGroups = [
    ...new Map(items.map((item) => [regionGroupKey(regionIdForItem(item), item.groupOrder), item])),
  ].sort((a, b) => a[0].localeCompare(b[0]));
  const byRegionGroup = new Map<string, number>();

  for (const [_key, item] of regionGroups) {
    // Extra gaps are channel constraints, so placement applies them as
    // band-global group offsets instead of inflating any fragment clearance.
    const cells = gaps.reduce(
      (sum, gap) =>
        gapAppliesToRegion(gap, regionIdForItem(item)) && gap.afterOrder < item.groupOrder
          ? sum + gap.cells
          : sum,
      0,
    );
    if (cells > 0) {
      byRegionGroup.set(regionGroupKey(regionIdForItem(item), item.groupOrder), cells);
    }
  }

  return { byRegionGroup };
}

function normalizeSupportedExtraGap(gap: ExtraGap): XAfterOrderExtraGap {
  if (gap.axis !== 'x' || !('afterOrder' in gap) || 'betweenRegions' in gap) {
    throw new Error('Grid placement extra gaps currently support only x-axis afterOrder gaps.');
  }
  if (!Number.isInteger(gap.afterOrder) || gap.afterOrder < 0) {
    throw new Error('Grid placement extra gap afterOrder must be a non-negative integer.');
  }
  if (!Number.isInteger(gap.cells) || gap.cells < 0) {
    throw new Error('Grid placement extra gap cells must be a non-negative integer.');
  }

  return {
    bandId: gap.bandId,
    afterOrder: gap.afterOrder,
    cells: gap.cells,
  };
}

function normalizeItems(items: readonly GridPlacementItem[]): readonly GridPlacementItem[] {
  const itemIds = new Set<string>();
  const groupIndexes = new Set<string>();

  for (const item of items) {
    if (!Number.isInteger(item.rankOrder) || item.rankOrder < 0) {
      throw new Error(`Grid placement item ${item.id} has an invalid rank order.`);
    }
    if (!Number.isInteger(item.groupOrder) || item.groupOrder < 0) {
      throw new Error(`Grid placement item ${item.id} has an invalid group order.`);
    }
    if (!Number.isInteger(item.indexInGroup) || item.indexInGroup < 0) {
      throw new Error(`Grid placement item ${item.id} has an invalid index within group.`);
    }
    if (itemIds.has(item.id)) {
      throw new Error(`Grid placement item ids must be unique: ${item.id}`);
    }
    itemIds.add(item.id);

    const groupIndexKey = `${regionIdForItem(item)}:${item.groupOrder}:${item.indexInGroup}`;
    if (groupIndexes.has(groupIndexKey)) {
      throw new Error(`Grid placement items must have unique group/index pairs: ${groupIndexKey}`);
    }
    groupIndexes.add(groupIndexKey);

    if (item.fragments.length === 0) {
      throw new Error(`Grid placement item ${item.id} must have at least one fragment.`);
    }
    for (const fragment of item.fragments) {
      assertGridRect(fragment.own, `item ${item.id} fragment ${fragment.fragmentId} own`);
      assertGridRect(
        fragment.clearance,
        `item ${item.id} fragment ${fragment.fragmentId} clearance`,
      );
    }
  }

  return [...items].sort(
    (a, b) =>
      a.rankOrder - b.rankOrder ||
      regionIdForItem(a).localeCompare(regionIdForItem(b)) ||
      a.groupOrder - b.groupOrder ||
      a.indexInGroup - b.indexInGroup ||
      a.id.localeCompare(b.id),
  );
}

function candidateFits(
  candidateFragments: readonly PlacedGridFragment[],
  placedFragments: readonly PlacedGridFragment[],
): boolean {
  for (const candidate of candidateFragments) {
    for (const placed of placedFragments) {
      if (candidate.regionId !== placed.regionId) {
        continue;
      }
      if (conflicts(candidate, placed)) {
        return false;
      }
    }
  }

  return true;
}

function minimumLeftColForItem(
  item: GridPlacementItem,
  localOwnBounds: RectBounds,
  placedItems: readonly PlacedGridItem[],
  groupExtraOffsets: GroupExtraOffsets,
  groupTracks: DisplayGroupTracks,
  rankLayerGapCells: number,
  firstRankLayerOrder: number,
  fnColumnWidth: number,
): number {
  const regionId = regionIdForItem(item);
  const groupExtraOffset = extraOffsetForGroup(regionId, item.groupOrder, groupExtraOffsets);
  const predecessorFloor =
    maxRightEdge(predecessorContexts(item.predecessorIds, placedItems, groupExtraOffsets)) +
    groupExtraOffset;
  const currentTrack = groupTracks.byRegionGroup.get(regionGroupKey(regionId, item.groupOrder));
  const previousTrack = nearestPreviousDisplayGroupTrack(
    regionId,
    item.groupOrder,
    item.rankOrder,
    groupTracks,
  );
  // Display groups are stable tracks from the shape planner, not row-local
  // packing hints. The first placed item defines the track; later lower/wider
  // items are handled as collisions so expansion pushes down before sideways.
  const displayGroupFloor =
    currentTrack?.leftCol ?? previousTrack?.rightCol ?? (item.groupOrder === 0 ? 0 : undefined);
  const rankLayerFloor = rankLayerFloorForItem(
    item,
    localOwnBounds,
    placedItems,
    rankLayerGapCells,
    firstRankLayerOrder,
  );
  // Reserved leftmost column for module-level function groups. Non-fn items
  // are floored to the global fn-column width so types align in column 2+
  // across every band, even bands that contain no function group.
  const fnColumnFloor = item.isFnColumn ? 0 : fnColumnWidth;

  return Math.max(
    predecessorFloor,
    (displayGroupFloor ?? 0) + groupExtraOffset,
    rankLayerFloor,
    fnColumnFloor,
  );
}

function rankLayerFloorForItem(
  item: GridPlacementItem,
  localOwnBounds: RectBounds,
  placedItems: readonly PlacedGridItem[],
  rankLayerGapCells: number,
  firstRankLayerOrder: number,
): number {
  if (rankLayerGapCells === 0 || item.rankOrder < firstRankLayerOrder) {
    return 0;
  }

  // The LCA layer gap is PREDECESSOR-relative, not layer-relative
  // (docs/layout.md Core Rule 1): an item's leftward floor comes only from
  // its ACTUAL forward predecessors' right edges — never from every item in
  // an earlier depth. Floor only against placed items that are this item's
  // forward predecessors (same membership test as `predecessorContexts`).
  // With no forward predecessor, no inter-rank floor applies (the band origin
  // / fn-column floor governs), because no arrow points at this item that
  // could route backward.
  const predecessorIdSet = new Set(item.predecessorIds);
  if (predecessorIdSet.size === 0) {
    return 0;
  }

  const localClearanceBounds = boundsOf(item.fragments.map((fragment) => fragment.clearance));
  const leftClearanceCells = Math.max(0, localOwnBounds.col - localClearanceBounds.col);
  let floor = 0;

  for (const placed of placedItems) {
    if (placed.rankOrder < firstRankLayerOrder || placed.rankOrder >= item.rankOrder) {
      continue;
    }
    if (!predecessorIdSet.has(placed.id) && !predecessorIdSet.has(placed.ownerId)) {
      continue;
    }
    for (const fragment of placed.fragments) {
      const ownRight = fragment.own.col + fragment.own.cols;
      const clearanceRight = fragment.clearance.col + fragment.clearance.cols;
      const rightClearanceCells = Math.max(0, clearanceRight - ownRight);
      // LCA ranks are a logical floor between own boxes. Clearance remains a
      // separate box contract, so the required gap is the larger constraint,
      // not rank gap plus clearance.
      const requiredGap = Math.max(rankLayerGapCells, rightClearanceCells, leftClearanceCells);
      floor = Math.max(floor, ownRight + requiredGap);
    }
  }

  return floor;
}

function predecessorContexts(
  predecessorIds: readonly string[],
  placedItems: readonly PlacedGridItem[],
  groupExtraOffsets: GroupExtraOffsets,
): readonly PreviousFragmentContext[] {
  if (predecessorIds.length === 0) {
    return [];
  }

  const predecessorIdSet = new Set(predecessorIds);
  const contexts: PreviousFragmentContext[] = [];

  for (const item of placedItems) {
    if (!predecessorIdSet.has(item.id) && !predecessorIdSet.has(item.ownerId)) {
      continue;
    }
    const groupExtraOffset = extraOffsetForGroup(item.regionId, item.groupOrder, groupExtraOffsets);
    for (const fragment of item.fragments) {
      contexts.push({
        indexInGroup: item.indexInGroup,
        own: translateGridRect(fragment.own, { col: -groupExtraOffset, row: 0 }),
      });
    }
  }

  return contexts;
}

function nearestPreviousDisplayGroupTrack(
  regionId: string,
  groupOrder: number,
  rankOrder: number,
  groupTracks: DisplayGroupTracks,
): DisplayGroupTrack | null {
  let previous: DisplayGroupTrack | null = null;

  for (const track of groupTracks.byRegionGroup.values()) {
    if (track.regionId !== regionId) {
      continue;
    }
    // Same-rank only: a display group is floored to the right of an earlier
    // group at the SAME depth (16:9 spreading). A group in a shallower rank
    // must NOT floor this one — that is the cross-rank layer wall a target's
    // forward predecessors are responsible for, not the previous rank's
    // widest group.
    if (track.rankOrder !== rankOrder) {
      continue;
    }
    if (track.groupOrder >= groupOrder) {
      continue;
    }
    if (previous === null || track.groupOrder > previous.groupOrder) {
      previous = track;
    }
  }

  return previous;
}

function extraOffsetForGroup(
  regionId: string,
  groupOrder: number,
  groupExtraOffsets: GroupExtraOffsets,
): number {
  return groupExtraOffsets.byRegionGroup.get(regionGroupKey(regionId, groupOrder)) ?? 0;
}

function maxRightEdge(contexts: readonly PreviousFragmentContext[]): number {
  return Math.max(0, ...contexts.map(({ own }) => own.col + own.cols));
}

function rememberDisplayGroupTrack(
  item: PlacedGridItem,
  groupExtraOffsets: GroupExtraOffsets,
  groupTracks: Map<string, DisplayGroupTrack>,
): void {
  const key = regionGroupKey(item.regionId, item.groupOrder);
  const groupExtraOffset = extraOffsetForGroup(item.regionId, item.groupOrder, groupExtraOffsets);
  const ownBounds = boundsOf(item.fragments.map((fragment) => fragment.own));
  const clearanceBounds = boundsOf(item.fragments.map((fragment) => fragment.clearance));
  const existing = groupTracks.get(key);
  if (existing !== undefined) {
    groupTracks.set(key, {
      ...existing,
      leftCol: Math.min(existing.leftCol, ownBounds.col - groupExtraOffset),
      rightCol: Math.max(
        existing.rightCol,
        clearanceBounds.col + clearanceBounds.cols - groupExtraOffset,
      ),
    });
    return;
  }

  groupTracks.set(key, {
    regionId: item.regionId,
    groupOrder: item.groupOrder,
    rankOrder: item.rankOrder,
    leftCol: ownBounds.col - groupExtraOffset,
    rightCol: clearanceBounds.col + clearanceBounds.cols - groupExtraOffset,
  });
}

function translateItemFragments(
  item: GridPlacementItem,
  origin: GridPoint,
): readonly PlacedGridFragment[] {
  const regionId = regionIdForItem(item);
  return item.fragments.map((fragment) => ({
    ...fragment,
    itemId: item.id,
    regionId,
    origin,
    own: translateGridRect(fragment.own, origin),
    clearance: translateGridRect(fragment.clearance, origin),
  }));
}

function regionIdForItem(item: GridPlacementItem): string {
  return item.regionId ?? '';
}

function regionGroupKey(regionId: string, groupOrder: number): string {
  return `${regionId}\x1F${groupOrder}`;
}

function gapAppliesToRegion(gap: XAfterOrderExtraGap, regionId: string): boolean {
  return regionId === '' || gap.bandId === regionId;
}

function translateGridRect(rect: GridRect, origin: GridPoint): GridRect {
  return {
    col: rect.col + origin.col,
    row: rect.row + origin.row,
    cols: rect.cols,
    rows: rect.rows,
  };
}

function itemClearanceBottom(item: PlacedGridItem): number {
  return Math.max(
    ...item.fragments.map((fragment) => fragment.clearance.row + fragment.clearance.rows),
  );
}

function boundsOf(rects: readonly GridRect[]): RectBounds {
  const left = Math.min(...rects.map((rect) => rect.col));
  const top = Math.min(...rects.map((rect) => rect.row));
  const right = Math.max(...rects.map((rect) => rect.col + rect.cols));
  const bottom = Math.max(...rects.map((rect) => rect.row + rect.rows));

  return {
    col: left,
    row: top,
    cols: right - left,
    rows: bottom - top,
  };
}

function assertGridRect(rect: GridRect, label: string): void {
  if (
    !Number.isInteger(rect.col) ||
    !Number.isInteger(rect.row) ||
    !Number.isInteger(rect.cols) ||
    !Number.isInteger(rect.rows)
  ) {
    throw new Error(`Grid placement ${label} must use integer grid cell indexes.`);
  }
  if (rect.cols < 0 || rect.rows < 0) {
    throw new Error(`Grid placement ${label} must have non-negative size.`);
  }
}
