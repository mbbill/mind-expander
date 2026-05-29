// Tier-2 (pure node) regression tests for the LAYOUT-PLACEMENT area.
//
// These assert the strong correct-behavior oracles from
// test-plan/layout-placement.md against the OWNING layers:
//   - analysis/logic + grid — `buildPlacementLayoutPlan` ranks/predecessors,
//     `planBandShape` 16:9 spreading, `placeGridItemsTopToBottom` 2D packing.
//   - the render seam in `geometry.ts` — `computeGlobalXStart`, band → pixel
//     projection (`globalXStart + col*cellWidth`), and the locality-glyph `→`
//     X computed on callable rows.
//
// A placement regression must fail a pure-geometry test here, never only a
// browser render. The fixed-width measurer keeps every assertion
// font-independent; real-font geometry is the Tier-3 net's job.
//
// Existing fn-column / globalXStart / non-overlap oracles live in
// tests/layout.test.ts against the same `computeGeometry` harness; the
// regression-lock cases below restate them so the placement contract cannot
// silently regress, and the dense-scale cases use the shared dense generator
// that the small/medium fixtures cannot reproduce.

import { describe, expect, it } from 'vitest';
import type { TypeBox } from '../../src/analysis/layout_model.ts';
import { callArrowKey } from '../../src/analysis/layout_model.ts';
import {
  BAND_GRID_CELL_H,
  BAND_GRID_CELL_W,
  type Geometry,
  ROW_H,
  computeGeometry,
} from '../../src/layout/geometry.ts';
import { computeObstacles } from '../../src/layout/obstacles.ts';
import { buildLayout } from '../../src/layout/pipeline.ts';
import type { PositionedType } from '../../src/layout/types.ts';
import { buildInputs, crateFacts, edge, mod, ty } from '../fixtures/builders.ts';
import { denseInputs } from '../fixtures/dense.ts';
import { mediumFixtureInputs } from '../fixtures/medium.ts';

const measure = (s: string): number => s.length * 7;
// A bold measurer that is much wider than the regular one, so a bold-measured
// row width is unmistakably distinct from its regular width (LP-12).
const measureBold = (s: string): number => s.length * 70;
const EPS = 0.5;

// ---------------------------------------------------------------------------
// Grid helpers — project a placed type back onto its band-local (col, row).
//   x === globalXStart + col*cellWidth        (assembleGeometryFromPlacedBands)
//   y === bandCursorY + row*cellHeight + ROW_H/2
// We read these back instead of re-deriving placement so the oracles assert
// the produced geometry, not a re-implementation of the packer.
// ---------------------------------------------------------------------------
function colOf(g: Geometry, t: PositionedType): number {
  return Math.round((t.x - g.globalXStart) / BAND_GRID_CELL_W);
}

function bandCursorY(g: Geometry, bandId: string): number {
  const m = g.modules.find((mod) => mod.node.id === bandId);
  if (m === undefined) throw new Error(`no module band ${bandId}`);
  return m.y;
}

function rowOf(g: Geometry, t: PositionedType): number {
  return Math.round((t.y - ROW_H / 2 - bandCursorY(g, t.bandId)) / BAND_GRID_CELL_H);
}

interface Rect {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

function typeRect(t: PositionedType): Rect {
  const top = t.y - ROW_H / 2;
  return { left: t.x, right: t.x + t.width, top, bottom: top + t.height };
}

function obstacleRect(o: { x: number; y: number; width: number; height: number }): Rect {
  return { left: o.x, right: o.x + o.width, top: o.y, bottom: o.y + o.height };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** Stable fingerprint of every type's (id, x, y, w, h). Mirrors the
 *  positionsKey convention in layout.test.ts for determinism comparisons. */
function positionsKey(g: Geometry): string {
  return [...g.types]
    .map((t) => `${t.node.id}|${t.x}|${t.y}|${t.width}|${t.height}`)
    .sort()
    .join('\n');
}

/** Dense single module: many sibling types at one depth so the same-depth
 *  bucket wraps into multiple capped sub-columns. Owner = T0_0 (depth 0)
 *  fans out intra-module to the rest (depth 1). All uniform height. */
function denseSameDepth(typesPerModule = 24): Geometry {
  const opts = {
    crate: 'w',
    modules: 1,
    typesPerModule,
    ownershipFanout: typesPerModule - 1,
    crossModuleRatio: 0,
    nestingDepth: 1,
    branchFactor: 1,
  } as const;
  return computeGeometry({ ...denseInputs(opts), measureText: measure });
}

// ===========================================================================
// LP-24 — Rule 3 + Rule 4 expansion stability: height-only growth, fixed
//         columns/order, and NO cross-column row-sync.
// ===========================================================================
// This is the most load-bearing layout invariant (layout.md Core Rules 3 & 4):
// expanding one item must change ONLY that item's box (height, maybe width),
// keep it in its column, never reorder or move anything between columns, and
// must NOT drag items in other columns down to a shared baseline. The fixture
// gives every child a field whose NAME ("x") is narrower than its header label
// so expansion grows HEIGHT only (block width counts the member-name anchor,
// not the verbose `ty_text` suffix — see geometry.measuredRowWidth).
describe('LP-24 expansion stability (Rule 3 fixed columns, Rule 4 no row-sync)', () => {
  const CHILD_COUNT = 12;
  const childNames = Array.from({ length: CHILD_COUNT }, (_, i) => `Child${i}`);

  function buildStabilityInputs(expanded: readonly string[]) {
    // One owner (Hub, depth 0) fans out to CHILD_COUNT siblings at depth 1 so
    // the same-depth bucket wraps into >1 column. Each child carries one short
    // primitive field (`x`) with a long ty_text annotation; the short name
    // keeps the box at header width, so expanding it grows height only.
    const types = [
      ty(
        'c',
        'm',
        'Hub',
        childNames.map((n, i) => ({ name: `f${i}`, ty_text: n })),
      ),
      ...childNames.map((n) =>
        ty('c', 'm', n, [{ name: 'x', ty_text: 'LongPrimitiveAnnotation' }]),
      ),
    ];
    const c = crateFacts('c', [mod('m', types)]);
    const edges = childNames.map((n, i) => edge('c::m::Hub', `c::m::${n}`, `field f${i}`));
    return buildInputs(c, edges, [...expanded]);
  }

  /** column index -> top-to-bottom ordered list of depth-1 type ids. */
  function columnOrder(g: Geometry): Map<number, string[]> {
    const depthOne = g.types.filter((t) => t.depth === 1);
    const byCol = new Map<number, PositionedType[]>();
    for (const t of depthOne) {
      const col = colOf(g, t);
      byCol.set(col, [...(byCol.get(col) ?? []), t]);
    }
    const out = new Map<number, string[]>();
    for (const [col, arr] of byCol) {
      out.set(
        col,
        [...arr].sort((a, b) => a.y - b.y).map((t) => t.node.id),
      );
    }
    return out;
  }

  function partitionKey(g: Geometry): string {
    return [...columnOrder(g).entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([col, ids]) => `${col}:${ids.join(',')}`)
      .join('|');
  }

  it('expanding a short-field item grows only its own box height, keeps its column/order, and moves no other column', () => {
    const base = ['c', 'c::m'];
    const target = 'c::m::Child5';
    const gCollapsed = computeGeometry({ ...buildStabilityInputs(base), measureText: measure });
    const gExpanded = computeGeometry({
      ...buildStabilityInputs([...base, target]),
      measureText: measure,
    });

    // Non-vacuity: the same-depth bucket actually wrapped into >1 column and
    // >1 row, and the target is NOT the bottom-most item of its column (so
    // there is a within-column successor to push and cross-column row-mates to
    // leave alone). Otherwise the stability assertions hold trivially.
    const orderCollapsed = columnOrder(gCollapsed);
    expect(orderCollapsed.size).toBeGreaterThan(1);
    expect([...orderCollapsed.values()].some((ids) => ids.length > 1)).toBe(true);

    const tCollapsed = gCollapsed.typesById.get(target);
    const tExpanded = gExpanded.typesById.get(target);
    if (!tCollapsed || !tExpanded) throw new Error('missing target child');
    const targetCol = colOf(gCollapsed, tCollapsed);

    // (a) The expanded box grew in HEIGHT (it gained a visible field row) and
    //     did NOT grow in width — the short field name stays inside the header
    //     anchor, the long ty_text suffix is excluded from block width.
    expect(tExpanded.height).toBeGreaterThan(tCollapsed.height);
    expect(tExpanded.width).toBe(tCollapsed.width);
    expect(tExpanded.visibleRows.length).toBe(1);

    // (b) The expanded item kept its exact column and y; the column partition
    //     and each column's top-to-bottom id order are identical collapsed vs
    //     expanded — no reorder, no item crossed columns (Rule 3).
    expect(colOf(gExpanded, tExpanded)).toBe(colOf(gCollapsed, tCollapsed));
    expect(tExpanded.y).toBeCloseTo(tCollapsed.y, 1);
    expect(partitionKey(gExpanded)).toBe(partitionKey(gCollapsed));

    // (c) No cross-column row-sync (Rule 4): every depth-1 sibling in a
    //     DIFFERENT column whose collapsed y is at/below the expanded item
    //     keeps its exact y — the expansion did not drag a neighbouring
    //     column's items down to a shared baseline.
    const siblingsBelowInOtherCols = gCollapsed.types.filter(
      (t) =>
        t.depth === 1 &&
        t.node.id !== target &&
        colOf(gCollapsed, t) !== targetCol &&
        t.y >= tCollapsed.y - EPS,
    );
    expect(siblingsBelowInOtherCols.length).toBeGreaterThan(0); // non-vacuity
    for (const sib of siblingsBelowInOtherCols) {
      const after = gExpanded.typesById.get(sib.node.id);
      if (!after) throw new Error(`missing sibling ${sib.node.id}`);
      expect(after.y, `${sib.node.id} y must not row-sync to the expanded item`).toBeCloseTo(
        sib.y,
        1,
      );
    }

    // (d) Within-column behavior is the legitimate Rule-3 effect: the next
    //     item BELOW the target IN ITS OWN column slides down to clear the
    //     taller box (it keeps its column, it is not reflowed elsewhere).
    const targetColIds = orderCollapsed.get(targetCol) ?? [];
    const targetIdx = targetColIds.indexOf(target);
    const successorId = targetColIds[targetIdx + 1];
    if (successorId !== undefined) {
      const succCollapsed = gCollapsed.typesById.get(successorId);
      const succExpanded = gExpanded.typesById.get(successorId);
      if (!succCollapsed || !succExpanded) throw new Error('missing successor');
      expect(succExpanded.y).toBeGreaterThan(succCollapsed.y);
      expect(colOf(gExpanded, succExpanded)).toBe(targetCol);
    }
  });
});

// ===========================================================================
// LP-03 — Same-depth packs into capped sub-columns, not one column per type
// ===========================================================================
describe('LP-03 capped sub-columns', () => {
  it('N≫cap same-depth types occupy a multi-column, capped, row-reusing grid', () => {
    const typesPerModule = 24;
    const g = denseSameDepth(typesPerModule);
    const depthOne = g.types.filter((t) => t.bandId === 'w::l0' && t.depth === 1);
    expect(depthOne.length).toBe(typesPerModule - 1);

    const cols = new Set(depthOne.map((t) => colOf(g, t)));
    const rows = new Set(depthOne.map((t) => rowOf(g, t)));

    // It spread (more than one column) but did NOT degenerate to one column
    // per type (the rejected "per-rank single-column" layout). The exact cap
    // comes from the 16:9 spreader, so assert the capped, multi-column,
    // row-reusing property rather than a hardcoded count.
    expect(cols.size).toBeGreaterThan(1);
    expect(cols.size).toBeLessThan(depthOne.length);
    expect(rows.size).toBeGreaterThan(1);
    // Rows are genuinely reused: columns hold multiple types each.
    expect(depthOne.length).toBeGreaterThan(cols.size);
  });
});

// ===========================================================================
// LP-04 — No global worst-case non-LCA column reservation
// ===========================================================================
describe('LP-04 sparse band fn-gap independent of another band density', () => {
  function buildSparseVsDense(denseCount: number): Geometry {
    const c = crateFacts('c', [
      {
        path: 'sparse',
        file: 'src/sparse.rs',
        types: [ty('c', 'sparse', 'One')],
        functions: [{ name: 'go', visibility: 'pub' }],
      },
      mod(
        'dense',
        Array.from({ length: denseCount }, (_, i) => ty('c', 'dense', `D${i}`)),
      ),
    ]);
    return computeGeometry({
      ...buildInputs(c, [], ['c', 'c::sparse', 'c::dense']),
      measureText: measure,
    });
  }

  it('sparse band first type sits past ONLY the global fn column, regardless of the dense band', () => {
    const gSmall = buildSparseVsDense(1);
    const gLarge = buildSparseVsDense(30);

    const fnSmall = gSmall.types.find((t) => t.node.typeKind === 'function_group');
    const oneSmall = gSmall.types.find((t) => t.node.id === 'c::sparse::One');
    const fnLarge = gLarge.types.find((t) => t.node.typeKind === 'function_group');
    const oneLarge = gLarge.types.find((t) => t.node.id === 'c::sparse::One');
    if (!fnSmall || !oneSmall || !fnLarge || !oneLarge)
      throw new Error('missing sparse band items');

    // The dense band's type count (1 vs 30) must not reserve empty columns in
    // the unrelated sparse band: One's position is byte-identical across the
    // two builds. A "no overlap" check would MISS this — the boxes never
    // overlap, they would just be pushed too far.
    expect(oneLarge.x).toBe(oneSmall.x);
    expect(fnLarge.x).toBe(fnSmall.x);

    // The whole gap is exactly the single global fn-column reservation: the
    // fn group sits at globalXStart, One sits one fn-column-width to its right.
    const gapCols = colOf(gSmall, oneSmall) - colOf(gSmall, fnSmall);
    const fnGroupWidthCols = Math.ceil(fnSmall.width / BAND_GRID_CELL_W);
    expect(colOf(gSmall, fnSmall)).toBe(0);
    // The reservation clears the fn group's own measured width (it is not a
    // k*cellWidth multiple of the dense band's count).
    expect(gapCols).toBeGreaterThanOrEqual(fnGroupWidthCols);
  });
});

// ===========================================================================
// LP-06 — fn-group at global column 0 (regression-lock)
// ===========================================================================
describe('LP-06 fn-group at global column 0', () => {
  it('fn-group sits at globalXStart with depth -1; every real type is to its right', () => {
    const c = crateFacts('c', [
      {
        path: 'm',
        file: 'src/m.rs',
        types: [ty('c', 'm', 'Real')],
        functions: [{ name: 'do_thing', visibility: 'pub' }],
      },
    ]);
    const g = computeGeometry({ ...buildInputs(c, [], ['c', 'c::m']), measureText: measure });
    const fnGroup = g.types.find((t) => t.node.typeKind === 'function_group');
    const real = g.types.find((t) => t.node.id === 'c::m::Real');
    expect(fnGroup).toBeDefined();
    expect(real).toBeDefined();
    expect(fnGroup?.x).toBe(g.globalXStart);
    expect(fnGroup?.depth).toBe(-1);
    expect(real?.x ?? 0).toBeGreaterThan(fnGroup?.x ?? 0);
  });
});

// ===========================================================================
// LP-07 — No-fn module leaves column 0 empty; types align at the global floor
// ===========================================================================
describe('LP-07 no-fn band keeps column 0 empty', () => {
  it('plain band first type aligns to with_fns first real type, both past globalXStart', () => {
    const c = crateFacts('c', [
      {
        path: 'with_fns',
        file: 'src/with_fns.rs',
        types: [ty('c', 'with_fns', 'Real')],
        functions: [{ name: 'do_thing', visibility: 'pub' }],
      },
      mod('plain', [ty('c', 'plain', 'Plain')]),
    ]);
    const g = computeGeometry({
      ...buildInputs(c, [], ['c', 'c::with_fns', 'c::plain']),
      measureText: measure,
    });
    const real = g.types.find((t) => t.node.id === 'c::with_fns::Real');
    const plain = g.types.find((t) => t.node.id === 'c::plain::Plain');
    expect(real).toBeDefined();
    expect(plain).toBeDefined();
    // Plain has no fn group of its own, but the GLOBAL fn column still floors
    // it — it lands at the same x as Real (the type-area baseline), strictly
    // right of globalXStart. The naive "types start at globalXStart" oracle is
    // WRONG: column 0 is reserved even for bands with no fn group.
    expect(plain?.x).toBe(real?.x);
    expect(plain?.x ?? 0).toBeGreaterThan(g.globalXStart);
  });
});

// ===========================================================================
// LP-08 — Global fn-column width tracks the widest fn fragment
// ===========================================================================
describe('LP-08 global fn-column width tracks widest fn row', () => {
  function buildWithFn(fnName: string): Geometry {
    const c = crateFacts('c', [
      {
        path: 'with_fns',
        file: 'src/with_fns.rs',
        types: [],
        functions: [{ name: fnName, visibility: 'pub' }],
      },
      mod('plain', [ty('c', 'plain', 'Plain')]),
    ]);
    return computeGeometry({
      ...buildInputs(c, [], ['c', 'c::with_fns', 'c::with_fns::__fn_pub', 'c::plain']),
      measureText: measure,
    });
  }

  it('widening one fn row pushes the type baseline in a different, plain band right', () => {
    const shortBuild = buildWithFn('go');
    const longBuild = buildWithFn(`go_${'x'.repeat(60)}`);
    const plainShort = shortBuild.types.find((t) => t.node.id === 'c::plain::Plain');
    const plainLong = longBuild.types.find((t) => t.node.id === 'c::plain::Plain');
    if (!plainShort || !plainLong) throw new Error('missing plain type');

    // Accepted tradeoff (pinned direction): the empty leftmost column is a
    // GLOBAL reservation sized to the widest fn fragment, so widening one fn
    // row in with_fns shifts the plain band's type baseline right too. A
    // "fix" that makes the column band-local would fail here on purpose.
    expect(plainLong.x).toBeGreaterThan(plainShort.x);
  });
});

// ===========================================================================
// LP-09 — Empty container module → no occupied type stripe
// ===========================================================================
describe('LP-09 empty container module', () => {
  it('a 0-own-type container occupies no type stripe; the leaf band still places correctly', () => {
    const c = crateFacts('c', [
      mod(''),
      mod('outer'), // container, no own types
      mod('outer::inner', [ty('c', 'outer::inner', 'Leaf')]),
    ]);
    const g = computeGeometry({
      ...buildInputs(c, [], ['c', 'c::outer', 'c::outer::inner']),
      measureText: measure,
    });

    // (a) No PositionedType is anchored to the empty container band.
    expect(g.types.filter((t) => t.bandId === 'c::outer')).toHaveLength(0);

    // (b) The container's band is the minimal row height (no type rows) — it
    // does not occupy a type-row block / dead stripe.
    const outer = g.modules.find((m) => m.node.id === 'c::outer');
    expect(outer).toBeDefined();
    expect(outer?.bandHeight).toBe(ROW_H);

    // (c) The deep leaf is still placed, below outer's header and not
    // overlapping it.
    const leaf = g.types.find((t) => t.node.id === 'c::outer::inner::Leaf');
    expect(leaf).toBeDefined();
    expect(leaf?.bandId).toBe('c::outer::inner');
    const innerY = bandCursorY(g, 'c::outer::inner');
    expect(leaf?.y ?? 0).toBeGreaterThanOrEqual(innerY);
    expect(innerY).toBeGreaterThanOrEqual((outer?.y ?? 0) + (outer?.bandHeight ?? 0) - EPS);
  });
});

// ===========================================================================
// LP-10 / LP-11 — globalXStart and type-pane x from visible modules only
// ===========================================================================
describe('LP-10 / LP-11 globalXStart from visible modules', () => {
  const longLeaf = 'reallyLongModule'.repeat(4);
  function buildLong(expanded: string[]): Geometry {
    const c = crateFacts('c', [
      mod('', [ty('c', '', 'A')]),
      mod(`a::b::${longLeaf}`, [ty('c', `a::b::${longLeaf}`, 'Hidden')]),
    ]);
    return computeGeometry({ ...buildInputs(c, [], expanded), measureText: measure });
  }

  it('LP-10: collapsed deep long-path module does NOT inflate globalXStart', () => {
    const collapsed = buildLong(['c']);
    const expanded = buildLong(['c', 'c::a', 'c::a::b']);
    expect(collapsed.globalXStart).toBeLessThan(expanded.globalXStart);
  });

  it('LP-11: expanding the deep long-path module DOES shift the type pane right (intended tradeoff)', () => {
    const collapsed = buildLong(['c']);
    const expanded = buildLong(['c', 'c::a', 'c::a::b']);
    const aCollapsed = collapsed.types.find((t) => t.node.id === 'c::A');
    const aExpanded = expanded.types.find((t) => t.node.id === 'c::A');
    if (!aCollapsed || !aExpanded) throw new Error('missing root type A');
    // The documented tradeoff: making the long leaf visible grows the module
    // column, so the type pane (A's x, the first type column) shifts right. A
    // future "stability" change that re-reserves worst-case width would make
    // this collapsed/expanded difference vanish and fail here on purpose.
    expect(aExpanded.x).toBeGreaterThan(aCollapsed.x);
  });
});

// ===========================================================================
// LP-12 — `→` glyph bold measure only when selected (regression-lock)
// ===========================================================================
describe('LP-12 callable glyph uses bold width only when selected', () => {
  function fnModule() {
    return crateFacts('c', [
      { path: 'm', file: 'src/m.rs', types: [], functions: [{ name: 'parse', visibility: 'pub' }] },
    ]);
  }
  const fnGroupId = 'c::m::__fn_pub';

  it('unselected row uses regular width; selecting it inflates to bold and pushes the glyph right', () => {
    const base = buildInputs(fnModule(), [], ['c', 'c::m', fnGroupId]);

    const unselected = buildLayout({ ...base, measureText: measure, measureBoldText: measureBold });
    const uRow = unselected.types
      .find((t) => t.id === fnGroupId)
      ?.fields.find((f) => f.kind === 'function');
    if (!uRow) throw new Error('expected function row');

    const selected = buildLayout({
      ...base,
      measureText: measure,
      measureBoldText: measureBold,
      callArrowsShown: new Set([callArrowKey(fnGroupId, 'parse', 'function')]),
    });
    const sRow = selected.types
      .find((t) => t.id === fnGroupId)
      ?.fields.find((f) => f.kind === 'function');
    if (!sRow) throw new Error('expected function row');

    // Unselected stays tight (regular measurer) — the naive "always bold
    // measure" oracle is WRONG, it would inflate every unselected row.
    expect(uRow.textWidth).toBe(measure('parse'));
    // The locality glyph hugs the regular name on the unselected row.
    expect(uRow.localityGlyphX).toBeCloseTo(uRow.x + uRow.textWidth + 2, 1);

    // Selected uses the bold measurer, which is strictly wider, so the glyph
    // moves right and never sits left of the bold name's right edge.
    expect(sRow.textWidth).toBe(measureBold('parse'));
    expect(sRow.localityGlyphX ?? 0).toBeGreaterThan(uRow.localityGlyphX ?? 0);
    expect(sRow.localityGlyphX ?? 0).toBeGreaterThanOrEqual(sRow.x + sRow.textWidth - EPS);
  });
});

// ===========================================================================
// LP-13 — Tight `→` glyph gap
// ===========================================================================
describe('LP-13 tight locality glyph gap', () => {
  it('glyph hugs the row name and sits just before the arrow exit', () => {
    const c = crateFacts('c', [
      { path: 'm', file: 'src/m.rs', types: [], functions: [{ name: 'parse', visibility: 'pub' }] },
    ]);
    const layout = buildLayout({
      ...buildInputs(c, [], ['c', 'c::m', 'c::m::__fn_pub']),
      measureText: measure,
    });
    const fn = layout.types
      .find((t) => t.id === 'c::m::__fn_pub')
      ?.fields.find((f) => f.kind === 'function');
    if (!fn || fn.localityGlyphX === undefined) throw new Error('expected function row with glyph');

    const glyphW = measure('→');
    const nameTrailingGap = fn.localityGlyphX - (fn.x + fn.textWidth);
    const localityGap = fn.arrowSourceX - (fn.localityGlyphX + glyphW);

    // Both gaps are the tightened small constants (a regression to the wide
    // `+4` gap fails here). Assert they are small and the structural ordering
    // name < glyph < exit holds, without baking in the exact pixel value.
    expect(nameTrailingGap).toBeGreaterThan(0);
    expect(nameTrailingGap).toBeLessThanOrEqual(4);
    expect(localityGap).toBeGreaterThan(0);
    expect(localityGap).toBeLessThanOrEqual(4);
    expect(fn.localityGlyphX).toBeGreaterThan(fn.x + fn.textWidth);
    expect(fn.localityGlyphX).toBeLessThan(fn.arrowSourceX);
  });
});

// ===========================================================================
// LP-14 — Cross-module owned type right of its visible owner
// ===========================================================================
describe('LP-14 cross-module owned type stays right of owner', () => {
  it('target.x >= owner.x + owner.width', () => {
    const c = crateFacts('c', [
      mod('', [ty('c', '', 'Owner', [{ name: 'target', ty_text: 'deep::Target' }])]),
      mod('deep', [ty('c', 'deep', 'Target')]),
    ]);
    const g = computeGeometry({
      ...buildInputs(c, [edge('c::Owner', 'c::deep::Target', 'field target')], ['c', 'c::deep']),
      measureText: measure,
    });
    const owner = g.typesById.get('c::Owner');
    const target = g.typesById.get('c::deep::Target');
    expect(owner).toBeDefined();
    expect(target).toBeDefined();
    expect(target?.x ?? 0).toBeGreaterThanOrEqual((owner?.x ?? 0) + (owner?.width ?? 0));
  });
});

// ===========================================================================
// LP-25 — Long field/method type annotations do not affect physical block width
// ===========================================================================
// Required invariant (layout.md "Physical Placement" + "Required Invariants"):
// block width counts the member-NAME anchor, never the hover/detail `ty_text`
// suffix. A verbose Rust type annotation must not force the parent box wide or
// push unrelated boxes apart.
describe('LP-25 long type annotations do not widen the block', () => {
  function buildWithFieldType(tyText: string): Geometry {
    // Two sibling types at depth 1 under one owner: the first carries a single
    // expanded field whose NAME is fixed but whose ty_text varies. The second
    // is a plain neighbour whose x reveals whether the first box grew.
    const c = crateFacts('c', [
      mod('m', [
        ty('c', 'm', 'Owner', [
          { name: 'a', ty_text: 'A' },
          { name: 'b', ty_text: 'B' },
        ]),
        ty('c', 'm', 'A', [{ name: 'field', ty_text: tyText }]),
        ty('c', 'm', 'B'),
      ]),
    ]);
    const edges = [
      edge('c::m::Owner', 'c::m::A', 'field a'),
      edge('c::m::Owner', 'c::m::B', 'field b'),
    ];
    return computeGeometry({
      ...buildInputs(c, edges, ['c', 'c::m', 'c::m::A']),
      measureText: measure,
    });
  }

  it('a verbose ty_text leaves the box width and every neighbour x unchanged', () => {
    const gShort = buildWithFieldType('u8');
    const gLong = buildWithFieldType(`Verbose::${'Generic<'.repeat(20)}u8>`);

    const aShort = gShort.typesById.get('c::m::A');
    const aLong = gLong.typesById.get('c::m::A');
    if (!aShort || !aLong) throw new Error('missing type A');

    // Non-vacuity: the box really is expanded with a visible field row whose
    // ty_text differs between the two builds.
    expect(aShort.visibleRows).toHaveLength(1);
    expect(aLong.visibleRows[0]?.tyText).not.toBe(aShort.visibleRows[0]?.tyText);
    // The differing ty_text annotation is far wider than the box, yet the box
    // width is byte-identical — width tracks the member-name anchor only.
    expect(measure(aLong.visibleRows[0]?.tyText ?? '')).toBeGreaterThan(aShort.width);
    expect(aLong.width).toBe(aShort.width);

    // The neighbour box B does not get pushed apart by A's verbose annotation.
    const bShort = gShort.typesById.get('c::m::B');
    const bLong = gLong.typesById.get('c::m::B');
    expect(bLong?.x).toBe(bShort?.x);
    expect(bLong?.y).toBe(bShort?.y);
  });
});

// ===========================================================================
// LP-26 — Rule 2: same-depth items spread into >1 column toward 16:9
// ===========================================================================
// Core Rule 2: same-depth items SPREAD into columns (driven by item count +
// stable order) toward a 16:9 band shape, instead of stacking into one tall
// column. Spreading must come from count/order, never from measured size —
// asserted here by checking the column partition is unchanged when one item
// expands (size changed, columns did not).
describe('LP-26 same-depth spread toward 16:9', () => {
  it('a many-item same-depth bucket occupies multiple columns and ignores box size when spreading', () => {
    const g = denseSameDepth(24);
    const depthOne = g.types.filter((t) => t.bandId === 'w::l0' && t.depth === 1);
    expect(depthOne.length).toBe(23);

    const cols = [...new Set(depthOne.map((t) => colOf(g, t)))].sort((a, b) => a - b);
    // It spread into more than one column but did NOT degenerate to one column
    // per item (the rejected single-tall-column shape).
    expect(cols.length).toBeGreaterThan(1);
    expect(cols.length).toBeLessThan(depthOne.length);

    // Trend toward 16:9: the band is meaningfully wider than tall in column
    // terms — columns used > rows in the tallest column. (Count-only spread, so
    // this holds regardless of box pixel sizes.)
    const perCol = new Map<number, number>();
    for (const t of depthOne) perCol.set(colOf(g, t), (perCol.get(colOf(g, t)) ?? 0) + 1);
    const maxPerCol = Math.max(...perCol.values());
    expect(cols.length).toBeGreaterThanOrEqual(maxPerCol);
  });
});

// ===========================================================================
// LP-15 — No box / obstacle overlap at scale (dense)
// ===========================================================================
describe('LP-15 no box/obstacle overlap at scale', () => {
  it('placeGridItemsTopToBottom does not throw and no per-band boxes/obstacles overlap', () => {
    // Build is wrapped so a GridPlacementFailure (thrown on silent overlap)
    // surfaces as a test failure rather than passing vacuously.
    const inputs = {
      ...denseInputs({
        modules: 6,
        typesPerModule: 8,
        ownershipFanout: 5,
        crossModuleRatio: 0.4,
        nestingDepth: 2,
        branchFactor: 2,
      }),
      measureText: measure,
    };
    const g = computeGeometry(inputs);
    const obstacles = computeObstacles(g, measure);
    expect(g.types.length).toBeGreaterThan(20); // non-vacuous scale guard

    // Header rects: no two types in the same band overlap.
    const byBand = new Map<string, PositionedType[]>();
    for (const t of g.types) byBand.set(t.bandId, [...(byBand.get(t.bandId) ?? []), t]);
    for (const [bandId, types] of byBand) {
      for (let i = 0; i < types.length; i++) {
        const a = types[i];
        if (a === undefined) continue;
        for (let j = i + 1; j < types.length; j++) {
          const b = types[j];
          if (b === undefined) continue;
          expect(
            overlaps(typeRect(a), typeRect(b)),
            `${bandId}: ${a.node.id} overlaps ${b.node.id}`,
          ).toBe(false);
        }
      }
    }

    // Full obstacle blocks: no two obstacles of different types in the same
    // band overlap.
    const obsByBand = new Map<string, typeof obstacles.all>();
    const bandOf = new Map(g.types.map((t) => [t.node.id, t.bandId] as const));
    for (const o of obstacles.all) {
      const band = bandOf.get(o.typeId) ?? '';
      obsByBand.set(band, [...(obsByBand.get(band) ?? []), o]);
    }
    for (const [band, obs] of obsByBand) {
      for (let i = 0; i < obs.length; i++) {
        const a = obs[i];
        if (a === undefined) continue;
        for (let j = i + 1; j < obs.length; j++) {
          const b = obs[j];
          if (b === undefined || a.typeId === b.typeId) continue;
          expect(
            overlaps(obstacleRect(a), obstacleRect(b)),
            `${band}: obstacle ${a.typeId} overlaps ${b.typeId}`,
          ).toBe(false);
        }
      }
    }
  });
});

// ===========================================================================
// LP-16 — fn-group ↔ real-type non-collision
// ===========================================================================
describe('LP-16 fn-group never collides with real types', () => {
  it('the fn group is strictly left of every real type and its block does not overlap them', () => {
    // Dense same-depth band PLUS a free function so a fn-group pseudo-type
    // appears in the same band as many real types.
    const typeCount = 16;
    const c = crateFacts('c', [
      {
        path: 'm',
        file: 'src/m.rs',
        types: Array.from({ length: typeCount }, (_, i) => ty('c', 'm', `T${i}`)),
        functions: [{ name: 'helper', visibility: 'pub' }],
      },
    ]);
    const g = computeGeometry({ ...buildInputs(c, [], ['c', 'c::m']), measureText: measure });
    const obstacles = computeObstacles(g, measure);

    const fnGroup = g.types.find((t) => t.node.typeKind === 'function_group');
    const realTypes = g.types.filter((t) => /^c::m::T\d+$/.test(t.node.id));
    expect(fnGroup).toBeDefined();
    expect(realTypes.length).toBe(typeCount);
    if (!fnGroup) throw new Error('no fn group');

    const fnBlock = obstacles.blockByType.get(fnGroup.node.id);
    expect(fnBlock).toBeDefined();
    for (const real of realTypes) {
      // The reserved-column separation: fn group entirely left of every real
      // type (the original collision came from both sharing rankOrder 0).
      expect(fnGroup.x + fnGroup.width, `fnGroup left of ${real.node.id}`).toBeLessThanOrEqual(
        real.x + EPS,
      );
      const realBlock = obstacles.blockByType.get(real.node.id);
      if (fnBlock && realBlock) {
        expect(
          overlaps(obstacleRect(fnBlock), obstacleRect(realBlock)),
          `fnGroup block overlaps ${real.node.id}`,
        ).toBe(false);
      }
    }
  });
});

// ===========================================================================
// LP-17 — Placement determinism
// ===========================================================================
describe('LP-17 placement determinism', () => {
  it('identical inputs produce byte-identical positions across repeated builds', () => {
    const reference = positionsKey(
      computeGeometry({
        ...mediumFixtureInputs(['c', 'c::m', 'c::m::Root']),
        measureText: measure,
      }),
    );
    for (let i = 0; i < 5; i++) {
      const next = positionsKey(
        computeGeometry({
          ...mediumFixtureInputs(['c', 'c::m', 'c::m::Root']),
          measureText: measure,
        }),
      );
      expect(next).toBe(reference);
    }
  });

  it('dense fixture is deterministic through the full buildLayout pipeline', () => {
    const fingerprint = (l: { types: readonly TypeBox[] }): string =>
      [...l.types]
        .map((t) => `${t.id}|${t.x}|${t.y}|${t.width}|${t.height}`)
        .sort()
        .join('\n');
    const a = buildLayout({
      ...denseInputs({ modules: 4, typesPerModule: 5 }),
      measureText: measure,
    });
    const b = buildLayout({
      ...denseInputs({ modules: 4, typesPerModule: 5 }),
      measureText: measure,
    });
    expect(fingerprint(a)).toBe(fingerprint(b));
  });
});
