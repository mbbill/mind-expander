// Obstacle-avoiding arrow routing. This module owns semantic endpoint
// selection and source/target stubs. The reusable middle-route field lives in
// routing_field.ts so clearance and route-shape policy stay in one place.
// It intentionally does not allocate lanes, avoid overlaps, or avoid crossings:
// multiple arrows may share the same segment.

import type { DriftClass } from '../analysis/drift.ts';
import type {
  Arrow,
  ArrowWaypoint,
  ChannelObstacle,
  LayoutDebug,
  LayoutInputs,
} from '../analysis/layout_model.ts';
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
  readonly fromRowKind: 'field' | 'method';
  readonly toTypeId: string;
  readonly kind: 'ownership' | 'reexport' | 'method';
  readonly driftClass: DriftClass;
  readonly sourceX: number;
  readonly targetX: number;
  readonly sourceBounds: TypeBounds;
  readonly targetBounds: TypeBounds;
  readonly start: ArrowWaypoint;
  readonly end: ArrowWaypoint;
}

interface RouteExit {
  readonly point: ArrowWaypoint;
}

export interface RoutingResult {
  readonly arrows: readonly Arrow[];
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

  return {
    arrows: requests.map((request) => emitRoutedArrow(request, field)),
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
        if (row.kind === 'method_bucket' || row.targets.length === 0) continue;

        for (const targetId of row.targets) {
          const target = geometry.typesById.get(targetId);
          const targetBounds = boundsByType.get(targetId);
          if (target === undefined || targetBounds === undefined) continue;
          if (target.depth < 0) continue;

          out.push({
            fromTypeId: source.node.id,
            fromFieldName: row.name,
            fromRowKind: row.kind === 'method' ? 'method' : 'field',
            toTypeId: targetId,
            kind: row.kind === 'method' ? 'method' : 'ownership',
            driftClass: drift.typeClass.get(targetId) ?? 'at_lca',
            sourceX: source.x,
            targetX: target.x,
            sourceBounds,
            targetBounds,
            start: { x: row.arrowSourceX, y: row.y },
            end: { x: targetBounds.left, y: target.y },
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
      out.push({
        fromTypeId: source.node.id,
        fromFieldName: '',
        fromRowKind: 'field',
        toTypeId: target.node.id,
        kind: 'reexport',
        driftClass: 'at_lca',
        sourceX: source.x,
        targetX: target.x,
        sourceBounds,
        targetBounds,
        start: { x: sourceBounds.right, y: source.y },
        end: { x: targetBounds.left, y: target.y },
      });
    }
  }

  return out;
}

function emitRoutedArrow(request: RouteRequest, field: RoutingField): Arrow {
  return {
    waypoints: routeAroundBlocks(request, field),
    fromTypeId: request.fromTypeId,
    fromFieldName: request.fromFieldName,
    fromRowKind: request.fromRowKind,
    toTypeId: request.toTypeId,
    kind: request.kind,
    driftClass: request.driftClass,
  };
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

function unroutedHiddenRoute(request: RouteRequest): readonly ArrowWaypoint[] {
  // A visible route must be a checked orthogonal path. If no checked path is
  // available, keep the arrow degenerate instead of leaking a diagonal fallback
  // through blocks.
  return [request.start];
}

function sourceExitForTarget(request: RouteRequest): RouteExit {
  const left = {
    point: { x: request.sourceBounds.left - BLOCK_LEFT_CLEARANCE_X, y: request.start.y },
  };
  const right = {
    point: { x: request.sourceBounds.right + BLOCK_RIGHT_CLEARANCE_X, y: request.start.y },
  };

  // Source side is endpoint semantics, not a route preference: an arrow leaves
  // the side facing the target, independent of where the member text anchor
  // sits inside the source block or how far expanded rows protrude.
  return request.targetX < request.sourceX ? left : right;
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
