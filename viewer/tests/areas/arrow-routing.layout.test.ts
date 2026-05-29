// Tier-2 (pure node) regression tests for the ARROW-ROUTING area.
//
// These assert the strong correct-behavior oracles from
// test-plan/arrow-routing.md against the OWNING layers:
//   - data/model     — the `Arrow.waypoints[0]/[last]` endpoint contract.
//   - analysis/logic — `arrow_hit` (hit zones / picking) and
//                       `arrow_disambig` (grouping + cross-crate labels).
//   - assembled layout (`buildLayout`) — endpoint anchoring, orthogonality,
//     and the at-scale completeness/non-looping invariants.
//
// The synthetic single-pass routing-shape oracles (AR-01..AR-04, AR-06,
// AR-08..AR-11, AR-15..AR-18, AR-33..AR-35) already live in
// tests/routing.test.ts against the `routeArrows` harness and are not
// duplicated here (shared files must not be edited). This file covers the
// buildLayout-level and analysis-module oracles plus the dense-scale ones.

import { describe, expect, it } from 'vitest';
import {
  type ArrowHit,
  type ArrowHitZone,
  pickArrowsAtPoint,
} from '../../src/analysis/arrow_hit.ts';
import type {
  Arrow,
  ArrowWaypoint,
  ChannelObstacle,
  Layout,
  TypeBox,
} from '../../src/analysis/layout_model.ts';
import { buildLayout } from '../../src/layout/pipeline.ts';
import {
  type ArrowDisambigGroup,
  arrowDisambigRowModel,
  groupArrowHits,
} from '../../src/view/arrow_disambig.ts';
import { arrowEndpointLayoutPoint } from '../../src/view/arrow_navigation.ts';
import { denseHighFanout, denseInputs } from '../fixtures/dense.ts';
import { mediumFixtureInputs } from '../fixtures/medium.ts';
import { smallFixtureInputs } from '../fixtures/small.ts';

const measure = (s: string): number => s.length * 7;
const EPS = 0.5;

const SMALL_EXPANDED = [
  'c',
  'c::core',
  'c::render',
  'c::App',
  'c::core::Engine',
  'c::render::Renderer',
];
const MEDIUM_EXPANDED = ['c', 'c::m', 'c::m::Root', 'c::m::Hub', 'c::m::Tail'];

function smallLayout(): Layout {
  return buildLayout({ ...smallFixtureInputs(SMALL_EXPANDED), measureText: measure });
}

// ---------------------------------------------------------------------------
// Geometry helpers (axis-aligned polylines)
// ---------------------------------------------------------------------------

function segments(waypoints: readonly ArrowWaypoint[]): Array<[ArrowWaypoint, ArrowWaypoint]> {
  const out: Array<[ArrowWaypoint, ArrowWaypoint]> = [];
  for (let i = 1; i < waypoints.length; i++) {
    const a = waypoints[i - 1];
    const b = waypoints[i];
    if (a !== undefined && b !== undefined) out.push([a, b]);
  }
  return out;
}

function isAxisAligned(waypoints: readonly ArrowWaypoint[]): boolean {
  return segments(waypoints).every(
    ([a, b]) => Math.abs(a.x - b.x) < EPS || Math.abs(a.y - b.y) < EPS,
  );
}

function allFinite(waypoints: readonly ArrowWaypoint[]): boolean {
  return waypoints.every((w) => Number.isFinite(w.x) && Number.isFinite(w.y));
}

function distinctPoints(waypoints: readonly ArrowWaypoint[]): number {
  const seen = new Set<string>();
  for (const w of waypoints) seen.add(`${w.x},${w.y}`);
  return seen.size;
}

function manhattan(a: ArrowWaypoint, b: ArrowWaypoint): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function pathLength(waypoints: readonly ArrowWaypoint[]): number {
  return segments(waypoints).reduce((sum, [a, b]) => sum + manhattan(a, b), 0);
}

function yExtent(waypoints: readonly ArrowWaypoint[]): { min: number; max: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const w of waypoints) {
    min = Math.min(min, w.y);
    max = Math.max(max, w.y);
  }
  return { min, max };
}

// ---------------------------------------------------------------------------
// AR-27 — every arrow is a finite, axis-aligned orthogonal polyline (>=2 pts)
// AR-12 — waypoints[0] anchors inside owner box; waypoints[last] on a
//         vertical edge of the target box (the endpoint contract).
// ---------------------------------------------------------------------------

// A row port can sit a little past either side edge — a left-exit port
// clears a drift dot — so allow this slack on the source horizontal band.
const PORT_MARGIN = 32;

describe('AR-27 — orthogonal polyline invariant (assembled layout)', () => {
  for (const sc of [
    { name: 'small / owners expanded', layout: smallLayout },
    {
      name: 'medium / owners expanded',
      layout: (): Layout =>
        buildLayout({ ...mediumFixtureInputs(MEDIUM_EXPANDED), measureText: measure }),
    },
  ]) {
    it(`every arrow is finite, orthogonal, >=2 pts: ${sc.name}`, () => {
      const layout = sc.layout();
      expect(layout.arrows.length).toBeGreaterThan(0); // non-vacuous
      for (const a of layout.arrows) {
        expect(a.waypoints.length, `${edgeLabel(a)} waypoint count`).toBeGreaterThanOrEqual(2);
        expect(allFinite(a.waypoints), `${edgeLabel(a)} finite`).toBe(true);
        expect(isAxisAligned(a.waypoints), `${edgeLabel(a)} axis-aligned`).toBe(true);
      }
    });
  }
});

describe('AR-12 — waypoints[0]/[last] ARE the source/target endpoints', () => {
  it('source anchors within owner box; target lands on a vertical box edge', () => {
    const layout = smallLayout();
    const boxById = new Map<string, TypeBox>(layout.types.map((t) => [t.id, t]));
    let checkedSource = 0;
    let checkedTarget = 0;
    for (const a of layout.arrows) {
      const first = a.waypoints[0];
      const last = a.waypoints[a.waypoints.length - 1];
      if (first === undefined || last === undefined) continue;
      const src = boxById.get(a.fromTypeId);
      if (src !== undefined) {
        // Source exits a field/method ROW inside the owner box: x within
        // box (a left-exit port may sit just past the left edge), y within
        // the box vertical extent. NOT asserted "on an edge" — that is the
        // documented WRONG oracle for a field-row port.
        expect(
          first.x >= src.boxX - PORT_MARGIN && first.x <= src.boxX + src.boxWidth + PORT_MARGIN,
          `${edgeLabel(a)} source x=${first.x} within owner box`,
        ).toBe(true);
        expect(
          first.y >= src.boxY - EPS && first.y <= src.boxY + src.boxHeight + EPS,
          `${edgeLabel(a)} source y within owner box`,
        ).toBe(true);
        checkedSource++;
      }
      const dst = boxById.get(a.toTypeId);
      if (dst !== undefined) {
        // Doc (Arrow Routing rule 4 + Required Invariant): every arrow ends
        // at the target's LEFT edge — NOT merely "a vertical edge". Asserting
        // left-OR-right would be a weak oracle that silently admits the
        // forbidden right-side entry slicing the target's row text.
        expect(
          Math.abs(last.x - dst.boxX) < EPS,
          `${edgeLabel(a)} target x=${last.x} on the LEFT edge (boxX=${dst.boxX})`,
        ).toBe(true);
        expect(
          last.y >= dst.boxY - EPS && last.y <= dst.boxY + dst.boxHeight + EPS,
          `${edgeLabel(a)} target y within box`,
        ).toBe(true);
        // Required Invariant: "arrows land on the target left side with a
        // left-to-right final stub." The penultimate waypoint must sit to the
        // LEFT of the landing point on the same horizontal (a rightward stub).
        const penult = a.waypoints[a.waypoints.length - 2];
        expect(penult, `${edgeLabel(a)} has a penultimate waypoint`).toBeDefined();
        if (penult !== undefined) {
          expect(
            Math.abs(penult.y - last.y) < EPS && penult.x < last.x - EPS,
            `${edgeLabel(a)} final stub is left-to-right (penult.x=${penult.x} -> last.x=${last.x})`,
          ).toBe(true);
        }
        checkedTarget++;
      }
    }
    expect(checkedSource).toBeGreaterThan(0);
    expect(checkedTarget).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// AR-13 — navigation reads endpoint from FRESH layout, never recomputes a
//         (type.x, type.y+h/2) formula and never the stale clicked arrow.
// ---------------------------------------------------------------------------

describe('AR-13 — arrowEndpointLayoutPoint reads the fresh routed waypoints', () => {
  it('returns the matching fresh arrow waypoints, not the stale clicked ones', () => {
    const fresh = smallLayout();
    const arrow = fresh.arrows[0];
    expect(arrow).toBeDefined();
    if (arrow === undefined) return;

    // A stale clicked arrow with the SAME edge identity but bogus waypoints
    // (what an old layout / pre-reroute click carried). Navigation must
    // ignore these and read the fresh layout's points.
    const stale: Arrow = {
      ...arrow,
      waypoints: [
        { x: -9999, y: -9999 },
        { x: -8888, y: -8888 },
      ],
    };

    const freshFirst = arrow.waypoints[0];
    const freshLast = arrow.waypoints[arrow.waypoints.length - 1];
    expect(arrowEndpointLayoutPoint(fresh, stale, 'source')).toEqual({
      x: freshFirst?.x,
      y: freshFirst?.y,
    });
    expect(arrowEndpointLayoutPoint(fresh, stale, 'target')).toEqual({
      x: freshLast?.x,
      y: freshLast?.y,
    });
  });

  it('returns null (skip pan) when the edge is not present in the fresh layout', () => {
    const fresh = smallLayout();
    const template = fresh.arrows[0];
    expect(template).toBeDefined();
    if (template === undefined) return;
    const absent: Arrow = { ...template, toTypeId: 'c::does::not::Exist' };
    expect(arrowEndpointLayoutPoint(fresh, absent, 'target')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AR-05 / AR-32 — at scale: every arrow with visible endpoints renders a
//   real multi-point route (no silent hide / no degenerate single point),
//   and no fan-out arrow loops (near-shortest, bounded vertical extent).
// ---------------------------------------------------------------------------

function nonLoopingBound(a: Arrow): void {
  const w = a.waypoints;
  const start = w[0];
  const goal = w[w.length - 1];
  if (start === undefined || goal === undefined) return;
  // No big drop-down-and-back: the route's vertical extent must stay within
  // a small slack of the endpoints' own band. A looping detour (Image #32)
  // dips far below/above both endpoints; box-clearance alone would miss it.
  const { min, max } = yExtent(w);
  const lo = Math.min(start.y, goal.y);
  const hi = Math.max(start.y, goal.y);
  const slack = 120; // generous: clearance rings + perimeter buffer
  expect(min, `${edgeLabel(a)} dips below endpoint band`).toBeGreaterThanOrEqual(lo - slack);
  expect(max, `${edgeLabel(a)} rises above endpoint band`).toBeLessThanOrEqual(hi + slack);
  // Near-shortest: routed length within a bounded multiple of Manhattan
  // distance (not a precise optimum — A* on a buffered grid adds detours,
  // but a first-fit loop blows past this).
  const lower = manhattan(start, goal);
  const len = pathLength(w);
  expect(len, `${edgeLabel(a)} length ${len} vs manhattan ${lower}`).toBeLessThanOrEqual(
    lower * 3 + 400,
  );
}

describe('AR-05 / AR-32 — dense fan-out: all arrows render, none loop', () => {
  const scenarios = [
    { name: 'denseHighFanout(24)', inputs: denseHighFanout(24), min: 20 },
    {
      name: 'denseInputs default',
      inputs: denseInputs({ crossModuleRatio: 0.6 }),
      min: 10,
    },
  ];
  for (const sc of scenarios) {
    it(`every arrow has >=2 distinct waypoints (no silent hide): ${sc.name}`, () => {
      const layout = buildLayout({ ...sc.inputs, measureText: measure });
      expect(layout.arrows.length, 'fixture emits enough arrows').toBeGreaterThanOrEqual(sc.min);
      for (const a of layout.arrows) {
        expect(a.waypoints.length, `${edgeLabel(a)} waypoint count`).toBeGreaterThanOrEqual(2);
        // A degenerate L-fallback collapsed to one point would hide the
        // arrow; a real route has >=2 DISTINCT waypoints.
        expect(
          distinctPoints(a.waypoints),
          `${edgeLabel(a)} distinct points`,
        ).toBeGreaterThanOrEqual(2);
        expect(isAxisAligned(a.waypoints), `${edgeLabel(a)} axis-aligned`).toBe(true);
        expect(allFinite(a.waypoints), `${edgeLabel(a)} finite`).toBe(true);
      }
    });

    it(`no fan-out arrow loops (bounded length + vertical extent): ${sc.name}`, () => {
      const layout = buildLayout({ ...sc.inputs, measureText: measure });
      for (const a of layout.arrows) nonLoopingBound(a);
    });
  }
});

// ---------------------------------------------------------------------------
// AR-08 / AR-34 (assembled) — routed arrows AVOID non-source/non-target
//   block fragments. (Doc: "routed arrows avoid non-source/non-target block
//   fragments"; routing rule 9 — obstacles are the real placed fragments.)
//   A box-clearance-only check on the endpoints is not enough: this walks
//   EVERY segment of EVERY arrow against EVERY obstacle that is not part of
//   the arrow's own source or target box, so a route that cuts through a
//   third, unrelated block fails. The source/target's own fragments are
//   excluded because the explicit source/target stubs may legitimately cross
//   their own block's clearance envelope (routing rules 6-7).
// ---------------------------------------------------------------------------

function rectsOverlapBox(o: ChannelObstacle, box: TypeBox): boolean {
  return (
    o.left < box.boxX + box.boxWidth + EPS &&
    o.right > box.boxX - EPS &&
    o.top < box.boxY + box.boxHeight + EPS &&
    o.bottom > box.boxY - EPS
  );
}

function segmentEntersObstacleInterior(
  a: ArrowWaypoint,
  b: ArrowWaypoint,
  o: ChannelObstacle,
): boolean {
  // Raw (un-inflated) obstacle interior. A route may run flush along an
  // obstacle's edge (the clearance boundary) without entering it; only a
  // segment whose span strictly pierces the rect interior is a violation.
  if (Math.abs(a.y - b.y) < EPS) {
    const lo = Math.min(a.x, b.x);
    const hi = Math.max(a.x, b.x);
    return a.y > o.top + EPS && a.y < o.bottom - EPS && hi > o.left + EPS && lo < o.right - EPS;
  }
  if (Math.abs(a.x - b.x) < EPS) {
    const lo = Math.min(a.y, b.y);
    const hi = Math.max(a.y, b.y);
    return a.x > o.left + EPS && a.x < o.right - EPS && hi > o.top + EPS && lo < o.bottom - EPS;
  }
  return false;
}

describe('AR-08/AR-34 — routed arrows avoid non-source/non-target fragments', () => {
  const scenarios = [
    { name: 'small / owners expanded', inputs: smallFixtureInputs(SMALL_EXPANDED) },
    { name: 'medium / owners expanded', inputs: mediumFixtureInputs(MEDIUM_EXPANDED) },
    { name: 'denseHighFanout(24)', inputs: denseHighFanout(24) },
    { name: 'denseInputs default', inputs: denseInputs({ crossModuleRatio: 0.6 }) },
  ];
  for (const sc of scenarios) {
    it(`no segment pierces a foreign obstacle: ${sc.name}`, () => {
      const layout = buildLayout({ ...sc.inputs, measureText: measure });
      const obstacles = layout.debug?.routing.obstacles ?? [];
      expect(obstacles.length, 'real obstacle model present').toBeGreaterThan(0);
      expect(layout.arrows.length, 'non-vacuous').toBeGreaterThan(0);
      const boxById = new Map<string, TypeBox>(layout.types.map((t) => [t.id, t]));
      for (const arrow of layout.arrows) {
        const src = boxById.get(arrow.fromTypeId);
        const dst = boxById.get(arrow.toTypeId);
        const foreign = obstacles.filter(
          (o) =>
            !(src !== undefined && rectsOverlapBox(o, src)) &&
            !(dst !== undefined && rectsOverlapBox(o, dst)),
        );
        for (const [a, b] of segments(arrow.waypoints)) {
          for (const o of foreign) {
            expect(
              segmentEntersObstacleInterior(a, b, o),
              `${edgeLabel(arrow)} segment (${a.x},${a.y})->(${b.x},${b.y}) pierces foreign obstacle [${o.left},${o.top},${o.right},${o.bottom}]`,
            ).toBe(false);
          }
        }
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Routing does NOT change physical placement. (Doc Required Invariant +
//   "Routing runs after physical placement and does not feed back into
//   placement: layout owns block positions, routing owns the path.")
//   The pipeline computes geometry (the type boxes) BEFORE routing and hands
//   it to the router read-only. Observable contract: every routed arrow only
//   *consumes* placement — its target endpoint lands exactly on the target
//   box's already-placed left edge — and a second fresh build produces byte-
//   identical box positions (routing introduced no positional feedback or
//   nondeterminism). A non-vacuity guard requires arrows to actually exist.
// ---------------------------------------------------------------------------

describe('routing consumes placement, never moves a box', () => {
  function boxPositions(layout: Layout): string {
    return layout.types
      .map((t) => `${t.id}:${t.boxX},${t.boxY},${t.boxWidth},${t.boxHeight}`)
      .sort()
      .join('|');
  }

  for (const sc of [
    { name: 'small', layout: smallLayout },
    {
      name: 'medium',
      layout: (): Layout =>
        buildLayout({ ...mediumFixtureInputs(MEDIUM_EXPANDED), measureText: measure }),
    },
  ]) {
    it(`target endpoints sit exactly on placed box left edges: ${sc.name}`, () => {
      const layout = sc.layout();
      expect(layout.arrows.length, 'non-vacuous').toBeGreaterThan(0);
      const boxById = new Map<string, TypeBox>(layout.types.map((t) => [t.id, t]));
      let checked = 0;
      for (const a of layout.arrows) {
        const dst = boxById.get(a.toTypeId);
        const last = a.waypoints[a.waypoints.length - 1];
        if (dst === undefined || last === undefined) continue;
        expect(
          Math.abs(last.x - dst.boxX) < EPS,
          `${edgeLabel(a)} target landed on the unmoved box left edge`,
        ).toBe(true);
        checked++;
      }
      expect(checked).toBeGreaterThan(0);
    });

    it(`a fresh build reproduces identical box placement: ${sc.name}`, () => {
      expect(boxPositions(sc.layout())).toBe(boxPositions(sc.layout()));
    });
  }
});

// ---------------------------------------------------------------------------
// AR-31 — [ARCH-NOTE] two arrows to different targets MAY share a column.
//   Assert the layout builds and both render with clear endpoints. Do NOT
//   assert MIN_LANE_SEP — that would re-impose the removed lane allocator.
// ---------------------------------------------------------------------------

describe('AR-31 — [ARCH-NOTE] different-target trunks may share a column', () => {
  it('medium fixture builds and every arrow renders with clear endpoints', () => {
    const layout = buildLayout({ ...mediumFixtureInputs(MEDIUM_EXPANDED), measureText: measure });
    // 12 Root leaves + 8 Hub leaves + 1 Tail back-edge.
    expect(layout.arrows.length).toBeGreaterThanOrEqual(21);
    for (const a of layout.arrows) {
      expect(a.waypoints.length).toBeGreaterThanOrEqual(2);
      expect(distinctPoints(a.waypoints)).toBeGreaterThanOrEqual(2);
      expect(isAxisAligned(a.waypoints)).toBe(true);
    }

    // Show that shared trunk columns DO occur (so the "no lane-sep"
    // contract is exercised, not vacuous): collect the x of the longest
    // vertical segment per arrow and assert at least one column is shared
    // by 2+ different-target arrows.
    const trunkX = new Map<number, Set<string>>();
    for (const a of layout.arrows) {
      const x = longestVerticalX(a.waypoints);
      if (x === null) continue;
      const set = trunkX.get(x) ?? new Set<string>();
      set.add(a.toTypeId);
      trunkX.set(x, set);
    }
    const shared = [...trunkX.values()].some((targets) => targets.size >= 2);
    expect(shared, 'expected at least one column shared by different-target trunks').toBe(true);
  });
});

function longestVerticalX(waypoints: readonly ArrowWaypoint[]): number | null {
  let bestX: number | null = null;
  let bestLen = -1;
  for (const [a, b] of segments(waypoints)) {
    if (Math.abs(a.x - b.x) >= EPS) continue; // not vertical
    const len = Math.abs(b.y - a.y);
    if (len > bestLen) {
      bestLen = len;
      bestX = a.x;
    }
  }
  return bestX;
}

// ---------------------------------------------------------------------------
// AR-19 / AR-22 — single-arrow hit zone split by ARC length to midpoint.
//   First half -> 'source' (click advances to target), second half ->
//   'target' (click goes back to source), exact midpoint -> 'source'
//   (forward-default tie). L-shape classified by arc length, not Euclidean.
// ---------------------------------------------------------------------------

function fakeArrow(waypoints: ArrowWaypoint[], over: Partial<Arrow> = {}): Arrow {
  return {
    waypoints,
    fromTypeId: 'crate::A',
    fromFieldName: 'f',
    fromRowKind: 'field',
    toTypeId: 'crate::B',
    kind: 'ownership',
    driftClass: 'at_lca',
    ...over,
  };
}

function zoneAt(arrow: Arrow, point: ArrowWaypoint): ArrowHitZone | null {
  const hits = pickArrowsAtPoint(point, [arrow], { hitTolerance: 1 });
  return hits[0]?.zone ?? null;
}

describe('AR-19 — single arrow click splits first/second half (no popup)', () => {
  const straight = fakeArrow([
    { x: 0, y: 0 },
    { x: 100, y: 0 },
  ]);

  it('first half -> source (advance to target)', () => {
    expect(zoneAt(straight, { x: 25, y: 0 })).toBe('source');
  });

  it('second half -> target (go back to source)', () => {
    expect(zoneAt(straight, { x: 75, y: 0 })).toBe('target');
  });

  it('exact midpoint -> source (forward-default tie)', () => {
    expect(zoneAt(straight, { x: 50, y: 0 })).toBe('source');
  });
});

describe('AR-22 — L-shape split is by ARC length, not Euclidean nearest', () => {
  // Total arc length 200. The corner sits at arc length 100 (the arc
  // midpoint). A point just before the corner (arc < 100) is in the FIRST
  // half -> 'source'; just after (arc > 100) -> 'target'. A naive Euclidean
  // split against the geometric midpoint would misclassify these.
  const lShape = fakeArrow([
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
  ]);

  it('point at arc length 75 (before corner) -> source', () => {
    expect(zoneAt(lShape, { x: 75, y: 0 })).toBe('source');
  });

  it('point at arc length 125 (after corner) -> target', () => {
    expect(zoneAt(lShape, { x: 100, y: 25 })).toBe('target');
  });

  it('corner sits at the arc midpoint -> source (tie default)', () => {
    expect(zoneAt(lShape, { x: 100, y: 0 })).toBe('source');
  });
});

// ---------------------------------------------------------------------------
// AR-21 — pickArrowsAtPoint returns exactly the arrows within tol at a
//   crossing, sorted closest-first; an unrelated farther arrow is excluded.
// ---------------------------------------------------------------------------

describe('AR-21 — pickArrowsAtPoint returns exactly the within-tolerance arrows', () => {
  it('crossing point hits both crossing arrows, excludes the far one', () => {
    const horizontal = fakeArrow(
      [
        { x: 0, y: 50 },
        { x: 100, y: 50 },
      ],
      { fromFieldName: 'h', toTypeId: 'crate::H' },
    );
    const vertical = fakeArrow(
      [
        { x: 50, y: 0 },
        { x: 50, y: 100 },
      ],
      { fromFieldName: 'v', toTypeId: 'crate::V' },
    );
    const far = fakeArrow(
      [
        { x: 0, y: 500 },
        { x: 100, y: 500 },
      ],
      { fromFieldName: 'far', toTypeId: 'crate::F' },
    );

    const hits = pickArrowsAtPoint({ x: 50, y: 50 }, [horizontal, vertical, far], {
      hitTolerance: 5,
    });
    const fields = hits.map((hit) => hit.arrow.fromFieldName);
    expect(fields).toContain('h');
    expect(fields).toContain('v');
    expect(fields).not.toContain('far');
    expect(hits.length).toBe(2);
    // Sorted closest-first (both are distance 0 here, so just assert the
    // exclusion + finite ordering by distance).
    for (let i = 1; i < hits.length; i++) {
      expect((hits[i]?.distance ?? 0) >= (hits[i - 1]?.distance ?? 0)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// AR-36 — disambig grouping: fan-out -> by-source, fan-in -> by-target,
//         tie -> by-source.
// AR-37 — disambig row model keeps the cross-crate prefix on the hop and
//         strips the matching (anchor) crate.
// ---------------------------------------------------------------------------

function hitFor(from: string, fromField: string, to: string): ArrowHit {
  return {
    arrow: fakeArrow(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      { fromTypeId: from, fromFieldName: fromField, toTypeId: to },
    ),
    zone: 'source',
    distance: 0,
  };
}

function kindsOf(groups: readonly ArrowDisambigGroup[]): Set<string> {
  return new Set(groups.map((g) => g.kind));
}

describe('AR-36 — disambig grouping picks the compressing axis', () => {
  it('fan-out (one source row, many targets) groups by-source', () => {
    // One source ROW (same typeId + fieldName + rowKind) fanning out to
    // three distinct targets => 1 distinct source, 3 distinct targets.
    const hits = [
      hitFor('c::A', 'f', 'c::X'),
      hitFor('c::A', 'f', 'c::Y'),
      hitFor('c::A', 'f', 'c::Z'),
    ];
    const groups = groupArrowHits(hits);
    expect(groups.length).toBe(1);
    expect(kindsOf(groups)).toEqual(new Set(['by-source']));
  });

  it('fan-in (many sources, one target) groups by-target', () => {
    const hits = [
      hitFor('c::A', 'f', 'c::Z'),
      hitFor('c::B', 'f', 'c::Z'),
      hitFor('c::C', 'f', 'c::Z'),
    ];
    const groups = groupArrowHits(hits);
    expect(groups.length).toBe(1);
    expect(kindsOf(groups)).toEqual(new Set(['by-target']));
  });

  it('tie (distinct sources == distinct targets) groups by-source', () => {
    // 2 distinct sources, 2 distinct targets -> tie -> by-source.
    const hits = [hitFor('c::A', 'f', 'c::X'), hitFor('c::B', 'g', 'c::Y')];
    const groups = groupArrowHits(hits);
    expect(kindsOf(groups)).toEqual(new Set(['by-source']));
  });
});

describe('AR-37 — disambig row model keeps cross-crate prefix, strips matching crate', () => {
  const qualify = (fullPath: string): string => fullPath;

  it('same-crate target omits the (anchor) crate name', () => {
    const model = arrowDisambigRowModel(hitFor('cli::App', 'engine', 'cli::core::Engine'), qualify);
    expect(model.source.crateName).toBeUndefined();
    expect(model.target.crateName).toBeUndefined();
    // Anchor crate is stripped from both sides' display.
    expect(model.source.prefix.includes('cli::')).toBe(false);
    expect(model.target.prefix.includes('cli::')).toBe(false);
  });

  it('cross-crate target surfaces the target crate name on the hop', () => {
    const model = arrowDisambigRowModel(hitFor('cli::App', 'engine', 'core::Engine'), qualify);
    // Source crate == anchor crate => omitted; target crate differs => kept.
    expect(model.source.crateName).toBeUndefined();
    expect(model.target.crateName).toBe('core');
  });
});

function edgeLabel(a: Arrow): string {
  return `${a.fromTypeId}.${a.fromFieldName}->${a.toTypeId}`;
}
