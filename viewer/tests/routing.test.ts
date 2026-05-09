import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeDrift } from '../src/analysis/drift.ts';
import { LAYOUT_GRID_CELL_W } from '../src/analysis/layout_metrics.ts';
import type { LayoutInputs } from '../src/analysis/layout_model.ts';
import { rowArrowKey } from '../src/analysis/layout_model.ts';
import { type TreeNode, type TypeNode, buildModuleTree } from '../src/analysis/module_tree.ts';
import { buildOwnershipIndex, computeOwnershipDepth } from '../src/analysis/ownership.ts';
import { canonicalize } from '../src/data/canonicalize.ts';
import type { Facts } from '../src/data/schema.ts';
import type { Geometry } from '../src/layout/geometry.ts';
import type { ObstacleMap } from '../src/layout/obstacles.ts';
import { buildLayout } from '../src/layout/pipeline.ts';
import { routeArrows } from '../src/layout/routing.ts';
import type { Obstacle, PositionedRow, PositionedType } from '../src/layout/types.ts';
import { ViewState } from '../src/state/view_state.ts';

const measure = (s: string): number => s.length * 7;

describe('routeArrows obstacle routing', () => {
  it('routes around an intervening block and keeps the target-left entry stub', () => {
    const source = typeBox('Source', { x: 0, y: 40, width: 40 }, [
      row('target', { y: 40, arrowSourceX: 32, target: 'Target' }),
    ]);
    const target = typeBox('Target', { x: 120, y: 40, width: 40 });
    const blocker = obstacle('Blocker', { x: 56, y: 20, width: 24, height: 40 });
    const routing = routeArrows(
      geometry([source, target]),
      obstacleMap([
        obstacle('Source', { x: 0, y: 28, width: 40, height: 24 }),
        obstacle('Target', { x: 120, y: 28, width: 40, height: 24 }),
        blocker,
      ]),
      routingInputs(),
      measure,
    );

    const arrow = routing.arrows[0];
    expect(arrow?.waypoints[0]).toEqual({ x: 32, y: 40 });
    expectAxisAlignedSegments(arrow?.waypoints ?? []);
    expect(arrow?.waypoints.at(-2)).toEqual({ x: 108, y: 40 });
    expect(arrow?.waypoints.at(-1)).toEqual({ x: 120, y: 40 });
    expect(segmentsIntersectObstacle(arrow?.waypoints ?? [], blocker)).toBe(false);
    expectLeftBorderClearance(arrow?.waypoints ?? [], blocker, LAYOUT_GRID_CELL_W * 1.5);
  });

  it('can exit the source from the left while still entering the target from the left', () => {
    const source = typeBox('Source', { x: 120, y: 40, width: 40 }, [
      row('target', { y: 40, arrowSourceX: 128, target: 'Target' }),
    ]);
    const target = typeBox('Target', { x: 0, y: 40, width: 40 });
    const routing = routeArrows(
      geometry([target, source]),
      obstacleMap([
        obstacle('Source', { x: 120, y: 28, width: 40, height: 24 }),
        obstacle('Target', { x: 0, y: 28, width: 40, height: 24 }),
      ]),
      routingInputs(),
      measure,
    );

    const arrow = routing.arrows[0];
    expectAxisAlignedSegments(arrow?.waypoints ?? []);
    expect(arrow?.waypoints[1]).toEqual({ x: 108, y: 40 });
    expect(arrow?.waypoints.at(-2)).toEqual({ x: -12, y: 40 });
    expect(arrow?.waypoints.at(-1)).toEqual({ x: 0, y: 40 });
  });

  it('uses the source exit facing the target', () => {
    const source = typeBox('Source', { x: 120, y: 40, width: 40 }, [
      row('right_target', { y: 40, arrowSourceX: 128, target: 'Target' }),
    ]);
    const target = typeBox('Target', { x: 240, y: 40, width: 40 });
    const routing = routeArrows(
      geometry([source, target]),
      obstacleMap([
        obstacle('Source', { x: 120, y: 28, width: 40, height: 24 }),
        obstacle('Target', { x: 240, y: 28, width: 40, height: 24 }),
      ]),
      routingInputs(),
      measure,
    );

    expect(routing.arrows[0]?.waypoints[0]).toEqual({ x: 128, y: 40 });
    expect(routing.arrows[0]?.waypoints[1]).toEqual({ x: 164, y: 40 });
  });

  it('uses placed type origins rather than protruding bounds for source side', () => {
    const source = typeBox('Source', { x: 120, y: 120, width: 40 }, [
      row('right_target', { y: 120, arrowSourceX: 152, target: 'Target' }),
    ]);
    const target = typeBox('Target', { x: 240, y: 40, width: 40 });
    const routing = routeArrows(
      geometry([source, target]),
      obstacleMap([
        obstacle('Source', { x: 120, y: 108, width: 280, height: 24 }),
        obstacle('Target', { x: 240, y: 28, width: 40, height: 24 }),
      ]),
      routingInputs(),
      measure,
    );

    expect(routing.arrows[0]?.waypoints[0]).toEqual({ x: 152, y: 120 });
    expect(routing.arrows[0]?.waypoints[1]).toEqual({ x: 404, y: 120 });
  });

  it('does not use the opposite source exit as a route fallback', () => {
    const source = typeBox('Source', { x: 120, y: 40, width: 40 }, [
      row('right_target', { y: 40, arrowSourceX: 128, target: 'Target' }),
    ]);
    const target = typeBox('Target', { x: 240, y: 40, width: 40 });
    const routing = routeArrows(
      geometry([source, target]),
      obstacleMap([
        obstacle('Source', { x: 120, y: 28, width: 40, height: 24 }),
        obstacle('Target', { x: 240, y: 28, width: 40, height: 24 }),
        obstacle('RightExitBlocker', { x: 148, y: 36, width: 8, height: 8 }),
      ]),
      routingInputs(),
      measure,
    );

    expect(routing.arrows[0]?.waypoints).toEqual([{ x: 128, y: 40 }]);
  });

  it('prefers the right-side vertical lane when equal-cost detours exist', () => {
    const source = typeBox('Source', { x: 0, y: 40, width: 40 }, [
      row('target', { y: 40, arrowSourceX: 32, target: 'Target' }),
    ]);
    const target = typeBox('Target', { x: 160, y: 80, width: 40 });
    const routing = routeArrows(
      geometry([source, target]),
      obstacleMap([
        obstacle('Source', { x: 0, y: 28, width: 40, height: 24 }),
        obstacle('Target', { x: 160, y: 68, width: 40, height: 24 }),
        obstacle('LeftCandidate', { x: 96, y: 8, width: 16, height: 16 }),
        obstacle('RightCandidate', { x: 144, y: 8, width: 16, height: 16 }),
      ]),
      routingInputs(),
      measure,
    );

    expect(longestVerticalSegmentX(routing.arrows[0]?.waypoints ?? [])).toBe(148);
  });

  it('keeps a simple target-entry trunk when no block blocks it', () => {
    const source = typeBox('Source', { x: 96, y: 20, width: 40 }, [
      row('target', { y: 20, arrowSourceX: 128, target: 'Target' }),
    ]);
    const target = typeBox('Target', { x: 180, y: 220, width: 40 });
    const routing = routeArrows(
      geometry([source, target]),
      obstacleMap([
        obstacle('Source', { x: 96, y: 8, width: 40, height: 24 }),
        obstacle('Target', { x: 180, y: 208, width: 40, height: 24 }),
        obstacle('LeftBusy', { x: 40, y: 60, width: 32, height: 120 }),
        obstacle('RightBusy', { x: 220, y: 60, width: 32, height: 120 }),
      ]),
      routingInputs(),
      measure,
    );

    expect(longestVerticalSegmentX(routing.arrows[0]?.waypoints ?? [])).toBe(168);
    expect(turnCount(routing.arrows[0]?.waypoints ?? [])).toBeLessThanOrEqual(3);
  });

  it('uses a checked perimeter path when the first horizontal move is blocked', () => {
    const source = typeBox('Source', { x: 96, y: 20, width: 40 }, [
      row('target', { y: 20, arrowSourceX: 128, target: 'Target' }),
    ]);
    const target = typeBox('Target', { x: 240, y: 220, width: 40 });
    const blocker = obstacle('Blocker', { x: 160, y: 8, width: 20, height: 40 });
    const routing = routeArrows(
      geometry([source, target]),
      obstacleMap([
        obstacle('Source', { x: 96, y: 8, width: 40, height: 24 }),
        obstacle('Target', { x: 240, y: 208, width: 40, height: 24 }),
        blocker,
      ]),
      routingInputs(),
      measure,
    );

    const waypoints = routing.arrows[0]?.waypoints ?? [];
    expect(waypoints.length).toBeGreaterThan(2);
    expectAxisAlignedSegments(waypoints);
    expect(segmentsIntersectObstacle(waypoints, blocker)).toBe(false);
  });

  it('does not draw an unchecked diagonal when target-entry clearance is blocked', () => {
    const source = typeBox('Source', { x: 0, y: 20, width: 40 }, [
      row('target', { y: 20, arrowSourceX: 32, target: 'Target' }),
    ]);
    const target = typeBox('Target', { x: 120, y: 80, width: 40 });
    const routing = routeArrows(
      geometry([source, target]),
      obstacleMap([
        obstacle('Source', { x: 0, y: 8, width: 40, height: 24 }),
        obstacle('Target', { x: 120, y: 68, width: 40, height: 24 }),
        obstacle('EntryBlocker', { x: 108, y: 76, width: 4, height: 8 }),
      ]),
      routingInputs(),
      measure,
    );

    expect(routing.arrows[0]?.waypoints).toEqual([{ x: 32, y: 20 }]);
  });

  it('keeps debug obstacles tied to the real obstacle model', () => {
    const source = typeBox('Source', { x: 0, y: 40, width: 40 }, [
      row('target', { y: 40, arrowSourceX: 32, target: 'Target' }),
    ]);
    const target = typeBox('Target', { x: 120, y: 40, width: 40 });
    const obstacles = obstacleMap([
      obstacle('Source', { x: 0, y: 28, width: 40, height: 24 }),
      obstacle('Target', { x: 120, y: 28, width: 40, height: 24 }),
    ]);
    const routing = routeArrows(geometry([source, target]), obstacles, routingInputs(), measure);

    expect(routing.debug.routing.obstacles).toEqual(
      obstacles.all.map((item) => ({
        left: item.x,
        right: item.x + item.width,
        top: item.y,
        bottom: item.y + item.height,
      })),
    );
  });

  it('keeps selected drift arrows visible when an intermediate real type expands', () => {
    const sourceId = 'sf-nano-core::utils::payload::PayloadError';
    const targetId = 'sf-nano-core::utils::leb128::ReadError';
    const fieldName = 'InvalidLEB128::.0';
    const inputs = sfNanoCoreRoutingInputs([
      'sf-nano-core',
      'sf-nano-core::utils',
      'sf-nano-core::utils::leb128',
      'sf-nano-core::utils::limits',
      'sf-nano-core::utils::payload',
      sourceId,
      'sf-nano-core::utils::limits::LimitsError',
    ]);
    const layout = buildLayout({
      ...inputs,
      fieldArrowsShown: new Set([rowArrowKey(sourceId, fieldName)]),
    });

    const arrow = layout.arrows.find(
      (candidate) =>
        candidate.fromTypeId === sourceId &&
        candidate.fromFieldName === fieldName &&
        candidate.toTypeId === targetId,
    );
    expect(arrow).toBeDefined();
    expect(arrow?.waypoints.length).toBeGreaterThan(1);
    expectAxisAlignedSegments(arrow?.waypoints ?? []);
  });
});

function sfNanoCoreRoutingInputs(expandedIds: readonly string[]): LayoutInputs {
  const raw = JSON.parse(readFileSync('./data/facts.json', 'utf8')) as Facts;
  const facts = canonicalize(raw);
  const crate = facts.crates['sf-nano-core'];
  if (crate === undefined) {
    throw new Error('sf-nano-core facts missing from test data.');
  }

  const staticRoot = buildModuleTree(crate);
  const ownership = buildOwnershipIndex(facts, 'sf-nano-core');
  const typeModule = collectTypeModule(staticRoot);
  const drift = computeDrift(ownership, typeModule);
  const depth = computeOwnershipDepth(ownership, collectTypeIds(staticRoot), drift);

  return {
    staticRoot,
    ownership,
    depth,
    drift,
    state: new ViewState(expandedIds),
    measureText: measure,
  };
}

function collectTypeIds(root: TreeNode): string[] {
  const out: string[] = [];
  const walk = (node: TreeNode): void => {
    if (node.kind === 'type') {
      out.push(node.fullPath);
      return;
    }
    for (const child of node.children) walk(child);
  };
  walk(root);
  return out;
}

function collectTypeModule(root: TreeNode): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (node: TreeNode): void => {
    if (node.kind === 'type') {
      out.set(node.fullPath, node.modulePath);
      return;
    }
    for (const child of node.children) walk(child);
  };
  walk(root);
  return out;
}

function typeBox(
  id: string,
  rect: { readonly x: number; readonly y: number; readonly width: number },
  visibleRows: readonly PositionedRow[] = [],
): PositionedType {
  return {
    node: typeNode(id),
    bandId: 'm',
    bandOrder: 0,
    indexInBandOrder: 0,
    x: rect.x,
    y: rect.y,
    width: rect.width,
    headerArrowX: null,
    headerHitWidth: rect.width,
    height: 24 + visibleRows.length * 16,
    depth: 0,
    subrank: 0,
    rank: 0,
    expanded: visibleRows.length > 0,
    visibleRows,
  };
}

function row(
  name: string,
  input: { readonly y: number; readonly arrowSourceX: number; readonly target: string },
): PositionedRow {
  return {
    name,
    tyText: '',
    ownership: 'owned',
    x: input.arrowSourceX - 16,
    y: input.y,
    arrowSourceX: input.arrowSourceX,
    targets: [input.target],
    kind: 'field',
    bucketId: null,
    memberDriftClass: 'at_lca',
  };
}

function typeNode(id: string): TypeNode {
  return {
    kind: 'type',
    id,
    label: id,
    typeKind: 'struct',
    visibility: 'pub',
    fullPath: id,
    modulePath: 'm',
    fields: [],
    methodBuckets: [],
  };
}

function geometry(types: readonly PositionedType[]): Geometry {
  return {
    types,
    modules: [],
    placedFragments: [],
    ranks: new Map(),
    typesById: new Map(types.map((type) => [type.node.id, type] as const)),
    debugLabels: [],
    debugGrid: {
      originX: 0,
      originY: 0,
      cellWidth: 8,
      cellHeight: 8,
      width: 200,
      height: 100,
    },
    globalXStart: 0,
    columnStride: 0,
    totalWidth: 200,
    totalHeight: 100,
  };
}

function obstacle(
  typeId: string,
  rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
): Obstacle {
  return {
    kind: 'block',
    typeId,
    fragmentId: typeId,
    fragmentIndex: 0,
    fragmentKind: 'body',
    rowIds: [],
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  };
}

function obstacleMap(items: readonly Obstacle[]): ObstacleMap {
  const blockByType = new Map<string, Obstacle>();
  const blocksByType = new Map<string, Obstacle[]>();
  for (const item of items) {
    blockByType.set(item.typeId, item);
    blocksByType.set(item.typeId, [...(blocksByType.get(item.typeId) ?? []), item]);
  }
  return {
    all: items,
    blockByType,
    blocksByType,
    protrusionsByType: new Map(),
  };
}

function routingInputs(): LayoutInputs {
  return {
    drift: { typeClass: new Map(), lca: new Map() },
  } as unknown as LayoutInputs;
}

function segmentsIntersectObstacle(
  waypoints: readonly { readonly x: number; readonly y: number }[],
  item: Obstacle,
): boolean {
  for (let i = 1; i < waypoints.length; i += 1) {
    const prev = waypoints[i - 1];
    const current = waypoints[i];
    if (prev === undefined || current === undefined) continue;
    if (segmentIntersectsRect(prev, current, item)) return true;
  }
  return false;
}

function expectAxisAlignedSegments(
  waypoints: readonly { readonly x: number; readonly y: number }[],
): void {
  for (let i = 1; i < waypoints.length; i += 1) {
    const prev = waypoints[i - 1];
    const current = waypoints[i];
    if (prev === undefined || current === undefined) continue;
    expect(prev.x === current.x || prev.y === current.y).toBe(true);
  }
}

function expectLeftBorderClearance(
  waypoints: readonly { readonly x: number; readonly y: number }[],
  item: Obstacle,
  minDistance: number,
): void {
  const left = item.x;
  const top = item.y;
  const bottom = item.y + item.height;
  for (let i = 1; i < waypoints.length; i += 1) {
    const prev = waypoints[i - 1];
    const current = waypoints[i];
    if (prev === undefined || current === undefined || prev.x !== current.x) continue;
    if (prev.x >= left) continue;
    const segTop = Math.min(prev.y, current.y);
    const segBottom = Math.max(prev.y, current.y);
    if (segBottom < top || segTop > bottom) continue;
    expect(left - prev.x).toBeGreaterThanOrEqual(minDistance);
  }
}

function longestVerticalSegmentX(
  waypoints: readonly { readonly x: number; readonly y: number }[],
): number | null {
  let bestX: number | null = null;
  let bestLength = -1;
  for (let i = 1; i < waypoints.length; i += 1) {
    const prev = waypoints[i - 1];
    const current = waypoints[i];
    if (prev === undefined || current === undefined || prev.x !== current.x) continue;
    const length = Math.abs(current.y - prev.y);
    if (length > bestLength) {
      bestLength = length;
      bestX = prev.x;
    }
  }
  return bestX;
}

function turnCount(waypoints: readonly { readonly x: number; readonly y: number }[]): number {
  let count = 0;
  let prevAxis: 'h' | 'v' | null = null;
  for (let i = 1; i < waypoints.length; i += 1) {
    const prev = waypoints[i - 1];
    const current = waypoints[i];
    if (prev === undefined || current === undefined) continue;
    const axis = prev.x === current.x ? 'v' : 'h';
    if (prevAxis !== null && prevAxis !== axis) count += 1;
    prevAxis = axis;
  }
  return count;
}

function segmentIntersectsRect(
  from: { readonly x: number; readonly y: number },
  to: { readonly x: number; readonly y: number },
  rect: Obstacle,
): boolean {
  const left = rect.x;
  const right = rect.x + rect.width;
  const top = rect.y;
  const bottom = rect.y + rect.height;
  if (from.y === to.y) {
    const minX = Math.min(from.x, to.x);
    const maxX = Math.max(from.x, to.x);
    return from.y >= top && from.y <= bottom && maxX >= left && minX <= right;
  }
  if (from.x !== to.x) return false;
  const minY = Math.min(from.y, to.y);
  const maxY = Math.max(from.y, to.y);
  return from.x >= left && from.x <= right && maxY >= top && minY <= bottom;
}
