// Pure hit-testing for arrows: given a click point in data-space, find
// which arrows are within tolerance and classify each candidate as a
// "head" click (near the arrowhead — navigates back to source) or a
// "body" click (anywhere else along the polyline — navigates to target).
// Lives in analysis/ so it can be unit-tested without DOM.

import type { Arrow, ArrowWaypoint } from './layout_model.ts';

export type ArrowHitZone = 'head' | 'body';

export interface ArrowHit {
  readonly arrow: Arrow;
  readonly zone: ArrowHitZone;
  /** Distance (in data-space units) from the click to the polyline.
   *  Used by callers to rank candidates when several are tied. */
  readonly distance: number;
}

export interface ArrowHitOptions {
  /** Maximum click-to-polyline distance considered a hit. Data-space
   *  units — caller should pass `pixelTol / zoomScale` so the on-screen
   *  hit area stays roughly constant regardless of zoom level. */
  readonly hitTolerance: number;
  /** Click within this radius of the FINAL waypoint counts as a "head"
   *  click. Data-space units; same scaling rule as `hitTolerance`. */
  readonly headRadius: number;
}

/**
 * Hit-test all arrows against a click point. Returns every arrow whose
 * polyline comes within `hitTolerance` of the point, sorted by distance
 * (closest first). For each candidate, we tag it as 'head' if the click
 * is near the arrow's final waypoint (i.e. the user clicked the
 * arrowhead) or 'body' otherwise.
 *
 * Keeping this as a pure transform — no DOM, no zoom-state — lets the
 * caller do the screen-to-data-space mapping once and have a fully
 * testable hit-classification step.
 */
export function pickArrowsAtPoint(
  point: { readonly x: number; readonly y: number },
  arrows: readonly Arrow[],
  options: ArrowHitOptions,
): ArrowHit[] {
  const hits: ArrowHit[] = [];
  for (const a of arrows) {
    const w = a.waypoints;
    if (w.length < 2) continue;
    const dist = distanceToPolyline(point, w);
    if (dist > options.hitTolerance) continue;
    const last = w[w.length - 1] as ArrowWaypoint;
    const dHead = Math.hypot(point.x - last.x, point.y - last.y);
    const zone: ArrowHitZone = dHead <= options.headRadius ? 'head' : 'body';
    hits.push({ arrow: a, zone, distance: dist });
  }
  hits.sort((a, b) => a.distance - b.distance);
  return hits;
}

/** Min distance from `p` to any segment of the polyline. */
export function distanceToPolyline(
  p: { readonly x: number; readonly y: number },
  waypoints: readonly ArrowWaypoint[],
): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < waypoints.length; i++) {
    const a = waypoints[i - 1] as ArrowWaypoint;
    const b = waypoints[i] as ArrowWaypoint;
    const d = distanceToSegment(p, a, b);
    if (d < best) best = d;
  }
  return best;
}

/** Distance from point to a finite line segment (a→b). Handles the
 *  zero-length-segment case by treating it as a single point. */
export function distanceToSegment(
  p: { readonly x: number; readonly y: number },
  a: ArrowWaypoint,
  b: ArrowWaypoint,
): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const cx = a.x + vx * t;
  const cy = a.y + vy * t;
  return Math.hypot(p.x - cx, p.y - cy);
}
