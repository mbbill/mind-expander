import { type Arrow, type Layout, isSameArrowEdge } from '../analysis/layout_model.ts';
import type { LayoutPoint } from './layout_lookup.ts';

export type ArrowEndpoint = 'source' | 'target';

/**
 * Resolve an arrow endpoint to a data-space point in the CURRENT layout.
 *
 * Implementation strategy: locate the freshly routed copy of `arrow` in
 * `layout.arrows` (same edge identity, possibly different waypoints because
 * the post-expansion redraw re-routed it) and return its first or last
 * waypoint. The producer (routing.ts) is the single source of truth for
 * where an arrow physically starts/ends — re-deriving the formula here
 * caused the two sides to drift apart in the past (different handling of
 * obstacle bounds, type vertical centring, incoming-call marker offsets).
 *
 * Returns null when the arrow is not present in the new layout. That
 * happens if expansion failed to make the endpoint visible, or if a
 * visibility flag dropped the arrow. The caller treats null as "skip pan".
 */
export function arrowEndpointLayoutPoint(
  layout: Layout | null,
  arrow: Arrow,
  endpoint: ArrowEndpoint,
): LayoutPoint | null {
  if (layout === null) return null;
  const fresh = layout.arrows.find((candidate) => isSameArrowEdge(candidate, arrow));
  if (fresh === undefined || fresh.waypoints.length < 2) return null;
  const point =
    endpoint === 'source' ? fresh.waypoints[0] : fresh.waypoints[fresh.waypoints.length - 1];
  return point === undefined ? null : { x: point.x, y: point.y };
}
