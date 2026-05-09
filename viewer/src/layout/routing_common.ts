// Shared routing contracts. This module owns endpoint/request construction so
// routing strategies can differ in path search without duplicating source and
// target semantics.

import type { DriftClass } from '../analysis/drift.ts';
import type {
  Arrow,
  ArrowWaypoint,
  ChannelObstacle,
  LayoutInputs,
} from '../analysis/layout_model.ts';
import { BAND_GRID_CELL_H, BAND_GRID_CELL_W } from './geometry.ts';
import type { Geometry } from './geometry.ts';
import type { ObstacleMap } from './obstacles.ts';
import { type RouteClass, classifyOwnershipRouteByDepth } from './routing_class.ts';
import type { Obstacle, PositionedType } from './types.ts';

export type { RouteClass } from './routing_class.ts';
export type SourceSide = 'right' | 'left';

export interface TypeBounds {
  readonly left: number;
  readonly right: number;
}

export interface RouteRequest {
  readonly fromTypeId: string;
  readonly fromFieldName: string;
  readonly toTypeId: string;
  readonly sourceLeftX: number;
  readonly sourceRowLeftX: number;
  readonly sourceRightX: number;
  readonly sourceRightBoundaryX: number;
  readonly sourceY: number;
  readonly targetLeftX: number;
  readonly targetRightX: number;
  readonly targetY: number;
  readonly fromRowKind: 'field' | 'method';
  readonly kind: 'ownership' | 'reexport' | 'method';
  readonly routeClass: RouteClass;
  readonly driftClass: DriftClass;
}

export interface IndexedObstacle {
  readonly obstacle: Obstacle;
  readonly leftCol: number;
  readonly rightCol: number;
  readonly topRow: number;
  readonly bottomRow: number;
}

export interface ObstacleIndex {
  readonly all: readonly IndexedObstacle[];
  readonly byCol: ReadonlyMap<number, readonly IndexedObstacle[]>;
  readonly byRow: ReadonlyMap<number, readonly IndexedObstacle[]>;
}

export interface OccupancyScore {
  readonly cells: number;
}

export function collectRouteRequests(
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
          if (target.depth < 0) continue; // ghost target

          const driftClass: DriftClass = drift.typeClass.get(targetId) ?? 'at_lca';
          const routeClass =
            row.kind === 'method' ? 'other' : classifyOwnershipRoute(source, target, driftClass);
          out.push({
            fromTypeId: source.node.id,
            fromFieldName: row.name,
            toTypeId: targetId,
            sourceLeftX: sourceBounds.left,
            sourceRowLeftX: row.x,
            sourceRightX: row.arrowSourceX,
            sourceRightBoundaryX: sourceBounds.right,
            sourceY: row.y,
            targetLeftX: targetBounds.left,
            targetRightX: targetBounds.right,
            targetY: target.y,
            fromRowKind: row.kind === 'method' ? 'method' : 'field',
            kind: row.kind === 'method' ? 'method' : 'ownership',
            routeClass,
            driftClass,
          });
        }
      }
    }

    // Re-export arrows are not structural ownership. They still use the same
    // source/target request contract so every routing strategy lands on the
    // target's left side and renders the same semantic arrow payload.
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
        toTypeId: target.node.id,
        sourceLeftX: sourceBounds.left,
        sourceRowLeftX: sourceBounds.left,
        sourceRightX: sourceBounds.right,
        sourceRightBoundaryX: sourceBounds.right,
        sourceY: source.y,
        targetLeftX: targetBounds.left,
        targetRightX: targetBounds.right,
        targetY: target.y,
        fromRowKind: 'field',
        kind: 'reexport',
        routeClass: 'other',
        driftClass: 'at_lca',
      });
    }
  }

  return out;
}

function classifyOwnershipRoute(
  source: PositionedType,
  target: PositionedType,
  driftClass: DriftClass,
): RouteClass {
  return classifyOwnershipRouteByDepth(source.depth, target.depth, driftClass);
}

export function buildTypeBounds(
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
    byType.set(type.node.id, { left: type.x, right: type.x + type.width });
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
  byType.set(typeId, {
    left: existing === undefined ? left : Math.min(existing.left, left),
    right: existing === undefined ? right : Math.max(existing.right, right),
  });
}

export function buildObstacleIndex(obstacles: readonly Obstacle[]): ObstacleIndex {
  const all: IndexedObstacle[] = [];
  const byCol = new Map<number, IndexedObstacle[]>();
  const byRow = new Map<number, IndexedObstacle[]>();

  for (const obstacle of obstacles) {
    const indexed: IndexedObstacle = {
      obstacle,
      leftCol: Math.floor(obstacle.x / BAND_GRID_CELL_W),
      rightCol: Math.ceil((obstacle.x + obstacle.width) / BAND_GRID_CELL_W),
      topRow: Math.floor(obstacle.y / BAND_GRID_CELL_H),
      bottomRow: Math.ceil((obstacle.y + obstacle.height) / BAND_GRID_CELL_H),
    };

    all.push(indexed);
    for (let col = indexed.leftCol; col < indexed.rightCol; col += 1) {
      appendIndex(byCol, col, indexed);
    }
    for (let row = indexed.topRow; row < indexed.bottomRow; row += 1) {
      appendIndex(byRow, row, indexed);
    }
  }

  return { all, byCol, byRow };
}

function appendIndex(
  index: Map<number, IndexedObstacle[]>,
  key: number,
  obstacle: IndexedObstacle,
): void {
  const existing = index.get(key);
  if (existing === undefined) {
    index.set(key, [obstacle]);
    return;
  }
  existing.push(obstacle);
}

export function obstacleRects(map: ObstacleMap): ChannelObstacle[] {
  return map.all.map((o) => ({
    left: o.x,
    right: o.x + o.width,
    top: o.y,
    bottom: o.y + o.height,
  }));
}

export function emitArrow(raw: RouteRequest, waypoints: readonly ArrowWaypoint[]): Arrow {
  return {
    waypoints,
    fromTypeId: raw.fromTypeId,
    fromFieldName: raw.fromFieldName,
    fromRowKind: raw.fromRowKind,
    toTypeId: raw.toTypeId,
    kind: raw.kind,
    driftClass: raw.driftClass,
  };
}

export function sameTarget(left: RouteRequest, right: RouteRequest): boolean {
  return left.toTypeId === right.toTypeId;
}

export function snap(value: number): number {
  return Math.round(value / BAND_GRID_CELL_W) * BAND_GRID_CELL_W;
}

export function snapDown(value: number): number {
  return Math.floor(value / BAND_GRID_CELL_W) * BAND_GRID_CELL_W;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function samePoint(left: ArrowWaypoint, right: ArrowWaypoint): boolean {
  return left.x === right.x && left.y === right.y;
}

export function rangeOverlap(aMin: number, aMax: number, bMin: number, bMax: number): number {
  return Math.max(0, Math.min(aMax, bMax) - Math.max(aMin, bMin));
}
