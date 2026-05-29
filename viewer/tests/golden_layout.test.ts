// Tier-2 layout safety net: golden snapshots + cross-cutting invariants
// over the WHOLE `buildLayout` output.
//
// The per-pass tests (routing/obstacles/grid_placement/…) verify each
// algorithm in isolation. This file verifies properties that must hold
// for EVERY type/arrow in an assembled layout regardless of which pass
// produced them — the class of UI bug where the math in one pass is
// right but the assembled result still renders wrong:
//
//   - "type box not showing"  → a box with zero/negative size.
//   - "arrow start/end wrong" → an endpoint detached from its type box.
//   - "arrow routing wrong"   → a non-orthogonal / NaN polyline.
//
// `buildLayout` is a pure function (deterministic given a measurer), so
// a rounded serialization is a stable golden snapshot: any unintended
// shift across the full pipeline shows up as a diff.

import { describe, expect, it } from 'vitest';
import type { Arrow, Layout, TypeBox } from '../src/analysis/layout_model.ts';
import { buildLayout } from '../src/layout/pipeline.ts';
import { mediumFixtureInputs } from './fixtures/medium.ts';
import { smallFixtureInputs } from './fixtures/small.ts';

// Fixed-width measurer so snapshots don't depend on real font metrics
// (those are the domain of the Tier-3 browser test). Matches the
// convention in layout.test.ts.
const measure = (s: string): number => s.length * 7;

// Expanding the OWNER type boxes (not just their modules) is what makes
// field rows visible, which is what emits the canonical field→type
// ownership arrows. Without this the arrow invariants below pass
// vacuously — see the `minArrows` guard.
const SMALL_EXPANDED = [
  'c',
  'c::core',
  'c::render',
  'c::App',
  'c::core::Engine',
  'c::render::Renderer',
];
const MEDIUM_EXPANDED = ['c', 'c::m', 'c::m::Root', 'c::m::Hub', 'c::m::Tail'];

const SCENARIOS: ReadonlyArray<{ name: string; layout: () => Layout; minArrows: number }> = [
  {
    name: 'small / owners expanded',
    layout: () => buildLayout({ ...smallFixtureInputs(SMALL_EXPANDED), measureText: measure }),
    // App→Engine, App→Renderer, Engine→Cylinder, Renderer→Pixel.
    minArrows: 4,
  },
  {
    name: 'small / collapsed (crate root only)',
    layout: () => buildLayout({ ...smallFixtureInputs(['c']), measureText: measure }),
    minArrows: 0,
  },
  {
    name: 'medium fixture / owners expanded',
    layout: () => buildLayout({ ...mediumFixtureInputs(MEDIUM_EXPANDED), measureText: measure }),
    // 12 Root leaves + 8 Hub leaves + 1 Tail back-edge.
    minArrows: 21,
  },
];

const EPS = 0.5;
const round = (n: number): number => Math.round(n * 100) / 100;

/** Deterministic, rounded projection of a Layout for snapshotting. Drops
 *  presentation-only / id-derived fields and sorts by stable keys so the
 *  snapshot reflects geometry, not map iteration order. */
function projectLayout(layout: Layout): unknown {
  return {
    totalWidth: round(layout.totalWidth),
    totalHeight: round(layout.totalHeight),
    modules: [...layout.modules]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((m) => ({ id: m.id, y: round(m.y), bandHeight: round(m.bandHeight), expanded: m.expanded })),
    types: [...layout.types]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((t) => ({
        id: t.id,
        x: round(t.x),
        y: round(t.y),
        width: round(t.width),
        height: round(t.height),
        box: [round(t.boxX), round(t.boxY), round(t.boxWidth), round(t.boxHeight)],
        expanded: t.expanded,
        fieldCount: t.fields.length,
      })),
    arrows: [...layout.arrows]
      .map((a) => ({
        from: `${a.fromTypeId}.${a.fromFieldName}`,
        to: a.toTypeId,
        kind: a.kind,
        waypoints: a.waypoints.map((w) => [round(w.x), round(w.y)]),
      }))
      .sort((a, b) => `${a.from}->${a.to}`.localeCompare(`${b.from}->${b.to}`)),
  };
}

describe('buildLayout — golden snapshots', () => {
  for (const sc of SCENARIOS) {
    it(`is stable: ${sc.name}`, () => {
      expect(projectLayout(sc.layout())).toMatchSnapshot();
    });
  }
});

describe('buildLayout — geometry invariants', () => {
  for (const sc of SCENARIOS) {
    describe(sc.name, () => {
      // Guard: a fixture/expansion regression that silently stops
      // emitting arrows would make the endpoint/orthogonality
      // invariants pass for free. Pin the expected count.
      it(`emits at least ${sc.minArrows} arrows`, () => {
        expect(sc.layout().arrows.length).toBeGreaterThanOrEqual(sc.minArrows);
      });

      it('every type box has positive size (box renders)', () => {
        for (const t of sc.layout().types) {
          // Header rect.
          expect(t.width, `${t.id} width`).toBeGreaterThan(0);
          expect(t.height, `${t.id} height`).toBeGreaterThan(0);
          // Full obstacle block used for selection rings / member bands.
          expect(t.boxWidth, `${t.id} boxWidth`).toBeGreaterThan(0);
          expect(t.boxHeight, `${t.id} boxHeight`).toBeGreaterThan(0);
          for (const v of [t.x, t.y, t.boxX, t.boxY, t.boxWidth, t.boxHeight]) {
            expect(Number.isFinite(v), `${t.id} finite coords`).toBe(true);
          }
        }
      });

      it('every arrow is a finite orthogonal polyline', () => {
        for (const a of sc.layout().arrows) {
          expect(a.waypoints.length, `${arrowLabel(a)} waypoint count`).toBeGreaterThanOrEqual(2);
          for (const w of a.waypoints) {
            expect(Number.isFinite(w.x) && Number.isFinite(w.y), `${arrowLabel(a)} finite`).toBe(
              true,
            );
          }
          // Each segment is axis-aligned (orthogonal routing). A diagonal
          // segment means a routing endpoint/waypoint drifted.
          for (let i = 1; i < a.waypoints.length; i++) {
            const p = a.waypoints[i - 1];
            const q = a.waypoints[i];
            if (p === undefined || q === undefined) continue;
            const axisAligned = Math.abs(p.x - q.x) < EPS || Math.abs(p.y - q.y) < EPS;
            expect(axisAligned, `${arrowLabel(a)} segment ${i} axis-aligned`).toBe(true);
          }
        }
      });

      it('arrow endpoints anchor to their type boxes (start/end correct)', () => {
        const layout = sc.layout();
        const boxById = new Map<string, TypeBox>(layout.types.map((t) => [t.id, t]));
        for (const a of layout.arrows) {
          const src = boxById.get(a.fromTypeId);
          const dst = boxById.get(a.toTypeId);
          const first = a.waypoints[0];
          const last = a.waypoints[a.waypoints.length - 1];
          if (first === undefined || last === undefined) continue;
          // Only assert when an endpoint's box is present in this layout
          // (an arrow may point at a collapsed/ghosted target).
          if (src !== undefined) {
            // The source exits from a field/method ROW inside the owner
            // box, so its port x lives within the box (a left-exit drift
            // port may sit just past the left edge), and its y within the
            // box's vertical extent.
            assertWithinBox(src, first, `${arrowLabel(a)} source`);
          }
          if (dst !== undefined) {
            // The target lands on a vertical SIDE of the target box.
            assertOnVerticalEdge(dst, last, `${arrowLabel(a)} target`);
          }
        }
      });
    });
  }
});

function arrowLabel(a: Arrow): string {
  return `${a.fromTypeId}.${a.fromFieldName}→${a.toTypeId}`;
}

// A row port can sit a little past either side edge — a left-exit port
// clears a drift dot, a right-exit port sits just past the right edge —
// so allow this much slack on both sides of the source's horizontal band.
const PORT_MARGIN = 32;

/** Source contract: `waypoints[0]` originates from a row inside the owner
 *  box — vertically within the box and horizontally on/near it. Catches a
 *  source endpoint that drifted away from its owner. */
function assertWithinBox(box: TypeBox, pt: { x: number; y: number }, who: string): void {
  expect(
    pt.x >= box.boxX - PORT_MARGIN && pt.x <= box.boxX + box.boxWidth + PORT_MARGIN,
    `${who} x=${pt.x} within owner box [${box.boxX}, ${box.boxX + box.boxWidth}]`,
  ).toBe(true);
  expect(
    pt.y >= box.boxY - EPS && pt.y <= box.boxY + box.boxHeight + EPS,
    `${who} y=${pt.y} within owner box [${box.boxY}, ${box.boxY + box.boxHeight}]`,
  ).toBe(true);
}

/** Target contract: `waypoints[last]` sits on the left OR right edge of
 *  the target box (orthogonal arrows connect to side ports) and within
 *  its vertical extent — the "arrow ends in the wrong place" bug class. */
function assertOnVerticalEdge(box: TypeBox, pt: { x: number; y: number }, who: string): void {
  const onLeft = Math.abs(pt.x - box.boxX) < EPS;
  const onRight = Math.abs(pt.x - (box.boxX + box.boxWidth)) < EPS;
  expect(onLeft || onRight, `${who} x=${pt.x} on box edge [${box.boxX}, ${box.boxX + box.boxWidth}]`).toBe(
    true,
  );
  expect(
    pt.y >= box.boxY - EPS && pt.y <= box.boxY + box.boxHeight + EPS,
    `${who} y=${pt.y} within box [${box.boxY}, ${box.boxY + box.boxHeight}]`,
  ).toBe(true);
}
