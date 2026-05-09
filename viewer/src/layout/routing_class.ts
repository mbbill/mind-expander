import type { DriftClass } from '../analysis/drift.ts';

export type RouteClass = 'lca-forward' | 'lca-backward' | 'other';

// Route class is a layout concern: it chooses path geometry/lane policy.
// Drift class remains the semantic signal used for arrow/member color.
export function classifyOwnershipRouteByDepth(
  sourceDepth: number,
  targetDepth: number,
  driftClass: DriftClass,
): RouteClass {
  if (driftClass !== 'at_lca' && driftClass !== 'within_budget') {
    return 'other';
  }
  return targetDepth > sourceDepth ? 'lca-forward' : 'lca-backward';
}
