// Obstacle-avoiding arrow routing. This module owns semantic endpoint
// selection and source/target stubs. The reusable middle-route field lives in
// routing_field.ts so clearance and route-shape policy stay in one place.
// It intentionally does not allocate lanes, avoid overlaps, or avoid crossings:
// multiple arrows may share the same segment.

import type { DriftClass } from '../analysis/drift.ts';
import { INCOMING_CALL_MARKER_OFFSET } from '../analysis/layout_metrics.ts';
import type {
  Arrow,
  ArrowLayer,
  ArrowLocality,
  ArrowWaypoint,
  ChannelObstacle,
  LayoutDebug,
  LayoutInputs,
} from '../analysis/layout_model.ts';
import { callArrowKey } from '../analysis/layout_model.ts';
import type { Geometry } from './geometry.ts';
import type { ObstacleMap } from './obstacles.ts';
import {
  BLOCK_LEFT_CLEARANCE_X,
  BLOCK_RIGHT_CLEARANCE_X,
  type RoutingField,
  TARGET_ENTRY_GAP,
  buildRoutingField,
} from './routing_field.ts';
import type { Obstacle } from './types.ts';

interface TypeBounds {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

interface RouteRequest {
  readonly fromTypeId: string;
  readonly fromFieldName: string;
  readonly fromRowKind: 'field' | 'method' | 'function';
  readonly toTypeId: string;
  readonly toFieldName?: string;
  readonly toRowKind?: 'method' | 'function';
  readonly kind: 'ownership' | 'reexport' | 'call';
  readonly driftClass: DriftClass;
  readonly locality?: ArrowLocality;
  readonly sourceSide: SourceSide;
  readonly sourceBounds: TypeBounds;
  readonly targetBounds: TypeBounds;
  readonly start: ArrowWaypoint;
  readonly end: ArrowWaypoint;
}

interface RouteExit {
  readonly point: ArrowWaypoint;
}

type SourceSide = 'left' | 'right';

const CALL_TARGET_LABEL_GAP = 4;

export interface RoutingResult {
  readonly arrows: readonly Arrow[];
  readonly arrowLayers: readonly ArrowLayer[];
  readonly debug: LayoutDebug;
}

export function routeArrows(
  geometry: Geometry,
  obstacles: ObstacleMap,
  inputs: LayoutInputs,
  _measure: (s: string) => number,
): RoutingResult {
  const boundsByType = buildTypeBounds(geometry, obstacles);
  const requests = collectRouteRequests(geometry, inputs, boundsByType);
  const field = buildRoutingField(obstacles.all);

  const arrows = requests.map((request) => emitRoutedArrow(request, field));
  return {
    arrows,
    arrowLayers: buildArrowLayers(arrows),
    debug: routingDebug(obstacles, geometry.debugLabels ?? [], geometry.debugGrid),
  };
}

function collectRouteRequests(
  geometry: Geometry,
  inputs: LayoutInputs,
  boundsByType: ReadonlyMap<string, TypeBounds>,
): RouteRequest[] {
  const out: RouteRequest[] = [];
  const drift = inputs.drift;

  for (const source of geometry.types) {
    const sourceBounds = boundsByType.get(source.node.id);
    if (sourceBounds === undefined) continue;

    if (source.expanded) {
      for (const row of source.visibleRows) {
        if (row.kind === 'method_bucket') continue;

        for (const targetId of row.targets) {
          const target = geometry.typesById.get(targetId);
          const targetBounds = boundsByType.get(targetId);
          if (target === undefined || targetBounds === undefined) continue;
          if (target.depth < 0) continue;
          const end = { x: targetBounds.left, y: target.y };
          // The row's leftPortX accounts for any visual ornaments to the
          // left of the row text (drift dots in particular) so an outgoing
          // arrow that exits left clears the ornament instead of slicing
          // through it. For ordinary rows this equals row.x.
          const sourcePort = sourceRowPort(row.leftPortX, row.y, row.arrowSourceX, end.x);

          out.push({
            fromTypeId: source.node.id,
            fromFieldName: row.name,
            fromRowKind:
              row.kind === 'method' ? 'method' : row.kind === 'function' ? 'function' : 'field',
            toTypeId: targetId,
            kind: 'ownership',
            driftClass: drift.typeClass.get(targetId) ?? 'at_lca',
            sourceSide: sourcePort.side,
            sourceBounds,
            targetBounds,
            start: sourcePort.start,
            end,
          });
        }

        const shouldRouteOutgoingCallTargets =
          (row.kind === 'method' || row.kind === 'function') &&
          inputs.callArrowsShown !== undefined &&
          inputs.callArrowsShown.has(callArrowKey(source.node.id, row.name, row.kind));

        for (const targetRef of row.callTargets ?? []) {
          const shouldRouteIncomingCallTarget =
            inputs.incomingCallTargetsShown?.has(targetRef.functionFullPath) ?? false;
          if (!shouldRouteOutgoingCallTargets && !shouldRouteIncomingCallTarget) continue;

          const target = geometry.typesById.get(targetRef.typeId);
          const targetBounds = boundsByType.get(targetRef.typeId);
          if (target === undefined || targetBounds === undefined) continue;
          const targetRow = target.visibleRows.find(
            (candidate) =>
              candidate.kind === targetRef.rowKind && candidate.name === targetRef.rowName,
          );
          if (targetRow === undefined) continue;
          const end = { x: callTargetEndX(targetRow), y: targetRow.y };
          // Fn/method rows have directional ports: right edge is the outgoing
          // port (this row calls another), left edge is the incoming port
          // (someone calls this row). Call arrows are always caller→callee,
          // so the source side is always the caller's right edge — never the
          // left edge that would cut back through the label text.
          const sourcePort = callOutgoingSourcePort(row.arrowSourceX, row.y);

          out.push({
            fromTypeId: source.node.id,
            fromFieldName: row.name,
            fromRowKind: row.kind === 'method' ? 'method' : 'function',
            toTypeId: targetRef.typeId,
            toFieldName: targetRef.rowName,
            toRowKind: targetRef.rowKind,
            kind: 'call',
            driftClass: 'at_lca',
            // The renderer reads `locality` to colour same-module calls grey
            // (background) and cross-module calls blue (attention). Locality
            // is derived from the source row's own callRefs so it cannot
            // disagree with the row-name colour decided upstream.
            locality: callLocality(row.callRefs, targetRef.functionFullPath),
            sourceSide: sourcePort.side,
            sourceBounds,
            targetBounds,
            start: sourcePort.start,
            end,
          });
        }
      }
    }

    if (source.node.isGhost === true && source.node.ghostTarget !== undefined) {
      if (inputs.ghostArrowsShown !== undefined && !inputs.ghostArrowsShown.has(source.node.id)) {
        continue;
      }
      const target = geometry.typesById.get(source.node.ghostTarget);
      const targetBounds = boundsByType.get(source.node.ghostTarget);
      if (target === undefined || targetBounds === undefined || target.node.isGhost === true) {
        continue;
      }
      const sourceSide = target.x < source.x ? 'left' : 'right';
      out.push({
        fromTypeId: source.node.id,
        fromFieldName: '',
        fromRowKind: 'field',
        toTypeId: target.node.id,
        kind: 'reexport',
        driftClass: 'at_lca',
        sourceSide,
        sourceBounds,
        targetBounds,
        start: { x: sourceSide === 'left' ? sourceBounds.left : sourceBounds.right, y: source.y },
        end: { x: targetBounds.left, y: target.y },
      });
    }
  }

  return out;
}

function buildArrowLayers(arrows: readonly Arrow[]): readonly ArrowLayer[] {
  const ownership = arrows.filter((arrow) => arrow.kind === 'ownership');
  const reexport = arrows.filter((arrow) => arrow.kind === 'reexport');
  const call = arrows.filter((arrow) => arrow.kind === 'call');
  return [
    { id: 'ownership', arrows: ownership, hitTestable: true },
    { id: 'reexport', arrows: reexport, hitTestable: true },
    { id: 'call', arrows: call, hitTestable: true },
  ];
}

function emitRoutedArrow(request: RouteRequest, field: RoutingField): Arrow {
  // Cross-crate test compares the leading `::`-separated segment of each
  // endpoint's id. Workspace ids are crate-qualified by construction
  // (extractor emits crate-prefixed paths), so a head mismatch is exactly
  // "source and target live in different crates".
  const fromCrate = request.fromTypeId.split('::', 1)[0] ?? '';
  const toCrate = request.toTypeId.split('::', 1)[0] ?? '';
  const isCrossCrate = fromCrate !== toCrate;
  const arrow: Arrow = {
    waypoints: routeAroundBlocks(request, field),
    fromTypeId: request.fromTypeId,
    fromFieldName: request.fromFieldName,
    fromRowKind: request.fromRowKind,
    toTypeId: request.toTypeId,
    kind: request.kind,
    driftClass: request.driftClass,
    ...(request.locality !== undefined ? { locality: request.locality } : {}),
    ...(isCrossCrate ? { isCrossCrate: true } : {}),
  };
  if (request.toFieldName !== undefined && request.toRowKind !== undefined) {
    return { ...arrow, toFieldName: request.toFieldName, toRowKind: request.toRowKind };
  }
  return arrow;
}

function callLocality(
  callRefs: ReadonlyArray<{ readonly callee: string; readonly locality: string }>,
  calleeFullPath: string,
): ArrowLocality {
  // FunctionCallRef carries the upstream locality verdict; reuse it instead
  // of recomputing module-path comparisons here, so the colour stays in
  // lockstep with the row-name colour the analysis layer already drives.
  const ref = callRefs.find((candidate) => candidate.callee === calleeFullPath);
  return ref?.locality === 'same_module' ? 'local' : 'external';
}

function routeAroundBlocks(request: RouteRequest, field: RoutingField): readonly ArrowWaypoint[] {
  const targetEntry = {
    x: request.targetBounds.left - TARGET_ENTRY_GAP,
    y: request.end.y,
  };
  const finalStubClear = field.segmentIsClear(targetEntry, request.end, {
    ignoreTypeId: request.toTypeId,
  });
  if (!finalStubClear) return unroutedHiddenRoute(request);

  const exit = sourceExitForTarget(request);
  if (!field.segmentIsClear(request.start, exit.point, { ignoreTypeId: request.fromTypeId })) {
    return unroutedHiddenRoute(request);
  }

  const middle = field.routeMiddle(exit.point, targetEntry);
  if (middle === null) return unroutedHiddenRoute(request);

  return compactDuplicateWaypoints([request.start, ...middle, request.end]);
}

function callOutgoingSourcePort(
  rightAnchorX: number,
  y: number,
): { readonly side: SourceSide; readonly start: ArrowWaypoint } {
  return { side: 'right', start: { x: rightAnchorX, y } };
}

function sourceRowPort(
  leftAnchorX: number,
  y: number,
  rightAnchorX: number,
  targetEndpointX: number,
): { readonly side: SourceSide; readonly start: ArrowWaypoint } {
  // Source-side selection is a row-port decision, not a type-origin decision.
  // Long function names can protrude far enough that a target type whose origin
  // is "to the right" still has its actual endpoint left of the source label.
  // Compare the target against the source label interval so the first visible
  // stub always exits away from the text.
  const side = sourceSideForEndpoint(leftAnchorX, rightAnchorX, targetEndpointX);
  return { side, start: { x: side === 'left' ? leftAnchorX : rightAnchorX, y } };
}

function sourceSideForEndpoint(
  leftAnchorX: number,
  rightAnchorX: number,
  targetEndpointX: number,
): SourceSide {
  if (targetEndpointX <= leftAnchorX) return 'left';
  if (targetEndpointX >= rightAnchorX) return 'right';
  return targetEndpointX - leftAnchorX <= rightAnchorX - targetEndpointX ? 'left' : 'right';
}

function callTargetEndX(row: { readonly x: number; readonly hasIncomingCalls: boolean }): number {
  return row.x - (row.hasIncomingCalls ? INCOMING_CALL_MARKER_OFFSET : 0) - CALL_TARGET_LABEL_GAP;
}

function unroutedHiddenRoute(request: RouteRequest): readonly ArrowWaypoint[] {
  // A visible route must be a checked orthogonal path. If no checked path is
  // available, keep the arrow degenerate instead of leaking a diagonal fallback
  // through blocks.
  return [request.start];
}

function sourceExitForTarget(request: RouteRequest): RouteExit {
  const left = {
    point: {
      x: Math.min(request.sourceBounds.left, request.start.x) - BLOCK_LEFT_CLEARANCE_X,
      y: request.start.y,
    },
  };
  const right = {
    point: {
      x: Math.max(request.sourceBounds.right, request.start.x) + BLOCK_RIGHT_CLEARANCE_X,
      y: request.start.y,
    },
  };

  // The exit is deliberately monotonic away from the source row anchor. This
  // keeps the visible source stub outside the row label even if block fragments
  // lag behind a long callable label or split-row protrusion.
  return request.sourceSide === 'left' ? left : right;
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
    byType.set(type.node.id, {
      left: type.x,
      right: type.x + type.width,
      top: type.y,
      bottom: type.y,
    });
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
  const top = Math.min(...fragments.map((fragment) => fragment.y));
  const bottom = Math.max(...fragments.map((fragment) => fragment.y + fragment.height));
  byType.set(typeId, {
    left: existing === undefined ? left : Math.min(existing.left, left),
    right: existing === undefined ? right : Math.max(existing.right, right),
    top: existing === undefined ? top : Math.min(existing.top, top),
    bottom: existing === undefined ? bottom : Math.max(existing.bottom, bottom),
  });
}

function routingDebug(
  obstacles: ObstacleMap,
  layoutLabels: NonNullable<LayoutDebug['routing']['layoutLabels']>,
  layoutGrid: NonNullable<LayoutDebug['routing']['layoutGrid']>,
): LayoutDebug {
  return {
    routing: {
      obstacles: obstacleRects(obstacles),
      layoutLabels,
      layoutGrid,
    },
  };
}

function obstacleRects(map: ObstacleMap): readonly ChannelObstacle[] {
  return map.all.map((obstacle) => ({
    left: obstacle.x,
    right: obstacle.x + obstacle.width,
    top: obstacle.y,
    bottom: obstacle.y + obstacle.height,
  }));
}
