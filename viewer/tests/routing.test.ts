import { describe, expect, it } from 'vitest';
import {
  BAND_GRID_CELL_H,
  BAND_GRID_CELL_W,
  FIELD_ROW_H,
  type Geometry,
  ROW_H,
  computeGeometry,
} from '../src/layout/geometry.ts';
import { computeObstacles } from '../src/layout/obstacles.ts';
import { routeArrows } from '../src/layout/routing.ts';
import { routeArrowsDogleg } from '../src/layout/routing_dogleg.ts';
import type { PlacedFragmentRect, PositionedType } from '../src/layout/types.ts';
import { buildInputs, crateFacts, edge, mod, ty } from './fixtures/builders.ts';

const measure = (s: string): number => s.length * 7;

function manualRoutingInputs() {
  const c = crateFacts('c', [
    mod('m', [
      ty('c', 'm', 'Source', [{ name: 'target', ty_text: 'Target' }]),
      ty('c', 'm', 'Target'),
    ]),
  ]);
  return buildInputs(c, [edge('c::m::Source', 'c::m::Target', 'field target')], []);
}

function manualRoutingGeometry(
  wall: PlacedFragmentRect | null = null,
  rowNames: readonly string[] = ['target'],
  options: {
    readonly sourceDepth?: number;
    readonly sourceWidth?: number;
    readonly sourceX?: number;
    readonly targetDepth?: number;
    readonly targetX?: number;
  } = {},
): Geometry {
  const sourceId = 'c::m::Source';
  const targetId = 'c::m::Target';
  const sourceX = options.sourceX ?? 20;
  const sourceWidth = options.sourceWidth ?? 70;
  const targetX = options.targetX ?? 200;
  const rows = rowNames.map((name, index) => ({
    name,
    tyText: 'Target',
    ownership: 'owned' as const,
    x: sourceX + 24,
    y: 100 + index * FIELD_ROW_H,
    arrowSourceX: sourceX + 60,
    targets: [targetId],
    kind: 'field' as const,
    bucketId: null,
  }));
  const source: PositionedType = {
    node: { id: sourceId, label: 'Source' } as PositionedType['node'],
    bandId: 'c::m',
    bandOrder: 0,
    indexInBandOrder: 0,
    x: sourceX,
    y: 80,
    width: sourceWidth,
    headerArrowX: sourceX + 38,
    headerHitWidth: sourceWidth,
    height: ROW_H + rowNames.length * FIELD_ROW_H,
    depth: options.sourceDepth ?? 0,
    subrank: 0,
    rank: 0,
    expanded: true,
    visibleRows: rows,
  };
  const target: PositionedType = {
    node: { id: targetId, label: 'Target' } as PositionedType['node'],
    bandId: 'c::m',
    bandOrder: 1,
    indexInBandOrder: 0,
    x: targetX,
    y: 160,
    width: 70,
    headerArrowX: null,
    headerHitWidth: 70,
    height: ROW_H,
    depth: options.targetDepth ?? 1,
    subrank: 0,
    rank: 1,
    expanded: false,
    visibleRows: [],
  };
  const placedFragments = [
    placedFragment(
      sourceId,
      sourceX,
      80 - ROW_H / 2,
      sourceWidth,
      ROW_H + rowNames.length * FIELD_ROW_H,
      0,
      0,
    ),
    placedFragment(targetId, targetX, 160 - ROW_H / 2, 70, ROW_H, 1, 0),
  ];
  if (wall !== null) placedFragments.push(wall);

  return {
    types: [source, target],
    modules: [],
    placedFragments,
    ranks: new Map(),
    typesById: new Map([
      [sourceId, source],
      [targetId, target],
    ]),
    debugGrid: {
      originX: 0,
      originY: 0,
      cellWidth: BAND_GRID_CELL_W,
      cellHeight: BAND_GRID_CELL_H,
      width: targetX + 70,
      height: 190,
    },
    globalXStart: 0,
    columnStride: 160,
    totalWidth: targetX + 70,
    totalHeight: 190,
  };
}

function multiTargetRoutingInputs(targetCount: number) {
  const targetNames = Array.from({ length: targetCount }, (_, index) => `Target${index}`);
  const c = crateFacts('c', [
    mod('m', [
      ty(
        'c',
        'm',
        'Source',
        targetNames.map((name, index) => ({ name: `field${index}`, ty_text: name })),
      ),
      ...targetNames.map((name) => ty('c', 'm', name)),
    ]),
  ]);
  return buildInputs(
    c,
    targetNames.map((name, index) => edge('c::m::Source', `c::m::${name}`, `field field${index}`)),
    [],
  );
}

function multiTargetRoutingGeometry(targetCount: number): Geometry {
  const sourceId = 'c::m::Source';
  const sourceX = 20;
  const sourceWidth = 80;
  const targetX = 200;
  const rows = Array.from({ length: targetCount }, (_, index) => {
    const targetId = `c::m::Target${index}`;
    return {
      name: `field${index}`,
      tyText: `Target${index}`,
      ownership: 'owned' as const,
      x: sourceX + 24,
      y: 220 + index * FIELD_ROW_H,
      arrowSourceX: sourceX + 60,
      targets: [targetId],
      kind: 'field' as const,
      bucketId: null,
    };
  });
  const source: PositionedType = {
    node: { id: sourceId, label: 'Source' } as PositionedType['node'],
    bandId: 'c::m',
    bandOrder: 0,
    indexInBandOrder: 0,
    x: sourceX,
    y: 200,
    width: sourceWidth,
    headerArrowX: sourceX + 38,
    headerHitWidth: sourceWidth,
    height: ROW_H + rows.length * FIELD_ROW_H,
    depth: 0,
    subrank: 0,
    rank: 0,
    expanded: true,
    visibleRows: rows,
  };
  const targets = Array.from({ length: targetCount }, (_, index): PositionedType => {
    const targetId = `c::m::Target${index}`;
    return {
      node: { id: targetId, label: `Target${index}` } as PositionedType['node'],
      bandId: 'c::m',
      bandOrder: 1,
      indexInBandOrder: index,
      x: targetX,
      y: 80 + index * FIELD_ROW_H,
      width: 80,
      headerArrowX: null,
      headerHitWidth: 80,
      height: ROW_H,
      depth: 1,
      subrank: 0,
      rank: 1,
      expanded: false,
      visibleRows: [],
    };
  });
  const typesByIdEntries: [string, PositionedType][] = [
    [sourceId, source],
    ...targets.map((target): [string, PositionedType] => [target.node.id, target]),
  ];
  return {
    types: [source, ...targets],
    modules: [],
    placedFragments: [
      placedFragment(sourceId, sourceX, 200 - ROW_H / 2, sourceWidth, source.height, 0, 0),
      ...targets.map((target, index) =>
        placedFragment(
          target.node.id,
          target.x,
          target.y - ROW_H / 2,
          target.width,
          ROW_H,
          1,
          index,
        ),
      ),
    ],
    ranks: new Map(),
    typesById: new Map(typesByIdEntries),
    debugGrid: {
      originX: 0,
      originY: 0,
      cellWidth: BAND_GRID_CELL_W,
      cellHeight: BAND_GRID_CELL_H,
      width: targetX + 80,
      height: 260 + targetCount * FIELD_ROW_H,
    },
    globalXStart: 0,
    columnStride: 160,
    totalWidth: targetX + 80,
    totalHeight: 260 + targetCount * FIELD_ROW_H,
  };
}

function mixedFanInRoutingInputs() {
  const c = crateFacts('c', [
    mod('m', [
      ty('c', 'm', 'SourceA', [
        { name: 'targetA1', ty_text: 'TargetA' },
        { name: 'targetB', ty_text: 'TargetB' },
      ]),
      ty('c', 'm', 'SourceB', [{ name: 'targetA2', ty_text: 'TargetA' }]),
      ty('c', 'm', 'TargetA'),
      ty('c', 'm', 'TargetB'),
    ]),
  ]);
  return buildInputs(
    c,
    [
      edge('c::m::SourceA', 'c::m::TargetA', 'field targetA1'),
      edge('c::m::SourceA', 'c::m::TargetB', 'field targetB'),
      edge('c::m::SourceB', 'c::m::TargetA', 'field targetA2'),
    ],
    [],
  );
}

function mixedFanInRoutingGeometry(): Geometry {
  const sourceAId = 'c::m::SourceA';
  const sourceBId = 'c::m::SourceB';
  const targetAId = 'c::m::TargetA';
  const targetBId = 'c::m::TargetB';
  const sourceX = 20;
  const sourceWidth = 80;
  const targetX = 240;
  const sourceARows = [
    {
      name: 'targetA1',
      tyText: 'TargetA',
      ownership: 'owned' as const,
      x: sourceX + 24,
      y: 180,
      arrowSourceX: sourceX + 60,
      targets: [targetAId],
      kind: 'field' as const,
      bucketId: null,
    },
    {
      name: 'targetB',
      tyText: 'TargetB',
      ownership: 'owned' as const,
      x: sourceX + 24,
      y: 204,
      arrowSourceX: sourceX + 60,
      targets: [targetBId],
      kind: 'field' as const,
      bucketId: null,
    },
  ];
  const sourceBRows = [
    {
      name: 'targetA2',
      tyText: 'TargetA',
      ownership: 'owned' as const,
      x: sourceX + 24,
      y: 280,
      arrowSourceX: sourceX + 60,
      targets: [targetAId],
      kind: 'field' as const,
      bucketId: null,
    },
  ];
  const sourceA: PositionedType = {
    node: { id: sourceAId, label: 'SourceA' } as PositionedType['node'],
    bandId: 'c::m',
    bandOrder: 0,
    indexInBandOrder: 0,
    x: sourceX,
    y: 150,
    width: sourceWidth,
    headerArrowX: sourceX + 38,
    headerHitWidth: sourceWidth,
    height: ROW_H + sourceARows.length * FIELD_ROW_H,
    depth: 0,
    subrank: 0,
    rank: 0,
    expanded: true,
    visibleRows: sourceARows,
  };
  const sourceB: PositionedType = {
    ...sourceA,
    node: { id: sourceBId, label: 'SourceB' } as PositionedType['node'],
    y: 250,
    height: ROW_H + sourceBRows.length * FIELD_ROW_H,
    visibleRows: sourceBRows,
  };
  const targetA: PositionedType = {
    node: { id: targetAId, label: 'TargetA' } as PositionedType['node'],
    bandId: 'c::m',
    bandOrder: 1,
    indexInBandOrder: 0,
    x: targetX,
    y: 100,
    width: 80,
    headerArrowX: null,
    headerHitWidth: 80,
    height: ROW_H,
    depth: 1,
    subrank: 0,
    rank: 1,
    expanded: false,
    visibleRows: [],
  };
  const targetB: PositionedType = {
    ...targetA,
    node: { id: targetBId, label: 'TargetB' } as PositionedType['node'],
    y: 140,
    indexInBandOrder: 1,
  };
  return {
    types: [sourceA, sourceB, targetA, targetB],
    modules: [],
    placedFragments: [
      placedFragment(sourceAId, sourceX, 150 - ROW_H / 2, sourceWidth, sourceA.height, 0, 0),
      placedFragment(sourceBId, sourceX, 250 - ROW_H / 2, sourceWidth, sourceB.height, 0, 1),
      placedFragment(targetAId, targetX, 100 - ROW_H / 2, 80, ROW_H, 1, 0),
      placedFragment(targetBId, targetX, 140 - ROW_H / 2, 80, ROW_H, 1, 1),
    ],
    ranks: new Map(),
    typesById: new Map([
      [sourceAId, sourceA],
      [sourceBId, sourceB],
      [targetAId, targetA],
      [targetBId, targetB],
    ]),
    debugGrid: {
      originX: 0,
      originY: 0,
      cellWidth: BAND_GRID_CELL_W,
      cellHeight: BAND_GRID_CELL_H,
      width: targetX + 80,
      height: 320,
    },
    globalXStart: 0,
    columnStride: 160,
    totalWidth: targetX + 80,
    totalHeight: 320,
  };
}

function orderedTwoTargetGeometry(): Geometry {
  const sourceId = 'c::m::Source';
  const upperTargetId = 'c::m::UpperTarget';
  const lowerTargetId = 'c::m::LowerTarget';
  const sourceX = 20;
  const sourceWidth = 80;
  const rows = [
    {
      name: 'upper',
      tyText: 'UpperTarget',
      ownership: 'owned' as const,
      x: sourceX + 24,
      y: 200,
      arrowSourceX: sourceX + 60,
      targets: [upperTargetId],
      kind: 'field' as const,
      bucketId: null,
    },
    {
      name: 'lower',
      tyText: 'LowerTarget',
      ownership: 'owned' as const,
      x: sourceX + 24,
      y: 224,
      arrowSourceX: sourceX + 60,
      targets: [lowerTargetId],
      kind: 'field' as const,
      bucketId: null,
    },
  ];
  const source: PositionedType = {
    node: { id: sourceId, label: 'Source' } as PositionedType['node'],
    bandId: 'c::m',
    bandOrder: 0,
    indexInBandOrder: 0,
    x: sourceX,
    y: 180,
    width: sourceWidth,
    headerArrowX: sourceX + 38,
    headerHitWidth: sourceWidth,
    height: ROW_H + rows.length * FIELD_ROW_H,
    depth: 0,
    subrank: 0,
    rank: 0,
    expanded: true,
    visibleRows: rows,
  };
  const upperTarget: PositionedType = {
    node: { id: upperTargetId, label: 'UpperTarget' } as PositionedType['node'],
    bandId: 'c::m',
    bandOrder: 1,
    indexInBandOrder: 0,
    x: 200,
    y: 80,
    width: 90,
    headerArrowX: null,
    headerHitWidth: 90,
    height: ROW_H,
    depth: 1,
    subrank: 0,
    rank: 1,
    expanded: false,
    visibleRows: [],
  };
  const lowerTarget: PositionedType = {
    ...upperTarget,
    node: { id: lowerTargetId, label: 'LowerTarget' } as PositionedType['node'],
    y: 160,
  };
  return {
    types: [source, upperTarget, lowerTarget],
    modules: [],
    placedFragments: [
      placedFragment(sourceId, sourceX, 180 - ROW_H / 2, sourceWidth, source.height, 0, 0),
      placedFragment(upperTargetId, 200, 80 - ROW_H / 2, 90, ROW_H, 1, 0),
      placedFragment(lowerTargetId, 200, 160 - ROW_H / 2, 90, ROW_H, 1, 0),
    ],
    ranks: new Map(),
    typesById: new Map([
      [sourceId, source],
      [upperTargetId, upperTarget],
      [lowerTargetId, lowerTarget],
    ]),
    debugGrid: {
      originX: 0,
      originY: 0,
      cellWidth: BAND_GRID_CELL_W,
      cellHeight: BAND_GRID_CELL_H,
      width: 290,
      height: 240,
    },
    globalXStart: 0,
    columnStride: 160,
    totalWidth: 290,
    totalHeight: 240,
  };
}

function placedFragment(
  typeId: string,
  x: number,
  y: number,
  width: number,
  height: number,
  bandOrder: number,
  fragmentIndex: number,
): PlacedFragmentRect {
  return {
    typeId,
    bandId: 'c::m',
    bandOrder,
    indexInBandOrder: 0,
    fragmentId: `${typeId}:fragment:${fragmentIndex}`,
    fragmentIndex,
    fragmentKind: 'main',
    rowIds: [],
    x,
    y,
    width,
    height,
  };
}

function routeIntersectsRect(
  waypoints: readonly { readonly x: number; readonly y: number }[],
  rect: Pick<PlacedFragmentRect, 'x' | 'y' | 'width' | 'height'>,
): boolean {
  for (let index = 1; index < waypoints.length; index++) {
    const from = waypoints[index - 1];
    const to = waypoints[index];
    if (from === undefined || to === undefined) continue;
    if (from.x === to.x && verticalSegmentIntersectsRect(from.x, from.y, to.y, rect)) return true;
    if (from.y === to.y && horizontalSegmentIntersectsRect(from.y, from.x, to.x, rect)) {
      return true;
    }
  }
  return false;
}

function routeIsOrthogonal(waypoints: readonly { readonly x: number; readonly y: number }[]) {
  for (let index = 1; index < waypoints.length; index += 1) {
    const from = waypoints[index - 1];
    const to = waypoints[index];
    if (from === undefined || to === undefined) continue;
    if (from.x !== to.x && from.y !== to.y) return false;
  }
  return true;
}

function verticalSegmentIntersectsRect(
  x: number,
  fromY: number,
  toY: number,
  rect: Pick<PlacedFragmentRect, 'x' | 'y' | 'width' | 'height'>,
): boolean {
  return (
    x >= rect.x &&
    x < rect.x + rect.width &&
    rangesOverlap(Math.min(fromY, toY), Math.max(fromY, toY), rect.y, rect.y + rect.height)
  );
}

function horizontalSegmentIntersectsRect(
  y: number,
  fromX: number,
  toX: number,
  rect: Pick<PlacedFragmentRect, 'x' | 'y' | 'width' | 'height'>,
): boolean {
  return (
    y >= rect.y &&
    y < rect.y + rect.height &&
    rangesOverlap(Math.min(fromX, toX), Math.max(fromX, toX), rect.x, rect.x + rect.width)
  );
}

function rangesOverlap(aMin: number, aMax: number, bMin: number, bMax: number): boolean {
  return aMin < bMax && bMin < aMax;
}

function verticalTrunkX(waypoints: readonly { readonly x: number; readonly y: number }[]): number {
  for (let index = 1; index < waypoints.length; index += 1) {
    const from = waypoints[index - 1];
    const to = waypoints[index];
    if (from === undefined || to === undefined) continue;
    if (from.x === to.x && from.y !== to.y) return from.x;
  }
  throw new Error(`No vertical trunk in ${JSON.stringify(waypoints)}.`);
}

function finalTargetApproachStartX(
  waypoints: readonly { readonly x: number; readonly y: number }[],
): number {
  const end = waypoints[waypoints.length - 1];
  const previous = waypoints[waypoints.length - 2];
  if (end === undefined || previous === undefined) {
    throw new Error(`No final approach in ${JSON.stringify(waypoints)}.`);
  }
  if (previous.y !== end.y || previous.x > end.x) {
    throw new Error(`Expected final target approach from the left: ${JSON.stringify(waypoints)}.`);
  }
  return previous.x;
}

function routePairCrosses(
  leftWaypoints: readonly { readonly x: number; readonly y: number }[],
  rightWaypoints: readonly { readonly x: number; readonly y: number }[],
): boolean {
  for (let leftIndex = 1; leftIndex < leftWaypoints.length; leftIndex += 1) {
    const leftFrom = leftWaypoints[leftIndex - 1];
    const leftTo = leftWaypoints[leftIndex];
    if (leftFrom === undefined || leftTo === undefined) continue;
    for (let rightIndex = 1; rightIndex < rightWaypoints.length; rightIndex += 1) {
      const rightFrom = rightWaypoints[rightIndex - 1];
      const rightTo = rightWaypoints[rightIndex];
      if (rightFrom === undefined || rightTo === undefined) continue;
      if (horizontalVerticalCrosses(leftFrom, leftTo, rightFrom, rightTo)) return true;
      if (horizontalVerticalCrosses(rightFrom, rightTo, leftFrom, leftTo)) return true;
    }
  }
  return false;
}

function horizontalVerticalCrosses(
  horizontalFrom: { readonly x: number; readonly y: number },
  horizontalTo: { readonly x: number; readonly y: number },
  verticalFrom: { readonly x: number; readonly y: number },
  verticalTo: { readonly x: number; readonly y: number },
): boolean {
  if (horizontalFrom.y !== horizontalTo.y || verticalFrom.x !== verticalTo.x) return false;
  return (
    verticalFrom.x > Math.min(horizontalFrom.x, horizontalTo.x) &&
    verticalFrom.x < Math.max(horizontalFrom.x, horizontalTo.x) &&
    horizontalFrom.y > Math.min(verticalFrom.y, verticalTo.y) &&
    horizontalFrom.y < Math.max(verticalFrom.y, verticalTo.y)
  );
}

function offsetSourcesInputs() {
  const c = crateFacts('c', [
    mod('m', [
      ty('c', 'm', 'SourceLeft', [{ name: 'fieldA', ty_text: 'TargetA' }]),
      ty('c', 'm', 'SourceRight', [{ name: 'fieldB', ty_text: 'TargetB' }]),
      ty('c', 'm', 'TargetA'),
      ty('c', 'm', 'TargetB'),
    ]),
  ]);
  return buildInputs(
    c,
    [
      edge('c::m::SourceLeft', 'c::m::TargetA', 'field fieldA'),
      edge('c::m::SourceRight', 'c::m::TargetB', 'field fieldB'),
    ],
    [],
  );
}

function offsetSourcesGeometry(): Geometry {
  // Two forward arrows from sources at different X positions onto targets
  // sharing the same column. The leftmost source's trunk window extends
  // further left than the rightmost source's; with edge-anchored lane
  // assignment the leftmost trunk must hug its own source.right + 0.5g
  // rather than wasting that clearance by anchoring inside the batch's
  // common corridor.
  const sourceLeftId = 'c::m::SourceLeft';
  const sourceRightId = 'c::m::SourceRight';
  const targetAId = 'c::m::TargetA';
  const targetBId = 'c::m::TargetB';
  const sourceLeftX = 20;
  const sourceLeftWidth = 60;
  const sourceRightX = 140;
  const sourceRightWidth = 40;
  const targetX = 300;
  const targetWidth = 80;
  const sourceLeftRow = {
    name: 'fieldA',
    tyText: 'TargetA',
    ownership: 'owned' as const,
    x: sourceLeftX + 24,
    y: 200,
    arrowSourceX: sourceLeftX + sourceLeftWidth - 12,
    targets: [targetAId],
    kind: 'field' as const,
    bucketId: null,
  };
  const sourceRightRow = {
    name: 'fieldB',
    tyText: 'TargetB',
    ownership: 'owned' as const,
    x: sourceRightX + 8,
    y: 220,
    arrowSourceX: sourceRightX + sourceRightWidth - 4,
    targets: [targetBId],
    kind: 'field' as const,
    bucketId: null,
  };
  const sourceLeft: PositionedType = {
    node: { id: sourceLeftId, label: 'SourceLeft' } as PositionedType['node'],
    bandId: 'c::m',
    bandOrder: 0,
    indexInBandOrder: 0,
    x: sourceLeftX,
    y: 180,
    width: sourceLeftWidth,
    headerArrowX: sourceLeftX + 38,
    headerHitWidth: sourceLeftWidth,
    height: ROW_H + FIELD_ROW_H,
    depth: 0,
    subrank: 0,
    rank: 0,
    expanded: true,
    visibleRows: [sourceLeftRow],
  };
  const sourceRight: PositionedType = {
    ...sourceLeft,
    node: { id: sourceRightId, label: 'SourceRight' } as PositionedType['node'],
    indexInBandOrder: 1,
    x: sourceRightX,
    y: 200,
    width: sourceRightWidth,
    headerArrowX: sourceRightX + 18,
    headerHitWidth: sourceRightWidth,
    visibleRows: [sourceRightRow],
  };
  const targetA: PositionedType = {
    node: { id: targetAId, label: 'TargetA' } as PositionedType['node'],
    bandId: 'c::m',
    bandOrder: 1,
    indexInBandOrder: 0,
    x: targetX,
    y: 100,
    width: targetWidth,
    headerArrowX: null,
    headerHitWidth: targetWidth,
    height: ROW_H,
    depth: 1,
    subrank: 0,
    rank: 1,
    expanded: false,
    visibleRows: [],
  };
  const targetB: PositionedType = {
    ...targetA,
    node: { id: targetBId, label: 'TargetB' } as PositionedType['node'],
    indexInBandOrder: 1,
    y: 140,
  };
  return {
    types: [sourceLeft, sourceRight, targetA, targetB],
    modules: [],
    placedFragments: [
      placedFragment(
        sourceLeftId,
        sourceLeftX,
        180 - ROW_H / 2,
        sourceLeftWidth,
        sourceLeft.height,
        0,
        0,
      ),
      placedFragment(
        sourceRightId,
        sourceRightX,
        200 - ROW_H / 2,
        sourceRightWidth,
        sourceRight.height,
        0,
        1,
      ),
      placedFragment(targetAId, targetX, 100 - ROW_H / 2, targetWidth, ROW_H, 1, 0),
      placedFragment(targetBId, targetX, 140 - ROW_H / 2, targetWidth, ROW_H, 1, 1),
    ],
    ranks: new Map(),
    typesById: new Map([
      [sourceLeftId, sourceLeft],
      [sourceRightId, sourceRight],
      [targetAId, targetA],
      [targetBId, targetB],
    ]),
    debugGrid: {
      originX: 0,
      originY: 0,
      cellWidth: BAND_GRID_CELL_W,
      cellHeight: BAND_GRID_CELL_H,
      width: targetX + targetWidth,
      height: 280,
    },
    globalXStart: 0,
    columnStride: 160,
    totalWidth: targetX + targetWidth,
    totalHeight: 280,
  };
}

function transitiveBatchInputs() {
  const c = crateFacts('c', [
    mod('m', [
      ty('c', 'm', 'SourceTop', [{ name: 'aTop', ty_text: 'TargetTop' }]),
      ty('c', 'm', 'SourceMid', [{ name: 'aMid', ty_text: 'TargetMid' }]),
      ty('c', 'm', 'SourceBot', [{ name: 'aBot', ty_text: 'TargetBot' }]),
      ty('c', 'm', 'TargetTop'),
      ty('c', 'm', 'TargetMid'),
      ty('c', 'm', 'TargetBot'),
    ]),
  ]);
  return buildInputs(
    c,
    [
      edge('c::m::SourceTop', 'c::m::TargetTop', 'field aTop'),
      edge('c::m::SourceMid', 'c::m::TargetMid', 'field aMid'),
      edge('c::m::SourceBot', 'c::m::TargetBot', 'field aBot'),
    ],
    [],
  );
}

function transitiveBatchGeometry(): Geometry {
  // Three forward arrows whose y-spans form a transitive conflict: top and
  // bottom don't y-overlap each other, but middle's span covers both. The
  // old sequential batcher walked groups by left/targetY and closed top's
  // batch when middle didn't y-overlap, so when bottom arrived it joined a
  // *new* batch with middle while top was already alone — leaving top's
  // lane uncoordinated with the others. Union-find batching must put all
  // three in one component and assign distinct lanes in barycenter order.
  const sourceX = 20;
  const sourceWidth = 60;
  const targetX = 240;
  const targetWidth = 80;
  const ids = [
    { source: 'c::m::SourceTop', target: 'c::m::TargetTop', sourceRowY: 80, targetY: 100 },
    { source: 'c::m::SourceMid', target: 'c::m::TargetMid', sourceRowY: 90, targetY: 250 },
    { source: 'c::m::SourceBot', target: 'c::m::TargetBot', sourceRowY: 300, targetY: 200 },
  ];
  const types: PositionedType[] = [];
  const placedFragments: PlacedFragmentRect[] = [];
  const typesByIdEntries: [string, PositionedType][] = [];

  ids.forEach((info, index) => {
    const row = {
      name: `a${info.target.split('::').pop()}`,
      tyText: info.target.split('::').pop() ?? '',
      ownership: 'owned' as const,
      x: sourceX + 24,
      y: info.sourceRowY,
      arrowSourceX: sourceX + sourceWidth - 12,
      targets: [info.target],
      kind: 'field' as const,
      bucketId: null,
    };
    const source: PositionedType = {
      node: { id: info.source, label: info.source } as PositionedType['node'],
      bandId: 'c::m',
      bandOrder: 0,
      indexInBandOrder: index,
      x: sourceX,
      y: info.sourceRowY - 20,
      width: sourceWidth,
      headerArrowX: sourceX + 38,
      headerHitWidth: sourceWidth,
      height: ROW_H + FIELD_ROW_H,
      depth: 0,
      subrank: 0,
      rank: 0,
      expanded: true,
      visibleRows: [row],
    };
    const target: PositionedType = {
      node: { id: info.target, label: info.target } as PositionedType['node'],
      bandId: 'c::m',
      bandOrder: 1,
      indexInBandOrder: index,
      x: targetX,
      y: info.targetY,
      width: targetWidth,
      headerArrowX: null,
      headerHitWidth: targetWidth,
      height: ROW_H,
      depth: 1,
      subrank: 0,
      rank: 1,
      expanded: false,
      visibleRows: [],
    };
    types.push(source, target);
    placedFragments.push(
      placedFragment(
        info.source,
        sourceX,
        source.y - ROW_H / 2,
        sourceWidth,
        source.height,
        0,
        index,
      ),
      placedFragment(info.target, targetX, info.targetY - ROW_H / 2, targetWidth, ROW_H, 1, index),
    );
    typesByIdEntries.push([info.source, source], [info.target, target]);
  });

  return {
    types,
    modules: [],
    placedFragments,
    ranks: new Map(),
    typesById: new Map(typesByIdEntries),
    debugGrid: {
      originX: 0,
      originY: 0,
      cellWidth: BAND_GRID_CELL_W,
      cellHeight: BAND_GRID_CELL_H,
      width: targetX + targetWidth,
      height: 360,
    },
    globalXStart: 0,
    columnStride: 160,
    totalWidth: targetX + targetWidth,
    totalHeight: 360,
  };
}

describe('routeArrows strategy selection', () => {
  it('keeps dogleg as the default backup strategy', () => {
    const inputs = manualRoutingInputs();
    const geometry = manualRoutingGeometry();
    const obstacles = computeObstacles(geometry, measure);

    expect(routeArrows(geometry, obstacles, inputs, measure).arrows).toEqual(
      routeArrowsDogleg(geometry, obstacles, inputs, measure).arrows,
    );
  });
});

describe('routeArrows grid routing', () => {
  it('routes forward LCA arrows through a batched monotone lane', () => {
    const inputs = manualRoutingInputs();
    const geometry = manualRoutingGeometry();
    const routing = routeArrows(geometry, computeObstacles(geometry, measure), inputs, measure, {
      algorithm: 'grid',
    });
    const source = geometry.typesById.get('c::m::Source');
    const target = geometry.typesById.get('c::m::Target');
    const row = source?.visibleRows.find((candidate) => candidate.name === 'target');
    const arrow = routing.arrows.find((candidate) => candidate.toTypeId === 'c::m::Target');
    const [start, sourceStub, targetStub, end] = arrow?.waypoints ?? [];

    expect(arrow?.waypoints).toHaveLength(4);
    expect(start).toEqual({ x: row?.arrowSourceX, y: row?.y });
    expect(sourceStub?.y).toBe(row?.y);
    expect(targetStub?.y).toBe(target?.y);
    expect(sourceStub?.x).toBe(targetStub?.x);
    expect(sourceStub?.x ?? 0).toBeGreaterThanOrEqual(
      (source?.x ?? 0) + (source?.width ?? 0) + BAND_GRID_CELL_W * 0.5,
    );
    expect(end).toEqual({ x: target?.x, y: target?.y });
    expect((end?.x ?? 0) - (targetStub?.x ?? 0)).toBeGreaterThanOrEqual(BAND_GRID_CELL_W * 1.5);
    expect(targetStub?.x).toBeCloseTo((target?.x ?? 0) - BAND_GRID_CELL_W * 1.5);
  });

  it('starts left-exiting fallback rows at the source text anchor', () => {
    const inputs = manualRoutingInputs();
    const geometry = manualRoutingGeometry(null, ['target'], {
      sourceDepth: 1,
      sourceX: 220,
      sourceWidth: 120,
      targetDepth: 0,
      targetX: 40,
    });
    const routing = routeArrows(geometry, computeObstacles(geometry, measure), inputs, measure, {
      algorithm: 'grid',
    });
    const arrow = routing.arrows.find((candidate) => candidate.toTypeId === 'c::m::Target');
    const source = geometry.typesById.get('c::m::Source');
    const row = source?.visibleRows.find((candidate) => candidate.name === 'target');

    // Visible arrows originate from the member text anchor. Later routing
    // rules may use block boundaries as ports, but the rendered start remains
    // tied to the row that owns the relationship.
    expect(arrow?.waypoints[0]).toEqual({ x: row?.x, y: row?.y });
    expect(routeIsOrthogonal(arrow?.waypoints ?? [])).toBe(true);
  });

  it('moves a forward LCA lane away from a non-endpoint obstacle', () => {
    const inputs = manualRoutingInputs();
    const wall = placedFragment('c::m::Wall', 128, 112, 40, 32, 0, 2);
    const geometry = manualRoutingGeometry(wall);
    const routing = routeArrows(geometry, computeObstacles(geometry, measure), inputs, measure, {
      algorithm: 'grid',
    });
    const arrow = routing.arrows.find((candidate) => candidate.toTypeId === 'c::m::Target');

    // This is still monotone lane routing rather than maze routing: it keeps
    // the dogleg shape, but the lane scorer must avoid obvious blockers.
    expect(routeIntersectsRect(arrow?.waypoints ?? [], wall)).toBe(false);
  });

  it('keeps two y-overlapping arrows on distinct columns when both stubs hit the same obstacle', () => {
    // Regression: when several arrows in one batch have their stubs blocked
    // by the same obstacle, the per-group lane scorer used to push every
    // affected lane to that obstacle's right edge — collapsing them onto a
    // single column even though their y-spans clearly overlap. Visual
    // collision (a y-overlapping pair within MIN_LANE_SEP) must outweigh an
    // obstacle-crossing fallback so the lanes spread apart even at the cost
    // of one cutting through the wall.
    const inputs = manualRoutingInputs();
    // Wall sits between source and target with y range covering target.y =
    // 160. Both rows route to the same target, but to expose the
    // convergence bug we use distinct targets at the same x; here the test
    // uses two same-target field rows which previously collapsed onto one
    // lane only because both stubs hit the wall, not because they merged
    // by toTypeId. Use the multi-target geometry with two rows + wall.
    const wall = placedFragment('c::m::Wall', 130, 96, 30, 96, 0, 4);
    const base = multiTargetRoutingGeometry(2);
    const geometry: Geometry = { ...base, placedFragments: [...base.placedFragments, wall] };
    const routing = routeArrows(geometry, computeObstacles(geometry, measure), inputs, measure, {
      algorithm: 'grid',
    });
    const trunkXs = routing.arrows
      .map((arrow) => verticalTrunkX(arrow.waypoints))
      .sort((a, b) => a - b);

    // Two arrows, two distinct trunks. Without the y-overlap-aware scorer
    // both used to land on wall.right + 0.5g.
    expect(routing.arrows).toHaveLength(2);
    expect(new Set(trunkXs).size).toBe(2);
    expect((trunkXs[1] ?? 0) - (trunkXs[0] ?? 0)).toBeGreaterThanOrEqual(BAND_GRID_CELL_W);
  });

  it('prefers a 1-collision detour over cutting through an obstacle on the target stub', () => {
    // Regression for the "blue arrow cuts through arrowheads" case (the
    // user's image #7): two arrows from one source share the corridor, and
    // only one alternative X (the target-side escape) is obstacle-free.
    // Putting the second trunk at its preferred X would route its target
    // stub through a non-endpoint block; tolerating one stacked collision
    // with the first arrow keeps both stubs clean. Quadratic collision
    // cost makes this trade flip from "OK" at one collision to "not OK"
    // at two.
    const inputs = multiTargetRoutingInputs(2);
    // Wall sits at the second target's y-row level; a trunk anywhere left
    // of wall.right would have its target stub at target1.y cut through.
    const wall = placedFragment('c::m::Wall', 130, 88, 60, 8, 0, 4);
    const base = multiTargetRoutingGeometry(2);
    const geometry: Geometry = { ...base, placedFragments: [...base.placedFragments, wall] };
    const routing = routeArrows(geometry, computeObstacles(geometry, measure), inputs, measure, {
      algorithm: 'grid',
    });
    for (const arrow of routing.arrows) {
      // Constraint #7: no segment crosses a non-endpoint obstacle. Even
      // the second arrow (which would prefer a leftward trunk) must reach
      // a clean column rather than slicing through the wall on its stub.
      expect(routeIntersectsRect(arrow.waypoints, wall)).toBe(false);
    }
  });

  it('routes the horizontal target stub around a non-endpoint obstacle at target.y', () => {
    // Regression: the lane scorer used to consider only the vertical-trunk
    // crossing. A wall sharing target.y between source and target was
    // sidestepped by the trunk (which moved off the wall's column) but the
    // horizontal target stub at target.y still ran straight through the
    // wall on its way east. Constraint #7 covers the whole path, so the
    // scorer must reject any candidate whose stub crosses the obstacle and
    // pick a column east of the wall instead.
    const inputs = manualRoutingInputs();
    // target.y in manualRoutingGeometry is 160; wall y-range [148, 172]
    // covers it. Wall x-range [130, 160] sits inside the corridor between
    // source (right=90) and target (left=200), so a leftward-pushed trunk
    // would cleanly pass the vertical check but leave the stub crossing.
    const wall = placedFragment('c::m::Wall', 130, 148, 30, 24, 0, 2);
    const geometry = manualRoutingGeometry(wall);
    const routing = routeArrows(geometry, computeObstacles(geometry, measure), inputs, measure, {
      algorithm: 'grid',
    });
    const arrow = routing.arrows.find((candidate) => candidate.toTypeId === 'c::m::Target');
    const trunkX = verticalTrunkX(arrow?.waypoints ?? []);

    expect(arrow).toBeDefined();
    expect(routeIntersectsRect(arrow?.waypoints ?? [], wall)).toBe(false);
    // The trunk is pushed east of the wall (with the 0.5g corner clearance)
    // so the target stub clears it; without the stub-aware scorer the trunk
    // would land on the wall's left edge and cut through.
    expect(trunkX).toBeGreaterThanOrEqual(wall.x + wall.width);
  });

  it('routes around incompatible source and target stub blockers with extra bends', () => {
    // A single-dogleg router cannot clear both blockers: a left trunk keeps
    // the source stub clean but cuts through WallB at target.y, while a right
    // trunk keeps the target stub clean but cuts through WallA at source.y.
    // Grid routing owns obstacle avoidance, so it should emit an orthogonal
    // detour through open grid space instead of marking either cut as normal.
    const inputs = manualRoutingInputs();
    const wallA = placedFragment('c::m::WallA', 140, 88, 48, 24, 0, 2);
    const wallB = placedFragment('c::m::WallB', 220, 148, 48, 24, 0, 3);
    const base = manualRoutingGeometry(null, ['target'], { sourceWidth: 80, targetX: 320 });
    const geometry: Geometry = {
      ...base,
      placedFragments: [...base.placedFragments, wallA, wallB],
    };

    const routing = routeArrows(geometry, computeObstacles(geometry, measure), inputs, measure, {
      algorithm: 'grid',
    });
    const arrow = routing.arrows.find((candidate) => candidate.toTypeId === 'c::m::Target');

    expect(arrow).toBeDefined();
    expect(arrow?.waypoints.length ?? 0).toBeGreaterThan(4);
    expect(routeIntersectsRect(arrow?.waypoints ?? [], wallA)).toBe(false);
    expect(routeIntersectsRect(arrow?.waypoints ?? [], wallB)).toBe(false);
    expect(finalTargetApproachStartX(arrow?.waypoints ?? [])).toBeLessThanOrEqual(
      320 - BAND_GRID_CELL_W * 1.5,
    );
    expect(routing.debug.routing.lanes.some((lane) => lane.blocked)).toBe(false);
  });

  it('merges same-target forward LCA rows onto one vertical lane', () => {
    const inputs = manualRoutingInputs();
    const geometry = manualRoutingGeometry(null, ['first', 'second', 'third'], {
      sourceWidth: 80,
      targetX: 160,
    });
    const routing = routeArrows(geometry, computeObstacles(geometry, measure), inputs, measure, {
      algorithm: 'grid',
    });
    const trunkXs = routing.arrows.map((arrow) => verticalTrunkX(arrow.waypoints));

    expect(routing.arrows).toHaveLength(3);
    expect(new Set(trunkXs).size).toBe(1);
  });

  it('splits different forward LCA targets into deterministic corridor lanes', () => {
    const inputs = multiTargetRoutingInputs(4);
    const geometry = multiTargetRoutingGeometry(4);
    const routing = routeArrows(geometry, computeObstacles(geometry, measure), inputs, measure, {
      algorithm: 'grid',
    });
    const trunkXs = routing.arrows
      .map((arrow) => verticalTrunkX(arrow.waypoints))
      .sort((a, b) => a - b);

    expect(routing.arrows).toHaveLength(4);
    expect(new Set(trunkXs).size).toBe(4);
    expect(trunkXs).toEqual([164, 172, 180, 188]);
  });

  it('shares lanes by target without collapsing different targets into that lane', () => {
    const inputs = mixedFanInRoutingInputs();
    const geometry = mixedFanInRoutingGeometry();
    const routing = routeArrows(geometry, computeObstacles(geometry, measure), inputs, measure, {
      algorithm: 'grid',
    });
    const targetATrunks = routing.arrows
      .filter((arrow) => arrow.toTypeId === 'c::m::TargetA')
      .map((arrow) => verticalTrunkX(arrow.waypoints));
    const targetBTrunks = routing.arrows
      .filter((arrow) => arrow.toTypeId === 'c::m::TargetB')
      .map((arrow) => verticalTrunkX(arrow.waypoints));

    expect(targetATrunks).toHaveLength(2);
    expect(targetBTrunks).toHaveLength(1);
    expect(new Set(targetATrunks).size).toBe(1);
    expect(Math.abs((targetBTrunks[0] ?? 0) - (targetATrunks[0] ?? 0))).toBeGreaterThanOrEqual(
      BAND_GRID_CELL_W,
    );
  });

  it('right-packs lanes unless a non-endpoint obstacle forces an escape lane', () => {
    // SourceLeft's right-packed stub would cut through SourceRight's block.
    // The router should keep SourceRight's clear right-packed lane, while
    // routing SourceLeft on an escape lane that avoids the non-endpoint block.
    const inputs = offsetSourcesInputs();
    const geometry = offsetSourcesGeometry();
    const routing = routeArrows(geometry, computeObstacles(geometry, measure), inputs, measure, {
      algorithm: 'grid',
    });
    const targetA = geometry.typesById.get('c::m::TargetA');
    const arrowToA = routing.arrows.find((a) => a.toTypeId === 'c::m::TargetA');
    const arrowToB = routing.arrows.find((a) => a.toTypeId === 'c::m::TargetB');
    const trunkToA = verticalTrunkX(arrowToA?.waypoints ?? []);
    const trunkToB = verticalTrunkX(arrowToB?.waypoints ?? []);
    const sourceRightObstacle = geometry.placedFragments.find(
      (fragment) => fragment.typeId === 'c::m::SourceRight',
    );
    if (sourceRightObstacle === undefined) throw new Error('missing SourceRight obstacle');

    const targetLeft = targetA?.x ?? 0;
    expect(trunkToB).toBeCloseTo(targetLeft - BAND_GRID_CELL_W * 1.5);
    expect(trunkToA).toBeLessThan(sourceRightObstacle.x);
    expect(routeIntersectsRect(arrowToA?.waypoints ?? [], sourceRightObstacle)).toBe(false);
  });

  it('batches transitive y-conflicts so all three lanes coordinate', () => {
    // Regression: the old sequential batcher walked groups left-to-right
    // and could close a batch before reaching a later group that conflicted
    // with both the current and previous batch. Top and bottom arrows here
    // don't y-overlap each other but middle's y-span covers both — so all
    // three must share one batch and assign distinct lanes in barycenter
    // order. Without union-find batching, top would land alone at its
    // singleton centerline while middle and bottom shared a separate
    // corridor, and top's lane would not respect the others.
    const inputs = transitiveBatchInputs();
    const geometry = transitiveBatchGeometry();
    const routing = routeArrows(geometry, computeObstacles(geometry, measure), inputs, measure, {
      algorithm: 'grid',
    });
    const trunkTop = verticalTrunkX(
      routing.arrows.find((a) => a.toTypeId === 'c::m::TargetTop')?.waypoints ?? [],
    );
    const trunkMid = verticalTrunkX(
      routing.arrows.find((a) => a.toTypeId === 'c::m::TargetMid')?.waypoints ?? [],
    );
    const trunkBot = verticalTrunkX(
      routing.arrows.find((a) => a.toTypeId === 'c::m::TargetBot')?.waypoints ?? [],
    );

    // Barycenters still define deterministic processing order, but lanes are
    // now right-packed next to the target column: Top gets the rightmost lane,
    // Mid one lane left, Bot the next lane left.
    expect(trunkTop).toBe(228);
    expect(trunkMid).toBe(220);
    expect(trunkBot).toBe(212);
  });
});

describe('routeArrows dogleg routing', () => {
  it('routes LCA-forward ownership as source right to target left', () => {
    const inputs = manualRoutingInputs();
    const geometry = manualRoutingGeometry();
    const { arrows } = routeArrows(geometry, computeObstacles(geometry, measure), inputs, measure);

    const arrow = arrows.find((candidate) => candidate.toTypeId === 'c::m::Target');
    const source = geometry.typesById.get('c::m::Source');
    const target = geometry.typesById.get('c::m::Target');
    const row = source?.visibleRows.find((candidate) => candidate.name === 'target');

    expect(arrow?.waypoints).toHaveLength(5);
    const [start, sourcePort, trunkTop, trunkBottom, end] = arrow?.waypoints ?? [];
    expect(start).toEqual({ x: row?.arrowSourceX, y: row?.y });
    expect(sourcePort).toEqual({ x: (source?.x ?? 0) + (source?.width ?? 0), y: row?.y });
    expect(end).toEqual({ x: target?.x, y: target?.y });
    expect(sourcePort?.x).toBeLessThan(trunkTop?.x ?? Number.NEGATIVE_INFINITY);
    expect(trunkTop?.x).toBeLessThan(end?.x ?? Number.NEGATIVE_INFINITY);
    expect(trunkTop?.x).toBe(trunkBottom?.x);
  });

  it('allows same-target vertical trunks to reuse the same routing lane', () => {
    const inputs = manualRoutingInputs();
    const geometry = manualRoutingGeometry(null, ['first', 'second'], {
      sourceWidth: 80,
      targetX: 116,
    });
    const { arrows, debug } = routeArrows(
      geometry,
      computeObstacles(geometry, measure),
      inputs,
      measure,
    );

    const trunkXs = arrows.map((arrow) => verticalTrunkX(arrow.waypoints)).sort((a, b) => a - b);
    const laneXs = debug.routing.lanes.map((lane) => lane.x).sort((a, b) => a - b);

    expect(arrows).toHaveLength(2);
    expect(new Set(trunkXs).size).toBe(1);
    expect(laneXs).toEqual(trunkXs);
  });

  it('does not split neighboring same-target vertical trunks into visual subtracks', () => {
    const inputs = manualRoutingInputs();
    const geometry = manualRoutingGeometry(null, ['first', 'second', 'third'], {
      sourceWidth: 80,
      targetX: 160,
    });
    const { arrows } = routeArrows(geometry, computeObstacles(geometry, measure), inputs, measure);

    const trunkXs = arrows.map((arrow) => verticalTrunkX(arrow.waypoints)).sort((a, b) => a - b);

    expect(arrows).toHaveLength(3);
    expect(new Set(trunkXs).size).toBe(1);
  });

  it('spreads different-target overlapping trunks onto grid-spaced lanes', () => {
    const inputs = multiTargetRoutingInputs(5);
    const geometry = multiTargetRoutingGeometry(5);
    const { arrows } = routeArrows(geometry, computeObstacles(geometry, measure), inputs, measure);
    const trunkXs = arrows.map((arrow) => verticalTrunkX(arrow.waypoints)).sort((a, b) => a - b);

    expect(arrows).toHaveLength(5);
    expect(new Set(trunkXs).size).toBe(5);
    for (let index = 1; index < trunkXs.length; index += 1) {
      expect((trunkXs[index] ?? 0) - (trunkXs[index - 1] ?? 0)).toBeGreaterThanOrEqual(
        BAND_GRID_CELL_W,
      );
    }
  });

  it('keeps ordered source and target rows from crossing each other', () => {
    const inputs = manualRoutingInputs();
    const geometry = orderedTwoTargetGeometry();
    const { arrows } = routeArrows(geometry, computeObstacles(geometry, measure), inputs, measure);
    const upper = arrows.find((arrow) => arrow.toTypeId === 'c::m::UpperTarget');
    const lower = arrows.find((arrow) => arrow.toTypeId === 'c::m::LowerTarget');

    expect(upper).toBeDefined();
    expect(lower).toBeDefined();
    expect(verticalTrunkX(upper?.waypoints ?? [])).toBeLessThan(
      verticalTrunkX(lower?.waypoints ?? []),
    );
    expect(routePairCrosses(upper?.waypoints ?? [], lower?.waypoints ?? [])).toBe(false);
  });

  it('routes LCA-backward ownership from either source side into target left', () => {
    const c = crateFacts('c', [
      mod('m', [
        ty('c', 'm', 'A', [{ name: 'b', ty_text: 'B' }]),
        ty('c', 'm', 'B', [{ name: 'a', ty_text: 'A' }]),
      ]),
    ]);
    const inputs = buildInputs(
      c,
      [edge('c::m::A', 'c::m::B', 'field b'), edge('c::m::B', 'c::m::A', 'field a')],
      ['c', 'c::m', 'c::m::A', 'c::m::B'],
    );
    const geometry = computeGeometry(inputs);
    const { arrows } = routeArrows(geometry, computeObstacles(geometry, measure), inputs, measure);
    const a = geometry.typesById.get('c::m::A');
    const b = geometry.typesById.get('c::m::B');

    const backward = arrows.find(
      (candidate) => candidate.fromTypeId === 'c::m::B' && candidate.toTypeId === 'c::m::A',
    );
    const [start, sourcePort, trunkTop, trunkBottom, end] = backward?.waypoints ?? [];

    expect(backward?.waypoints).toHaveLength(5);
    expect(start).toEqual({
      x: b?.visibleRows.find((r) => r.name === 'a')?.x,
      y: b?.visibleRows.find((r) => r.name === 'a')?.y,
    });
    expect(sourcePort).toEqual({ x: b?.x, y: b?.visibleRows.find((r) => r.name === 'a')?.y });
    expect(end).toEqual({ x: a?.x, y: a?.y });
    expect(trunkTop?.x).toBeLessThan(end?.x ?? Number.NEGATIVE_INFINITY);
    expect(trunkTop?.x).toBe(trunkBottom?.x);
  });

  it('always enters targets from the left even for free-form arrows', () => {
    const caller = {
      ...ty('c', 'm', 'Caller'),
      methods: [
        {
          name: 'use_target',
          visibility: 'pub',
          params: [{ name: 'target', ty_text: 'Target' }],
        },
      ],
    };
    const c = crateFacts('c', [mod('m', [caller, ty('c', 'm', 'Target')])]);
    const inputs = {
      ...buildInputs(
        c,
        [
          {
            from: 'c::m::Caller',
            to: 'c::m::Target',
            kind: 'borrows_immut' as const,
            via: 'fn_param' as const,
            origin: 'fn use_target param target',
          },
        ],
        ['c', 'c::m', 'c::m::Caller', 'c::m::Caller::__methods_pub'],
      ),
      methodArrowsShown: new Set(['c::m::Caller\x1Fuse_target']),
    };
    const geometry = computeGeometry(inputs);
    const routing = routeArrows(geometry, computeObstacles(geometry, measure), inputs, measure);
    const arrow = routing.arrows.find((candidate) => candidate.kind === 'method');
    const target = geometry.typesById.get('c::m::Target');
    const vertical = arrow?.waypoints.find(
      (point, index, points) => index > 0 && points[index - 1]?.x === point.x,
    );

    expect(arrow?.waypoints.at(-1)).toEqual({ x: target?.x, y: target?.y });
    expect(vertical?.x).toBeLessThanOrEqual(target?.x ?? Number.NEGATIVE_INFINITY);
  });

  it('emits method and re-export arrows as non-LCA doglegs', () => {
    const caller = {
      ...ty('c', 'm', 'Caller'),
      methods: [
        {
          name: 'use_target',
          visibility: 'pub',
          params: [{ name: 'target', ty_text: 'Target' }],
        },
      ],
    };
    const c = crateFacts('c', [mod('m', [caller, ty('c', 'm', 'Target')])]);
    const methodInputs = {
      ...buildInputs(
        c,
        [
          {
            from: 'c::m::Caller',
            to: 'c::m::Target',
            kind: 'borrows_immut' as const,
            via: 'fn_param' as const,
            origin: 'fn use_target param target',
          },
        ],
        ['c', 'c::m', 'c::m::Caller', 'c::m::Caller::__methods_pub'],
      ),
      methodArrowsShown: new Set(['c::m::Caller\x1Fuse_target']),
    };
    const methodGeometry = computeGeometry(methodInputs);
    const methodRouting = routeArrows(
      methodGeometry,
      computeObstacles(methodGeometry, measure),
      methodInputs,
      measure,
    );
    expect(methodRouting.arrows.find((arrow) => arrow.kind === 'method')?.toTypeId).toBe(
      'c::m::Target',
    );

    const reexportCrate = crateFacts('c', [
      {
        path: 'm',
        file: 'src/m.rs',
        types: [ty('c', 'm', 'Real')],
        functions: [],
        re_exports: [
          {
            exposed_name: 'Alias',
            target_path: 'c::m::Real',
            visibility: 'pub',
            kind: 'type',
            target_kind: 'struct',
          },
        ],
      },
    ]);
    const reexportInputs = {
      ...buildInputs(reexportCrate, [], ['c', 'c::m']),
      ghostArrowsShown: new Set(['c::m::__re_Alias']),
    };
    const reexportGeometry = computeGeometry(reexportInputs);
    const reexportRouting = routeArrows(
      reexportGeometry,
      computeObstacles(reexportGeometry, measure),
      reexportInputs,
      measure,
    );
    expect(reexportRouting.arrows.find((arrow) => arrow.kind === 'reexport')?.toTypeId).toBe(
      'c::m::Real',
    );
  });

  it('keeps every route to a single dogleg and chooses a clear trunk when possible', () => {
    const inputs = manualRoutingInputs();
    const wall = placedFragment('c::m::Wall', 136, 112, 16, 32, 0, 2);
    const geometry = manualRoutingGeometry(wall);
    const routing = routeArrows(geometry, computeObstacles(geometry, measure), inputs, measure);
    const arrow = routing.arrows.find((candidate) => candidate.toTypeId === 'c::m::Target');

    expect(arrow?.waypoints).toHaveLength(5);
    expect(routeIntersectsRect(arrow?.waypoints ?? [], wall)).toBe(false);
    expect(routing.debug.routing.lanes[0]?.blocked).toBe(false);
  });

  it('starts expanded-row doglegs at the source boundary', () => {
    const inputs = manualRoutingInputs();
    const geometry = manualRoutingGeometry(null, ['target'], { sourceWidth: 150, targetX: 240 });
    const routing = routeArrows(geometry, computeObstacles(geometry, measure), inputs, measure);
    const arrow = routing.arrows.find((candidate) => candidate.toTypeId === 'c::m::Target');
    const [rowAnchor, sourcePort, trunkTop] = arrow?.waypoints ?? [];
    const sourceRight = 20 + 150;

    // Field arrows keep their semantic row anchor, but the dogleg starts at
    // the source boundary so the long route cannot cut through expanded text.
    expect(rowAnchor).toEqual({ x: 80, y: 100 });
    expect(sourcePort).toEqual({ x: sourceRight, y: 100 });
    const trunkX = trunkTop?.x;
    expect(trunkX).toBeGreaterThan(sourceRight);
    expect(trunkX).toBeLessThan(240);
    expect(routing.debug.routing.lanes[0]?.blocked).toBe(false);
  });

  it('considers farther-left obstacle-edge lanes for left-side doglegs', () => {
    const inputs = manualRoutingInputs();
    const wall = placedFragment('c::m::Wall', 64, 112, 108, 32, 0, 2);
    const geometry = manualRoutingGeometry(wall, ['target'], {
      sourceDepth: 1,
      sourceX: 300,
      targetDepth: 0,
      targetX: 180,
    });
    const routing = routeArrows(geometry, computeObstacles(geometry, measure), inputs, measure);
    const arrow = routing.arrows.find((candidate) => candidate.toTypeId === 'c::m::Target');
    const lane = routing.debug.routing.lanes[0];

    expect(arrow?.waypoints).toHaveLength(5);
    expect(lane?.x).toBeLessThan(wall.x);
    expect(routeIntersectsRect(arrow?.waypoints ?? [], wall)).toBe(false);
    expect(lane?.blocked).toBe(false);
  });

  it('reuses same-target vertical trunks before compression', () => {
    const inputs = manualRoutingInputs();
    const geometry = manualRoutingGeometry(null, ['targetA', 'targetB']);
    const routing = routeArrows(geometry, computeObstacles(geometry, measure), inputs, measure);
    const laneXs = routing.debug.routing.lanes.map((lane) => lane.x);

    expect(routing.arrows).toHaveLength(2);
    expect(new Set(laneXs).size).toBe(1);
  });

  it('marks the least-bad dogleg as blocked when every trunk cuts occupied cells', () => {
    const inputs = manualRoutingInputs();
    const wall = placedFragment('c::m::Wall', 88, 80, 112, 112, 0, 2);
    const geometry = manualRoutingGeometry(wall);
    const routing = routeArrows(geometry, computeObstacles(geometry, measure), inputs, measure);

    expect(routing.arrows[0]?.waypoints).toHaveLength(5);
    expect(routing.debug.routing.lanes[0]?.blocked).toBe(true);
  });
});
