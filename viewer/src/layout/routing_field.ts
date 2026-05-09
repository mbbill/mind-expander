// Reusable clearance field for arrow middle routes. It owns inflated obstacle
// envelopes, clear-segment checks, route candidates, and route-shape
// scoring. Source/target stubs stay in routing.ts because they depend on the
// semantic arrow endpoints.

import { LAYOUT_GRID_CELL_H, LAYOUT_GRID_CELL_W } from '../analysis/layout_metrics.ts';
import type { ArrowWaypoint } from '../analysis/layout_model.ts';
import type { Obstacle } from './types.ts';

export interface RoutingField {
  readonly routeMiddle: (
    start: ArrowWaypoint,
    goal: ArrowWaypoint,
  ) => readonly ArrowWaypoint[] | null;
  readonly segmentIsClear: (
    from: ArrowWaypoint,
    to: ArrowWaypoint,
    options?: { readonly ignoreTypeId?: string },
  ) => boolean;
}

interface ClearanceRect {
  readonly typeId: string;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

interface RouteCandidate {
  readonly length: number;
  readonly turns: number;
  readonly rightness: number;
  readonly waypoints: readonly ArrowWaypoint[];
}

interface RouteMetrics {
  readonly length: number;
  readonly turns: number;
}

export const TARGET_ENTRY_GAP = LAYOUT_GRID_CELL_W + LAYOUT_GRID_CELL_W / 2;
export const BLOCK_LEFT_CLEARANCE_X = TARGET_ENTRY_GAP;
export const BLOCK_RIGHT_CLEARANCE_X = LAYOUT_GRID_CELL_W / 2;

const EPS = 1e-6;
const BLOCK_VERTICAL_CLEARANCE_Y = LAYOUT_GRID_CELL_H / 2;
const OUTER_ROUTE_GAP_X = LAYOUT_GRID_CELL_W;
const OUTER_ROUTE_GAP_Y = LAYOUT_GRID_CELL_H;

export function buildRoutingField(obstacles: readonly Obstacle[]): RoutingField {
  const clearanceRects = obstacles.map(clearanceRectForObstacle);

  return {
    routeMiddle: (start, goal) => routeMiddle(start, goal, clearanceRects),
    segmentIsClear: (from, to, options) =>
      segmentIsClear(
        from,
        to,
        options?.ignoreTypeId === undefined
          ? clearanceRects
          : clearanceRects.filter((rect) => rect.typeId !== options.ignoreTypeId),
      ),
  };
}

function clearanceRectForObstacle(obstacle: Obstacle): ClearanceRect {
  return {
    typeId: obstacle.typeId,
    left: obstacle.x - BLOCK_LEFT_CLEARANCE_X,
    right: obstacle.x + obstacle.width + BLOCK_RIGHT_CLEARANCE_X,
    top: obstacle.y - BLOCK_VERTICAL_CLEARANCE_Y,
    bottom: obstacle.y + obstacle.height + BLOCK_VERTICAL_CLEARANCE_Y,
  };
}

function routeMiddle(
  start: ArrowWaypoint,
  goal: ArrowWaypoint,
  obstacles: readonly ClearanceRect[],
): readonly ArrowWaypoint[] | null {
  if (!pointIsClear(start, obstacles) || !pointIsClear(goal, obstacles)) return null;

  let best: RouteCandidate | null = null;
  for (const waypoints of candidateMiddlePaths(start, goal, obstacles)) {
    const simplified = simplifyOrthogonalPath(compactDuplicateWaypoints(waypoints));
    if (!pathIsClear(simplified, obstacles)) continue;
    const metrics = routeMetrics(simplified);
    const candidate = {
      length: metrics.length,
      turns: metrics.turns,
      rightness: routeRightness(simplified),
      waypoints: simplified,
    };
    if (best === null || compareRouteCandidates(candidate, best) < 0) {
      best = candidate;
    }
  }

  return best?.waypoints ?? null;
}

function candidateMiddlePaths(
  start: ArrowWaypoint,
  goal: ArrowWaypoint,
  obstacles: readonly ClearanceRect[],
): readonly (readonly ArrowWaypoint[])[] {
  const out: Array<readonly ArrowWaypoint[]> = [];
  if (start.x === goal.x || start.y === goal.y) {
    out.push([start, goal]);
  }

  const verticalXs = candidateVerticalXs(start, goal, obstacles);
  const horizontalYs = candidateHorizontalYs(start, goal, obstacles);

  for (const x of verticalXs) {
    out.push([start, { x, y: start.y }, { x, y: goal.y }, goal]);
  }

  for (const y of horizontalYs) {
    out.push([start, { x: start.x, y }, { x: goal.x, y }, goal]);
  }

  const perimeterXs = uniqueNumbers([...verticalXs, ...globalOuterVerticalXs(obstacles)]);
  const perimeterYs = uniqueNumbers([...horizontalYs, ...globalOuterHorizontalYs(obstacles)]);
  for (const x of perimeterXs) {
    for (const y of perimeterYs) {
      out.push([start, { x, y: start.y }, { x, y }, { x: goal.x, y }, goal]);
      out.push([start, { x: start.x, y }, { x, y }, { x, y: goal.y }, goal]);
    }
  }

  return out;
}

function candidateVerticalXs(
  start: ArrowWaypoint,
  goal: ArrowWaypoint,
  obstacles: readonly ClearanceRect[],
): readonly number[] {
  const minX = Math.min(start.x, goal.x);
  const maxX = Math.max(start.x, goal.x);
  const minY = Math.min(start.y, goal.y);
  const maxY = Math.max(start.y, goal.y);
  const candidates = new Set<number>([start.x, goal.x]);
  let outerLeft = Number.POSITIVE_INFINITY;
  let outerRight = Number.NEGATIVE_INFINITY;

  for (const obstacle of obstacles) {
    if (!rangesOverlap(minY, maxY, obstacle.top, obstacle.bottom)) continue;
    outerLeft = Math.min(outerLeft, obstacle.left);
    outerRight = Math.max(outerRight, obstacle.right);
    if (obstacle.left >= minX - EPS && obstacle.left <= maxX + EPS) candidates.add(obstacle.left);
    if (obstacle.right >= minX - EPS && obstacle.right <= maxX + EPS)
      candidates.add(obstacle.right);
  }

  if (Number.isFinite(outerLeft)) candidates.add(outerLeft - OUTER_ROUTE_GAP_X);
  if (Number.isFinite(outerRight)) candidates.add(outerRight + OUTER_ROUTE_GAP_X);

  return [...candidates].sort((a, b) => b - a);
}

function globalOuterVerticalXs(obstacles: readonly ClearanceRect[]): readonly number[] {
  let outerLeft = Number.POSITIVE_INFINITY;
  let outerRight = Number.NEGATIVE_INFINITY;

  for (const obstacle of obstacles) {
    outerLeft = Math.min(outerLeft, obstacle.left);
    outerRight = Math.max(outerRight, obstacle.right);
  }

  const out: number[] = [];
  if (Number.isFinite(outerRight)) out.push(outerRight + OUTER_ROUTE_GAP_X);
  if (Number.isFinite(outerLeft)) out.push(outerLeft - OUTER_ROUTE_GAP_X);
  return out;
}

function candidateHorizontalYs(
  start: ArrowWaypoint,
  goal: ArrowWaypoint,
  obstacles: readonly ClearanceRect[],
): readonly number[] {
  const minX = Math.min(start.x, goal.x);
  const maxX = Math.max(start.x, goal.x);
  let outerTop = Number.POSITIVE_INFINITY;
  let outerBottom = Number.NEGATIVE_INFINITY;
  const candidates = new Set<number>([
    start.y,
    goal.y,
    start.y - LAYOUT_GRID_CELL_H,
    start.y + LAYOUT_GRID_CELL_H,
    goal.y - LAYOUT_GRID_CELL_H,
    goal.y + LAYOUT_GRID_CELL_H,
  ]);

  for (const obstacle of obstacles) {
    if (!rangesOverlap(minX, maxX, obstacle.left, obstacle.right)) continue;
    outerTop = Math.min(outerTop, obstacle.top);
    outerBottom = Math.max(outerBottom, obstacle.bottom);
    candidates.add(obstacle.top);
    candidates.add(obstacle.bottom);
  }

  if (Number.isFinite(outerTop)) candidates.add(outerTop - OUTER_ROUTE_GAP_Y);
  if (Number.isFinite(outerBottom)) candidates.add(outerBottom + OUTER_ROUTE_GAP_Y);

  return [...candidates].sort((a, b) => Math.abs(a - start.y) - Math.abs(b - start.y) || b - a);
}

function globalOuterHorizontalYs(obstacles: readonly ClearanceRect[]): readonly number[] {
  let outerTop = Number.POSITIVE_INFINITY;
  let outerBottom = Number.NEGATIVE_INFINITY;

  for (const obstacle of obstacles) {
    outerTop = Math.min(outerTop, obstacle.top);
    outerBottom = Math.max(outerBottom, obstacle.bottom);
  }

  const out: number[] = [];
  if (Number.isFinite(outerBottom)) out.push(outerBottom + OUTER_ROUTE_GAP_Y);
  if (Number.isFinite(outerTop)) out.push(outerTop - OUTER_ROUTE_GAP_Y);
  return out;
}

function uniqueNumbers(values: readonly number[]): readonly number[] {
  const byKey = new Map<string, number>();
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    const key = value.toFixed(3);
    if (!byKey.has(key)) byKey.set(key, value);
  }
  return [...byKey.values()];
}

function routeMetrics(points: readonly ArrowWaypoint[]): RouteMetrics {
  let length = 0;
  let turns = 0;
  let prevAxis: 'h' | 'v' | null = null;

  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const current = points[i];
    if (prev === undefined || current === undefined) continue;

    length += Math.abs(current.x - prev.x) + Math.abs(current.y - prev.y);
    const axis = prev.x === current.x ? 'v' : 'h';
    if (prevAxis !== null && prevAxis !== axis) turns += 1;
    prevAxis = axis;
  }

  return { length, turns };
}

function routeRightness(points: readonly ArrowWaypoint[]): number {
  let score = Number.NEGATIVE_INFINITY;
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const current = points[i];
    if (prev === undefined || current === undefined || prev.x !== current.x) continue;
    score = Math.max(score, prev.x);
  }
  return score;
}

function compareRouteCandidates(a: RouteCandidate, b: RouteCandidate): number {
  if (a.length < b.length - EPS) return -1;
  if (a.length > b.length + EPS) return 1;
  if (a.turns < b.turns) return -1;
  if (a.turns > b.turns) return 1;
  if (a.rightness > b.rightness + EPS) return -1;
  if (a.rightness < b.rightness - EPS) return 1;
  return 0;
}

function simplifyOrthogonalPath(points: readonly ArrowWaypoint[]): readonly ArrowWaypoint[] {
  if (points.length < 3) return points;

  const out: ArrowWaypoint[] = [];
  const first = points[0];
  if (first === undefined) return [];
  out.push(first);

  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = out[out.length - 1];
    const current = points[i];
    const next = points[i + 1];
    if (prev === undefined || current === undefined || next === undefined) continue;
    if (isStraightThrough(prev, current, next)) continue;
    out.push(current);
  }

  const last = points[points.length - 1];
  if (last !== undefined) out.push(last);
  return out;
}

function isStraightThrough(a: ArrowWaypoint, b: ArrowWaypoint, c: ArrowWaypoint): boolean {
  if (a.y === b.y && b.y === c.y) {
    return Math.sign(b.x - a.x) === Math.sign(c.x - b.x);
  }
  if (a.x === b.x && b.x === c.x) {
    return Math.sign(b.y - a.y) === Math.sign(c.y - b.y);
  }
  return false;
}

function compactDuplicateWaypoints(points: readonly ArrowWaypoint[]): readonly ArrowWaypoint[] {
  const out: ArrowWaypoint[] = [];
  for (const point of points) {
    const prev = out[out.length - 1];
    if (prev !== undefined && prev.x === point.x && prev.y === point.y) continue;
    out.push(point);
  }
  return out;
}

function pointIsClear(point: ArrowWaypoint, obstacles: readonly ClearanceRect[]): boolean {
  return obstacles.every((obstacle) => !pointInsideRect(point, obstacle));
}

function pointInsideRect(point: ArrowWaypoint, rect: ClearanceRect): boolean {
  return (
    point.x > rect.left + EPS &&
    point.x < rect.right - EPS &&
    point.y > rect.top + EPS &&
    point.y < rect.bottom - EPS
  );
}

function pathIsClear(
  waypoints: readonly ArrowWaypoint[],
  obstacles: readonly ClearanceRect[],
): boolean {
  for (let i = 1; i < waypoints.length; i += 1) {
    const prev = waypoints[i - 1];
    const current = waypoints[i];
    if (prev === undefined || current === undefined) continue;
    if (!segmentIsClear(prev, current, obstacles)) return false;
  }
  return true;
}

function segmentIsClear(
  from: ArrowWaypoint,
  to: ArrowWaypoint,
  obstacles: readonly ClearanceRect[],
): boolean {
  if (from.x === to.x && from.y === to.y) return true;
  if (from.x !== to.x && from.y !== to.y) return false;
  return obstacles.every((obstacle) => !axisAlignedSegmentIntersectsRect(from, to, obstacle));
}

function axisAlignedSegmentIntersectsRect(
  from: ArrowWaypoint,
  to: ArrowWaypoint,
  rect: ClearanceRect,
): boolean {
  if (from.y === to.y) {
    const left = Math.min(from.x, to.x);
    const right = Math.max(from.x, to.x);
    return (
      from.y > rect.top + EPS &&
      from.y < rect.bottom - EPS &&
      right > rect.left + EPS &&
      left < rect.right - EPS
    );
  }

  const top = Math.min(from.y, to.y);
  const bottom = Math.max(from.y, to.y);
  return (
    from.x > rect.left + EPS &&
    from.x < rect.right - EPS &&
    bottom > rect.top + EPS &&
    top < rect.bottom - EPS
  );
}

function rangesOverlap(a0: number, a1: number, b0: number, b1: number): boolean {
  return Math.max(a0, b0) <= Math.min(a1, b1) + EPS;
}
