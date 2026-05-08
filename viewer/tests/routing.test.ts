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
