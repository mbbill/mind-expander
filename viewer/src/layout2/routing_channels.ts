// Routing-channel planner used by `routeArrows` for final waypoint emission.
// It evaluates full-route clearance so horizontal and vertical segments share
// the same placed-fragment obstacle contract.

import type { ArrowWaypoint } from '../analysis/layout_bak.ts';

export type RoutingChannelStrategy = 'direct' | 'lane-scan' | 'bypass' | 'fallback';

export type RoutingSegmentOrientation = 'horizontal' | 'vertical';

export interface RoutingChannelObstacle {
  readonly typeId: string;
  readonly fragmentId?: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface RoutingChannelOptions {
  /** Pixel grid used to snap preferred lane x and bypass y coordinates. */
  readonly gridCellSize: number;
  /** Pixel distance between scanned lane candidates. */
  readonly laneStep: number;
  /** Number of lane steps to scan on each side of the preferred lane. */
  readonly maxScan: number;
  /** Preferred vertical-lane x. Defaults to the snapped source/target midpoint. */
  readonly preferredLaneX?: number;
}

export interface RoutingChannelRequest {
  readonly source: ArrowWaypoint;
  readonly target: ArrowWaypoint;
  readonly sourceTypeId: string;
  readonly targetTypeId: string;
  readonly obstacles: readonly RoutingChannelObstacle[];
  readonly obstacleIndex?: RoutingObstacleIndex;
  readonly options: RoutingChannelOptions;
}

export interface RoutingObstacleIndex {
  readonly cellSize: number;
  readonly obstacleByKey: ReadonlyMap<string, RoutingChannelObstacle>;
  readonly byXCell: ReadonlyMap<number, readonly RoutingChannelObstacle[]>;
  readonly byYCell: ReadonlyMap<number, readonly RoutingChannelObstacle[]>;
}

export interface RoutingChannelBlockage {
  readonly segmentIndex: number;
  readonly orientation: RoutingSegmentOrientation;
  readonly obstacleTypeId: string;
  readonly obstacleFragmentId?: string;
}

export interface RoutingChannelMetadata {
  readonly clear: boolean;
  readonly blocked: boolean;
  readonly overflowed: boolean;
  readonly fallback: boolean;
  readonly strategy: RoutingChannelStrategy;
  readonly laneX: number;
  readonly lane2X?: number;
  readonly bypassY?: number;
  readonly blockages: readonly RoutingChannelBlockage[];
}

export interface RoutingChannelPlan {
  readonly waypoints: readonly ArrowWaypoint[];
  readonly metadata: RoutingChannelMetadata;
}

interface RouteEvaluation {
  readonly waypoints: readonly ArrowWaypoint[];
  readonly strategy: Exclude<RoutingChannelStrategy, 'fallback'>;
  readonly laneX: number;
  readonly lane2X?: number;
  readonly bypassY?: number;
  readonly blockages: readonly RoutingChannelBlockage[];
}

interface NormalizedOptions {
  readonly gridCellSize: number;
  readonly laneStep: number;
  readonly maxScan: number;
  readonly preferredLaneX: number;
}

const MAX_VERTICAL_BYPASS_CANDIDATES = 4;
const MAX_BYPASS_LANE_PAIR_CANDIDATES = 64;
const ROUTING_OBSTACLE_INDEX_CELL_SIZE = 128;

export function planRoutingChannel(request: RoutingChannelRequest): RoutingChannelPlan {
  const options = normalizeOptions(request);
  const obstacleIndex = request.obstacleIndex ?? buildRoutingObstacleIndex(request.obstacles);
  const laneXs = laneCandidates(options);
  let bestFallback: RouteEvaluation | null = null;
  const failedDirects: RouteEvaluation[] = [];

  for (const [index, laneX] of laneXs.entries()) {
    const evaluation = evaluateRoute(request, obstacleIndex, {
      waypoints: directWaypoints(request.source, request.target, laneX),
      strategy: index === 0 ? 'direct' : 'lane-scan',
      laneX,
    });
    if (evaluation.blockages.length === 0) {
      return clearPlan(evaluation);
    }
    failedDirects.push(evaluation);
    bestFallback = betterFallback(bestFallback, evaluation);
  }

  const bypassYs = bypassYCandidates(request, failedDirects, obstacleIndex, options);
  const bypassLanePairs = bypassLanePairCandidates(laneXs);
  for (const bypassY of bypassYs) {
    for (const { laneX, lane2X } of bypassLanePairs) {
      const evaluation = evaluateRoute(request, obstacleIndex, {
        waypoints: bypassWaypoints(request.source, request.target, laneX, lane2X, bypassY),
        strategy: 'bypass',
        laneX,
        lane2X,
        bypassY,
      });
      if (evaluation.blockages.length === 0) {
        return clearPlan(evaluation);
      }
      bestFallback = betterFallback(bestFallback, evaluation);
    }
  }

  if (bestFallback === null) {
    throw new Error('Routing channel planning produced no candidate route.');
  }
  return blockedPlan(bestFallback);
}

export function buildRoutingObstacleIndex(
  obstacles: readonly RoutingChannelObstacle[],
  cellSize = ROUTING_OBSTACLE_INDEX_CELL_SIZE,
): RoutingObstacleIndex {
  assertPositiveFinite(cellSize, 'Routing obstacle index cell size');

  const obstacleByKey = new Map<string, RoutingChannelObstacle>();
  const byXCell = new Map<number, RoutingChannelObstacle[]>();
  const byYCell = new Map<number, RoutingChannelObstacle[]>();

  for (const obstacle of obstacles) {
    obstacleByKey.set(obstacleBlockageKey(obstacle), obstacle);
    forEachCoveredCell(obstacle.x, obstacle.x + obstacle.width, cellSize, (cell) =>
      appendIndexedObstacle(byXCell, cell, obstacle),
    );
    forEachCoveredCell(obstacle.y, obstacle.y + obstacle.height, cellSize, (cell) =>
      appendIndexedObstacle(byYCell, cell, obstacle),
    );
  }

  return { cellSize, obstacleByKey, byXCell, byYCell };
}

function appendIndexedObstacle(
  index: Map<number, RoutingChannelObstacle[]>,
  cell: number,
  obstacle: RoutingChannelObstacle,
): void {
  const existing = index.get(cell);
  if (existing === undefined) {
    index.set(cell, [obstacle]);
    return;
  }
  existing.push(obstacle);
}

function forEachCoveredCell(
  min: number,
  max: number,
  cellSize: number,
  visit: (cell: number) => void,
): void {
  const start = Math.floor(min / cellSize);
  const end = Math.floor(max / cellSize);
  for (let cell = start; cell <= end; cell += 1) {
    visit(cell);
  }
}

function normalizeOptions(request: RoutingChannelRequest): NormalizedOptions {
  const { gridCellSize, laneStep, maxScan } = request.options;
  assertPositiveFinite(gridCellSize, 'Routing grid cell size');
  assertPositiveFinite(laneStep, 'Routing lane step');
  if (!Number.isInteger(maxScan) || maxScan < 0) {
    throw new Error('Routing max scan must be a non-negative integer.');
  }

  const rawPreferred = request.options.preferredLaneX ?? (request.source.x + request.target.x) / 2;
  assertFiniteNumber(rawPreferred, 'Routing preferred lane x');

  return {
    gridCellSize,
    laneStep,
    maxScan,
    preferredLaneX: snapToGrid(rawPreferred, gridCellSize),
  };
}

function laneCandidates(options: NormalizedOptions): readonly number[] {
  const out = [options.preferredLaneX];
  for (let offset = 1; offset <= options.maxScan; offset++) {
    out.push(options.preferredLaneX + offset * options.laneStep);
    out.push(options.preferredLaneX - offset * options.laneStep);
  }
  return out;
}

interface BypassLanePair {
  readonly laneX: number;
  readonly lane2X: number;
  readonly sourceLaneIndex: number;
  readonly targetLaneIndex: number;
}

function bypassLanePairCandidates(laneXs: readonly number[]): readonly BypassLanePair[] {
  const pairs: BypassLanePair[] = [];
  for (const [sourceLaneIndex, laneX] of laneXs.entries()) {
    for (const [targetLaneIndex, lane2X] of laneXs.entries()) {
      pairs.push({ laneX, lane2X, sourceLaneIndex, targetLaneIndex });
    }
  }

  return pairs.sort(compareBypassLanePairs).slice(0, MAX_BYPASS_LANE_PAIR_CANDIDATES);
}

function compareBypassLanePairs(left: BypassLanePair, right: BypassLanePair): number {
  const leftScore = left.sourceLaneIndex + left.targetLaneIndex;
  const rightScore = right.sourceLaneIndex + right.targetLaneIndex;
  if (leftScore !== rightScore) {
    return leftScore - rightScore;
  }
  if (left.sourceLaneIndex !== right.sourceLaneIndex) {
    return left.sourceLaneIndex - right.sourceLaneIndex;
  }
  return left.targetLaneIndex - right.targetLaneIndex;
}

function directWaypoints(
  source: ArrowWaypoint,
  target: ArrowWaypoint,
  laneX: number,
): readonly ArrowWaypoint[] {
  return [source, { x: laneX, y: source.y }, { x: laneX, y: target.y }, target];
}

function bypassWaypoints(
  source: ArrowWaypoint,
  target: ArrowWaypoint,
  laneX: number,
  lane2X: number,
  bypassY: number,
): readonly ArrowWaypoint[] {
  return [
    source,
    { x: laneX, y: source.y },
    { x: laneX, y: bypassY },
    { x: lane2X, y: bypassY },
    { x: lane2X, y: target.y },
    target,
  ];
}

function evaluateRoute(
  request: RoutingChannelRequest,
  obstacleIndex: RoutingObstacleIndex,
  route: Omit<RouteEvaluation, 'blockages'>,
): RouteEvaluation {
  return {
    ...route,
    blockages: routeBlockages(request, obstacleIndex, route.waypoints),
  };
}

function routeBlockages(
  request: RoutingChannelRequest,
  obstacleIndex: RoutingObstacleIndex,
  waypoints: readonly ArrowWaypoint[],
): readonly RoutingChannelBlockage[] {
  const blockages: RoutingChannelBlockage[] = [];
  const segments = routeSegments(waypoints);

  for (const segment of segments) {
    for (const obstacle of candidateObstaclesForSegment(segment, obstacleIndex)) {
      if (isEndpointObstacle(request, obstacle)) {
        continue;
      }
      if (segmentIntersectsObstacle(segment, obstacle)) {
        blockages.push(blockageFor(segment, obstacle));
      }
    }
  }

  return blockages;
}

function candidateObstaclesForSegment(
  segment: RouteSegment,
  obstacleIndex: RoutingObstacleIndex,
): readonly RoutingChannelObstacle[] {
  // Routing evaluates many candidate polylines against the same placed
  // fragments. Querying by the segment's constant x/y keeps this exact
  // obstacle contract without the old O(candidates × all-obstacles) scan.
  const cell =
    segment.orientation === 'vertical'
      ? Math.floor(segment.from.x / obstacleIndex.cellSize)
      : Math.floor(segment.from.y / obstacleIndex.cellSize);
  return (
    (segment.orientation === 'vertical'
      ? obstacleIndex.byXCell.get(cell)
      : obstacleIndex.byYCell.get(cell)) ?? []
  );
}

function isEndpointObstacle(
  request: RoutingChannelRequest,
  obstacle: RoutingChannelObstacle,
): boolean {
  // Endpoint fragments are allowed to overlap the first/last route contact so
  // arrows can visibly leave and enter their owning boxes. Unrelated fragments
  // still reserve physical routing space for every route segment.
  return obstacle.typeId === request.sourceTypeId || obstacle.typeId === request.targetTypeId;
}

interface RouteSegment {
  readonly index: number;
  readonly from: ArrowWaypoint;
  readonly to: ArrowWaypoint;
  readonly orientation: RoutingSegmentOrientation;
}

function routeSegments(waypoints: readonly ArrowWaypoint[]): readonly RouteSegment[] {
  const segments: RouteSegment[] = [];
  for (let index = 1; index < waypoints.length; index++) {
    const from = waypoints[index - 1];
    const to = waypoints[index];
    if (from === undefined || to === undefined) {
      continue;
    }
    if (from.x === to.x && from.y === to.y) {
      continue;
    }
    if (from.x === to.x) {
      segments.push({ index: index - 1, from, to, orientation: 'vertical' });
      continue;
    }
    if (from.y === to.y) {
      segments.push({ index: index - 1, from, to, orientation: 'horizontal' });
      continue;
    }
    throw new Error('Routing channel planner generated a non-orthogonal segment.');
  }
  return segments;
}

function segmentIntersectsObstacle(
  segment: RouteSegment,
  obstacle: RoutingChannelObstacle,
): boolean {
  const left = obstacle.x;
  const right = obstacle.x + obstacle.width;
  const top = obstacle.y;
  const bottom = obstacle.y + obstacle.height;

  if (segment.orientation === 'vertical') {
    const yMin = Math.min(segment.from.y, segment.to.y);
    const yMax = Math.max(segment.from.y, segment.to.y);
    return (
      segment.from.x >= left && segment.from.x <= right && rangesOverlap(yMin, yMax, top, bottom)
    );
  }

  const xMin = Math.min(segment.from.x, segment.to.x);
  const xMax = Math.max(segment.from.x, segment.to.x);
  return (
    segment.from.y >= top && segment.from.y <= bottom && rangesOverlap(xMin, xMax, left, right)
  );
}

function rangesOverlap(aMin: number, aMax: number, bMin: number, bMax: number): boolean {
  return aMin < bMax && bMin < aMax;
}

function blockageFor(
  segment: RouteSegment,
  obstacle: RoutingChannelObstacle,
): RoutingChannelBlockage {
  const base = {
    segmentIndex: segment.index,
    orientation: segment.orientation,
    obstacleTypeId: obstacle.typeId,
  };
  if (obstacle.fragmentId === undefined) {
    return base;
  }
  return { ...base, obstacleFragmentId: obstacle.fragmentId };
}

function bypassYCandidates(
  request: RoutingChannelRequest,
  failedDirects: readonly RouteEvaluation[],
  obstacleIndex: RoutingObstacleIndex,
  options: NormalizedOptions,
): readonly number[] {
  const blockers = bypassBlockers(failedDirects, obstacleIndex);
  const candidates: number[] = [];

  if (blockers.horizontal.length > 0) {
    const top = Math.min(...blockers.horizontal.map((obstacle) => obstacle.y));
    const bottom = Math.max(...blockers.horizontal.map((obstacle) => obstacle.y + obstacle.height));
    candidates.push(
      snapDown(top - options.laneStep, options.gridCellSize),
      snapUp(bottom + options.laneStep, options.gridCellSize),
    );
  }

  // Vertical direct blockages often need a mid-route lane swap rather than a
  // wider x scan. Deriving y candidates only from observed direct failures
  // keeps bypass search bounded by the configured lane scan and this fixed
  // candidate window, even when the real obstacle set is large.
  candidates.push(...verticalBypassYCandidates(request, blockers.vertical, options));

  return uniqueNumbers(candidates);
}

interface VerticalBypassCandidate {
  readonly y: number;
  readonly order: number;
  readonly insideDirectSpan: boolean;
  readonly distanceFromMidpoint: number;
}

function verticalBypassYCandidates(
  request: RoutingChannelRequest,
  blockers: readonly RoutingChannelObstacle[],
  options: NormalizedOptions,
): readonly number[] {
  const yMin = Math.min(request.source.y, request.target.y);
  const yMax = Math.max(request.source.y, request.target.y);
  const midpoint = (request.source.y + request.target.y) / 2;
  const byY = new Map<number, VerticalBypassCandidate>();
  let order = 0;

  for (const obstacle of blockers) {
    for (const y of [
      snapDown(obstacle.y - options.laneStep, options.gridCellSize),
      snapUp(obstacle.y + obstacle.height + options.laneStep, options.gridCellSize),
    ]) {
      if (!byY.has(y)) {
        byY.set(y, {
          y,
          order,
          insideDirectSpan: y > yMin && y < yMax,
          distanceFromMidpoint: Math.abs(y - midpoint),
        });
      }
      order++;
    }
  }

  return [...byY.values()]
    .sort(compareVerticalBypassCandidates)
    .slice(0, MAX_VERTICAL_BYPASS_CANDIDATES)
    .map((candidate) => candidate.y);
}

function compareVerticalBypassCandidates(
  left: VerticalBypassCandidate,
  right: VerticalBypassCandidate,
): number {
  if (left.insideDirectSpan !== right.insideDirectSpan) {
    return left.insideDirectSpan ? -1 : 1;
  }
  if (left.distanceFromMidpoint !== right.distanceFromMidpoint) {
    return left.distanceFromMidpoint - right.distanceFromMidpoint;
  }
  if (left.order !== right.order) {
    return left.order - right.order;
  }
  return left.y - right.y;
}

interface BypassBlockers {
  readonly horizontal: readonly RoutingChannelObstacle[];
  readonly vertical: readonly RoutingChannelObstacle[];
}

function bypassBlockers(
  failedDirects: readonly RouteEvaluation[],
  obstacleIndex: RoutingObstacleIndex,
): BypassBlockers {
  const horizontalBlockageKeys = new Set<string>();
  const verticalBlockageKeys = new Set<string>();

  for (const route of failedDirects) {
    for (const blockage of route.blockages) {
      if (blockage.orientation === 'horizontal') {
        horizontalBlockageKeys.add(blockageKey(blockage));
      } else {
        verticalBlockageKeys.add(blockageKey(blockage));
      }
    }
  }

  return {
    horizontal: obstaclesForBlockageKeys(horizontalBlockageKeys, obstacleIndex.obstacleByKey),
    vertical: obstaclesForBlockageKeys(verticalBlockageKeys, obstacleIndex.obstacleByKey),
  };
}

function obstaclesForBlockageKeys(
  blockageKeys: ReadonlySet<string>,
  obstacleByKey: ReadonlyMap<string, RoutingChannelObstacle>,
): readonly RoutingChannelObstacle[] {
  const out: RoutingChannelObstacle[] = [];
  for (const key of blockageKeys) {
    const obstacle = obstacleByKey.get(key);
    if (obstacle !== undefined) {
      out.push(obstacle);
    }
  }
  return out;
}

function betterFallback(
  current: RouteEvaluation | null,
  candidate: RouteEvaluation,
): RouteEvaluation {
  if (current === null) {
    return candidate;
  }
  if (fallbackScore(candidate) < fallbackScore(current)) {
    return candidate;
  }
  return current;
}

function fallbackScore(evaluation: RouteEvaluation): number {
  const blockedSegments = new Set(evaluation.blockages.map((blockage) => blockage.segmentIndex))
    .size;
  return blockedSegments * 1000 + evaluation.blockages.length;
}

function clearPlan(evaluation: RouteEvaluation): RoutingChannelPlan {
  return {
    waypoints: evaluation.waypoints,
    metadata: {
      clear: true,
      blocked: false,
      overflowed: false,
      fallback: false,
      strategy: evaluation.strategy,
      laneX: evaluation.laneX,
      ...optionalLane2X(evaluation),
      ...optionalBypassY(evaluation),
      blockages: [],
    },
  };
}

function blockedPlan(evaluation: RouteEvaluation): RoutingChannelPlan {
  return {
    waypoints: evaluation.waypoints,
    metadata: {
      clear: false,
      blocked: true,
      overflowed: true,
      fallback: true,
      strategy: 'fallback',
      laneX: evaluation.laneX,
      ...optionalLane2X(evaluation),
      ...optionalBypassY(evaluation),
      blockages: evaluation.blockages,
    },
  };
}

function optionalLane2X(evaluation: RouteEvaluation): { readonly lane2X?: number } {
  return evaluation.lane2X === undefined ? {} : { lane2X: evaluation.lane2X };
}

function optionalBypassY(evaluation: RouteEvaluation): { readonly bypassY?: number } {
  return evaluation.bypassY === undefined ? {} : { bypassY: evaluation.bypassY };
}

function obstacleBlockageKey(obstacle: RoutingChannelObstacle): string {
  return JSON.stringify([obstacle.typeId, obstacle.fragmentId ?? '']);
}

function blockageKey(blockage: RoutingChannelBlockage): string {
  return JSON.stringify([blockage.obstacleTypeId, blockage.obstacleFragmentId ?? '']);
}

function uniqueNumbers(values: readonly number[]): readonly number[] {
  const out: number[] = [];
  for (const value of values) {
    if (!out.includes(value)) {
      out.push(value);
    }
  }
  return out;
}

function snapToGrid(value: number, gridCellSize: number): number {
  return Math.round(value / gridCellSize) * gridCellSize;
}

function snapDown(value: number, gridCellSize: number): number {
  return Math.floor(value / gridCellSize) * gridCellSize;
}

function snapUp(value: number, gridCellSize: number): number {
  return Math.ceil(value / gridCellSize) * gridCellSize;
}

function assertPositiveFinite(value: number, label: string): void {
  assertFiniteNumber(value, label);
  if (value <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }
}

function assertFiniteNumber(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be finite.`);
  }
}
