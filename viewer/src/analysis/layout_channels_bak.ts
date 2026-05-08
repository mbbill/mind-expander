import type { DriftClass } from './drift.ts';

// Channel allocation is deliberately separate from `layout.ts`'s type
// packing. Packing decides where node shapes can sit; this module decides
// whether the space between those shapes has enough vertical AND horizontal
// routing capacity. Different semantic bundles reserve distinct rails inside
// the same horizontal channel, even when their y-spans do not overlap, because
// near-parallel unrelated rails read as one thick false connection.

export type ChannelArrowKind = 'ownership' | 'reexport' | 'method';

export interface ChannelArrow {
  readonly sourceX: number;
  readonly sourceLeftX?: number;
  readonly sourceRightX?: number;
  readonly sourceSide?: 'left' | 'right';
  readonly sourceY: number;
  readonly targetX: number;
  readonly targetY: number;
  readonly sourceCol: number;
  readonly targetCol: number;
  readonly fromTypeId: string;
  readonly fromFieldName: string;
  readonly fromRowKind: 'field' | 'method';
  readonly toTypeId: string;
  readonly driftClass: DriftClass;
  readonly kind: ChannelArrowKind;
}

export interface ChannelObstacle {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export interface ChannelDebugLane {
  readonly x: number;
  readonly yMin: number;
  readonly yMax: number;
  readonly fromTypeId: string;
  readonly toTypeId: string;
  readonly bundleKey: string;
  readonly blocked: boolean;
}

export interface ChannelDebugGroup {
  readonly id: number;
  readonly laneCount: number;
  readonly targetIds: readonly string[];
  readonly xMin: number;
  readonly xMax: number;
}

export interface LayoutDebugLabel {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly label: string;
}

export interface LayoutDebugGrid {
  readonly originX: number;
  readonly originY: number;
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly width: number;
  readonly height: number;
}

export interface ChannelDebug {
  readonly lanes: readonly ChannelDebugLane[];
  readonly groups: readonly ChannelDebugGroup[];
  readonly obstacles: readonly ChannelObstacle[];
  readonly layoutLabels?: readonly LayoutDebugLabel[];
  readonly layoutGrid?: LayoutDebugGrid;
}

export interface ChannelAllocation {
  readonly laneXByArrow: ReadonlyMap<ChannelArrow, number>;
  readonly slotCountByTarget: ReadonlyMap<string, number>;
  readonly debug: ChannelDebug;
}

export const LANE_BASE_GAP = 12;
export const LANE_SLOT_W = 8;
const CENTER_LANE_STEP = 8;
export const MIN_SEMANTIC_LANE_GAP = 18;
const CHANNEL_X_PAD = 24;

export function gutterWidth(slotCount: number): number {
  return Math.max(
    2 * LANE_BASE_GAP + LANE_SLOT_W,
    Math.max(1, slotCount) * LANE_SLOT_W + 2 * LANE_BASE_GAP,
  );
}

export function isCanonicalDriftClass(c: DriftClass): boolean {
  return c === 'at_lca' || c === 'within_budget';
}

export function isPlacementArrow(a: ChannelArrow): boolean {
  return a.kind === 'ownership' && isCanonicalDriftClass(a.driftClass) && a.targetCol > a.sourceCol;
}

export function isReturnArrow(a: ChannelArrow): boolean {
  if (a.kind !== 'ownership') return false;
  return a.sourceSide === undefined ? !isPlacementArrow(a) : a.sourceSide === 'left';
}

export function allocateIncomingChannels(
  arrows: readonly ChannelArrow[],
  obstacles: readonly ChannelObstacle[] = [],
): ChannelAllocation {
  const items = arrows
    .map((arrow) => ({
      arrow,
      bundleKey: bundleKey(arrow),
      bounds: channelBounds(arrow),
      yMin: Math.min(arrow.sourceY, arrow.targetY),
      yMax: Math.max(arrow.sourceY, arrow.targetY),
      priority: isPlacementArrow(arrow) ? 0 : 1,
    }))
    .sort(
      (a, b) =>
        a.priority - b.priority ||
        a.bounds.xMin - b.bounds.xMin ||
        a.yMin - b.yMin ||
        a.yMax - b.yMax ||
        a.bundleKey.localeCompare(b.bundleKey),
    );

  interface LaneUse {
    readonly item: (typeof items)[number];
    readonly laneX: number;
    readonly blockedDemandSlots: number;
  }

  const uses: LaneUse[] = [];
  const laneXByArrow = new Map<ChannelArrow, number>();

  for (const item of items) {
    const laneX =
      chooseLane(item, uses, obstacles, false) ?? chooseLane(item, uses, obstacles, true);
    const blockedDemandSlots = laneX === null ? blockedDemandSlotsFor(item, obstacles) : 0;
    const chosen = laneX ?? item.bounds.preferredX;
    uses.push({ item, laneX: chosen, blockedDemandSlots });
    laneXByArrow.set(item.arrow, chosen);
  }

  const groups = buildDebugGroups(uses);
  const slotCountByTarget = new Map<string, number>();
  for (const group of groups) {
    for (const targetId of group.targetIds) {
      slotCountByTarget.set(
        targetId,
        Math.max(slotCountByTarget.get(targetId) ?? 0, group.laneCount),
      );
    }
  }

  return {
    laneXByArrow,
    slotCountByTarget,
    debug: {
      lanes: uses.map((u) => ({
        x: u.laneX,
        yMin: u.item.yMin,
        yMax: u.item.yMax,
        fromTypeId: u.item.arrow.fromTypeId,
        toTypeId: u.item.arrow.toTypeId,
        bundleKey: u.item.bundleKey,
        blocked: u.blockedDemandSlots > 0,
      })),
      groups,
      obstacles,
    },
  };
}

function chooseLane(
  item: {
    readonly arrow: ChannelArrow;
    readonly bundleKey: string;
    readonly bounds: ChannelBounds;
    readonly yMin: number;
    readonly yMax: number;
  },
  uses: readonly {
    readonly item: {
      readonly arrow: ChannelArrow;
      readonly bundleKey: string;
      readonly bounds: ChannelBounds;
      readonly yMin: number;
      readonly yMax: number;
    };
    readonly laneX: number;
  }[],
  obstacles: readonly ChannelObstacle[],
  ignoreSemanticConflicts: boolean,
): number | null {
  for (const laneX of candidateLaneXs(item.bounds)) {
    if (!laneAllowed(item.arrow, laneX, item.bounds)) continue;
    if (!verticalClear(laneX, item.yMin, item.yMax, obstacles)) continue;
    if (!ignoreSemanticConflicts && laneConflicts(item, laneX, uses)) continue;
    return laneX;
  }
  return null;
}

function blockedDemandSlotsFor(
  item: {
    readonly arrow: ChannelArrow;
    readonly bounds: ChannelBounds;
    readonly yMin: number;
    readonly yMax: number;
  },
  obstacles: readonly ChannelObstacle[],
): number {
  if (!item.bounds.bounded) return 1;
  let requiredTargetX = item.arrow.targetX + LANE_SLOT_W;
  for (const obstacle of obstacles) {
    if (!intervalsOverlap(item.yMin, item.yMax, obstacle.top, obstacle.bottom)) continue;
    if (obstacle.right <= item.bounds.xMin || obstacle.left >= item.bounds.xMax) continue;
    // The only way to get a vertical lane past an obstacle that fills the
    // current source-target corridor is to push the target farther right.
    // Obstacles are already padded, so the extra LANE_BASE_GAP is the
    // readable channel after that padded keepout.
    requiredTargetX = Math.max(requiredTargetX, obstacle.right + LANE_BASE_GAP);
  }
  const missing = Math.max(0, requiredTargetX - item.arrow.targetX);
  return Math.max(2, Math.ceil(missing / LANE_SLOT_W) + 1);
}

function laneConflicts(
  item: {
    readonly arrow: ChannelArrow;
    readonly bundleKey: string;
    readonly bounds: ChannelBounds;
    readonly yMin: number;
    readonly yMax: number;
  },
  laneX: number,
  uses: readonly {
    readonly item: {
      readonly arrow: ChannelArrow;
      readonly bundleKey: string;
      readonly bounds: ChannelBounds;
      readonly yMin: number;
      readonly yMax: number;
    };
    readonly laneX: number;
  }[],
): boolean {
  for (const use of uses) {
    if (!channelBoundsTouch(item.bounds, use.item.bounds, CHANNEL_X_PAD)) continue;
    const distance = Math.abs(laneX - use.laneX);
    if (item.bundleKey === use.item.bundleKey) {
      if (
        distance < LANE_SLOT_W &&
        intervalsOverlap(item.yMin, item.yMax, use.item.yMin, use.item.yMax)
      ) {
        return true;
      }
      continue;
    }
    // Different semantic bundles get real visual separation inside the
    // same horizontal channel. Otherwise unrelated arrows that only differ
    // by a pixel or two read as one thick rail.
    if (distance < MIN_SEMANTIC_LANE_GAP) return true;
  }
  return false;
}

interface ChannelBounds {
  readonly bounded: boolean;
  readonly xMin: number;
  readonly xMax: number;
  readonly preferredX: number;
}

function channelBounds(a: ChannelArrow): ChannelBounds {
  const sourceX = routeSourceX(a, a.targetX);
  if (sourceX + 2 * LANE_BASE_GAP <= a.targetX) {
    const xMin = sourceX + LANE_BASE_GAP;
    const xMax = a.targetX - LANE_BASE_GAP;
    return {
      bounded: true,
      xMin,
      xMax,
      preferredX: (xMin + xMax) / 2,
    };
  }

  if (a.sourceSide === 'right' && sourceX < a.targetX) {
    const preferredX = sourceX + LANE_BASE_GAP;
    return {
      bounded: false,
      xMin: sourceX,
      xMax: Math.max(a.targetX - 1, preferredX),
      preferredX,
    };
  }

  const preferredX = fallbackIncomingLaneX(a.targetX, 0);
  return {
    bounded: false,
    xMin: Number.NEGATIVE_INFINITY,
    xMax: a.targetX - 1,
    preferredX,
  };
}

function candidateLaneXs(bounds: ChannelBounds): number[] {
  const out: number[] = [];
  const maxSteps = 96;
  const add = (x: number): void => {
    if (bounds.bounded && (x < bounds.xMin || x > bounds.xMax)) return;
    if (!bounds.bounded && x > bounds.xMax) return;
    if (!out.includes(x)) out.push(x);
  };

  add(bounds.preferredX);
  for (let i = 1; i <= maxSteps; i++) {
    const d = i * CENTER_LANE_STEP;
    add(bounds.preferredX - d);
    add(bounds.preferredX + d);
  }
  if (out.length === 0) add(bounds.xMax);
  return out;
}

function laneAllowed(a: ChannelArrow, laneX: number, bounds: ChannelBounds): boolean {
  if (bounds.bounded) return laneX >= bounds.xMin && laneX <= bounds.xMax;
  if (laneX > bounds.xMax) return false;
  if (a.sourceLeftX === undefined || a.sourceRightX === undefined || a.sourceSide === undefined) {
    return laneX <= a.targetX - 1;
  }
  if (a.sourceSide === 'right') return laneX >= a.sourceRightX;
  return laneX <= a.sourceLeftX;
}

export function fallbackIncomingLaneX(targetX: number, slotIdx: number): number {
  return targetX - LANE_BASE_GAP - (slotIdx + 0.5) * LANE_SLOT_W;
}

export function routeSourceX(a: ChannelArrow, nextX: number): number {
  if (a.sourceLeftX === undefined || a.sourceRightX === undefined) return a.sourceX;
  if (a.sourceSide === 'right') return a.sourceRightX;
  if (a.sourceSide === 'left') return a.sourceLeftX;
  return nextX >= a.sourceRightX ? a.sourceRightX : a.sourceLeftX;
}

function bundleKey(a: ChannelArrow): string {
  return `${a.fromTypeId}\x1F${a.toTypeId}`;
}

function buildDebugGroups(
  uses: readonly {
    readonly item: {
      readonly arrow: ChannelArrow;
      readonly bounds: ChannelBounds;
      readonly bundleKey: string;
    };
    readonly laneX: number;
    readonly blockedDemandSlots: number;
  }[],
): ChannelDebugGroup[] {
  const parent = new Map<number, number>();
  for (let i = 0; i < uses.length; i++) parent.set(i, i);

  const find = (i: number): number => {
    let p = parent.get(i) ?? i;
    while (p !== (parent.get(p) ?? p)) p = parent.get(p) ?? p;
    parent.set(i, p);
    return p;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };

  for (let i = 0; i < uses.length; i++) {
    for (let j = i + 1; j < uses.length; j++) {
      const a = uses[i];
      const b = uses[j];
      if (!a || !b) continue;
      if (channelBoundsTouch(a.item.bounds, b.item.bounds, CHANNEL_X_PAD)) union(i, j);
    }
  }

  const byRoot = new Map<number, typeof uses>();
  for (let i = 0; i < uses.length; i++) {
    const root = find(i);
    const cur = byRoot.get(root) ?? [];
    byRoot.set(root, [...cur, uses[i] as (typeof uses)[number]]);
  }

  const out: ChannelDebugGroup[] = [];
  let id = 0;
  for (const groupUses of byRoot.values()) {
    const targetIds = [...new Set(groupUses.map((u) => u.item.arrow.toTypeId))].sort();
    const laneBuckets = new Set(groupUses.map((u) => Math.round(u.laneX / LANE_SLOT_W)));
    const bundles = new Set(groupUses.map((u) => u.item.bundleKey));
    const blockedDemandSlots = Math.max(0, ...groupUses.map((u) => u.blockedDemandSlots));
    const semanticDemandSlots =
      bundles.size <= 1
        ? 1
        : Math.ceil(((bundles.size - 1) * MIN_SEMANTIC_LANE_GAP) / LANE_SLOT_W) + 1;
    out.push({
      id: id++,
      laneCount: Math.max(1, laneBuckets.size, semanticDemandSlots, blockedDemandSlots),
      targetIds,
      xMin: Math.min(...groupUses.map((u) => u.item.bounds.xMin)),
      xMax: Math.max(...groupUses.map((u) => u.item.bounds.xMax)),
    });
  }
  return out;
}

function channelBoundsTouch(a: ChannelBounds, b: ChannelBounds, pad: number): boolean {
  return !(a.xMax + pad < b.xMin || b.xMax + pad < a.xMin);
}

function intervalsOverlap(aMin: number, aMax: number, bMin: number, bMax: number): boolean {
  return aMin < bMax && bMin < aMax;
}

function verticalClear(
  x: number,
  yMin: number,
  yMax: number,
  obstacles: readonly ChannelObstacle[],
): boolean {
  for (const o of obstacles) {
    if (x <= o.left || x >= o.right) continue;
    if (yMin < o.bottom && o.top < yMax) return false;
  }
  return true;
}
