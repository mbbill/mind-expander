// Grid arrow routing.
//
// Forward-LCA implements the constraint contract from docs/layout.md
// "Arrow Routing": axis-aligned polyline (rowAnchor → trunk → target.left),
// trunk X kept ≥0.5 grid from source.right and ≥1.5 grid from target.left,
// strict rightward monotonicity, same-target merge, different-target trunks
// kept ≥1 grid apart inside their conflict batches. Trunk X is continuous —
// no grid snap.
//
// Backward-LCA, method, and re-export use an orthogonal fallback. Their full
// constraint contracts are deferred until the forward-LCA pass settles, but
// grid mode should never emit diagonal arrows.

import type {
  ArrowWaypoint,
  ChannelDebugLane,
  LayoutDebug,
  LayoutInputs,
} from '../analysis/layout_model.ts';
import { BAND_GRID_CELL_W } from './geometry.ts';
import type { Geometry } from './geometry.ts';
import type { ObstacleMap } from './obstacles.ts';
import {
  type RouteRequest,
  buildTypeBounds,
  collectRouteRequests,
  emitArrow,
  obstacleRects,
  rangeOverlap,
} from './routing_common.ts';
import type { RoutingResult } from './routing_dogleg.ts';
import type { Obstacle } from './types.ts';

const SOURCE_STUB_MIN = BAND_GRID_CELL_W * 0.5;
const TARGET_STUB_MIN = BAND_GRID_CELL_W * 1.5;
const MIN_LANE_SEP = BAND_GRID_CELL_W;
const DETOUR_GAP = BAND_GRID_CELL_W;
const DETOUR_TURN_COST = BAND_GRID_CELL_W * 2;
const MAX_DETOUR_OBSTACLES = 48;
// Two competing visual costs:
//   - obstacle crossing: arrow cuts through a non-endpoint block (ugly).
//   - lane collision: arrow stacks within MIN_LANE_SEP of another arrow's
//     y-overlapping trunk (looks like one duplicated line).
// One of each is roughly comparable, but they scale differently under
// pressure: stacking N arrows on the same column reads quadratically
// worse — three coincident lines are dramatically worse than two — while
// cutting through N blocks reads roughly linearly bad. So a short
// one-block cut is preferable to a 1-collision stack (a lone line through
// a single block beats two ghosted-together lines), but cutting through
// several blocks reads worse than tolerating two stacked arrows.
const OBSTACLE_CROSSING_COST = 100_000;
const LANE_COLLISION_COST = 70_000;
const ROUTE_CROSSING_COST = 5_000;

interface Route {
  readonly raw: RouteRequest;
  readonly waypoints: readonly ArrowWaypoint[];
  readonly blocked: boolean;
}

interface IndexedRequest {
  readonly raw: RouteRequest;
  readonly index: number;
}

interface ForwardGroup {
  readonly targetId: string;
  readonly requests: readonly IndexedRequest[];
  /** Trunk-X window, intersection of member windows. */
  readonly windowL: number;
  readonly windowR: number;
  /** Union of member trunk y-spans. */
  readonly yMin: number;
  readonly yMax: number;
  /** Average of (sourceY + targetY)/2 over members — barycenter heuristic
   *  for crossing-minimizing lane order inside a batch. */
  readonly barycenter: number;
  /** Stable secondary order key (smallest member index). */
  readonly order: number;
}

interface AssignedLane {
  readonly x: number;
  readonly blocked: boolean;
}

interface DetourState {
  readonly pointIndex: number;
  readonly direction: SearchDirection;
}

type SearchDirection = 'none' | 'horizontal' | 'vertical';

interface SearchPoint {
  readonly x: number;
  readonly y: number;
}

interface HeapEntry {
  readonly state: DetourState;
  readonly cost: number;
}

export function routeArrowsGrid(
  geometry: Geometry,
  obstacles: ObstacleMap,
  inputs: LayoutInputs,
  _measure: (s: string) => number,
): RoutingResult {
  const boundsByType = buildTypeBounds(geometry, obstacles);
  const requests = collectRouteRequests(geometry, inputs, boundsByType);
  const indexed: IndexedRequest[] = requests.map((raw, index) => ({ raw, index }));
  const routes = new Map<number, Route>();

  routeForwardLca(
    indexed.filter((request) => request.raw.routeClass === 'lca-forward'),
    routes,
    obstacles.all,
  );

  for (const request of indexed) {
    if (routes.has(request.index)) continue;
    routes.set(request.index, orthogonalFallbackRoute(request.raw));
  }

  const ordered: Route[] = indexed.map((request) => {
    const route = routes.get(request.index);
    if (route === undefined) throw new Error(`Missing grid route for request ${request.index}.`);
    return route;
  });

  return {
    arrows: ordered.map((route) => emitArrow(route.raw, route.waypoints)),
    debug: directDebug(ordered, obstacles, geometry.debugLabels ?? [], geometry.debugGrid),
  };
}

function routeForwardLca(
  requests: readonly IndexedRequest[],
  routes: Map<number, Route>,
  obstacles: readonly Obstacle[],
): void {
  if (requests.length === 0) return;
  const groups = sameTargetGroups(requests);
  for (const batch of conflictBatches(groups)) {
    const lanes = assignLanes(batch, obstacles);
    for (const group of batch) {
      const lane = lanes.get(group.targetId);
      if (lane === undefined) continue;
      for (const request of group.requests) {
        const route = forwardRoute(request.raw, lane.x, lane.blocked);
        routes.set(request.index, improveForwardRoute(route, obstacles));
      }
    }
  }
  markCrossings(
    requests.map((request) => request.index),
    routes,
  );
}

function sameTargetGroups(requests: readonly IndexedRequest[]): readonly ForwardGroup[] {
  const byTarget = new Map<string, IndexedRequest[]>();
  for (const request of requests) {
    const list = byTarget.get(request.raw.toTypeId);
    if (list === undefined) byTarget.set(request.raw.toTypeId, [request]);
    else list.push(request);
  }
  const groups: ForwardGroup[] = [];
  for (const [targetId, members] of byTarget) {
    const windowL = Math.max(...members.map((m) => m.raw.sourceRightBoundaryX + SOURCE_STUB_MIN));
    const windowR = Math.min(...members.map((m) => m.raw.targetLeftX - TARGET_STUB_MIN));
    const ys = members.flatMap((m) => [m.raw.sourceY, m.raw.targetY]);
    const yMin = Math.min(...ys);
    const yMax = Math.max(...ys);
    const sourceYAvg = members.reduce((sum, m) => sum + m.raw.sourceY, 0) / members.length;
    const targetY = members[0]?.raw.targetY ?? 0;
    const barycenter = (sourceYAvg + targetY) / 2;
    const order = Math.min(...members.map((m) => m.index));
    groups.push({ targetId, requests: members, windowL, windowR, yMin, yMax, barycenter, order });
  }
  return groups;
}

function conflictBatches(groups: readonly ForwardGroup[]): readonly (readonly ForwardGroup[])[] {
  // Two groups belong to the same batch when their lanes could collide:
  // windows overlap (could share a column) AND y-spans overlap (verticals
  // would coincide). Connected components handle the transitive case where
  // A and C only conflict via B — the previous sequential batcher missed
  // those, which is why unrelated forward arrows could end up on the same
  // column.
  const parent = groups.map((_, index) => index);
  const find = (i: number): number => {
    let cursor = i;
    while ((parent[cursor] ?? cursor) !== cursor) {
      const next = parent[cursor] ?? cursor;
      parent[cursor] = parent[next] ?? next;
      cursor = parent[cursor] ?? cursor;
    }
    return cursor;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  for (let i = 0; i < groups.length; i += 1) {
    for (let j = i + 1; j < groups.length; j += 1) {
      const a = groups[i];
      const b = groups[j];
      if (a === undefined || b === undefined) continue;
      const xOverlap = Math.max(a.windowL, b.windowL) <= Math.min(a.windowR, b.windowR);
      const yOverlap = a.yMin <= b.yMax && b.yMin <= a.yMax;
      if (xOverlap && yOverlap) union(i, j);
    }
  }

  const buckets = new Map<number, ForwardGroup[]>();
  for (let i = 0; i < groups.length; i += 1) {
    const root = find(i);
    let bucket = buckets.get(root);
    if (bucket === undefined) {
      bucket = [];
      buckets.set(root, bucket);
    }
    const group = groups[i];
    if (group !== undefined) bucket.push(group);
  }

  return [...buckets.values()]
    .map((batch) => [...batch].sort(compareGroup))
    .sort((a, b) => {
      const af = a[0];
      const bf = b[0];
      if (af === undefined || bf === undefined) return 0;
      return af.order - bf.order;
    });
}

function compareGroup(a: ForwardGroup, b: ForwardGroup): number {
  if (a.barycenter !== b.barycenter) return a.barycenter - b.barycenter;
  if (a.order !== b.order) return a.order - b.order;
  return a.targetId.localeCompare(b.targetId);
}

interface PlacedLane {
  readonly x: number;
  readonly yMin: number;
  readonly yMax: number;
  readonly toTypeId: string;
  readonly waypoints: readonly ArrowWaypoint[];
}

function assignLanes(
  batch: readonly ForwardGroup[],
  obstacles: readonly Obstacle[],
): ReadonlyMap<string, AssignedLane> {
  const result = new Map<string, AssignedLane>();
  if (batch.length === 0) return result;
  if (batch.length === 1) {
    const group = batch[0];
    if (group !== undefined)
      result.set(group.targetId, chooseLane(group, obstacles, [], group.windowR));
    return result;
  }

  // Lane assignment is constrained per *y-overlap*, not per batch order.
  // Prefer the rightmost legal trunk for each target (`target.left - 1.5g`)
  // and let the scorer step left by one grid lane per already-placed target
  // group. Same-target arrows still merge; different targets get a compact
  // right-packed lane stack instead of spreading across the whole corridor.
  const placed: PlacedLane[] = [];
  for (let index = 0; index < batch.length; index += 1) {
    const group = batch[index];
    if (group === undefined) continue;
    const preferred = group.windowR;
    const lane = chooseLane(group, obstacles, placed, preferred);
    result.set(group.targetId, lane);
    for (const request of group.requests) {
      placed.push({
        x: lane.x,
        yMin: Math.min(request.raw.sourceY, request.raw.targetY),
        yMax: Math.max(request.raw.sourceY, request.raw.targetY),
        toTypeId: group.targetId,
        waypoints: forwardRoute(request.raw, lane.x, lane.blocked).waypoints,
      });
    }
  }
  return result;
}

function chooseLane(
  group: ForwardGroup,
  obstacles: readonly Obstacle[],
  placed: readonly PlacedLane[],
  preferredOverride?: number,
): AssignedLane {
  if (group.windowR < group.windowL) {
    return { x: (group.windowL + group.windowR) / 2, blocked: true };
  }
  const preferred = preferredOverride ?? (group.windowL + group.windowR) / 2;
  const differentTargetLanes = placed.filter((lane) => lane.toTypeId !== group.targetId);
  const candidates = new Set<number>([clamp(preferred, group.windowL, group.windowR)]);
  for (const obstacle of obstacles) {
    if (!obstacleAffectsGroup(obstacle, group)) continue;
    const left = obstacle.x - SOURCE_STUB_MIN;
    const right = obstacle.x + obstacle.width + SOURCE_STUB_MIN;
    if (left >= group.windowL && left <= group.windowR) candidates.add(left);
    if (right >= group.windowL && right <= group.windowR) candidates.add(right);
  }
  // Escape candidates: if a y-overlapping lane sits at column X, candidates
  // X ± MIN_LANE_SEP let the scorer step out of its collision zone without
  // having to walk every grid position in the window.
  for (const lane of differentTargetLanes) {
    const right = lane.x + MIN_LANE_SEP;
    const left = lane.x - MIN_LANE_SEP;
    if (right >= group.windowL && right <= group.windowR) candidates.add(right);
    if (left >= group.windowL && left <= group.windowR) candidates.add(left);
  }
  for (const x of routeCrossingEscapeXs(group, placed)) {
    if (x >= group.windowL && x <= group.windowR) candidates.add(x);
  }
  let best: { x: number; cost: number; blocked: boolean } | null = null;
  for (const x of candidates) {
    const crossings = laneCrossingCount(x, group, obstacles);
    const collisions = differentTargetLanes.filter(
      (lane) => Math.abs(lane.x - x) < MIN_LANE_SEP,
    ).length;
    const routeCrossings = routeCrossingCount(x, group, placed);
    const distance = Math.abs(x - preferred);
    // Obstacles are linear (each cut adds the same cost), collisions are
    // quadratic (n^2) — N stacked lanes look dramatically worse than N
    // isolated obstacle cuts. Distance breaks ties.
    const cost =
      crossings * OBSTACLE_CROSSING_COST +
      collisions * collisions * LANE_COLLISION_COST +
      routeCrossings * ROUTE_CROSSING_COST +
      distance;
    if (best === null || cost < best.cost) {
      best = { x, cost, blocked: crossings > 0 || collisions > 0 || routeCrossings > 0 };
    }
  }
  return best ?? { x: clamp(preferred, group.windowL, group.windowR), blocked: true };
}

function routeCrossingEscapeXs(
  group: ForwardGroup,
  placed: readonly PlacedLane[],
): readonly number[] {
  const values = new Set<number>();
  for (const lane of placed) {
    if (lane.toTypeId === group.targetId) continue;
    for (let index = 1; index < lane.waypoints.length; index += 1) {
      const from = lane.waypoints[index - 1];
      const to = lane.waypoints[index];
      if (from === undefined || to === undefined || from.y !== to.y || from.x === to.x) continue;
      if (from.y < group.yMin || from.y > group.yMax) continue;
      values.add(Math.min(from.x, to.x));
      values.add(Math.max(from.x, to.x));
    }
  }
  return [...values];
}

function routeCrossingCount(
  laneX: number,
  group: ForwardGroup,
  placed: readonly PlacedLane[],
): number {
  let crossings = 0;
  for (const request of group.requests) {
    const waypoints = forwardRoute(request.raw, laneX, false).waypoints;
    for (const lane of placed) {
      if (lane.toTypeId === group.targetId) continue;
      if (polylinesCross(waypoints, lane.waypoints)) crossings += 1;
    }
  }
  return crossings;
}

function obstacleAffectsGroup(obstacle: Obstacle, group: ForwardGroup): boolean {
  if (obstacle.y + obstacle.height < group.yMin || obstacle.y > group.yMax) return false;
  if (obstacle.x > group.windowR || obstacle.x + obstacle.width < group.windowL) return false;
  return true;
}

function laneCrossingCount(x: number, group: ForwardGroup, obstacles: readonly Obstacle[]): number {
  // Constraint #7 covers the *path*, not just the trunk: the source stub
  // at sourceY (rowAnchor → trunk) and target stub at targetY (trunk →
  // target.left) must clear non-endpoint obstacles too. Returns a *count*
  // so the scorer treats a path that cuts through several blocks as
  // strictly worse than a one-block grazing — that's the difference
  // between the user's "shouldn't cut through *all* the arrowheads" case
  // and an unavoidable single-block clip.
  let count = 0;
  for (const obstacle of obstacles) {
    if (!obstacleAffectsGroup(obstacle, group)) continue;
    for (const request of group.requests) {
      if (obstacle.typeId === request.raw.fromTypeId || obstacle.typeId === request.raw.toTypeId) {
        continue;
      }
      const oLeft = obstacle.x;
      const oRight = obstacle.x + obstacle.width;
      const oTop = obstacle.y;
      const oBot = obstacle.y + obstacle.height;
      const yLo = Math.min(request.raw.sourceY, request.raw.targetY);
      const yHi = Math.max(request.raw.sourceY, request.raw.targetY);
      if (x >= oLeft && x <= oRight && Math.max(yLo, oTop) < Math.min(yHi, oBot)) {
        count += 1;
        continue;
      }
      if (
        request.raw.sourceY >= oTop &&
        request.raw.sourceY <= oBot &&
        Math.max(Math.min(request.raw.sourceRightX, x), oLeft) <
          Math.min(Math.max(request.raw.sourceRightX, x), oRight)
      ) {
        count += 1;
        continue;
      }
      if (
        request.raw.targetY >= oTop &&
        request.raw.targetY <= oBot &&
        Math.max(Math.min(x, request.raw.targetLeftX), oLeft) <
          Math.min(Math.max(x, request.raw.targetLeftX), oRight)
      ) {
        count += 1;
      }
    }
  }
  return count;
}

function markCrossings(forwardIndices: readonly number[], routes: Map<number, Route>): void {
  // After lane assignment some inherent crossings can remain: a vertical
  // trunk piercing another arrow's source/target stub. These can't always
  // be resolved by reordering, so we flag the lanes blocked rather than
  // search wider — per constraint #14 the route is still emitted.
  for (let i = 0; i < forwardIndices.length; i += 1) {
    for (let j = i + 1; j < forwardIndices.length; j += 1) {
      const idxA = forwardIndices[i];
      const idxB = forwardIndices[j];
      if (idxA === undefined || idxB === undefined) continue;
      const a = routes.get(idxA);
      const b = routes.get(idxB);
      if (a === undefined || b === undefined) continue;
      // Same-target arrows merge by design; coincident segments aren't a
      // crossing.
      if (a.raw.toTypeId === b.raw.toTypeId) continue;
      if (!polylinesCross(a.waypoints, b.waypoints)) continue;
      if (!a.blocked) routes.set(idxA, { ...a, blocked: true });
      if (!b.blocked) routes.set(idxB, { ...b, blocked: true });
    }
  }
}

function improveForwardRoute(route: Route, obstacles: readonly Obstacle[]): Route {
  const blockers = routeCrossingObstacles(route.waypoints, route.raw, obstacles);
  if (blockers.length === 0) return route;

  const detour = detourForwardRoute(route.raw, route.waypoints, blockers, obstacles);
  if (detour === null) return route;
  if (routeCrossingObstacles(detour, route.raw, obstacles).length > 0) return route;

  return {
    ...route,
    waypoints: detour,
    blocked: false,
  };
}

function detourForwardRoute(
  raw: RouteRequest,
  seedWaypoints: readonly ArrowWaypoint[],
  blockers: readonly Obstacle[],
  obstacles: readonly Obstacle[],
): readonly ArrowWaypoint[] | null {
  const visualStart = { x: raw.sourceRightX, y: raw.sourceY };
  const routeStart = { x: raw.sourceRightBoundaryX, y: raw.sourceY };
  const routeEnd = { x: raw.targetLeftX, y: raw.targetY };
  const relevant = relevantDetourObstacles(raw, seedWaypoints, blockers, obstacles);
  if (relevant.length > MAX_DETOUR_OBSTACLES) return null;

  const xs = detourXs(raw, seedWaypoints, routeStart, routeEnd, relevant);
  const ys = detourYs(raw, routeStart, routeEnd, relevant);
  const searchPath = searchOrthogonalDetour(routeStart, routeEnd, xs, ys, raw, obstacles);
  if (searchPath === null) return null;

  // The detour search starts at the source block boundary. Keep the rendered
  // ownership anchor on the actual row text, but let the obstacle-avoiding
  // path begin only after it has left the source box.
  return collapseCollinear([visualStart, ...searchPath]);
}

function relevantDetourObstacles(
  raw: RouteRequest,
  seedWaypoints: readonly ArrowWaypoint[],
  blockers: readonly Obstacle[],
  obstacles: readonly Obstacle[],
): readonly Obstacle[] {
  const byId = new Map<string, Obstacle>();
  const remember = (obstacle: Obstacle): void => {
    byId.set(obstacle.fragmentId, obstacle);
  };

  for (const blocker of blockers) remember(blocker);

  const routeLeft = Math.min(...seedWaypoints.map((point) => point.x)) - DETOUR_GAP;
  const routeRight = Math.max(...seedWaypoints.map((point) => point.x)) + DETOUR_GAP;
  const blockerTop = Math.min(raw.sourceY, raw.targetY, ...blockers.map((obstacle) => obstacle.y));
  const blockerBottom = Math.max(
    raw.sourceY,
    raw.targetY,
    ...blockers.map((obstacle) => obstacle.y + obstacle.height),
  );
  const routeTop = blockerTop - DETOUR_GAP * 2;
  const routeBottom = blockerBottom + DETOUR_GAP * 2;

  for (const obstacle of obstacles) {
    if (isEndpointObstacle(raw, obstacle)) continue;
    const obstacleRight = obstacle.x + obstacle.width;
    const obstacleBottom = obstacle.y + obstacle.height;
    if (obstacle.x > routeRight || obstacleRight < routeLeft) continue;
    if (obstacle.y > routeBottom || obstacleBottom < routeTop) continue;
    remember(obstacle);
  }

  return [...byId.values()].sort(compareObstacles);
}

function compareObstacles(left: Obstacle, right: Obstacle): number {
  if (left.x !== right.x) return left.x - right.x;
  if (left.y !== right.y) return left.y - right.y;
  return left.fragmentId.localeCompare(right.fragmentId);
}

function detourXs(
  raw: RouteRequest,
  seedWaypoints: readonly ArrowWaypoint[],
  start: SearchPoint,
  end: SearchPoint,
  obstacles: readonly Obstacle[],
): readonly number[] {
  const minX = Math.min(start.x, end.x);
  const maxX = Math.max(start.x, end.x);
  const xs = new Set<number>([
    start.x,
    end.x,
    raw.sourceRightBoundaryX + SOURCE_STUB_MIN,
    raw.targetLeftX - TARGET_STUB_MIN,
    ...seedWaypoints.map((point) => point.x),
  ]);

  for (const obstacle of obstacles) {
    xs.add(obstacle.x - DETOUR_GAP);
    xs.add(obstacle.x + obstacle.width + DETOUR_GAP);
  }

  return [...xs].filter((x) => x >= minX && x <= maxX).sort((a, b) => a - b);
}

function detourYs(
  raw: RouteRequest,
  start: SearchPoint,
  end: SearchPoint,
  obstacles: readonly Obstacle[],
): readonly number[] {
  const ys = new Set<number>([start.y, end.y, raw.sourceY, raw.targetY]);

  for (const obstacle of obstacles) {
    ys.add(obstacle.y - DETOUR_GAP);
    ys.add(obstacle.y + obstacle.height + DETOUR_GAP);
  }

  return [...ys].sort((a, b) => a - b);
}

function searchOrthogonalDetour(
  start: SearchPoint,
  end: SearchPoint,
  xs: readonly number[],
  ys: readonly number[],
  raw: RouteRequest,
  obstacles: readonly Obstacle[],
): readonly SearchPoint[] | null {
  const startIndex = pointIndex(xs, ys, start);
  const endIndex = pointIndex(xs, ys, end);
  if (startIndex === null || endIndex === null) return null;

  const startState: DetourState = { pointIndex: startIndex, direction: 'none' };
  const heap = new MinHeap();
  const best = new Map<string, number>();
  const previous = new Map<string, string>();
  const states = new Map<string, DetourState>();
  const startKey = stateKey(startState);
  best.set(startKey, 0);
  states.set(startKey, startState);
  heap.push({ state: startState, cost: 0 });

  while (heap.size > 0) {
    const current = heap.pop();
    if (current === undefined) break;
    const currentKey = stateKey(current.state);
    if (current.cost !== best.get(currentKey)) continue;
    if (current.state.pointIndex === endIndex) {
      return reconstructSearchPath(currentKey, previous, states, xs, ys);
    }

    for (const next of detourNeighbors(current.state, xs, ys, raw, obstacles)) {
      const nextKey = stateKey(next.state);
      const nextCost = current.cost + next.cost;
      if (nextCost >= (best.get(nextKey) ?? Number.POSITIVE_INFINITY)) continue;
      best.set(nextKey, nextCost);
      previous.set(nextKey, currentKey);
      states.set(nextKey, next.state);
      heap.push({ state: next.state, cost: nextCost });
    }
  }

  return null;
}

function detourNeighbors(
  state: DetourState,
  xs: readonly number[],
  ys: readonly number[],
  raw: RouteRequest,
  obstacles: readonly Obstacle[],
): readonly { readonly state: DetourState; readonly cost: number }[] {
  const out: { readonly state: DetourState; readonly cost: number }[] = [];
  const point = pointAtIndex(state.pointIndex, xs, ys);
  if (point === null) return out;
  const xIndex = state.pointIndex % xs.length;
  const yIndex = Math.floor(state.pointIndex / xs.length);

  const add = (nextXIndex: number, nextYIndex: number, direction: SearchDirection): void => {
    const nextPoint = { x: xs[nextXIndex] ?? point.x, y: ys[nextYIndex] ?? point.y };
    if (sameSearchPoint(point, nextPoint)) return;
    if (!detourEndpointGapsValid(point, nextPoint, direction, raw, endPoint(raw))) return;
    if (!detourSegmentClear(point, nextPoint, raw, obstacles)) return;
    const turnCost =
      state.direction !== 'none' && state.direction !== direction ? DETOUR_TURN_COST : 0;
    out.push({
      state: {
        pointIndex: nextYIndex * xs.length + nextXIndex,
        direction,
      },
      cost: Math.abs(nextPoint.x - point.x) + Math.abs(nextPoint.y - point.y) + turnCost,
    });
  };

  if (xIndex + 1 < xs.length) add(xIndex + 1, yIndex, 'horizontal');
  if (yIndex > 0) add(xIndex, yIndex - 1, 'vertical');
  if (yIndex + 1 < ys.length) add(xIndex, yIndex + 1, 'vertical');

  return out;
}

function detourEndpointGapsValid(
  from: SearchPoint,
  to: SearchPoint,
  direction: SearchDirection,
  raw: RouteRequest,
  end: SearchPoint,
): boolean {
  const minVerticalX = raw.sourceRightBoundaryX + SOURCE_STUB_MIN;
  const maxVerticalX = raw.targetLeftX - TARGET_STUB_MIN;
  if (maxVerticalX < minVerticalX) return false;

  if (direction === 'vertical') {
    return from.x >= minVerticalX && from.x <= maxVerticalX;
  }

  if (to.x > maxVerticalX && !sameSearchPoint(to, end)) {
    return false;
  }

  if (sameSearchPoint(to, end)) {
    return from.y === raw.targetY && from.x <= maxVerticalX;
  }

  return true;
}

function endPoint(raw: RouteRequest): SearchPoint {
  return { x: raw.targetLeftX, y: raw.targetY };
}

function pointIndex(
  xs: readonly number[],
  ys: readonly number[],
  point: SearchPoint,
): number | null {
  const xIndex = xs.indexOf(point.x);
  const yIndex = ys.indexOf(point.y);
  if (xIndex < 0 || yIndex < 0) return null;
  return yIndex * xs.length + xIndex;
}

function pointAtIndex(
  index: number,
  xs: readonly number[],
  ys: readonly number[],
): SearchPoint | null {
  const x = xs[index % xs.length];
  const y = ys[Math.floor(index / xs.length)];
  if (x === undefined || y === undefined) return null;
  return { x, y };
}

function sameSearchPoint(left: SearchPoint, right: SearchPoint): boolean {
  return left.x === right.x && left.y === right.y;
}

function stateKey(state: DetourState): string {
  return `${state.pointIndex}:${state.direction}`;
}

function reconstructSearchPath(
  endKey: string,
  previous: ReadonlyMap<string, string>,
  states: ReadonlyMap<string, DetourState>,
  xs: readonly number[],
  ys: readonly number[],
): readonly SearchPoint[] | null {
  const reversed: SearchPoint[] = [];
  let cursor: string | undefined = endKey;
  while (cursor !== undefined) {
    const state = states.get(cursor);
    if (state === undefined) return null;
    const point = pointAtIndex(state.pointIndex, xs, ys);
    if (point === null) return null;
    reversed.push(point);
    cursor = previous.get(cursor);
  }
  return reversed.reverse();
}

function routeCrossingObstacles(
  waypoints: readonly ArrowWaypoint[],
  raw: RouteRequest,
  obstacles: readonly Obstacle[],
): readonly Obstacle[] {
  const out: Obstacle[] = [];
  for (const obstacle of obstacles) {
    if (isEndpointObstacle(raw, obstacle)) continue;
    if (routeIntersectsObstacle(waypoints, obstacle)) out.push(obstacle);
  }
  return out;
}

function routeIntersectsObstacle(waypoints: readonly ArrowWaypoint[], obstacle: Obstacle): boolean {
  for (let index = 1; index < waypoints.length; index += 1) {
    const from = waypoints[index - 1];
    const to = waypoints[index];
    if (from === undefined || to === undefined) continue;
    if (!detourSegmentClear(from, to, null, [obstacle])) return true;
  }
  return false;
}

function detourSegmentClear(
  from: SearchPoint,
  to: SearchPoint,
  raw: RouteRequest | null,
  obstacles: readonly Obstacle[],
): boolean {
  if (from.x !== to.x && from.y !== to.y) return false;
  for (const obstacle of obstacles) {
    if (raw !== null && isEndpointObstacle(raw, obstacle)) continue;
    if (segmentIntersectsObstacle(from, to, obstacle)) return false;
  }
  return true;
}

function segmentIntersectsObstacle(
  from: SearchPoint,
  to: SearchPoint,
  obstacle: Obstacle,
): boolean {
  const left = obstacle.x;
  const right = obstacle.x + obstacle.width;
  const top = obstacle.y;
  const bottom = obstacle.y + obstacle.height;

  if (from.x === to.x) {
    return (
      from.x >= left &&
      from.x < right &&
      rangeOverlap(Math.min(from.y, to.y), Math.max(from.y, to.y), top, bottom) > 0
    );
  }

  return (
    from.y >= top &&
    from.y < bottom &&
    rangeOverlap(Math.min(from.x, to.x), Math.max(from.x, to.x), left, right) > 0
  );
}

function isEndpointObstacle(raw: RouteRequest, obstacle: Obstacle): boolean {
  return obstacle.typeId === raw.fromTypeId || obstacle.typeId === raw.toTypeId;
}

function polylinesCross(left: readonly ArrowWaypoint[], right: readonly ArrowWaypoint[]): boolean {
  for (let i = 1; i < left.length; i += 1) {
    const lf = left[i - 1];
    const lt = left[i];
    if (lf === undefined || lt === undefined) continue;
    for (let j = 1; j < right.length; j += 1) {
      const rf = right[j - 1];
      const rt = right[j];
      if (rf === undefined || rt === undefined) continue;
      if (segmentsCross(lf, lt, rf, rt)) return true;
    }
  }
  return false;
}

function segmentsCross(
  af: ArrowWaypoint,
  at: ArrowWaypoint,
  bf: ArrowWaypoint,
  bt: ArrowWaypoint,
): boolean {
  const aHorizontal = af.y === at.y;
  const aVertical = af.x === at.x;
  const bHorizontal = bf.y === bt.y;
  const bVertical = bf.x === bt.x;
  if (aHorizontal && bVertical) return interiorCross(af, at, bf, bt);
  if (aVertical && bHorizontal) return interiorCross(bf, bt, af, at);
  return false;
}

function interiorCross(
  horizFrom: ArrowWaypoint,
  horizTo: ArrowWaypoint,
  vertFrom: ArrowWaypoint,
  vertTo: ArrowWaypoint,
): boolean {
  const hMinX = Math.min(horizFrom.x, horizTo.x);
  const hMaxX = Math.max(horizFrom.x, horizTo.x);
  const vMinY = Math.min(vertFrom.y, vertTo.y);
  const vMaxY = Math.max(vertFrom.y, vertTo.y);
  // Strict inequality: shared corners/endpoints are joins, not crossings.
  return vertFrom.x > hMinX && vertFrom.x < hMaxX && horizFrom.y > vMinY && horizFrom.y < vMaxY;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

function forwardRoute(raw: RouteRequest, laneX: number, blocked: boolean): Route {
  return {
    raw,
    waypoints: collapseCollinear([
      { x: raw.sourceRightX, y: raw.sourceY },
      { x: laneX, y: raw.sourceY },
      { x: laneX, y: raw.targetY },
      { x: raw.targetLeftX, y: raw.targetY },
    ]),
    blocked,
  };
}

function orthogonalFallbackRoute(raw: RouteRequest): Route {
  const sourceSide = fallbackSourceSide(raw);
  const visual = sourceSide === 'right' ? { x: raw.sourceRightX, y: raw.sourceY } : leftSource(raw);
  const source =
    sourceSide === 'right'
      ? { x: raw.sourceRightBoundaryX, y: raw.sourceY }
      : { x: raw.sourceLeftX, y: raw.sourceY };
  const target = { x: raw.targetLeftX, y: raw.targetY };
  const laneX = fallbackLaneX(raw, sourceSide);

  return {
    raw,
    waypoints: collapseCollinear([
      visual,
      source,
      { x: laneX, y: source.y },
      { x: laneX, y: target.y },
      target,
    ]),
    blocked: false,
  };
}

function fallbackSourceSide(raw: RouteRequest): 'left' | 'right' {
  const sourceCenter = (raw.sourceLeftX + raw.sourceRightBoundaryX) / 2;
  const targetCenter = (raw.targetLeftX + raw.targetRightX) / 2;
  return targetCenter >= sourceCenter ? 'right' : 'left';
}

function leftSource(raw: RouteRequest): ArrowWaypoint {
  return { x: raw.sourceRowLeftX, y: raw.sourceY };
}

function fallbackLaneX(raw: RouteRequest, sourceSide: 'left' | 'right'): number {
  if (sourceSide === 'right') {
    const legalMid = (raw.sourceRightBoundaryX + raw.targetLeftX) / 2;
    if (raw.sourceRightBoundaryX < raw.targetLeftX) return legalMid;
    return Math.max(raw.sourceRightBoundaryX, raw.targetRightX) + SOURCE_STUB_MIN;
  }

  return Math.min(raw.sourceLeftX, raw.targetLeftX) - TARGET_STUB_MIN;
}

function directDebug(
  routes: readonly Route[],
  obstacles: ObstacleMap,
  layoutLabels: NonNullable<LayoutDebug['routing']['layoutLabels']>,
  layoutGrid: NonNullable<LayoutDebug['routing']['layoutGrid']>,
): LayoutDebug {
  return {
    routing: {
      obstacles: obstacleRects(obstacles),
      lanes: debugLanes(routes),
      groups: [],
      layoutLabels,
      layoutGrid,
    },
  };
}

function collapseCollinear(points: readonly ArrowWaypoint[]): readonly ArrowWaypoint[] {
  const out: ArrowWaypoint[] = [];
  for (const point of points) {
    const previous = out[out.length - 1];
    if (previous !== undefined && previous.x === point.x && previous.y === point.y) continue;
    out.push(point);
    while (out.length >= 3) {
      const a = out[out.length - 3];
      const b = out[out.length - 2];
      const c = out[out.length - 1];
      if (a === undefined || b === undefined || c === undefined) break;
      if ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)) {
        out.splice(out.length - 2, 1);
      } else {
        break;
      }
    }
  }
  return out;
}

function debugLanes(routes: readonly Route[]): readonly ChannelDebugLane[] {
  const lanes: ChannelDebugLane[] = [];
  routes.forEach((route, routeIndex) => {
    for (let index = 1; index < route.waypoints.length; index += 1) {
      const from = route.waypoints[index - 1];
      const to = route.waypoints[index];
      if (from === undefined || to === undefined || from.x !== to.x || from.y === to.y) continue;
      lanes.push({
        x: from.x,
        yMin: Math.min(from.y, to.y),
        yMax: Math.max(from.y, to.y),
        fromTypeId: route.raw.fromTypeId,
        toTypeId: route.raw.toTypeId,
        bundleKey: `forward-lca:${route.raw.toTypeId}:${routeIndex}:${index}`,
        blocked: route.blocked,
      });
    }
  });
  return lanes;
}

class MinHeap {
  private readonly entries: HeapEntry[] = [];

  get size(): number {
    return this.entries.length;
  }

  push(entry: HeapEntry): void {
    this.entries.push(entry);
    this.siftUp(this.entries.length - 1);
  }

  pop(): HeapEntry | undefined {
    const first = this.entries[0];
    const last = this.entries.pop();
    if (first === undefined || last === undefined) return first;
    if (this.entries.length > 0) {
      this.entries[0] = last;
      this.siftDown(0);
    }
    return first;
  }

  private siftUp(index: number): void {
    let cursor = index;
    while (cursor > 0) {
      const parent = Math.floor((cursor - 1) / 2);
      if (!heapLess(this.entries[cursor], this.entries[parent])) break;
      this.swap(cursor, parent);
      cursor = parent;
    }
  }

  private siftDown(index: number): void {
    let cursor = index;
    while (true) {
      const left = cursor * 2 + 1;
      const right = left + 1;
      let best = cursor;
      if (heapLess(this.entries[left], this.entries[best])) best = left;
      if (heapLess(this.entries[right], this.entries[best])) best = right;
      if (best === cursor) break;
      this.swap(cursor, best);
      cursor = best;
    }
  }

  private swap(left: number, right: number): void {
    const a = this.entries[left];
    const b = this.entries[right];
    if (a === undefined || b === undefined) return;
    this.entries[left] = b;
    this.entries[right] = a;
  }
}

function heapLess(left: HeapEntry | undefined, right: HeapEntry | undefined): boolean {
  if (left === undefined) return false;
  if (right === undefined) return true;
  if (left.cost !== right.cost) return left.cost < right.cost;
  const leftKey = stateKey(left.state);
  const rightKey = stateKey(right.state);
  return leftKey < rightKey;
}
