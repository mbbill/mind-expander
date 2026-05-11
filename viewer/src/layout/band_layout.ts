import {
  type BandDepth,
  type BandShapePlan,
  type BandShapeStrategy,
  planBandShape,
} from './band_shape.ts';
import {
  type LayoutBoxFragment,
  type LayoutBoxFragmentClearance,
  type LayoutBoxFragments,
  type LayoutBoxSplitStrategy,
  type MeasuredBoxPart,
  type MeasuredLayoutRow,
  buildLayoutBoxFragments,
} from './box_fragments.ts';
import type { GridSpec } from './grid.ts';
import {
  type GridPlacementItem,
  type GridPlacementOptions,
  type GridPoint,
  type PlacedGridFragment,
  type PlacedGridItem,
  placeGridItemsTopToBottom,
} from './grid_placement.ts';

export interface BandLayoutItem {
  readonly id: string;
  readonly name: string;
  readonly depth: BandDepth;
  readonly rankOrder?: number;
  readonly predecessorIds?: readonly string[];
  readonly stableOrder?: number;
  readonly isFnColumn?: boolean;
  readonly header: MeasuredBoxPart;
  readonly rows: readonly MeasuredLayoutRow[];
  readonly grid: GridSpec;
  readonly clearance?: LayoutBoxFragmentClearance;
  readonly splitStrategy?: LayoutBoxSplitStrategy;
}

export interface BandLayoutOptions {
  readonly shapeStrategy?: BandShapeStrategy;
  readonly placementOptions?: GridPlacementOptions;
}

export interface BandLayoutGridItem extends Omit<GridPlacementItem, 'fragments'> {
  readonly fragments: readonly LayoutBoxFragment[];
}

export interface PlacedBandLayoutFragment extends LayoutBoxFragment {
  readonly itemId: string;
  readonly origin: GridPoint;
}

export interface PlacedBandLayoutItem extends Omit<PlacedGridItem, 'fragments'> {
  readonly fragments: readonly PlacedBandLayoutFragment[];
}

export interface BandLayoutResult {
  readonly shapePlan: BandShapePlan;
  readonly fragmentsByItem: readonly LayoutBoxFragments[];
  readonly gridItems: readonly BandLayoutGridItem[];
  readonly placedItems: readonly PlacedBandLayoutItem[];
  readonly placedFragments: readonly PlacedBandLayoutFragment[];
}

export interface PreparedBandLayout {
  readonly shapePlan: BandShapePlan;
  readonly fragmentsByItem: readonly LayoutBoxFragments[];
  readonly fragmentsById: ReadonlyMap<string, LayoutBoxFragments>;
  readonly gridItems: readonly BandLayoutGridItem[];
}

export function layoutOneModuleBand(
  items: readonly BandLayoutItem[],
  options: BandLayoutOptions = {},
): BandLayoutResult {
  assertUniqueItemIds(items);

  const prepared = prepareModuleBandLayout(items, options);
  const placement = placeGridItemsTopToBottom(prepared.gridItems, options.placementOptions);
  const placedItems = restorePlacedFragmentData(placement.items, prepared.fragmentsById);

  return {
    shapePlan: prepared.shapePlan,
    fragmentsByItem: prepared.fragmentsByItem,
    gridItems: prepared.gridItems,
    placedItems,
    placedFragments: placedItems.flatMap((item) => item.fragments),
  };
}

export function prepareModuleBandLayout(
  items: readonly BandLayoutItem[],
  options: Pick<BandLayoutOptions, 'shapeStrategy'> = {},
): PreparedBandLayout {
  assertUniqueItemIds(items);

  const shapePlan = planBandShape(
    items.map(({ id, name, depth, rankOrder, stableOrder, isFnColumn }) => ({
      id,
      name,
      depth,
      ...(rankOrder !== undefined ? { rankOrder } : {}),
      ...(stableOrder !== undefined ? { stableOrder } : {}),
      ...(isFnColumn !== undefined ? { isFnColumn } : {}),
    })),
    options.shapeStrategy,
  );
  const fragmentsById = buildFragmentsById(items);
  const predecessorIdsByItem = new Map(items.map((item) => [item.id, item.predecessorIds ?? []]));
  const gridItems = buildGridItems(shapePlan, fragmentsById, predecessorIdsByItem);

  return {
    shapePlan,
    fragmentsByItem: shapePlan.assignments.map((assignment) =>
      requireFragments(fragmentsById, assignment.id),
    ),
    fragmentsById,
    gridItems,
  };
}

function buildFragmentsById(
  items: readonly BandLayoutItem[],
): ReadonlyMap<string, LayoutBoxFragments> {
  const fragmentsById = new Map<string, LayoutBoxFragments>();

  for (const item of items) {
    fragmentsById.set(
      item.id,
      buildLayoutBoxFragments({
        objectId: item.id,
        name: item.name,
        header: item.header,
        rows: item.rows,
        grid: item.grid,
        ...(item.clearance !== undefined ? { clearance: item.clearance } : {}),
        ...(item.splitStrategy !== undefined ? { splitStrategy: item.splitStrategy } : {}),
      }),
    );
  }

  return fragmentsById;
}

function buildGridItems(
  shapePlan: BandShapePlan,
  fragmentsById: ReadonlyMap<string, LayoutBoxFragments>,
  predecessorIdsByItem: ReadonlyMap<string, readonly string[]>,
): readonly BandLayoutGridItem[] {
  return shapePlan.assignments.map((assignment) => {
    const fragments = requireFragments(fragmentsById, assignment.id);

    return {
      id: assignment.id,
      ownerId: assignment.id,
      rankOrder: assignment.rankOrder,
      predecessorIds: predecessorIdsByItem.get(assignment.id) ?? [],
      groupOrder: assignment.groupOrder,
      indexInGroup: assignment.indexInGroup,
      isFnColumn: assignment.isFnColumn,
      // Long-row splitting is a physical layout detail. The placement item
      // stays owner-scoped so split fragments cannot become graph nodes.
      fragments: fragments.fragments,
    };
  });
}

function restorePlacedFragmentData(
  placedItems: readonly PlacedGridItem[],
  fragmentsById: ReadonlyMap<string, LayoutBoxFragments>,
): readonly PlacedBandLayoutItem[] {
  return placedItems.map((item) => ({
    id: item.id,
    ownerId: item.ownerId,
    regionId: item.regionId,
    rankOrder: item.rankOrder,
    predecessorIds: item.predecessorIds,
    groupOrder: item.groupOrder,
    indexInGroup: item.indexInGroup,
    origin: item.origin,
    fragments: item.fragments.map((fragment) => restorePlacedFragment(fragment, fragmentsById)),
  }));
}

function restorePlacedFragment(
  fragment: PlacedGridFragment,
  fragmentsById: ReadonlyMap<string, LayoutBoxFragments>,
): PlacedBandLayoutFragment {
  const original = requireFragments(fragmentsById, fragment.ownerId).fragments.find(
    (candidate) => candidate.fragmentId === fragment.fragmentId,
  );

  if (original === undefined) {
    throw new Error(
      `Placed fragment ${fragment.ownerId}:${fragment.fragmentId} does not match an input fragment.`,
    );
  }

  return {
    ...original,
    itemId: fragment.itemId,
    origin: fragment.origin,
    own: fragment.own,
    clearance: fragment.clearance,
  };
}

function requireFragments(
  fragmentsById: ReadonlyMap<string, LayoutBoxFragments>,
  itemId: string,
): LayoutBoxFragments {
  const fragments = fragmentsById.get(itemId);

  if (fragments === undefined) {
    throw new Error(`Missing layout fragments for band item: ${itemId}`);
  }

  return fragments;
}

function assertUniqueItemIds(items: readonly BandLayoutItem[]): void {
  const ids = new Set<string>();

  for (const item of items) {
    if (ids.has(item.id)) {
      throw new Error(`Band layout item ids must be unique: ${item.id}`);
    }
    ids.add(item.id);
  }
}
