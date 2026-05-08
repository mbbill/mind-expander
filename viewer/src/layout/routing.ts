// Arrow routing pass: choose source/target sides per edge, group edges
// into per-gutter bundles, allocate vertical lane slots, and emit
// orthogonal polylines.
//
// Side selection (per edge):
//   Forward (source.endX + ROUTE_GAP < target.x):
//     source.right → target.left
//   Reverse (else):
//     source.left  → target.left  (loops left through the lane)
//
// Lane placement:
//   - All arrows entering a target column share the gutter immediately
//     LEFT of that column. Each arrow's vertical leg sits in one lane
//     within that gutter.
//   - Lane 0 = gutter centerline; ±1, ±2 alternate outward.
//   - Default LANE_W. When demand exceeds capacity the gutter shrinks
//     each lane down to MIN_LANE_W. Beyond that the request still gets
//     a lane (might overlap), and `needsReflow=true` is reported so a
//     future iteration could request explicit gap pressure without changing
//     ownership rank or predecessor ordering.
//
// Emission:
//   Legacy grouping and gutter allocation still choose the preferred lane.
//   The routing-channel planner owns final waypoint emission and checks every
//   planned horizontal/vertical segment against the real placed-fragment
//   obstacle map.

import type {
  Arrow,
  ArrowWaypoint,
  ChannelDebugGroup,
  ChannelDebugLane,
  ChannelObstacle,
  LayoutDebug,
  LayoutInputs,
} from '../analysis/layout_model.ts';
import type { DriftClass } from './../analysis/drift.ts';
import { BAND_GRID_CELL_W, TYPE_GLYPH_W } from './geometry.ts';
import type { Geometry } from './geometry.ts';
import type { ObstacleMap } from './obstacles.ts';
import {
  type RoutingChannelPlan,
  type RoutingChannelRequest,
  type RoutingObstacleIndex,
  buildRoutingObstacleIndex,
  planRoutingChannel,
} from './routing_channels.ts';
import {
  type ArrowClass,
  type ExtraGap,
  type RoutingArrowDemand,
  type RoutingChannelKey,
  type RoutingDensityConfig,
  computeRoutingPressure,
} from './routing_pressure.ts';
import type { PlacedFragmentRect } from './types.ts';

export const LANE_W = 16;
export const MIN_LANE_W = 6;
/** Horizontal gap between source endpoint and the lane (used in the
 *  "is this arrow forward or reverse?" decision). */
export const ROUTE_GAP = 12;
/** Horizontal margin keeping the outermost lanes off the gutter walls. */
export const GUTTER_MARGIN = 6;
export const ROUTING_PRESSURE_DENSITY: RoutingDensityConfig = {
  maxArrowsPerCell: {
    forward: 2,
    backward: 4,
  },
};
// Planner fallback means the chosen channel still crossed an obstacle. Ask the
// single feedback pass for one lane step of recovery room on each side; this
// is bounded routing recovery pressure, not intrinsic box clearance.
export const FALLBACK_RECOVERY_EXTRA_CELLS = Math.ceil((2 * LANE_W) / BAND_GRID_CELL_W);
const ROUTING_CHANNEL_MAX_SCAN = 8;

export interface RoutingResult {
  readonly arrows: readonly Arrow[];
  readonly routingPressure: readonly ExtraGap[];
  /** True if a legacy pixel gutter exhausted capacity or the final channel
   *  planner had to return overflow/fallback metadata. The bounded pipeline
   *  does not loop on this; routing pressure is the explicit placement
   *  feedback contract. */
  readonly needsReflow: boolean;
  /** Debug overlay payload formatted in the renderer-facing
   *  `Layout.debug.routing` shape. */
  readonly debug: LayoutDebug;
}

export interface RouteArrowsOptions {
  /** Temporary block-layout isolation mode. It emits direct endpoint arrows
   *  and no routing pressure, so broken lane routing cannot affect placement
   *  while we evaluate the box layout itself. */
  readonly allocateLanes?: boolean;
}

export interface RoutingPressureArrow {
  readonly toTypeId: string;
  readonly side: 'forward' | 'reverse';
}

interface RawArrow extends RoutingPressureArrow {
  readonly fromTypeId: string;
  readonly fromFieldName: string;
  /** Where the arrow leaves source (forward = right of field text;
   *  reverse = left of source type box). */
  readonly sourceX: number;
  readonly sourceY: number;
  readonly targetX: number;
  readonly targetY: number;
  readonly fromRowKind: 'field' | 'method';
  readonly kind: 'ownership' | 'reexport' | 'method';
  readonly driftClass: DriftClass;
}

export function routeArrows(
  geometry: Geometry,
  obstacles: ObstacleMap,
  inputs: LayoutInputs,
  measure: (s: string) => number,
  options: RouteArrowsOptions = {},
): RoutingResult {
  const raws = collectArrows(geometry, inputs, measure);
  if (options.allocateLanes === false) {
    return routeArrowsWithoutLaneAllocation(geometry, obstacles, raws);
  }

  const densityRoutingPressure = computeRoutingPressureForArrowGroups(geometry, raws);
  if (raws.length === 0) {
    return {
      arrows: [],
      routingPressure: densityRoutingPressure,
      needsReflow: false,
      debug: {
        routing: {
          obstacles: obstacleRects(obstacles),
          lanes: [],
          groups: [],
          layoutLabels: geometry.debugLabels ?? [],
          layoutGrid: geometry.debugGrid,
        },
      },
    };
  }

  // Group by target.x — every arrow ending in a given target column
  // routes through the same gutter, immediately left of that column.
  const byTargetX = new Map<number, RawArrow[]>();
  for (const r of raws) {
    let arr = byTargetX.get(r.targetX);
    if (!arr) {
      arr = [];
      byTargetX.set(r.targetX, arr);
    }
    arr.push(r);
  }

  const arrows: Arrow[] = [];
  const debugLanes: ChannelDebugLane[] = [];
  const debugGroups: ChannelDebugGroup[] = [];
  const fallbackRoutingPressure = new Map<string, ExtraGap>();
  const obstacleIndex = buildRoutingObstacleIndex(obstacles.all);
  let needsReflow = false;
  let groupId = 0;
  for (const [targetX, group] of byTargetX) {
    const allocation = allocateGutter(group, targetX, geometry.columnStride, obstacles);
    if (allocation.overflowed) needsReflow = true;
    let xMin = Number.POSITIVE_INFINITY;
    let xMax = Number.NEGATIVE_INFINITY;
    const plannedLaneXs = new Set<number>();
    const targetIds = new Set<string>();
    for (let i = 0; i < group.length; i++) {
      const raw = group[i];
      const laneX = allocation.laneXs[i];
      if (!raw || laneX === undefined) continue;
      // Keep layout pressure stable during this refactor: allocation still
      // supplies the preferred gutter lane, while the planner owns collision-
      // checked final segments and fallback metadata.
      const plan = planArrowChannel(raw, laneX, obstacles, obstacleIndex);
      if (plan.metadata.overflowed || plan.metadata.fallback) {
        needsReflow = true;
        addFallbackRoutingPressure(fallbackRoutingPressure, geometry, raw.toTypeId);
      }
      arrows.push(emitPlannedArrow(raw, plan.waypoints));

      const verticalSegments = plannedVerticalSegments(plan);
      for (const segment of verticalSegments) {
        debugLanes.push({
          x: segment.x,
          yMin: segment.yMin,
          yMax: segment.yMax,
          fromTypeId: raw.fromTypeId,
          toTypeId: raw.toTypeId,
          bundleKey: `${targetX}`,
          blocked: segment.blocked,
        });
        plannedLaneXs.add(segment.x);
        if (segment.x < xMin) xMin = segment.x;
        if (segment.x > xMax) xMax = segment.x;
      }
      targetIds.add(raw.toTypeId);
    }
    if (Number.isFinite(xMin)) {
      debugGroups.push({
        id: groupId++,
        laneCount: Math.max(1, plannedLaneXs.size),
        targetIds: [...targetIds].sort(),
        xMin,
        xMax,
      });
    }
  }

  const debug: LayoutDebug = {
    routing: {
      obstacles: obstacleRects(obstacles),
      lanes: debugLanes,
      groups: debugGroups,
      layoutLabels: geometry.debugLabels ?? [],
      layoutGrid: geometry.debugGrid,
    },
  };

  const routingPressure = mergeRoutingPressure(densityRoutingPressure, [
    ...fallbackRoutingPressure.values(),
  ]);

  return { arrows, routingPressure, needsReflow, debug };
}

function routeArrowsWithoutLaneAllocation(
  geometry: Geometry,
  obstacles: ObstacleMap,
  raws: readonly RawArrow[],
): RoutingResult {
  return {
    arrows: raws.map((raw) =>
      emitPlannedArrow(raw, [
        { x: raw.sourceX, y: raw.sourceY },
        { x: raw.targetX, y: raw.targetY },
      ]),
    ),
    routingPressure: [],
    needsReflow: false,
    debug: {
      routing: {
        obstacles: obstacleRects(obstacles),
        lanes: [],
        groups: [],
        layoutLabels: geometry.debugLabels ?? [],
        layoutGrid: geometry.debugGrid,
      },
    },
  };
}

interface RoutingPressureUsageAccumulator {
  readonly channel: RoutingChannelKey;
  readonly targetBandOrder: number;
  readonly countsByClass: Map<ArrowClass, number>;
}

export function computeRoutingPressureForArrowGroups(
  geometry: Geometry,
  arrows: readonly RoutingPressureArrow[],
  density: RoutingDensityConfig = ROUTING_PRESSURE_DENSITY,
): readonly ExtraGap[] {
  const byChannel = new Map<string, RoutingPressureUsageAccumulator>();

  for (const arrow of arrows) {
    const target = geometry.typesById.get(arrow.toTypeId);
    if (target === undefined) {
      continue;
    }

    const channel = targetSideRoutingPressureChannel(target);
    if (channel === null) continue;
    const key = routingPressureChannelId(channel);
    let accumulator = byChannel.get(key);
    if (accumulator === undefined) {
      accumulator = {
        channel,
        targetBandOrder: target.bandOrder,
        countsByClass: new Map(),
      };
      byChannel.set(key, accumulator);
    }

    const arrowClass = arrowClassForSide(arrow.side);
    accumulator.countsByClass.set(arrowClass, (accumulator.countsByClass.get(arrowClass) ?? 0) + 1);
  }

  const usages = [...byChannel.values()].map((accumulator) => ({
    channel: accumulator.channel,
    availableCells: availableGapCellsBeforeBandOrder(
      geometry,
      accumulator.channel.bandId,
      accumulator.targetBandOrder,
    ),
    arrows: routingArrowDemands(accumulator.countsByClass),
  }));

  return computeRoutingPressure({ density, usages });
}

function addFallbackRoutingPressure(
  byChannel: Map<string, ExtraGap>,
  geometry: Geometry,
  targetTypeId: string,
): void {
  const target = geometry.typesById.get(targetTypeId);
  if (target === undefined) {
    return;
  }

  const channel = targetSideRoutingPressureChannel(target);
  if (channel === null) {
    return;
  }

  const gap = {
    ...channel,
    cells: FALLBACK_RECOVERY_EXTRA_CELLS,
  };
  const key = routingPressureChannelId(channel);
  const existing = byChannel.get(key);
  if (existing === undefined || gap.cells > existing.cells) {
    byChannel.set(key, gap);
  }
}

function targetSideRoutingPressureChannel(target: {
  readonly bandId: string;
  readonly bandOrder: number;
}): RoutingChannelKey | null {
  if (target.bandOrder === 0) {
    // afterOrder channels name gaps after an existing group. A target in
    // group 0 has no legal left-side afterOrder channel, so this bounded
    // feedback pass leaves it to the final router's lane squeeze.
    return null;
  }

  return {
    bandId: target.bandId,
    axis: 'x',
    afterOrder: target.bandOrder - 1,
  };
}

function mergeRoutingPressure(
  ...pressureGroups: readonly (readonly ExtraGap[])[]
): readonly ExtraGap[] {
  const byChannel = new Map<string, ExtraGap>();

  for (const pressureGroup of pressureGroups) {
    for (const gap of pressureGroup) {
      const key = routingPressureChannelId(gap);
      const existing = byChannel.get(key);
      if (existing === undefined || gap.cells > existing.cells) {
        byChannel.set(key, gap);
      }
    }
  }

  return [...byChannel.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, gap]) => gap);
}

function routingPressureChannelId(channel: RoutingChannelKey): string {
  if ('afterOrder' in channel) {
    return JSON.stringify(['after', channel.bandId, channel.axis, channel.afterOrder]);
  }

  return JSON.stringify([
    'between',
    channel.bandId,
    channel.axis,
    channel.betweenRegions[0],
    channel.betweenRegions[1],
  ]);
}

function routingArrowDemands(
  countsByClass: ReadonlyMap<ArrowClass, number>,
): readonly RoutingArrowDemand[] {
  const demands: RoutingArrowDemand[] = [];
  const forwardCount = countsByClass.get('forward') ?? 0;
  if (forwardCount > 0) {
    demands.push({ arrowClass: 'forward', count: forwardCount });
  }
  const backwardCount = countsByClass.get('backward') ?? 0;
  if (backwardCount > 0) {
    demands.push({ arrowClass: 'backward', count: backwardCount });
  }
  return demands;
}

function arrowClassForSide(side: RoutingPressureArrow['side']): ArrowClass {
  return side === 'forward' ? 'forward' : 'backward';
}

function availableGapCellsBeforeBandOrder(
  geometry: Geometry,
  bandId: string,
  bandOrder: number,
): number {
  const previousOrder = nearestPreviousBandOrder(geometry, bandId, bandOrder);
  if (previousOrder === null) {
    return 0;
  }

  const previousFragments = fragmentsInBandOrder(geometry, bandId, previousOrder);
  const targetFragments = fragmentsInBandOrder(geometry, bandId, bandOrder);
  // Routing pressure consumes the same snapped fragment rectangles that drive
  // obstacles/debug. Header boxes can be narrower than body or split-row
  // fragments, so using PositionedType.width here would understate pressure
  // in the very channel the placement feedback needs to widen.
  const previousRight = Math.max(
    ...previousFragments.map((fragment) => fragment.x + fragment.width),
  );
  const targetLeft = Math.min(...targetFragments.map((fragment) => fragment.x));

  if (!Number.isFinite(previousRight) || !Number.isFinite(targetLeft)) {
    return 0;
  }

  return Math.max(0, Math.floor((targetLeft - previousRight) / BAND_GRID_CELL_W));
}

function fragmentsInBandOrder(
  geometry: Geometry,
  bandId: string,
  bandOrder: number,
): readonly PlacedFragmentRect[] {
  return geometry.placedFragments.filter(
    (fragment) => fragment.bandId === bandId && fragment.bandOrder === bandOrder,
  );
}

function nearestPreviousBandOrder(
  geometry: Geometry,
  bandId: string,
  bandOrder: number,
): number | null {
  let previousOrder: number | null = null;

  for (const fragment of geometry.placedFragments) {
    if (fragment.bandId !== bandId || fragment.bandOrder >= bandOrder) {
      continue;
    }
    if (previousOrder === null || fragment.bandOrder > previousOrder) {
      previousOrder = fragment.bandOrder;
    }
  }

  return previousOrder;
}

function obstacleRects(map: ObstacleMap): ChannelObstacle[] {
  return map.all.map((o) => ({
    left: o.x,
    right: o.x + o.width,
    top: o.y,
    bottom: o.y + o.height,
  }));
}

function collectArrows(
  geometry: Geometry,
  inputs: LayoutInputs,
  measure: (s: string) => number,
): RawArrow[] {
  const out: RawArrow[] = [];
  const drift = inputs.drift;

  for (const t of geometry.types) {
    if (t.expanded) {
      for (const row of t.visibleRows) {
        if (row.kind === 'method_bucket' || row.targets.length === 0) continue;
        const forwardSourceX = row.arrowSourceX;
        const reverseSourceX = row.x - 4;

        for (const targetId of row.targets) {
          const targetPos = geometry.typesById.get(targetId);
          if (!targetPos) continue; // target collapsed away
          if (targetPos.depth < 0) continue; // ghost target

          const useForward = forwardSourceX + ROUTE_GAP < targetPos.x;
          const driftClass: DriftClass = drift.typeClass.get(targetId) ?? 'at_lca';
          out.push({
            fromTypeId: t.node.id,
            fromFieldName: row.name,
            toTypeId: targetId,
            side: useForward ? 'forward' : 'reverse',
            sourceX: useForward ? forwardSourceX : reverseSourceX,
            sourceY: row.y,
            targetX: targetPos.x,
            targetY: targetPos.y,
            fromRowKind: row.kind === 'method' ? 'method' : 'field',
            kind: row.kind === 'method' ? 'method' : 'ownership',
            driftClass,
          });
        }
      }
    }

    // Ghost rows do not expand, but the existing UI toggles one violet
    // re-export arrow per ghost. Routing owns that endpoint geometry so
    // the renderer can keep treating it like any other arrow.
    if (t.node.isGhost === true && t.node.ghostTarget !== undefined) {
      if (inputs.ghostArrowsShown !== undefined && !inputs.ghostArrowsShown.has(t.node.id)) {
        continue;
      }
      const target = geometry.typesById.get(t.node.ghostTarget);
      if (!target || target.node.isGhost === true) continue;
      const typeDotXOffset = 6;
      const dotEdgeBack = 8;
      const sourceLeftX = t.x + typeDotXOffset - dotEdgeBack;
      const sourceRightX = t.x + TYPE_GLYPH_W + measure(t.node.label) + 4;
      const targetX = target.x + typeDotXOffset - dotEdgeBack;
      const useForward = targetX >= sourceRightX;
      out.push({
        fromTypeId: t.node.id,
        fromFieldName: '',
        toTypeId: target.node.id,
        side: useForward ? 'forward' : 'reverse',
        sourceX: useForward ? sourceRightX : sourceLeftX,
        sourceY: t.y,
        targetX,
        targetY: target.y,
        fromRowKind: 'field',
        kind: 'reexport',
        driftClass: 'at_lca',
      });
    }
  }
  return out;
}

interface GutterAllocation {
  readonly laneXs: readonly number[];
  readonly overflowed: boolean;
}

function allocateGutter(
  arrows: readonly RawArrow[],
  targetX: number,
  columnStride: number,
  obstacles: ObstacleMap,
): GutterAllocation {
  // The gutter sits in the stable stride immediately left of the target.
  // Lane 0 is its centerline; ±k lanes fan outward.
  const gutterLeft = targetX - columnStride + GUTTER_MARGIN;
  const gutterRight = targetX - GUTTER_MARGIN;
  const gutterCenter = (gutterLeft + gutterRight) / 2;
  const usableWidth = gutterRight - gutterLeft;

  // Try LANE_W first; shrink towards MIN_LANE_W if the slot count is
  // smaller than the demand. capacity counts both positive and negative
  // slots PLUS slot 0, hence (2k+1) for max-slot k.
  let laneW = LANE_W;
  let maxSlot = Math.floor((usableWidth - laneW) / 2 / laneW); // both sides
  if (maxSlot < 0) maxSlot = 0;
  let capacity = 2 * maxSlot + 1;
  while (capacity < arrows.length && laneW > MIN_LANE_W) {
    laneW = Math.max(MIN_LANE_W, laneW - 2);
    maxSlot = Math.floor((usableWidth - laneW) / 2 / laneW);
    if (maxSlot < 0) maxSlot = 0;
    capacity = 2 * maxSlot + 1;
  }
  let overflowed = capacity < arrows.length;

  // Sort by yMin for greedy interval coloring, but track original
  // index so the returned array matches the input order.
  const indexed = arrows.map((a, idx) => ({
    idx,
    arrow: a,
    yMin: Math.min(a.sourceY, a.targetY),
    yMax: Math.max(a.sourceY, a.targetY),
    sourceY: a.sourceY,
    targetY: a.targetY,
  }));
  indexed.sort((p, q) => p.yMin - q.yMin);

  // slotEnds[slot] = last yMax assigned to that slot. A new arrow can
  // reuse a slot iff its yMin > the slot's last yMax.
  const slotEnds = new Map<number, number>();
  const result = new Array<number>(arrows.length).fill(gutterCenter);

  for (const item of indexed) {
    let chosen: number | null = null;
    // Center-first order: 0, 1, -1, 2, -2, …
    for (let mag = 0; mag <= maxSlot; mag++) {
      const candidates = mag === 0 ? [0] : [mag, -mag];
      for (const slot of candidates) {
        const lastEnd = slotEnds.get(slot) ?? Number.NEGATIVE_INFINITY;
        if (lastEnd >= item.yMin) continue; // y-overlap
        const laneX = gutterCenter + slot * laneW;
        if (laneCollidesWithObstacle(laneX, item.yMin, item.yMax, item.arrow, obstacles)) {
          continue;
        }
        chosen = slot;
        break;
      }
      if (chosen !== null) break;
    }
    if (chosen === null) {
      // Overflow: settle for slot 0 (will visually overlap others).
      overflowed = true;
      chosen = 0;
    }
    slotEnds.set(chosen, item.yMax);
    result[item.idx] = gutterCenter + chosen * laneW;
  }

  return { laneXs: result, overflowed };
}

function laneCollidesWithObstacle(
  laneX: number,
  yMin: number,
  yMax: number,
  arrow: RawArrow,
  obstacles: ObstacleMap,
): boolean {
  // Use the same obstacle model the debug overlay shows. Endpoint blocks
  // are skipped so arrows can enter/exit their own types, but unrelated
  // blocks and protrusions reserve real vertical routing space.
  for (const o of obstacles.all) {
    if (o.kind === 'block' && (o.typeId === arrow.fromTypeId || o.typeId === arrow.toTypeId)) {
      continue;
    }
    if (o.y + o.height <= yMin || o.y >= yMax) continue;
    if (laneX < o.x || laneX > o.x + o.width) continue;
    return true;
  }
  return false;
}

function planArrowChannel(
  raw: RawArrow,
  preferredLaneX: number,
  obstacles: ObstacleMap,
  obstacleIndex: RoutingObstacleIndex,
): RoutingChannelPlan {
  const request: RoutingChannelRequest = {
    source: { x: raw.sourceX, y: raw.sourceY },
    target: { x: raw.targetX, y: raw.targetY },
    sourceTypeId: raw.fromTypeId,
    targetTypeId: raw.toTypeId,
    obstacles: obstacles.all,
    obstacleIndex,
    options: {
      gridCellSize: BAND_GRID_CELL_W,
      laneStep: LANE_W,
      maxScan: ROUTING_CHANNEL_MAX_SCAN,
      preferredLaneX,
    },
  };
  return planRoutingChannel(request);
}

interface PlannedVerticalSegment {
  readonly x: number;
  readonly yMin: number;
  readonly yMax: number;
  readonly blocked: boolean;
}

function plannedVerticalSegments(plan: RoutingChannelPlan): readonly PlannedVerticalSegment[] {
  const blockedVerticalSegments = new Set(
    plan.metadata.blockages
      .filter((blockage) => blockage.orientation === 'vertical')
      .map((blockage) => blockage.segmentIndex),
  );
  const segments: PlannedVerticalSegment[] = [];
  for (let index = 1; index < plan.waypoints.length; index++) {
    const from = plan.waypoints[index - 1];
    const to = plan.waypoints[index];
    if (from === undefined || to === undefined) {
      continue;
    }
    if (from.x !== to.x || from.y === to.y) {
      continue;
    }
    segments.push({
      x: from.x,
      yMin: Math.min(from.y, to.y),
      yMax: Math.max(from.y, to.y),
      blocked: plan.metadata.fallback || blockedVerticalSegments.has(index - 1),
    });
  }
  return segments;
}

function emitPlannedArrow(raw: RawArrow, waypoints: readonly ArrowWaypoint[]): Arrow {
  return {
    waypoints,
    fromTypeId: raw.fromTypeId,
    fromFieldName: raw.fromFieldName,
    fromRowKind: raw.fromRowKind,
    toTypeId: raw.toTypeId,
    kind: raw.kind,
    driftClass: raw.driftClass,
  };
}
