export type BandDepth =
  | { readonly kind: 'prelude' }
  | { readonly kind: 'rank'; readonly depth: number };

export interface BandShapeItem {
  readonly id: string;
  readonly name: string;
  readonly depth: BandDepth;
  /** Ownership rank from the placement plan. Optional for isolated planner
   *  tests; production callers pass this so shape planning does not derive
   *  logical order from physical display depth. */
  readonly rankOrder?: number;
  /** Optional facts-derived ordering within a rank bucket. When omitted,
   *  same-rank items fall back to name/id order. */
  readonly stableOrder?: number;
  /** True for module-level function groups, which live in a reserved
   *  leftmost column. fn-column items get their own shape bucket so they
   *  never share a placement group with non-fn items (which would let the
   *  band-shape spreader scatter them across columns). */
  readonly isFnColumn?: boolean;
}

export interface BandShapeGroup {
  readonly depth: BandDepth;
  /** Ownership rank tier. Same-rank display groups share one rank order; the
   *  16:9 spread only creates additional display groups inside it. */
  readonly rankOrder: number;
  readonly bandOrder: number;
  readonly groupIndex: number;
  readonly items: readonly BandShapeAssignment[];
}

export interface BandShapeAssignment {
  readonly id: string;
  readonly name: string;
  readonly depth: BandDepth;
  readonly depthOrder: number;
  readonly rankOrder: number;
  readonly groupOrder: number;
  readonly groupIndex: number;
  readonly indexInGroup: number;
  readonly isFnColumn: boolean;
}

export interface BandShapeBucket {
  readonly depth: BandDepth;
  readonly isFnColumn: boolean;
  readonly items: readonly OrderedBandShapeItem[];
}

export interface OrderedBandShapeItem extends BandShapeItem {
  readonly depthOrder: number;
}

export interface BandShapePlan {
  readonly groups: readonly BandShapeGroup[];
  readonly assignments: readonly BandShapeAssignment[];
}

export type BandShapeStrategy = (buckets: readonly BandShapeBucket[]) => readonly number[];

const WIDESCREEN_TARGET_RATIO = 16 / 9;

export function planBandShape(
  items: readonly BandShapeItem[],
  strategy: BandShapeStrategy = chooseCountOnlyWidescreenGroups,
): BandShapePlan {
  const buckets = buildDepthBuckets(items);
  const groupCounts = strategy(buckets);

  if (groupCounts.length !== buckets.length) {
    throw new Error('Band shape strategy must return one group count per rank bucket.');
  }

  const groups: BandShapeGroup[] = [];
  const assignments: BandShapeAssignment[] = [];

  for (const [bucketIndex, bucket] of buckets.entries()) {
    const rawGroupCount = groupCounts[bucketIndex];
    if (rawGroupCount === undefined || !Number.isInteger(rawGroupCount) || rawGroupCount < 1) {
      throw new Error('Band shape strategy returned an invalid group count.');
    }

    const groupCount = Math.min(rawGroupCount, bucket.items.length);
    const groupSize = Math.ceil(bucket.items.length / groupCount);
    const rankOrder = rankOrderForBucket(bucket);

    for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
      const bandOrder = groups.length;
      const groupItems = bucket.items.slice(groupIndex * groupSize, (groupIndex + 1) * groupSize);
      const groupAssignments = groupItems.map((item, indexInGroup) => ({
        id: item.id,
        name: item.name,
        depth: item.depth,
        depthOrder: item.depthOrder,
        rankOrder,
        groupOrder: bandOrder,
        groupIndex,
        indexInGroup,
        isFnColumn: item.isFnColumn ?? false,
      }));

      assignments.push(...groupAssignments);
      groups.push({
        depth: bucket.depth,
        rankOrder,
        // Placement and routing need a band-global group identity; groupIndex
        // intentionally remains scoped to one rank bucket.
        bandOrder,
        groupIndex,
        items: groupAssignments,
      });
    }
  }

  return { groups, assignments };
}

function rankOrderForDepth(depth: BandDepth): number {
  return depth.kind === 'prelude' ? 0 : depth.depth + 1;
}

function rankOrderForBucket(bucket: BandShapeBucket): number {
  const first = bucket.items[0]?.rankOrder;
  const fallback = rankOrderForDepth(bucket.depth);
  for (const item of bucket.items) {
    const itemRankOrder = item.rankOrder ?? fallback;
    if (itemRankOrder !== (first ?? fallback)) {
      throw new Error('Band shape bucket cannot mix multiple rank orders.');
    }
  }
  return first ?? fallback;
}

export function chooseCountOnlyWidescreenGroups(
  buckets: readonly BandShapeBucket[],
): readonly number[] {
  const groupCounts = buckets.map(() => 1);
  let currentScore = shapeScore(buckets, groupCounts);

  while (true) {
    let bestIndex = -1;
    let bestScore = currentScore;

    for (const [index, bucket] of buckets.entries()) {
      // fn-column buckets always stay in a single group so multiple
      // function_groups (e.g. `pub fn` + `local fn` in the same module)
      // stack vertically inside the reserved leftmost column.
      if (bucket.isFnColumn) continue;
      const currentGroupCount = groupCounts[index];
      if (currentGroupCount === undefined || currentGroupCount >= bucket.items.length) {
        continue;
      }

      const candidate = groupCounts.slice();
      candidate[index] = currentGroupCount + 1;
      const score = shapeScore(buckets, candidate);

      if (score < bestScore) {
        bestIndex = index;
        bestScore = score;
      }
    }

    if (bestIndex === -1) {
      return groupCounts;
    }

    groupCounts[bestIndex] = (groupCounts[bestIndex] ?? 0) + 1;
    currentScore = bestScore;
  }
}

function buildDepthBuckets(items: readonly BandShapeItem[]): readonly BandShapeBucket[] {
  const orderedItems = [...items].sort(compareItems).map((item, depthOrder) => ({
    ...item,
    depthOrder,
  }));

  const buckets: Array<{ depth: BandDepth; isFnColumn: boolean; items: OrderedBandShapeItem[] }> =
    [];

  for (const item of orderedItems) {
    const isFnColumn = item.isFnColumn ?? false;
    const previous = buckets.at(-1);
    if (
      previous !== undefined &&
      sameDepth(previous.depth, item.depth) &&
      previous.isFnColumn === isFnColumn
    ) {
      previous.items.push(item);
      continue;
    }

    buckets.push({ depth: item.depth, isFnColumn, items: [item] });
  }

  return buckets;
}

function shapeScore(buckets: readonly BandShapeBucket[], groupCounts: readonly number[]): number {
  const groupTotal = groupCounts.reduce((sum, groupCount) => sum + groupCount, 0);
  const rowTotal = Math.max(
    ...buckets.map((bucket, index) => Math.ceil(bucket.items.length / (groupCounts[index] ?? 1))),
    1,
  );

  // Same-rank spreading is a logical assignment hint for later placement.
  // Counts are the only signal here so expansion and measurement cannot move
  // items between rightward display groups.
  return Math.abs(groupTotal / rowTotal - WIDESCREEN_TARGET_RATIO);
}

function compareItems(a: BandShapeItem, b: BandShapeItem): number {
  const depthOrder = compareDepth(a.depth, b.depth);
  if (depthOrder !== 0) {
    return depthOrder;
  }

  // fn-column items sort before non-fn items at the same depth so the
  // bucket builder splits them into their own bucket (fn-column items must
  // never share a shape group with non-fn items — the spreader would scatter
  // them across columns instead of stacking in the reserved leftmost column).
  const aFn = a.isFnColumn ?? false;
  const bFn = b.isFnColumn ?? false;
  if (aFn !== bFn) return aFn ? -1 : 1;

  if (a.stableOrder !== undefined && b.stableOrder !== undefined) {
    const stableOrder = a.stableOrder - b.stableOrder;
    if (stableOrder !== 0) return stableOrder;
  }

  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

function compareDepth(a: BandDepth, b: BandDepth): number {
  if (a.kind !== b.kind) {
    return a.kind === 'prelude' ? -1 : 1;
  }

  if (a.kind === 'prelude' || b.kind === 'prelude') {
    return 0;
  }

  return a.depth - b.depth;
}

function sameDepth(a: BandDepth, b: BandDepth): boolean {
  return compareDepth(a, b) === 0;
}
