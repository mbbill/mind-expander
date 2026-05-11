// Pure hit-testing for arrows: given a click point in data-space, find
// which arrows are within tolerance and classify each candidate by the
// part of the polyline the click landed on. Lives in analysis/ so it can
// be unit-tested without DOM.
//
// Zones are direction-aware affordances:
//   - 'source' = first `endpointRadius` of arc length, near the arrow's
//                origin. Direct click here navigates forward (to target).
//   - 'target' = last `endpointRadius` of arc length, near the arrowhead.
//                Direct click here navigates backward (to source).
//   - 'middle' = everything else. Direct click here opens the disambig
//                popup so the user picks a direction.
//
// Arc length (not Euclidean distance) is used so a click "near the source"
// on a long L-shaped route still feels close to the origin even if the
// click is far from the origin in straight-line distance.

import type { Arrow, ArrowWaypoint } from './layout_model.ts';

export type ArrowHitZone = 'source' | 'target' | 'middle';

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
  /** Arc length (in data-space units) measured from each polyline endpoint
   *  that counts as the source / target zone. Same scaling rule as
   *  `hitTolerance`. On short polylines (<= 2*endpointRadius) each zone is
   *  clamped to half the polyline length so source and target never overlap. */
  readonly endpointRadius: number;
}

export function pickArrowsAtPoint(
  point: { readonly x: number; readonly y: number },
  arrows: readonly Arrow[],
  options: ArrowHitOptions,
): ArrowHit[] {
  const hits: ArrowHit[] = [];
  for (const a of arrows) {
    const w = a.waypoints;
    if (w.length < 2) continue;
    const projection = projectOntoPolyline(point, w);
    if (projection.distance > options.hitTolerance) continue;
    hits.push({
      arrow: a,
      zone: zoneForProjection(projection.arcLength, polylineLength(w), options.endpointRadius),
      distance: projection.distance,
    });
  }
  hits.sort((a, b) => a.distance - b.distance);
  return hits;
}

function zoneForProjection(
  arcLength: number,
  totalLength: number,
  endpointRadius: number,
): ArrowHitZone {
  // Source and target each own at most half the polyline so the two zones
  // cannot overlap on a short arrow; ties at the midpoint resolve to source.
  const radius = Math.min(endpointRadius, totalLength / 2);
  if (arcLength <= radius) return 'source';
  if (totalLength - arcLength <= radius) return 'target';
  return 'middle';
}

interface PolylineProjection {
  readonly distance: number;
  /** Arc length from the polyline start to the closest point on the polyline. */
  readonly arcLength: number;
}

function projectOntoPolyline(
  p: { readonly x: number; readonly y: number },
  waypoints: readonly ArrowWaypoint[],
): PolylineProjection {
  let best: PolylineProjection = { distance: Number.POSITIVE_INFINITY, arcLength: 0 };
  let acc = 0;
  for (let i = 1; i < waypoints.length; i++) {
    const a = waypoints[i - 1] as ArrowWaypoint;
    const b = waypoints[i] as ArrowWaypoint;
    const seg = projectOntoSegment(p, a, b);
    if (seg.distance < best.distance) {
      best = { distance: seg.distance, arcLength: acc + seg.alongSegment };
    }
    acc += segmentLength(a, b);
  }
  return best;
}

function polylineLength(waypoints: readonly ArrowWaypoint[]): number {
  let total = 0;
  for (let i = 1; i < waypoints.length; i++) {
    total += segmentLength(waypoints[i - 1] as ArrowWaypoint, waypoints[i] as ArrowWaypoint);
  }
  return total;
}

function segmentLength(a: ArrowWaypoint, b: ArrowWaypoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Min distance from `p` to any segment of the polyline. */
export function distanceToPolyline(
  p: { readonly x: number; readonly y: number },
  waypoints: readonly ArrowWaypoint[],
): number {
  return projectOntoPolyline(p, waypoints).distance;
}

/** Distance from point to a finite line segment (a→b). Handles the
 *  zero-length-segment case by treating it as a single point. */
export function distanceToSegment(
  p: { readonly x: number; readonly y: number },
  a: ArrowWaypoint,
  b: ArrowWaypoint,
): number {
  return projectOntoSegment(p, a, b).distance;
}

interface SegmentProjection {
  readonly distance: number;
  /** Arc length from `a` to the projected point on the segment. */
  readonly alongSegment: number;
}

function projectOntoSegment(
  p: { readonly x: number; readonly y: number },
  a: ArrowWaypoint,
  b: ArrowWaypoint,
): SegmentProjection {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  if (len2 === 0) return { distance: Math.hypot(p.x - a.x, p.y - a.y), alongSegment: 0 };
  let t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const cx = a.x + vx * t;
  const cy = a.y + vy * t;
  return {
    distance: Math.hypot(p.x - cx, p.y - cy),
    alongSegment: t * Math.sqrt(len2),
  };
}
