// Arrow routing pass. Geometry owns block placement; this module only chooses
// deterministic dogleg paths between already-placed endpoints.

import type { DriftClass } from '../analysis/drift.ts';
import type {
  Arrow,
  ArrowWaypoint,
  ChannelDebugLane,
  ChannelObstacle,
  LayoutDebug,
  LayoutInputs,
} from '../analysis/layout_model.ts';
import { BAND_GRID_CELL_H, BAND_GRID_CELL_W } from './geometry.ts';
import type { Geometry } from './geometry.ts';
import type { ObstacleMap } from './obstacles.ts';
import type { Obstacle, PositionedType } from './types.ts';

export const ROUTE_GAP = BAND_GRID_CELL_W * 2;
export const DOGLEG_CORNER_RADIUS = BAND_GRID_CELL_W;

const DIRECTION_VIOLATION_COST = 1_000_000_000;
const OBSTACLE_CELL_COST = 10_000;
const ARROW_CROSSING_COST = 80_000;
const VERTICAL_CONFLICT_COST = {
  lcaForward: 20_000,
  lcaBackward: 4_000,
  other: 8_000,
} as const;
const TRUNK_SUBTRACK_SPACING = BAND_GRID_CELL_W;

export interface RoutingResult {
  readonly arrows: readonly Arrow[];
  /** Debug overlay payload formatted in the renderer-facing
   *  `Layout.debug.routing` shape. */
  readonly debug: LayoutDebug;
}

type RouteClass = 'lca-forward' | 'lca-backward' | 'other';
type SourceSide = 'right' | 'left';

interface TypeBounds {
  readonly left: number;
  readonly right: number;
}

interface RawArrow {
  readonly fromTypeId: string;
  readonly fromFieldName: string;
  readonly toTypeId: string;
  readonly sourceLeftX: number;
  readonly sourceRowLeftX: number;
  readonly sourceRightX: number;
  readonly sourceRightBoundaryX: number;
  readonly sourceY: number;
  readonly targetLeftX: number;
  readonly targetRightX: number;
  readonly targetY: number;
  readonly fromRowKind: 'field' | 'method';
  readonly kind: 'ownership' | 'reexport' | 'method';
  readonly routeClass: RouteClass;
  readonly driftClass: DriftClass;
}

interface RouteCandidate {
  readonly raw: RawArrow;
  readonly sourceSide: SourceSide;
  readonly sourceSidePreference: number;
  /** Renderer-visible semantic endpoint on the row. */
  readonly visualSource: ArrowWaypoint;
  /** Routing port on the source boundary. The dogleg starts here so expanded
   *  rows do not drag the long horizontal/vertical path through source text. */
  readonly source: ArrowWaypoint;
  readonly target: ArrowWaypoint;
  readonly laneX: number;
  readonly sameTargetReuse: boolean;
  readonly legalInterval: boolean;
  readonly distanceFromPreferred: number;
}

interface RouteScore {
  readonly total: number;
  readonly obstacleCells: number;
  readonly arrowCrossings: number;
  readonly verticalConflictCells: number;
  readonly directionViolation: boolean;
}

interface ChosenRoute {
  readonly raw: RawArrow;
  readonly sourceSide: SourceSide;
  readonly waypoints: readonly ArrowWaypoint[];
  readonly lane: ChannelDebugLane;
  readonly score: RouteScore;
}

interface VerticalTrunk {
  readonly x: number;
  readonly yMin: number;
  readonly yMax: number;
  readonly routeClass: RouteClass;
  readonly toTypeId: string;
}

interface VerticalTrunkEntry {
  readonly routeIndex: number;
  readonly segmentIndex: number;
  readonly x: number;
  readonly yMin: number;
  readonly yMax: number;
  readonly toTypeId: string;
  readonly stableKey: string;
}

interface IndexedObstacle {
  readonly obstacle: Obstacle;
  readonly leftCol: number;
  readonly rightCol: number;
  readonly topRow: number;
  readonly bottomRow: number;
}

interface ObstacleIndex {
  readonly all: readonly IndexedObstacle[];
  readonly byCol: ReadonlyMap<number, readonly IndexedObstacle[]>;
  readonly byRow: ReadonlyMap<number, readonly IndexedObstacle[]>;
}

interface OccupancyScore {
  readonly cells: number;
}

export function routeArrows(
  geometry: Geometry,
  obstacles: ObstacleMap,
  inputs: LayoutInputs,
  _measure: (s: string) => number,
): RoutingResult {
  const boundsByType = buildTypeBounds(geometry, obstacles);
  const raws = collectArrows(geometry, inputs, boundsByType);
  const obstacleIndex = buildObstacleIndex(obstacles.all);
  const arrows: Arrow[] = [];
  const verticalTrunks: VerticalTrunk[] = [];
  const chosenRoutes: ChosenRoute[] = [];

  for (const raw of raws) {
    const chosen = chooseDoglegRoute(raw, obstacleIndex, verticalTrunks, chosenRoutes);
    chosenRoutes.push(chosen);
    verticalTrunks.push({
      x: chosen.lane.x,
      yMin: chosen.lane.yMin,
      yMax: chosen.lane.yMax,
      routeClass: raw.routeClass,
      toTypeId: raw.toTypeId,
    });
  }

  const separatedRoutes = separateOverlappingVerticalTrunks(chosenRoutes, obstacleIndex);
  for (const route of separatedRoutes) {
    arrows.push(emitArrow(route.raw, route.waypoints));
  }

  return {
    arrows,
    debug: {
      routing: {
        obstacles: obstacleRects(obstacles),
        lanes: separatedRoutes.map((route) => route.lane),
        groups: [],
        layoutLabels: geometry.debugLabels ?? [],
        layoutGrid: geometry.debugGrid,
      },
    },
  };
}

function separateOverlappingVerticalTrunks(
  routes: readonly ChosenRoute[],
  obstacleIndex: ObstacleIndex,
): readonly ChosenRoute[] {
  const entries: VerticalTrunkEntry[] = [];

  routes.forEach((route, routeIndex) => {
    const segmentIndex = doglegVerticalSegmentIndex(route.waypoints);
    if (segmentIndex === null) return;
    const from = route.waypoints[segmentIndex];
    const to = route.waypoints[segmentIndex + 1];
    if (from === undefined || to === undefined) return;

    const entry: VerticalTrunkEntry = {
      routeIndex,
      segmentIndex,
      x: route.lane.x,
      yMin: Math.min(from.y, to.y),
      yMax: Math.max(from.y, to.y),
      toTypeId: route.raw.toTypeId,
      stableKey: `${route.raw.fromTypeId}:${route.raw.fromFieldName}:${route.raw.toTypeId}:${routeIndex}`,
    };
    entries.push(entry);
  });

  const offsetsByRoute = new Map<
    number,
    { readonly segmentIndex: number; readonly offset: number }
  >();

  for (const component of overlappingTrunkCorridors(entries)) {
    for (const assignment of assignTrunkSubtracks(component)) {
      if (assignment.offset === 0) continue;
      offsetsByRoute.set(assignment.routeIndex, {
        segmentIndex: assignment.segmentIndex,
        offset: assignment.offset,
      });
    }
  }

  if (offsetsByRoute.size === 0) return routes;

  return routes.map((route, routeIndex) => {
    const assignment = offsetsByRoute.get(routeIndex);
    if (assignment === undefined) return route;
    return offsetVerticalTrunk(route, assignment.segmentIndex, assignment.offset, obstacleIndex);
  });
}

function doglegVerticalSegmentIndex(waypoints: readonly ArrowWaypoint[]): number | null {
  for (let index = 1; index < waypoints.length; index += 1) {
    const from = waypoints[index - 1];
    const to = waypoints[index];
    if (from === undefined || to === undefined) continue;
    if (from.x === to.x && from.y !== to.y) return index - 1;
  }
  return null;
}

function overlappingTrunkCorridors(
  entries: readonly VerticalTrunkEntry[],
): readonly (readonly VerticalTrunkEntry[])[] {
  const remaining = new Set(entries);
  const components: VerticalTrunkEntry[][] = [];

  for (const seed of [...remaining].sort(compareVerticalTrunkEntries)) {
    if (!remaining.has(seed)) continue;
    const component: VerticalTrunkEntry[] = [];
    const queue = [seed];
    remaining.delete(seed);

    for (const entry of queue) {
      component.push(entry);
      for (const candidate of [...remaining]) {
        if (!sameTrunkCorridor(entry, candidate)) continue;
        remaining.delete(candidate);
        queue.push(candidate);
      }
    }

    components.push(component.sort(compareVerticalTrunkEntries));
  }

  return components;
}

function sameTrunkCorridor(left: VerticalTrunkEntry, right: VerticalTrunkEntry): boolean {
  // Same-target fan-in is intentional overlap: splitting those trunks creates
  // visual noise without adding routing information.
  if (left.toTypeId === right.toTypeId) return false;
  const sameOrNeighborLane = Math.abs(left.x - right.x) <= BAND_GRID_CELL_W;
  const overlapsVertically = rangeOverlap(left.yMin, left.yMax, right.yMin, right.yMax) > 0;
  return sameOrNeighborLane && overlapsVertically;
}

function assignTrunkSubtracks(component: readonly VerticalTrunkEntry[]): readonly {
  readonly routeIndex: number;
  readonly segmentIndex: number;
  readonly offset: number;
}[] {
  const sorted = [...component].sort(compareVerticalTrunkEntries);
  const trackYMax: number[] = [];
  const trackByEntry = new Map<VerticalTrunkEntry, number>();

  for (const entry of sorted) {
    let track = firstAvailableTrack(entry, trackYMax);
    if (track === null) track = trackYMax.length;
    trackYMax[track] = Math.max(trackYMax[track] ?? Number.NEGATIVE_INFINITY, entry.yMax);
    trackByEntry.set(entry, track);
  }

  const trackCount = trackYMax.length;
  const centerX = trunkCorridorCenter(sorted);
  return sorted.map((entry) => {
    const track = trackByEntry.get(entry) ?? 0;
    // Same-corridor doglegs are still one routing decision. Different-target
    // trunks need real grid-lane spacing when the corridor has room; otherwise
    // dense fan-out turns into ambiguous overdraw even though routing is legal.
    const subtrackX = centerX + (track - (trackCount - 1) / 2) * TRUNK_SUBTRACK_SPACING;
    return {
      routeIndex: entry.routeIndex,
      segmentIndex: entry.segmentIndex,
      offset: subtrackX - entry.x,
    };
  });
}

function trunkCorridorCenter(entries: readonly VerticalTrunkEntry[]): number {
  const minX = Math.min(...entries.map((entry) => entry.x));
  const maxX = Math.max(...entries.map((entry) => entry.x));
  return (minX + maxX) / 2;
}

function firstAvailableTrack(
  entry: VerticalTrunkEntry,
  trackYMax: readonly number[],
): number | null {
  for (let track = 0; track < trackYMax.length; track += 1) {
    if (entry.yMin >= (trackYMax[track] ?? Number.NEGATIVE_INFINITY)) return track;
  }
  return null;
}

function compareVerticalTrunkEntries(left: VerticalTrunkEntry, right: VerticalTrunkEntry): number {
  if (left.yMin !== right.yMin) return left.yMin - right.yMin;
  if (left.yMax !== right.yMax) return left.yMax - right.yMax;
  return left.stableKey.localeCompare(right.stableKey);
}

function offsetVerticalTrunk(
  route: ChosenRoute,
  segmentIndex: number,
  offset: number,
  obstacleIndex: ObstacleIndex,
): ChosenRoute {
  const waypoints = route.waypoints.map((point, index) =>
    index === segmentIndex || index === segmentIndex + 1
      ? { x: point.x + offset, y: point.y }
      : point,
  );
  if (!offsetRouteStaysValid(route, waypoints, obstacleIndex)) {
    return route;
  }

  return {
    ...route,
    waypoints,
    lane: {
      ...route.lane,
      x: route.lane.x + offset,
      bundleKey: `${route.lane.bundleKey}:sub:${offset}`,
    },
  };
}

function offsetRouteStaysValid(
  route: ChosenRoute,
  waypoints: readonly ArrowWaypoint[],
  obstacleIndex: ObstacleIndex,
): boolean {
  if (!routePreservesEndpointDirection(route, waypoints)) {
    return false;
  }

  const candidate = routeCandidateFromWaypoints(route, waypoints);
  if (candidate === null) return false;
  return routeObstacleCells(waypoints, candidate, obstacleIndex) <= route.score.obstacleCells;
}

function routePreservesEndpointDirection(
  route: ChosenRoute,
  waypoints: readonly ArrowWaypoint[],
): boolean {
  const trunk = doglegVerticalSegmentIndex(waypoints);
  const target = waypoints[waypoints.length - 1];
  if (trunk === null || target === undefined) return false;
  const trunkPoint = waypoints[trunk];
  if (trunkPoint === undefined) return false;

  if (trunkPoint.x > target.x) {
    return false;
  }

  if (route.raw.routeClass === 'lca-forward') {
    const start = waypoints[0];
    if (start === undefined) return false;
    return start.x <= trunkPoint.x && trunkPoint.x <= target.x;
  }

  return true;
}

function routeCandidateFromWaypoints(
  route: ChosenRoute,
  waypoints: readonly ArrowWaypoint[],
): RouteCandidate | null {
  const trunk = doglegVerticalSegmentIndex(waypoints);
  const visualSource = waypoints[0];
  const target = waypoints[waypoints.length - 1];
  if (trunk === null || visualSource === undefined || target === undefined) return null;
  const source = waypoints[Math.max(0, trunk - 1)];
  const trunkPoint = waypoints[trunk];
  if (source === undefined || trunkPoint === undefined) return null;
  const interval = laneSearchWindow(source, target, route.sourceSide);
  if (interval.legal && (trunkPoint.x < interval.left || trunkPoint.x > interval.right)) {
    return null;
  }

  return {
    raw: route.raw,
    sourceSide: route.sourceSide,
    sourceSidePreference: 0,
    visualSource,
    source,
    target,
    laneX: trunkPoint.x,
    sameTargetReuse: false,
    legalInterval: interval.legal,
    distanceFromPreferred: Math.abs(trunkPoint.x - interval.preferred),
  };
}

function collectArrows(
  geometry: Geometry,
  inputs: LayoutInputs,
  boundsByType: ReadonlyMap<string, TypeBounds>,
): RawArrow[] {
  const out: RawArrow[] = [];
  const drift = inputs.drift;

  for (const source of geometry.types) {
    const sourceBounds = boundsByType.get(source.node.id);
    if (sourceBounds === undefined) continue;

    if (source.expanded) {
      for (const row of source.visibleRows) {
        if (row.kind === 'method_bucket' || row.targets.length === 0) continue;

        for (const targetId of row.targets) {
          const target = geometry.typesById.get(targetId);
          const targetBounds = boundsByType.get(targetId);
          if (target === undefined || targetBounds === undefined) continue;
          if (target.depth < 0) continue; // ghost target

          const driftClass: DriftClass = drift.typeClass.get(targetId) ?? 'at_lca';
          const routeClass =
            row.kind === 'method' ? 'other' : classifyOwnershipRoute(source, target, driftClass);
          out.push({
            fromTypeId: source.node.id,
            fromFieldName: row.name,
            toTypeId: targetId,
            sourceLeftX: sourceBounds.left,
            sourceRowLeftX: row.x,
            sourceRightX: row.arrowSourceX,
            sourceRightBoundaryX: sourceBounds.right,
            sourceY: row.y,
            targetLeftX: targetBounds.left,
            targetRightX: targetBounds.right,
            targetY: target.y,
            fromRowKind: row.kind === 'method' ? 'method' : 'field',
            kind: row.kind === 'method' ? 'method' : 'ownership',
            routeClass,
            driftClass,
          });
        }
      }
    }

    // Re-export arrows are not structural ownership. They use the same dogleg
    // scorer as ownership arrows, but their legal direction is chosen from the
    // current physical source/target positions.
    if (source.node.isGhost === true && source.node.ghostTarget !== undefined) {
      if (inputs.ghostArrowsShown !== undefined && !inputs.ghostArrowsShown.has(source.node.id)) {
        continue;
      }
      const target = geometry.typesById.get(source.node.ghostTarget);
      const targetBounds = boundsByType.get(source.node.ghostTarget);
      if (target === undefined || targetBounds === undefined || target.node.isGhost === true) {
        continue;
      }
      out.push({
        fromTypeId: source.node.id,
        fromFieldName: '',
        toTypeId: target.node.id,
        sourceLeftX: sourceBounds.left,
        sourceRowLeftX: sourceBounds.left,
        sourceRightX: sourceBounds.right,
        sourceRightBoundaryX: sourceBounds.right,
        sourceY: source.y,
        targetLeftX: targetBounds.left,
        targetRightX: targetBounds.right,
        targetY: target.y,
        fromRowKind: 'field',
        kind: 'reexport',
        routeClass: 'other',
        driftClass: 'at_lca',
      });
    }
  }

  return out;
}

function classifyOwnershipRoute(
  source: PositionedType,
  target: PositionedType,
  driftClass: DriftClass,
): RouteClass {
  if (driftClass !== 'at_lca' && driftClass !== 'within_budget') {
    return 'other';
  }
  return target.depth > source.depth ? 'lca-forward' : 'lca-backward';
}

function chooseDoglegRoute(
  raw: RawArrow,
  obstacleIndex: ObstacleIndex,
  verticalTrunks: readonly VerticalTrunk[],
  existingRoutes: readonly ChosenRoute[],
): ChosenRoute {
  let best: (RouteCandidate & { readonly score: RouteScore }) | null = null;

  for (const [sourceSidePreference, sourceSide] of legalSourceSides(raw).entries()) {
    for (const candidate of doglegCandidates(
      raw,
      sourceSide,
      sourceSidePreference,
      obstacleIndex,
      existingRoutes,
    )) {
      const score = scoreRoute(candidate, obstacleIndex, verticalTrunks, existingRoutes);
      if (best === null || compareScoredCandidates(candidate, score, best, best.score) < 0) {
        best = { ...candidate, score };
      }
    }
  }

  if (best === null) {
    throw new Error(`No dogleg route candidates for ${raw.fromTypeId} -> ${raw.toTypeId}.`);
  }

  const waypoints = doglegWaypoints(best);
  const yMin = Math.min(best.source.y, best.target.y);
  const yMax = Math.max(best.source.y, best.target.y);
  return {
    raw,
    sourceSide: best.sourceSide,
    waypoints,
    lane: {
      x: best.laneX,
      yMin,
      yMax,
      fromTypeId: raw.fromTypeId,
      toTypeId: raw.toTypeId,
      bundleKey: `${raw.routeClass}:${best.sourceSide}:${Math.round(best.laneX / BAND_GRID_CELL_W)}`,
      blocked:
        best.score.obstacleCells > 0 ||
        best.score.arrowCrossings > 0 ||
        best.score.verticalConflictCells > 0 ||
        best.score.directionViolation,
    },
    score: best.score,
  };
}

function legalSourceSides(raw: RawArrow): readonly SourceSide[] {
  if (raw.routeClass === 'lca-forward') return ['right'];

  const sourceCenter = (raw.sourceLeftX + raw.sourceRightBoundaryX) / 2;
  const targetCenter = (raw.targetLeftX + raw.targetRightX) / 2;
  const preferred: SourceSide = targetCenter >= sourceCenter ? 'right' : 'left';
  return preferred === 'right' ? ['right', 'left'] : ['left', 'right'];
}

function doglegCandidates(
  raw: RawArrow,
  sourceSide: SourceSide,
  sourceSidePreference: number,
  obstacleIndex: ObstacleIndex,
  existingRoutes: readonly ChosenRoute[],
): readonly RouteCandidate[] {
  const visualSource =
    sourceSide === 'right'
      ? { x: raw.sourceRightX, y: raw.sourceY }
      : { x: raw.sourceRowLeftX, y: raw.sourceY };
  const source =
    sourceSide === 'right'
      ? { x: raw.sourceRightBoundaryX, y: raw.sourceY }
      : { x: raw.sourceLeftX, y: raw.sourceY };
  const target = { x: raw.targetLeftX, y: raw.targetY };
  const interval = laneSearchWindow(source, target, sourceSide);
  const laneXs =
    sourceSide === 'left' && interval.legal
      ? leftSideLaneXs(interval, source, target, obstacleIndex)
      : interval.legal
        ? legalLaneXs(interval.left, interval.right, interval.preferred)
        : [interval.preferred];
  const sameTargetLaneXs = sameTargetReusableLaneXs(raw, interval, existingRoutes);
  const mergedLaneXs = [...new Set([...sameTargetLaneXs, ...laneXs])];

  return mergedLaneXs.map((laneX) => ({
    raw,
    sourceSide,
    sourceSidePreference,
    visualSource,
    source,
    target,
    laneX,
    sameTargetReuse: sameTargetLaneXs.includes(laneX),
    legalInterval: interval.legal,
    distanceFromPreferred: Math.abs(laneX - interval.preferred),
  }));
}

function sameTargetReusableLaneXs(
  raw: RawArrow,
  interval: LaneSearchWindow,
  existingRoutes: readonly ChosenRoute[],
): readonly number[] {
  const values = new Set<number>();
  for (const route of existingRoutes) {
    // Same-target routes may reuse the exact lane because the overlap reads as
    // fan-in to one destination, not as ambiguous competing edges.
    if (!sameTarget(raw, route.raw)) continue;
    const laneX = route.lane.x;
    if (interval.legal && (laneX < interval.left || laneX > interval.right)) continue;
    values.add(laneX);
  }
  return [...values].sort((a, b) => a - b);
}

interface LaneSearchWindow {
  readonly left: number;
  readonly right: number;
  readonly preferred: number;
  readonly legal: boolean;
}

function laneSearchWindow(
  source: ArrowWaypoint,
  target: ArrowWaypoint,
  sourceSide: SourceSide,
): LaneSearchWindow {
  if (sourceSide === 'right') {
    const left = source.x + DOGLEG_CORNER_RADIUS;
    const right = target.x - DOGLEG_CORNER_RADIUS;
    if (left <= right) {
      return {
        left,
        right,
        preferred: (source.x + target.x) / 2,
        legal: true,
      };
    }
    const fallback = snapDown(target.x - DOGLEG_CORNER_RADIUS);
    return {
      left: fallback,
      right: fallback,
      preferred: fallback,
      legal: false,
    };
  }

  const right = Math.min(source.x, target.x) - DOGLEG_CORNER_RADIUS;
  return {
    left: right - ROUTE_GAP * 6,
    right,
    preferred: right,
    legal: true,
  };
}

function legalLaneXs(left: number, right: number, center: number): readonly number[] {
  const values = new Set<number>();
  const first = Math.ceil(left / BAND_GRID_CELL_W) * BAND_GRID_CELL_W;
  const last = Math.floor(right / BAND_GRID_CELL_W) * BAND_GRID_CELL_W;
  for (let x = first; x <= last; x += BAND_GRID_CELL_W) {
    values.add(x);
  }
  values.add(clamp(snap(center), left, right));

  return [...values].sort((a, b) => {
    const da = Math.abs(a - center);
    const db = Math.abs(b - center);
    if (da !== db) return da - db;
    return a - b;
  });
}

function leftSideLaneXs(
  interval: LaneSearchWindow,
  source: ArrowWaypoint,
  target: ArrowWaypoint,
  obstacleIndex: ObstacleIndex,
): readonly number[] {
  const values = new Set(legalLaneXs(interval.left, interval.right, interval.preferred));
  const yMin = Math.min(source.y, target.y);
  const yMax = Math.max(source.y, target.y);

  for (const indexed of obstacleIndex.all) {
    const obstacleYMin = indexed.obstacle.y;
    const obstacleYMax = indexed.obstacle.y + indexed.obstacle.height;
    if (rangeOverlap(yMin, yMax, obstacleYMin, obstacleYMax) <= 0) {
      continue;
    }
    const obstacleLeft = indexed.leftCol * BAND_GRID_CELL_W;
    if (obstacleLeft > interval.right) {
      continue;
    }
    // Left-side doglegs sometimes need to step outside a blocking column of
    // boxes. Generate a candidate just left of each vertical-span obstacle so
    // the normal scorer can choose a clean trunk instead of being trapped in
    // the small local window near the endpoint.
    values.add(snapDown(obstacleLeft - DOGLEG_CORNER_RADIUS));
  }

  return [...values].sort((a, b) => {
    const da = Math.abs(a - interval.preferred);
    const db = Math.abs(b - interval.preferred);
    if (da !== db) return da - db;
    return a - b;
  });
}

function scoreRoute(
  candidate: RouteCandidate,
  obstacleIndex: ObstacleIndex,
  verticalTrunks: readonly VerticalTrunk[],
  existingRoutes: readonly ChosenRoute[],
): RouteScore {
  const waypoints = doglegWaypoints(candidate);
  const obstacleCells = routeObstacleCells(waypoints, candidate, obstacleIndex);
  const arrowCrossings = routeArrowCrossings(waypoints, candidate.raw, existingRoutes);
  const verticalConflictCells = verticalTrunkConflictCells(candidate, verticalTrunks);
  const directionViolation = !candidate.legalInterval;
  const verticalConflictCost = verticalConflictWeight(candidate.raw.routeClass);
  const total =
    obstacleCells * OBSTACLE_CELL_COST +
    arrowCrossings * ARROW_CROSSING_COST +
    verticalConflictCells * verticalConflictCost +
    (directionViolation ? DIRECTION_VIOLATION_COST : 0);

  return {
    total,
    obstacleCells,
    arrowCrossings,
    verticalConflictCells,
    directionViolation,
  };
}

function compareScoredCandidates(
  left: RouteCandidate,
  leftScore: RouteScore,
  right: RouteCandidate,
  rightScore: RouteScore,
): number {
  if (leftScore.total !== rightScore.total) return leftScore.total - rightScore.total;
  if (leftScore.obstacleCells !== rightScore.obstacleCells) {
    return leftScore.obstacleCells - rightScore.obstacleCells;
  }
  if (leftScore.arrowCrossings !== rightScore.arrowCrossings) {
    return leftScore.arrowCrossings - rightScore.arrowCrossings;
  }
  if (leftScore.verticalConflictCells !== rightScore.verticalConflictCells) {
    return leftScore.verticalConflictCells - rightScore.verticalConflictCells;
  }
  if (left.sameTargetReuse !== right.sameTargetReuse) {
    return left.sameTargetReuse ? -1 : 1;
  }
  if (left.sourceSidePreference !== right.sourceSidePreference) {
    return left.sourceSidePreference - right.sourceSidePreference;
  }
  if (left.distanceFromPreferred !== right.distanceFromPreferred) {
    return left.distanceFromPreferred - right.distanceFromPreferred;
  }
  return left.laneX - right.laneX;
}

function doglegWaypoints(candidate: RouteCandidate): readonly ArrowWaypoint[] {
  const sourceConnector = samePoint(candidate.visualSource, candidate.source)
    ? []
    : [candidate.visualSource];
  return [
    ...sourceConnector,
    candidate.source,
    { x: candidate.laneX, y: candidate.source.y },
    { x: candidate.laneX, y: candidate.target.y },
    candidate.target,
  ];
}

function routeArrowCrossings(
  waypoints: readonly ArrowWaypoint[],
  raw: RawArrow,
  existingRoutes: readonly ChosenRoute[],
): number {
  let crossings = 0;
  for (const route of existingRoutes) {
    // Do not score same-target overlap as a conflict; obstacle scoring still
    // protects boxes, but route-on-route overlap is expected fan-in.
    if (sameTarget(raw, route.raw)) continue;
    crossings += routeCrossings(waypoints, route.waypoints);
  }
  return crossings;
}

function routeCrossings(
  leftWaypoints: readonly ArrowWaypoint[],
  rightWaypoints: readonly ArrowWaypoint[],
): number {
  let crossings = 0;
  for (let leftIndex = 1; leftIndex < leftWaypoints.length; leftIndex += 1) {
    const leftFrom = leftWaypoints[leftIndex - 1];
    const leftTo = leftWaypoints[leftIndex];
    if (leftFrom === undefined || leftTo === undefined) continue;
    if (samePoint(leftFrom, leftTo)) continue;

    for (let rightIndex = 1; rightIndex < rightWaypoints.length; rightIndex += 1) {
      const rightFrom = rightWaypoints[rightIndex - 1];
      const rightTo = rightWaypoints[rightIndex];
      if (rightFrom === undefined || rightTo === undefined) continue;
      if (samePoint(rightFrom, rightTo)) continue;

      const crossing = perpendicularCrossing(leftFrom, leftTo, rightFrom, rightTo);
      if (crossing === null) continue;
      // Shared route corners and endpoints are intentional joins/branches, not
      // visual crossings. Penalize only true line-through-line intersections.
      if (isRouteWaypoint(crossing, leftWaypoints) || isRouteWaypoint(crossing, rightWaypoints)) {
        continue;
      }
      crossings += 1;
    }
  }
  return crossings;
}

function perpendicularCrossing(
  aFrom: ArrowWaypoint,
  aTo: ArrowWaypoint,
  bFrom: ArrowWaypoint,
  bTo: ArrowWaypoint,
): ArrowWaypoint | null {
  const aHorizontal = aFrom.y === aTo.y;
  const aVertical = aFrom.x === aTo.x;
  const bHorizontal = bFrom.y === bTo.y;
  const bVertical = bFrom.x === bTo.x;

  if (aHorizontal && bVertical) {
    return segmentIntersection(aFrom.y, aFrom.x, aTo.x, bFrom.x, bFrom.y, bTo.y);
  }
  if (aVertical && bHorizontal) {
    return segmentIntersection(bFrom.y, bFrom.x, bTo.x, aFrom.x, aFrom.y, aTo.y);
  }
  return null;
}

function segmentIntersection(
  horizontalY: number,
  horizontalX1: number,
  horizontalX2: number,
  verticalX: number,
  verticalY1: number,
  verticalY2: number,
): ArrowWaypoint | null {
  if (
    !isBetween(verticalX, horizontalX1, horizontalX2) ||
    !isBetween(horizontalY, verticalY1, verticalY2)
  ) {
    return null;
  }
  return { x: verticalX, y: horizontalY };
}

function isRouteWaypoint(point: ArrowWaypoint, waypoints: readonly ArrowWaypoint[]): boolean {
  return waypoints.some((waypoint) => samePoint(point, waypoint));
}

function isBetween(value: number, a: number, b: number): boolean {
  return value >= Math.min(a, b) && value <= Math.max(a, b);
}

function routeObstacleCells(
  waypoints: readonly ArrowWaypoint[],
  candidate: RouteCandidate,
  obstacleIndex: ObstacleIndex,
): number {
  let cells = 0;
  const segmentCount = waypoints.length - 1;
  for (let index = 1; index < waypoints.length; index++) {
    const from = waypoints[index - 1];
    const to = waypoints[index];
    if (from === undefined || to === undefined) continue;
    if (from.x === to.x && from.y === to.y) continue;

    const score =
      from.x === to.x
        ? scoreVerticalSegment(
            from.x,
            from.y,
            to.y,
            candidate,
            index - 1,
            segmentCount,
            obstacleIndex,
          )
        : scoreHorizontalSegment(
            from.y,
            from.x,
            to.x,
            candidate,
            index - 1,
            segmentCount,
            obstacleIndex,
          );
    cells += score.cells;
  }
  return cells;
}

function scoreVerticalSegment(
  x: number,
  fromY: number,
  toY: number,
  candidate: RouteCandidate,
  segmentIndex: number,
  segmentCount: number,
  obstacleIndex: ObstacleIndex,
): OccupancyScore {
  const col = Math.floor(x / BAND_GRID_CELL_W);
  const rowMin = Math.floor(Math.min(fromY, toY) / BAND_GRID_CELL_H);
  const rowMax = Math.ceil(Math.max(fromY, toY) / BAND_GRID_CELL_H);
  let cells = 0;

  for (const indexed of obstacleIndex.byCol.get(col) ?? []) {
    if (isAllowedEndpointContact(candidate, indexed.obstacle, segmentIndex, segmentCount)) {
      continue;
    }
    const overlap = rangeOverlap(rowMin, rowMax, indexed.topRow, indexed.bottomRow);
    if (overlap > 0) cells += overlap;
  }

  return { cells };
}

function scoreHorizontalSegment(
  y: number,
  fromX: number,
  toX: number,
  candidate: RouteCandidate,
  segmentIndex: number,
  segmentCount: number,
  obstacleIndex: ObstacleIndex,
): OccupancyScore {
  const row = Math.floor(y / BAND_GRID_CELL_H);
  const colMin = Math.floor(Math.min(fromX, toX) / BAND_GRID_CELL_W);
  const colMax = Math.ceil(Math.max(fromX, toX) / BAND_GRID_CELL_W);
  let cells = 0;

  for (const indexed of obstacleIndex.byRow.get(row) ?? []) {
    if (isAllowedEndpointContact(candidate, indexed.obstacle, segmentIndex, segmentCount)) {
      continue;
    }
    const overlap = rangeOverlap(colMin, colMax, indexed.leftCol, indexed.rightCol);
    if (overlap > 0) cells += overlap;
  }

  return { cells };
}

function verticalTrunkConflictCells(
  candidate: RouteCandidate,
  verticalTrunks: readonly VerticalTrunk[],
): number {
  const yMin = Math.min(candidate.source.y, candidate.target.y);
  const yMax = Math.max(candidate.source.y, candidate.target.y);
  const col = Math.round(candidate.laneX / BAND_GRID_CELL_W);
  const rowMin = Math.floor(yMin / BAND_GRID_CELL_H);
  const rowMax = Math.ceil(yMax / BAND_GRID_CELL_H);
  let cells = 0;

  for (const trunk of verticalTrunks) {
    if (trunk.toTypeId === candidate.raw.toTypeId) continue;
    if (Math.round(trunk.x / BAND_GRID_CELL_W) !== col) continue;
    const overlap = rangeOverlap(
      rowMin,
      rowMax,
      Math.floor(trunk.yMin / BAND_GRID_CELL_H),
      Math.ceil(trunk.yMax / BAND_GRID_CELL_H),
    );
    if (overlap > 0) cells += overlap;
  }

  return cells;
}

function sameTarget(left: RawArrow, right: RawArrow): boolean {
  return left.toTypeId === right.toTypeId;
}

function verticalConflictWeight(routeClass: RouteClass): number {
  if (routeClass === 'lca-forward') return VERTICAL_CONFLICT_COST.lcaForward;
  if (routeClass === 'lca-backward') return VERTICAL_CONFLICT_COST.lcaBackward;
  return VERTICAL_CONFLICT_COST.other;
}

function isAllowedEndpointContact(
  candidate: RouteCandidate,
  obstacle: Obstacle,
  segmentIndex: number,
  segmentCount: number,
): boolean {
  const raw = candidate.raw;
  if (obstacle.typeId === raw.fromTypeId) {
    const exitsViaBoundaryPort = !samePoint(candidate.visualSource, candidate.source);
    // Expanded rows have a semantic row anchor plus a boundary route port.
    // Exempt only that local connector and the boundary-exit stub; later
    // trunk segments must still be scored against the source block.
    return segmentIndex === 0 || (exitsViaBoundaryPort && segmentIndex === 1);
  }
  if (obstacle.typeId === raw.toTypeId) {
    return segmentIndex === segmentCount - 1;
  }
  return false;
}

function buildTypeBounds(
  geometry: Geometry,
  obstacles: ObstacleMap,
): ReadonlyMap<string, TypeBounds> {
  const byType = new Map<string, TypeBounds>();

  for (const [typeId, fragments] of obstacles.blocksByType) {
    rememberBounds(byType, typeId, fragments);
  }

  for (const [typeId, fragments] of obstacles.protrusionsByType) {
    rememberBounds(byType, typeId, fragments);
  }

  for (const type of geometry.types) {
    if (byType.has(type.node.id)) continue;
    byType.set(type.node.id, { left: type.x, right: type.x + type.width });
  }

  return byType;
}

function rememberBounds(
  byType: Map<string, TypeBounds>,
  typeId: string,
  fragments: readonly Obstacle[],
): void {
  const existing = byType.get(typeId);
  const left = Math.min(...fragments.map((fragment) => fragment.x));
  const right = Math.max(...fragments.map((fragment) => fragment.x + fragment.width));
  byType.set(typeId, {
    left: existing === undefined ? left : Math.min(existing.left, left),
    right: existing === undefined ? right : Math.max(existing.right, right),
  });
}

function buildObstacleIndex(obstacles: readonly Obstacle[]): ObstacleIndex {
  const all: IndexedObstacle[] = [];
  const byCol = new Map<number, IndexedObstacle[]>();
  const byRow = new Map<number, IndexedObstacle[]>();

  for (const obstacle of obstacles) {
    const indexed: IndexedObstacle = {
      obstacle,
      leftCol: Math.floor(obstacle.x / BAND_GRID_CELL_W),
      rightCol: Math.ceil((obstacle.x + obstacle.width) / BAND_GRID_CELL_W),
      topRow: Math.floor(obstacle.y / BAND_GRID_CELL_H),
      bottomRow: Math.ceil((obstacle.y + obstacle.height) / BAND_GRID_CELL_H),
    };

    all.push(indexed);
    for (let col = indexed.leftCol; col < indexed.rightCol; col += 1) {
      appendIndex(byCol, col, indexed);
    }
    for (let row = indexed.topRow; row < indexed.bottomRow; row += 1) {
      appendIndex(byRow, row, indexed);
    }
  }

  return { all, byCol, byRow };
}

function appendIndex(
  index: Map<number, IndexedObstacle[]>,
  key: number,
  obstacle: IndexedObstacle,
): void {
  const existing = index.get(key);
  if (existing === undefined) {
    index.set(key, [obstacle]);
    return;
  }
  existing.push(obstacle);
}

function obstacleRects(map: ObstacleMap): ChannelObstacle[] {
  return map.all.map((o) => ({
    left: o.x,
    right: o.x + o.width,
    top: o.y,
    bottom: o.y + o.height,
  }));
}

function emitArrow(raw: RawArrow, waypoints: readonly ArrowWaypoint[]): Arrow {
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

function snap(value: number): number {
  return Math.round(value / BAND_GRID_CELL_W) * BAND_GRID_CELL_W;
}

function snapDown(value: number): number {
  return Math.floor(value / BAND_GRID_CELL_W) * BAND_GRID_CELL_W;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function samePoint(left: ArrowWaypoint, right: ArrowWaypoint): boolean {
  return left.x === right.x && left.y === right.y;
}

function rangeOverlap(aMin: number, aMax: number, bMin: number, bMax: number): number {
  return Math.max(0, Math.min(aMax, bMax) - Math.max(aMin, bMin));
}
