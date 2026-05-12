// Routing field: complete orthogonal pathfinder for arrow routes between
// two points in the layout. Owns inflated obstacle envelopes, segment
// clearance checks, and the actual path search.
//
// Algorithm: A* on a Hanan grid. The grid's axis lines are the union of
// every clearance rect's left/right edges (x-coordinates) and top/bottom
// edges (y-coordinates), plus an outer perimeter buffer that wraps every
// obstacle so the search can always find SOME path around. Vertices are
// the implicit intersections of those lines; edges are the orthogonal
// connections between adjacent grid points whose connecting segment is
// clear of every obstacle. The graph is built **once per layout pass**
// (`buildRoutingField`) and queried per arrow (`routeMiddle`), so the
// expensive O(N²) edge-validity work is amortized across all routed
// arrows in the same draw.
//
// Soundness: for any two clear endpoints, A* will find a path so long as
// the grid includes the outer perimeter — the perimeter is reachable
// from every clear point, and the goal is reachable from the perimeter.
// `routeMiddle` therefore never silently returns `null` for a layout
// with finite obstacles; callers don't need a "degenerate fallback."
// (It returns `null` only for the degenerate case of a non-clear start
// or goal — i.e., a layout bug where one endpoint sits inside an
// obstacle — which the caller should surface, not silently hide.)
//
// Edge weights encode the same preference the old heuristic comparator
// used (length, then fewer turns, then right-leaning verticals), so the
// route aesthetics on cases the old algorithm already handled stay
// close to today's behaviour.

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
  /** Walk outward from `start` along the requested horizontal direction
   *  (`+1` = right, `-1` = left) until the point sits outside every
   *  obstacle's clearance rect. Used by routeAroundBlocks to push the
   *  canonical-side source/target anchors past any other obstacle that
   *  pins against the source's/target's edge, so the A* between them
   *  always operates on two clear endpoints. Walks by grid edges --
   *  each jump lands on a clearance-rect boundary -- so the adjusted
   *  point stays grid-aligned with the routing field. Returns the
   *  original point unchanged when it was already clear. */
  readonly findClearAnchor: (
    start: ArrowWaypoint,
    direction: 1 | -1,
  ) => ArrowWaypoint;
}

interface ClearanceRect {
  readonly typeId: string;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export const TARGET_ENTRY_GAP = LAYOUT_GRID_CELL_W + LAYOUT_GRID_CELL_W / 2;
export const BLOCK_LEFT_CLEARANCE_X = TARGET_ENTRY_GAP;
export const BLOCK_RIGHT_CLEARANCE_X = LAYOUT_GRID_CELL_W / 2;

const EPS = 1e-6;
const BLOCK_VERTICAL_CLEARANCE_Y = LAYOUT_GRID_CELL_H / 2;
// Outer perimeter offset — a buffer ring that wraps every obstacle so
// the search graph is always connected. Any pair of clear endpoints can
// reach each other by going around this perimeter; that's what makes
// `routeMiddle` complete.
const OUTER_ROUTE_GAP_X = LAYOUT_GRID_CELL_W;
const OUTER_ROUTE_GAP_Y = LAYOUT_GRID_CELL_H;

// Edge-weight knobs. Length dominates; turn cost is a small bias so
// equal-length routes prefer fewer corners; rightness bias is tinier
// still so among same-length-same-turn routes the search leans right.
// The relative magnitudes mirror the lexicographic comparator the old
// heuristic used: length > turns > rightness.
const TURN_PENALTY = LAYOUT_GRID_CELL_W * 0.05;
const RIGHTNESS_BIAS_PER_UNIT = 1e-6;

type Dir = 'none' | 'h' | 'v';

export function buildRoutingField(obstacles: readonly Obstacle[]): RoutingField {
  const clearanceRects = obstacles.map(clearanceRectForObstacle);
  // Shared per-layout grid axis lines. Computed once and reused across
  // every arrow routed in this layout pass.
  const globalXs = computeGlobalAxis(clearanceRects, 'x');
  const globalYs = computeGlobalAxis(clearanceRects, 'y');
  const rightnessAnchorX = globalXs.length === 0 ? 0 : (globalXs[globalXs.length - 1] ?? 0);
  // Per-axis-line obstacle pruning. For each x in globalXs, the rects
  // whose clearance strictly contains x are the only ones that can
  // block a vertical segment at that x; same for y and horizontals.
  // A* segment-clear checks then iterate ~k overlapping rects instead
  // of all N obstacles -- typically a 10-40x speedup on dense layouts.
  // Built once per layout pass and reused for every arrow.
  const blockerCache = buildBlockerCache(clearanceRects, globalXs, globalYs);

  return {
    routeMiddle: (start, goal) =>
      routeMiddle(start, goal, clearanceRects, globalXs, globalYs, rightnessAnchorX, blockerCache),
    segmentIsClear: (from, to, options) =>
      segmentIsClear(
        from,
        to,
        options?.ignoreTypeId === undefined
          ? clearanceRects
          : clearanceRects.filter((rect) => rect.typeId !== options.ignoreTypeId),
      ),
    findClearAnchor: (start, direction) =>
      findClearAnchor(start, direction, clearanceRects, blockerCache),
  };
}

function findClearAnchor(
  start: ArrowWaypoint,
  direction: 1 | -1,
  obstacles: readonly ClearanceRect[],
  blockerCache: BlockerCache,
): ArrowWaypoint {
  // Only rects whose y range strictly contains start.y can intersect
  // a point at (x, start.y). Pulling the candidate set from the
  // blocker cache trims the inner loop from N obstacles to k overlap
  // rects -- typically 0-3 for realistic layouts.
  const rects = blockersForHorizontal(start.y, obstacles, blockerCache);
  if (rects.length === 0) return start;

  let x = start.x;
  // Each iteration: find the first rect strictly containing x; if
  // none, x is clear -- return it. Otherwise jump x past that rect's
  // edge on the requested direction. blocker.right (or .left) sits ON
  // the edge, not strictly inside, so pointInsideRect (strict) reports
  // it clear of the just-jumped rect; another rect that begins at the
  // same edge is also boundary-clear by the same rule.
  //
  // Bounded by `2 * rects.length + 1`: a rect can block the walk at
  // most once before we jump past its edge, so the count is the
  // worst-case number of distinct rects in the y band, doubled for
  // safety against weird overlap chains.
  const maxIters = rects.length * 2 + 1;
  for (let i = 0; i < maxIters; i++) {
    let blocker: ClearanceRect | null = null;
    for (const r of rects) {
      if (r.left + EPS < x && x < r.right - EPS) {
        blocker = r;
        break;
      }
    }
    if (blocker === null) return { x, y: start.y };
    x = direction > 0 ? blocker.right : blocker.left;
  }
  // Pathological case: a chain of overlapping rects boxes the anchor
  // in. The perimeter buffer baked into globalXs guarantees this
  // shouldn't happen for real layouts, so surface loudly and return
  // the original; routeAroundBlocks's "non-clear endpoint" branch
  // will catch it and emit a visible degenerate L-path.
  console.error(
    `routing: findClearAnchor could not clear (${start.x}, ${start.y}) in direction ${direction}`,
  );
  return start;
}

interface BlockerCache {
  /** Rects whose clearance strictly contains the keyed x. These are the
   *  only rects that can block a vertical segment at that x. Keys are
   *  the x values from `globalXs`. */
  readonly verticalByX: ReadonlyMap<number, readonly ClearanceRect[]>;
  /** Rects whose clearance strictly contains the keyed y -- analogue
   *  for horizontal segments. */
  readonly horizontalByY: ReadonlyMap<number, readonly ClearanceRect[]>;
}

function buildBlockerCache(
  rects: readonly ClearanceRect[],
  globalXs: readonly number[],
  globalYs: readonly number[],
): BlockerCache {
  const verticalByX = new Map<number, ClearanceRect[]>();
  for (const x of globalXs) {
    const list: ClearanceRect[] = [];
    for (const r of rects) {
      if (r.left + EPS < x && x < r.right - EPS) list.push(r);
    }
    verticalByX.set(x, list);
  }
  const horizontalByY = new Map<number, ClearanceRect[]>();
  for (const y of globalYs) {
    const list: ClearanceRect[] = [];
    for (const r of rects) {
      if (r.top + EPS < y && y < r.bottom - EPS) list.push(r);
    }
    horizontalByY.set(y, list);
  }
  return { verticalByX, horizontalByY };
}

function blockersForHorizontal(
  y: number,
  rects: readonly ClearanceRect[],
  cache: BlockerCache,
): readonly ClearanceRect[] {
  const cached = cache.horizontalByY.get(y);
  if (cached !== undefined) return cached;
  // Per-arrow y values (start.y, goal.y) that don't sit on a global
  // axis line. Computed on the fly -- happens at most twice per arrow.
  const list: ClearanceRect[] = [];
  for (const r of rects) {
    if (r.top + EPS < y && y < r.bottom - EPS) list.push(r);
  }
  return list;
}

function blockersForVertical(
  x: number,
  rects: readonly ClearanceRect[],
  cache: BlockerCache,
): readonly ClearanceRect[] {
  const cached = cache.verticalByX.get(x);
  if (cached !== undefined) return cached;
  const list: ClearanceRect[] = [];
  for (const r of rects) {
    if (r.left + EPS < x && x < r.right - EPS) list.push(r);
  }
  return list;
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

function computeGlobalAxis(
  rects: readonly ClearanceRect[],
  axis: 'x' | 'y',
): readonly number[] {
  if (rects.length === 0) return [];
  const values: number[] = [];
  let outerMin = Number.POSITIVE_INFINITY;
  let outerMax = Number.NEGATIVE_INFINITY;
  for (const r of rects) {
    const lo = axis === 'x' ? r.left : r.top;
    const hi = axis === 'x' ? r.right : r.bottom;
    values.push(lo, hi);
    if (lo < outerMin) outerMin = lo;
    if (hi > outerMax) outerMax = hi;
  }
  const outerGap = axis === 'x' ? OUTER_ROUTE_GAP_X : OUTER_ROUTE_GAP_Y;
  values.push(outerMin - outerGap, outerMax + outerGap);
  return sortedUnique(values);
}

function sortedUnique(values: readonly number[]): readonly number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of sorted) {
    if (!Number.isFinite(v)) continue;
    const prev = out[out.length - 1];
    if (prev !== undefined && Math.abs(v - prev) < EPS) continue;
    out.push(v);
  }
  return out;
}

function routeMiddle(
  start: ArrowWaypoint,
  goal: ArrowWaypoint,
  obstacles: readonly ClearanceRect[],
  globalXs: readonly number[],
  globalYs: readonly number[],
  rightnessAnchorX: number,
  blockerCache: BlockerCache,
): readonly ArrowWaypoint[] | null {
  // Compose the per-arrow axis grids: shared global lines plus the four
  // endpoint coordinates. Adding endpoints to the grid lets A* terminate
  // exactly on (goal.x, goal.y) without needing a post-hoc snap.
  const xs = sortedUnique([...globalXs, start.x, goal.x]);
  const ys = sortedUnique([...globalYs, start.y, goal.y]);

  const startXi = indexOf(xs, start.x);
  const startYi = indexOf(ys, start.y);
  const goalXi = indexOf(xs, goal.x);
  const goalYi = indexOf(ys, goal.y);
  if (startXi < 0 || startYi < 0 || goalXi < 0 || goalYi < 0) return null;

  // Per-segment clearance check. Uses the per-axis-line blocker cache
  // to iterate only the few rects that can intersect a segment along
  // this axis, instead of all N obstacles.
  const clearForSearch = (from: ArrowWaypoint, to: ArrowWaypoint): boolean => {
    if (from.x === to.x && from.y === to.y) return true;
    if (from.x !== to.x && from.y !== to.y) return false;
    const candidates =
      from.y === to.y
        ? blockersForHorizontal(from.y, obstacles, blockerCache)
        : blockersForVertical(from.x, obstacles, blockerCache);
    for (const rect of candidates) {
      if (axisAlignedSegmentIntersectsRect(from, to, rect)) return false;
    }
    return true;
  };
  const pointClearForSearch = (p: ArrowWaypoint): boolean => {
    for (const rect of obstacles) {
      if (pointInsideRect(p, rect)) return false;
    }
    return true;
  };

  // Endpoint sanity. The new architecture only calls routeMiddle on
  // anchors already pushed outside every obstacle's clearance (see
  // findClearAnchor above), so a non-clear endpoint here is a
  // routing-field invariant bug; return null and let the caller
  // surface it loudly.
  if (!pointClearForSearch(start) || !pointClearForSearch(goal)) return null;

  // Trivial co-aligned case: direct segment if clear.
  if ((start.x === goal.x || start.y === goal.y) && clearForSearch(start, goal)) {
    return [start, goal];
  }

  // A* state: (xi, yi, dir). `dir` is the axis of the segment that
  // brought us into this node — included in the state because the turn
  // penalty depends on it, and a node reached from a different
  // incoming axis may yield a different best path onward.
  interface NodeState {
    readonly xi: number;
    readonly yi: number;
    readonly dir: Dir;
  }
  const stateKey = (s: NodeState): string => `${s.xi}|${s.yi}|${s.dir}`;
  const heuristic = (xi: number, yi: number): number =>
    Math.abs((xs[xi] ?? 0) - (xs[goalXi] ?? 0)) +
    Math.abs((ys[yi] ?? 0) - (ys[goalYi] ?? 0));

  const open = new MinHeap<NodeState>();
  const gScore = new Map<string, number>();
  const cameFrom = new Map<string, string>();

  const startState: NodeState = { xi: startXi, yi: startYi, dir: 'none' };
  open.push(heuristic(startXi, startYi), startState);
  gScore.set(stateKey(startState), 0);

  while (open.size > 0) {
    const current = open.pop();
    if (current === undefined) break;
    if (current.xi === goalXi && current.yi === goalYi) {
      return reconstructPath(current, stateKey, cameFrom, xs, ys);
    }
    const currentKey = stateKey(current);
    const currentG = gScore.get(currentKey);
    if (currentG === undefined) continue;

    const cx = xs[current.xi];
    const cy = ys[current.yi];
    if (cx === undefined || cy === undefined) continue;

    // Four cardinal successors. Each move steps to the next grid line
    // along the chosen axis, costing the segment length plus turn
    // penalty (if the axis changed) plus a small rightness bias on
    // vertical moves (preferring verticals further right).
    for (const move of cardinalMoves(current, xs.length, ys.length)) {
      const nx = xs[move.xi];
      const ny = ys[move.yi];
      if (nx === undefined || ny === undefined) continue;
      const from: ArrowWaypoint = { x: cx, y: cy };
      const to: ArrowWaypoint = { x: nx, y: ny };
      if (!clearForSearch(from, to)) continue;

      const segLen = Math.abs(nx - cx) + Math.abs(ny - cy);
      const turned = current.dir !== 'none' && current.dir !== move.dir;
      const rightness = move.dir === 'v' ? RIGHTNESS_BIAS_PER_UNIT * (rightnessAnchorX - cx) : 0;
      const tentativeG = currentG + segLen + (turned ? TURN_PENALTY : 0) + rightness;
      const nextState: NodeState = { xi: move.xi, yi: move.yi, dir: move.dir };
      const nextKey = stateKey(nextState);
      const prevG = gScore.get(nextKey);
      if (prevG !== undefined && prevG <= tentativeG + EPS) continue;
      gScore.set(nextKey, tentativeG);
      cameFrom.set(nextKey, currentKey);
      open.push(tentativeG + heuristic(move.xi, move.yi), nextState);
    }
  }

  return null;
}

function cardinalMoves(
  s: { readonly xi: number; readonly yi: number },
  xLen: number,
  yLen: number,
): { readonly xi: number; readonly yi: number; readonly dir: Dir }[] {
  const out: { xi: number; yi: number; dir: Dir }[] = [];
  if (s.xi + 1 < xLen) out.push({ xi: s.xi + 1, yi: s.yi, dir: 'h' });
  if (s.xi > 0) out.push({ xi: s.xi - 1, yi: s.yi, dir: 'h' });
  if (s.yi + 1 < yLen) out.push({ xi: s.xi, yi: s.yi + 1, dir: 'v' });
  if (s.yi > 0) out.push({ xi: s.xi, yi: s.yi - 1, dir: 'v' });
  return out;
}

function reconstructPath(
  goalState: { readonly xi: number; readonly yi: number; readonly dir: Dir },
  stateKey: (s: { readonly xi: number; readonly yi: number; readonly dir: Dir }) => string,
  cameFrom: ReadonlyMap<string, string>,
  xs: readonly number[],
  ys: readonly number[],
): readonly ArrowWaypoint[] {
  const points: ArrowWaypoint[] = [];
  let key: string | undefined = stateKey(goalState);
  let current: { xi: number; yi: number; dir: Dir } | undefined = goalState;
  // Walk predecessors back to start. Each cameFrom edge encodes a
  // single grid step, so the recovered polyline has one waypoint per
  // visited grid intersection. simplifyOrthogonalPath collapses the
  // colinear runs into the canonical L/Z/U shape afterward.
  while (current !== undefined) {
    const cx = xs[current.xi];
    const cy = ys[current.yi];
    if (cx !== undefined && cy !== undefined) points.push({ x: cx, y: cy });
    const prevKey: string | undefined = key === undefined ? undefined : cameFrom.get(key);
    if (prevKey === undefined) break;
    current = parseStateKey(prevKey);
    key = prevKey;
  }
  points.reverse();
  return simplifyOrthogonalPath(compactDuplicateWaypoints(points));
}

function parseStateKey(key: string): { xi: number; yi: number; dir: Dir } | undefined {
  const parts = key.split('|');
  if (parts.length !== 3) return undefined;
  const xi = Number.parseInt(parts[0] ?? '', 10);
  const yi = Number.parseInt(parts[1] ?? '', 10);
  const dir = parts[2] as Dir;
  if (Number.isNaN(xi) || Number.isNaN(yi)) return undefined;
  return { xi, yi, dir };
}

function indexOf(arr: readonly number[], value: number): number {
  // Binary search with EPS tolerance — arr is sorted-unique by the
  // same EPS, so any element within EPS of `value` is the match.
  let lo = 0;
  let hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = arr[mid];
    if (v === undefined) return -1;
    if (Math.abs(v - value) < EPS) return mid;
    if (v < value) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

class MinHeap<T> {
  private readonly items: { priority: number; value: T }[] = [];

  get size(): number {
    return this.items.length;
  }

  push(priority: number, value: T): void {
    this.items.push({ priority, value });
    this.siftUp(this.items.length - 1);
  }

  pop(): T | undefined {
    if (this.items.length === 0) return undefined;
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0 && last !== undefined) {
      this.items[0] = last;
      this.siftDown(0);
    }
    return top?.value;
  }

  private siftUp(idx: number): void {
    let i = idx;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const current = this.items[i];
      const parentItem = this.items[parent];
      if (current === undefined || parentItem === undefined) break;
      if (current.priority >= parentItem.priority) break;
      this.items[i] = parentItem;
      this.items[parent] = current;
      i = parent;
    }
  }

  private siftDown(idx: number): void {
    let i = idx;
    const len = this.items.length;
    while (true) {
      const left = i * 2 + 1;
      const right = left + 1;
      let smallest = i;
      const at = (k: number): number | undefined => this.items[k]?.priority;
      const cur = at(smallest);
      const lp = at(left);
      const rp = at(right);
      if (cur === undefined) break;
      if (left < len && lp !== undefined && lp < cur) smallest = left;
      const cur2 = at(smallest);
      if (right < len && rp !== undefined && cur2 !== undefined && rp < cur2) smallest = right;
      if (smallest === i) break;
      const a = this.items[i];
      const b = this.items[smallest];
      if (a === undefined || b === undefined) break;
      this.items[i] = b;
      this.items[smallest] = a;
      i = smallest;
    }
  }
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
