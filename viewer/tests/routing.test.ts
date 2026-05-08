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
import {
  FALLBACK_RECOVERY_EXTRA_CELLS,
  LANE_W,
  ROUTE_GAP,
  computeRoutingPressureForArrowGroups,
  routeArrows,
} from '../src/layout/routing.ts';
import type { PlacedFragmentRect, PositionedType } from '../src/layout/types.ts';
import { buildInputs, crateFacts, edge, mod, ty } from './fixtures/builders.ts';
import { mediumFixtureInputs } from './fixtures/medium.ts';
import { smallFixtureInputs } from './fixtures/small.ts';

const measure = (s: string): number => s.length * 7;

function crowdedTargetInputs() {
  const fields = Array.from({ length: 10 }, (_, index) => ({
    name: `target${index}`,
    ty_text: 'Target',
  }));
  const c = crateFacts('c', [mod('m', [ty('c', 'm', 'Source', fields), ty('c', 'm', 'Target')])]);
  const edges = fields.map((field) => edge('c::m::Source', 'c::m::Target', `field ${field.name}`));

  return buildInputs(c, edges, ['c', 'c::m', 'c::m::Source']);
}

function positionedTypeStub(
  id: string,
  bandOrder: number,
  x: number,
  width: number,
): PositionedType {
  return {
    node: { id, label: id } as PositionedType['node'],
    bandId: 'band:a',
    bandOrder,
    indexInBandOrder: 0,
    x,
    y: ROW_H / 2,
    width,
    headerArrowX: null,
    headerHitWidth: width,
    height: ROW_H,
    depth: bandOrder,
    subrank: 0,
    rank: bandOrder,
    expanded: false,
    visibleRows: [],
  };
}

function fragmentRectStub(
  typeId: string,
  bandOrder: number,
  fragmentKind: PlacedFragmentRect['fragmentKind'],
  x: number,
  width: number,
  fragmentIndex: number,
): PlacedFragmentRect {
  return {
    typeId,
    bandId: 'band:a',
    bandOrder,
    indexInBandOrder: 0,
    fragmentId: `${fragmentIndex}:${fragmentKind}`,
    fragmentIndex,
    fragmentKind,
    rowIds: fragmentKind === 'body' ? [`${typeId}:row:wide`] : [],
    x,
    y: fragmentIndex * ROW_H,
    width,
    height: ROW_H,
  };
}

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
  wall: PlacedFragmentRect,
  rowNames: readonly string[] = ['target'],
): Geometry {
  const sourceId = 'c::m::Source';
  const targetId = 'c::m::Target';
  const rows = rowNames.map((name, index) => ({
    name,
    tyText: 'Target',
    ownership: 'owned' as const,
    x: 44,
    y: 100 + index * FIELD_ROW_H,
    arrowSourceX: 80,
    targets: [targetId],
    kind: 'field' as const,
    bucketId: null,
  }));
  const source: PositionedType = {
    node: { id: sourceId, label: 'Source' } as PositionedType['node'],
    bandId: 'c::m',
    bandOrder: 0,
    indexInBandOrder: 0,
    x: 20,
    y: 80,
    width: 70,
    headerArrowX: 58,
    headerHitWidth: 76,
    height: ROW_H + rowNames.length * FIELD_ROW_H,
    depth: 0,
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
    x: 200,
    y: 160,
    width: 70,
    headerArrowX: null,
    headerHitWidth: 70,
    height: ROW_H,
    depth: 1,
    subrank: 0,
    rank: 1,
    expanded: false,
    visibleRows: [],
  };
  const placedFragments = [
    placedFragment(sourceId, 20, 80 - ROW_H / 2, 70, ROW_H + rowNames.length * FIELD_ROW_H, 0, 0),
    placedFragment(targetId, 200, 160 - ROW_H / 2, 70, ROW_H, 1, 0),
    wall,
  ];
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
      width: 270,
      height: 190,
    },
    globalXStart: 0,
    columnStride: 160,
    totalWidth: 270,
    totalHeight: 190,
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
    if (from === undefined || to === undefined) {
      continue;
    }
    if (from.x === to.x && verticalSegmentIntersectsRect(from.x, from.y, to.y, rect)) {
      return true;
    }
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
    x <= rect.x + rect.width &&
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
    y <= rect.y + rect.height &&
    rangesOverlap(Math.min(fromX, toX), Math.max(fromX, toX), rect.x, rect.x + rect.width)
  );
}

function rangesOverlap(aMin: number, aMax: number, bMin: number, bMax: number): boolean {
  return aMin < bMax && bMin < aMax;
}

describe('routeArrows — forward edge', () => {
  it('expanded App emits a 4-waypoint arrow to Engine from the current physical side', () => {
    const inputs = smallFixtureInputs(['c', 'c::core', 'c::render', 'c::App']);
    const geometry = computeGeometry(inputs);
    const obstacles = computeObstacles(geometry, measure);
    const { arrows } = routeArrows(geometry, obstacles, inputs, measure);

    const a = arrows.find((x) => x.toTypeId === 'c::core::Engine');
    expect(a).toBeDefined();
    expect(a?.waypoints).toHaveLength(4);

    const engine = geometry.typesById.get('c::core::Engine');
    const app = geometry.typesById.get('c::App');
    expect(engine).toBeDefined();
    expect(app).toBeDefined();

    const [w0, w1, w2, w3] = a?.waypoints ?? [];
    const row = app?.visibleRows.find((r) => r.name === 'engine');
    expect(row).toBeDefined();
    const usesForwardSide = (row?.arrowSourceX ?? 0) + ROUTE_GAP < (engine?.x ?? 0);
    expect(w0?.x).toBe(usesForwardSide ? row?.arrowSourceX : (row?.x ?? 0) - 4);

    expect(w1?.x).toBe(w2?.x);
    // The endpoint side is deterministic; the channel planner may still pick
    // either side of the source/target pair while routing around obstacles.
    expect(w1?.x).not.toBe(w0?.x);
    // Vertical leg shares x; only y changes.
    expect(w1?.y).toBe(w0?.y);
    expect(w2?.y).toBe(w3?.y);
    // Final segment terminates at the target's left edge.
    expect(w3?.x).toBe(engine?.x);
    expect(w3?.y).toBe(engine?.y);
  });
});

describe('routeArrows — reverse edge', () => {
  it('back-edge (cycle) produces a reverse arrow: source.left → target.left through the left gutter', () => {
    // A↔B cycle. Kahn breaks one direction as a back-edge:
    //   A.depth = 0 (the surviving owner edge points B → A)
    //   B.depth = 1 (owned by A)
    // BUT both edges remain in `ownership.owns`, so routing emits both
    // arrows. The "interesting" one is B → A, where source (B) is at
    // depth 1 (right) and target (A) is at depth 0 (left) — reverse.
    const c = crateFacts('c', [
      mod('m', [
        ty('c', 'm', 'A', [{ name: 'b', ty_text: 'B' }]),
        ty('c', 'm', 'B', [{ name: 'a', ty_text: 'A' }]),
      ]),
    ]);
    const edges = [edge('c::m::A', 'c::m::B', 'field b'), edge('c::m::B', 'c::m::A', 'field a')];
    const inputs = buildInputs(c, edges, ['c', 'c::m', 'c::m::A', 'c::m::B']);
    const geometry = computeGeometry(inputs);
    const obstacles = computeObstacles(geometry, measure);
    const { arrows } = routeArrows(geometry, obstacles, inputs, measure);

    const a = geometry.typesById.get('c::m::A');
    const b = geometry.typesById.get('c::m::B');
    expect(a && b).toBeTruthy();
    // Sanity: B is right of A (since B.depth > A.depth after Kahn).
    expect(b?.x ?? 0).toBeGreaterThan(a?.x ?? 0);

    const reverse = arrows.find((x) => x.fromTypeId === 'c::m::B' && x.toTypeId === 'c::m::A');
    expect(reverse).toBeDefined();
    const [w0, w1, w2, w3] = reverse?.waypoints ?? [];

    // Reverse arrow exits just before the source row text.
    expect(w0?.x).toBe((b?.visibleRows.find((r) => r.name === 'a')?.x ?? 0) - 4);
    // The vertical leg sits in the gutter LEFT of target, so:
    expect(w1?.x).toBe(w2?.x); // shared lane x
    expect(w1?.x).toBeLessThan(w0?.x ?? 0); // first horizontal segment goes LEFT
    expect(w1?.x).toBeLessThan(a?.x ?? 0); // lane is left of target
    expect(w3?.x).toBe(a?.x); // terminates at target.left
    expect(w3?.x).toBeGreaterThan(w2?.x ?? 0); // final segment goes RIGHT
  });
});

describe('routeArrows — method and ghost parity', () => {
  it('emits opt-in method arrows with method row identity', () => {
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
    const obstacles = computeObstacles(geometry, measure);
    const { arrows } = routeArrows(geometry, obstacles, inputs, measure);

    const arrow = arrows.find((a) => a.kind === 'method');
    expect(arrow?.fromTypeId).toBe('c::m::Caller');
    expect(arrow?.fromFieldName).toBe('use_target');
    expect(arrow?.fromRowKind).toBe('method');
    expect(arrow?.toTypeId).toBe('c::m::Target');
  });

  it('emits re-export ghost arrows only for shown ghosts', () => {
    const c = crateFacts('c', [
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
    const base = buildInputs(c, [], ['c', 'c::m']);
    const hiddenInputs = { ...base, ghostArrowsShown: new Set<string>() };
    const shownInputs = { ...base, ghostArrowsShown: new Set(['c::m::__re_Alias']) };

    const hiddenGeometry = computeGeometry(hiddenInputs);
    const hidden = routeArrows(
      hiddenGeometry,
      computeObstacles(hiddenGeometry, measure),
      hiddenInputs,
      measure,
    );
    expect(hidden.arrows.filter((a) => a.kind === 'reexport')).toHaveLength(0);

    const shownGeometry = computeGeometry(shownInputs);
    const shown = routeArrows(
      shownGeometry,
      computeObstacles(shownGeometry, measure),
      shownInputs,
      measure,
    );
    const arrow = shown.arrows.find((a) => a.kind === 'reexport');
    expect(arrow?.fromTypeId).toBe('c::m::__re_Alias');
    expect(arrow?.toTypeId).toBe('c::m::Real');
  });
});

describe('routeArrows — lane allocation', () => {
  it('many arrows into one target column get allocated to distinct lane x values when overlapping in y', () => {
    // Root owns 12 R-leaves at depth 2 in the medium fixture. Expand
    // Root so all 12 field rows fire arrows into the R-leaf column.
    // Sources fan vertically (one per field row); targets all share
    // the same gutter (left of the R-column).
    const inputs = mediumFixtureInputs(['c', 'c::m', 'c::m::Root']);
    const geometry = computeGeometry(inputs);
    const obstacles = computeObstacles(geometry, measure);
    const { arrows } = routeArrows(geometry, obstacles, inputs, measure);

    const rArrows = arrows.filter((a) => /^c::m::R\d+$/.test(a.toTypeId));
    expect(rArrows.length).toBe(12);

    // Group by target's column subrank — each subcol's arrows share a
    // gutter. Within a gutter, lanes (vertical-leg x) should be
    // distributed across multiple distinct values rather than all
    // collapsing to one x.
    const lanesByTarget = new Map<string, Set<number>>();
    for (const a of rArrows) {
      const w1 = a.waypoints[1];
      if (!w1) continue;
      const targetX = a.waypoints[3]?.x ?? 0;
      const key = String(targetX);
      let set = lanesByTarget.get(key);
      if (!set) {
        set = new Set();
        lanesByTarget.set(key, set);
      }
      set.add(w1.x);
    }

    // At least one gutter should have used multiple lane positions
    // (otherwise allocation is broken).
    const maxLanesUsed = Math.max(...[...lanesByTarget.values()].map((s) => s.size));
    expect(maxLanesUsed).toBeGreaterThan(1);
  });

  it('lane x values within a gutter stay on the default LANE_W grid', () => {
    // Same setup. The compact band-local geometry can ask for routing
    // reflow before the routing refactor, but lane slots that are allocated
    // in a gutter should still land on the default lane grid.
    const inputs = mediumFixtureInputs(['c', 'c::m', 'c::m::Root']);
    const geometry = computeGeometry(inputs);
    const obstacles = computeObstacles(geometry, measure);
    const { arrows } = routeArrows(geometry, obstacles, inputs, measure);

    // Pick one target gutter, look at the distinct lane xs.
    const rArrows = arrows.filter((a) => /^c::m::R\d+$/.test(a.toTypeId));
    const lanesByTarget = new Map<number, number[]>();
    for (const a of rArrows) {
      const w1 = a.waypoints[1];
      const tx = a.waypoints[3]?.x;
      if (!w1 || tx === undefined) continue;
      let arr = lanesByTarget.get(tx);
      if (!arr) {
        arr = [];
        lanesByTarget.set(tx, arr);
      }
      arr.push(w1.x);
    }
    for (const list of lanesByTarget.values()) {
      const sorted = [...new Set(list)].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1];
        const cur = sorted[i];
        if (prev === undefined || cur === undefined) continue;
        expect((cur - prev) % LANE_W).toBe(0);
      }
    }
  });
});

describe('routeArrows — channel planner integration', () => {
  it('emits waypoints that avoid an unrelated obstacle on the legacy horizontal segment', () => {
    const inputs = manualRoutingInputs();
    const wall = placedFragment('c::m::Wall', 90, 95, 20, 10, 0, 2);
    const geometry = manualRoutingGeometry(wall);
    const obstacles = computeObstacles(geometry, measure);
    const { arrows, debug, needsReflow } = routeArrows(geometry, obstacles, inputs, measure);

    const arrow = arrows.find((candidate) => candidate.toTypeId === 'c::m::Target');
    expect(arrow).toBeDefined();

    const legacyWaypoints = [
      { x: 80, y: 100 },
      { x: 120, y: 100 },
      { x: 120, y: 160 },
      { x: 200, y: 160 },
    ];
    expect(routeIntersectsRect(legacyWaypoints, wall)).toBe(true);
    expect(routeIntersectsRect(arrow?.waypoints ?? [], wall)).toBe(false);
    expect(arrow?.waypoints).toEqual([
      { x: 80, y: 100 },
      { x: 88, y: 100 },
      { x: 88, y: 160 },
      { x: 200, y: 160 },
    ]);
    expect(debug.routing.lanes).toEqual([
      {
        x: 88,
        yMin: 100,
        yMax: 160,
        fromTypeId: 'c::m::Source',
        toTypeId: 'c::m::Target',
        bundleKey: '200',
        blocked: false,
      },
    ]);
    expect(needsReflow).toBe(false);
  });

  it('propagates planner fallback metadata to reflow and blocked lane debug output', () => {
    const inputs = manualRoutingInputs();
    const wall = placedFragment('c::m::Wall', -100, -100, 500, 500, 0, 2);
    const geometry = manualRoutingGeometry(wall);
    const obstacles = computeObstacles(geometry, measure);
    const { arrows, debug, needsReflow } = routeArrows(geometry, obstacles, inputs, measure);
    const arrow = arrows.find((candidate) => candidate.toTypeId === 'c::m::Target');
    const verticalX = arrow?.waypoints.find((waypoint, index, waypoints) => {
      const next = waypoints[index + 1];
      return next !== undefined && waypoint.x === next.x && waypoint.y !== next.y;
    })?.x;

    expect(needsReflow).toBe(true);
    expect(verticalX).toBeDefined();
    expect(debug.routing.lanes).toEqual([
      {
        x: verticalX,
        yMin: 100,
        yMax: 160,
        fromTypeId: 'c::m::Source',
        toTypeId: 'c::m::Target',
        bundleKey: '200',
        blocked: true,
      },
    ]);
  });
});

describe('routeArrows — routing pressure', () => {
  it('reports an x afterOrder extra gap before a crowded target group', () => {
    const inputs = crowdedTargetInputs();
    const geometry = computeGeometry(inputs);
    const obstacles = computeObstacles(geometry, measure);
    const { routingPressure } = routeArrows(geometry, obstacles, inputs, measure);

    expect(geometry.typesById.get('c::m::Target')?.bandOrder).toBe(1);
    expect(routingPressure).toEqual([
      {
        bandId: 'c::m',
        axis: 'x',
        afterOrder: 0,
        cells: 3,
      },
    ]);
  });

  it('measures available channel cells from placed fragment extents instead of header width', () => {
    const previous = positionedTypeStub('previous', 0, 0, 140);
    const target = positionedTypeStub('target', 1, 208, 140);
    const previousHeader = fragmentRectStub(previous.node.id, 0, 'main', 0, previous.width, 0);
    const previousBody = fragmentRectStub(previous.node.id, 0, 'body', 0, 200, 1);
    const targetHeader = fragmentRectStub(target.node.id, 1, 'main', target.x, target.width, 0);
    const geometry: Geometry = {
      types: [previous, target],
      modules: [],
      placedFragments: [previousHeader, previousBody, targetHeader],
      ranks: new Map(),
      typesById: new Map([[target.node.id, target]]),
      debugGrid: {
        originX: 0,
        originY: 0,
        cellWidth: BAND_GRID_CELL_W,
        cellHeight: BAND_GRID_CELL_H,
        width: target.x + target.width,
        height: ROW_H,
      },
      globalXStart: 0,
      columnStride: 240,
      totalWidth: target.x + target.width,
      totalHeight: ROW_H,
    };

    const legacyHeaderAvailableCells = Math.floor(
      (target.x - (previous.x + previous.width)) / BAND_GRID_CELL_W,
    );
    const realFragmentAvailableCells = Math.floor(
      (targetHeader.x - (previousBody.x + previousBody.width)) / BAND_GRID_CELL_W,
    );

    expect(previousBody.width).toBeGreaterThan(previous.width);
    expect(legacyHeaderAvailableCells).toBeGreaterThanOrEqual(2);
    expect(realFragmentAvailableCells).toBe(1);
    expect(
      computeRoutingPressureForArrowGroups(
        geometry,
        [
          { toTypeId: target.node.id, side: 'forward' },
          { toTypeId: target.node.id, side: 'forward' },
        ],
        { maxArrowsPerCell: { forward: 1, backward: 4 } },
      ),
    ).toEqual([
      {
        bandId: 'band:a',
        axis: 'x',
        afterOrder: 0,
        cells: 1,
      },
    ]);
  });

  it('adds bounded target-side fallback recovery pressure when final planning falls back', () => {
    const inputs = manualRoutingInputs();
    const wall = placedFragment('c::m::Wall', -100, -100, 500, 500, 0, 2);
    const geometry = manualRoutingGeometry(wall);
    const obstacles = computeObstacles(geometry, measure);
    const { needsReflow, routingPressure } = routeArrows(geometry, obstacles, inputs, measure);

    expect(needsReflow).toBe(true);
    expect(routingPressure).toEqual([
      {
        bandId: 'c::m',
        axis: 'x',
        afterOrder: 0,
        cells: FALLBACK_RECOVERY_EXTRA_CELLS,
      },
    ]);
  });

  it('deduplicates same-channel fallback recovery pressure with max cells', () => {
    const inputs = manualRoutingInputs();
    const wall = placedFragment('c::m::Wall', -100, -100, 500, 500, 0, 2);
    const geometry = manualRoutingGeometry(wall, ['targetA', 'targetB']);
    const obstacles = computeObstacles(geometry, measure);
    const { arrows, routingPressure } = routeArrows(geometry, obstacles, inputs, measure);

    expect(arrows).toHaveLength(2);
    expect(routingPressure).toEqual([
      {
        bandId: 'c::m',
        axis: 'x',
        afterOrder: 0,
        cells: FALLBACK_RECOVERY_EXTRA_CELLS,
      },
    ]);
  });
});

describe('routeArrows — no targets visible', () => {
  it('arrow is skipped when its target is not in the geometry (collapsed module)', () => {
    // Only crate root expanded → Engine is not visible. App owns Engine
    // but the arrow can't terminate.
    const inputs = smallFixtureInputs(['c']);
    const geometry = computeGeometry(inputs);
    const obstacles = computeObstacles(geometry, measure);
    const { arrows } = routeArrows(geometry, obstacles, inputs, measure);

    // App isn't even expanded in this state, so no arrows at all.
    expect(arrows).toHaveLength(0);
  });

  it('arrows skip when source type is collapsed', () => {
    // App is not expanded → its field rows aren't visible → no arrows.
    const inputs = smallFixtureInputs(['c', 'c::core', 'c::render']);
    const geometry = computeGeometry(inputs);
    const obstacles = computeObstacles(geometry, measure);
    const { arrows } = routeArrows(geometry, obstacles, inputs, measure);

    const fromApp = arrows.filter((a) => a.fromTypeId === 'c::App');
    expect(fromApp).toHaveLength(0);
  });
});
