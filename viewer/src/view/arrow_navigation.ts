import { INCOMING_CALL_MARKER_OFFSET } from '../analysis/layout_metrics.ts';
import type { Arrow, FieldRow, Layout, TypeBox } from '../analysis/layout_model.ts';
import type { LayoutPoint } from './layout_lookup.ts';

export type ArrowEndpoint = 'source' | 'target';

const CALL_TARGET_LABEL_GAP = 4;

/**
 * Resolve an arrow endpoint to a data-space point in the CURRENT layout.
 *
 * This must be called against a freshly built layout — never against the
 * stale waypoints stored on `arrow`. Popup navigation expands the target
 * (or source) row's module/type/bucket first and rebuilds the layout, so
 * the visible position of the endpoint changes; routing those clicks
 * through this function instead of the arrow's frozen waypoints is what
 * lets the chosen endpoint actually land where the user expects.
 *
 * The point returned matches where the arrow visually starts or ends:
 *   - source: the caller row's right edge (`arrowSourceX`)
 *   - target (row arrow): just left of the callee row's label, accounting
 *     for an incoming-call marker if present (matches `callTargetEndX`
 *     in routing)
 *   - target (type-level arrow): the target type's vertical mid-height
 *     at its left edge
 *
 * Returns null when the endpoint cannot be located in the current layout
 * (e.g. its containing type/module is still collapsed after expansion —
 * shouldn't happen if the caller expanded the right ids first).
 */
export function arrowEndpointLayoutPoint(
  layout: Layout | null,
  arrow: Arrow,
  endpoint: ArrowEndpoint,
): LayoutPoint | null {
  if (layout === null) return null;
  return endpoint === 'source'
    ? sourceEndpointPoint(layout, arrow)
    : targetEndpointPoint(layout, arrow);
}

function sourceEndpointPoint(layout: Layout, arrow: Arrow): LayoutPoint | null {
  const sourceType = layout.types.find((type) => type.id === arrow.fromTypeId);
  if (sourceType === undefined) return null;
  if (arrow.fromFieldName !== '') {
    const sourceRow = sourceType.fields.find(
      (row) => row.kind === arrow.fromRowKind && row.name === arrow.fromFieldName,
    );
    if (sourceRow !== undefined) return { x: sourceRow.arrowSourceX, y: sourceRow.y };
  }
  return { x: sourceType.x + sourceType.width / 2, y: sourceType.y + sourceType.height / 2 };
}

function targetEndpointPoint(layout: Layout, arrow: Arrow): LayoutPoint | null {
  const targetType = layout.types.find((type) => type.id === arrow.toTypeId);
  if (targetType === undefined) return null;
  if (arrow.toFieldName !== undefined && arrow.toRowKind !== undefined) {
    const targetRow = targetType.fields.find(
      (row) => row.kind === arrow.toRowKind && row.name === arrow.toFieldName,
    );
    if (targetRow !== undefined) return callTargetEntryPoint(targetRow);
  }
  return typeLeftEdgePoint(targetType);
}

function callTargetEntryPoint(row: FieldRow): LayoutPoint {
  // Match routing.callTargetEndX so the click anchor matches the visible
  // arrowhead position rather than the row label's text-start.
  const markerOffset = row.hasIncomingCalls ? INCOMING_CALL_MARKER_OFFSET : 0;
  return { x: row.x - markerOffset - CALL_TARGET_LABEL_GAP, y: row.y };
}

function typeLeftEdgePoint(type: TypeBox): LayoutPoint {
  return { x: type.x, y: type.y + type.height / 2 };
}
