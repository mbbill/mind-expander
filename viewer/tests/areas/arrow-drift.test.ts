// Tier-2 pure-layout regression tests for OWNERSHIP-ARROW DRIFT (GROUP I).
//
// These cover the data/analysis contract that the visual layer reads:
//   • each ownership arrow's `driftClass` is the TARGET type's drift class
//     (canonical / drift_below / drift_above / drift_sideways), and
//   • a field row's `memberDriftClass` is the strongest drift among that
//     row's targets, and
//   • canonical ownership arrows are ALWAYS visible (rendered even when
//     `fieldArrowsShown` is empty), while drifted ones are opt-in.
//
// Pure `buildLayout` oracles — no DOM. Fixtures are built with the shared
// `builders.ts` helpers and a hand-shaped module hierarchy that places a
// type at every drift relationship to its owner (at_lca, >1 below, above,
// sideways). Style mirrors tests/areas/arrow-routing.layout.test.ts.

import { describe, expect, it } from 'vitest';
import type { DriftClass } from '../../src/analysis/drift.ts';
import type { Arrow, Layout, LayoutInputs } from '../../src/analysis/layout_model.ts';
import { rowArrowKey } from '../../src/analysis/layout_model.ts';
import { buildLayout } from '../../src/layout/pipeline.ts';
import { buildInputs, crateFacts, edge, mod, ty } from '../fixtures/builders.ts';

const measure = (s: string): number => s.length * 7;

// ---------------------------------------------------------------------------
// Drift-class fixture. A single crate placing four target types at four
// distinct drift relationships to their (single) owner:
//   • Canon       — same module as owner Hub (root)            → at_lca
//   • a::b::c::Below — 3 levels below owner Hub's module (root) → drift_below
//   • Above       — owned by deep::sub::AboveOwner, lives at root
//                   so the LCA (deep::sub) is a descendant of the
//                   type's module                              → drift_above
//   • right::Sideways — owned by left::SideOwner; different
//                   subtree (left vs right)                    → drift_sideways
// Each owner is a distinct type so every target has exactly one owner and
// the class is unambiguous.
// ---------------------------------------------------------------------------

const HUB = 'c::Hub';
const SIDE_OWNER = 'c::left::SideOwner';
const ABOVE_OWNER = 'c::deep::sub::AboveOwner';

function driftInputs(): LayoutInputs {
  const c = crateFacts('c', [
    mod('', [
      ty('c', '', 'Hub', [
        { name: 'canon', ty_text: 'Canon' },
        { name: 'below', ty_text: 'a::b::c::Below' },
      ]),
      ty('c', '', 'Canon'),
      ty('c', '', 'Above'),
    ]),
    mod('a::b::c', [ty('c', 'a::b::c', 'Below')]),
    mod('deep::sub', [ty('c', 'deep::sub', 'AboveOwner', [{ name: 'up', ty_text: 'deep::Above' }])]),
    mod('left', [ty('c', 'left', 'SideOwner', [{ name: 'sw', ty_text: 'right::Sideways' }])]),
    mod('right', [ty('c', 'right', 'Sideways')]),
  ]);
  // `deep::Above` resolves to the root `Above` type (owner sits below it).
  const edges = [
    edge(HUB, 'c::Canon', 'field canon'),
    edge(HUB, 'c::a::b::c::Below', 'field below'),
    edge(ABOVE_OWNER, 'c::Above', 'field up'),
    edge(SIDE_OWNER, 'c::right::Sideways', 'field sw'),
  ];
  const expanded = [
    'c',
    'c::a',
    'c::a::b',
    'c::a::b::c',
    'c::deep',
    'c::deep::sub',
    'c::left',
    'c::right',
    HUB,
    ABOVE_OWNER,
    SIDE_OWNER,
  ];
  return buildInputs(c, edges, expanded);
}

/** Reveal every drifted row so all four arrows are present at once. */
function allDriftedShown(): ReadonlySet<string> {
  return new Set([
    rowArrowKey(HUB, 'below'),
    rowArrowKey(ABOVE_OWNER, 'up'),
    rowArrowKey(SIDE_OWNER, 'sw'),
  ]);
}

function ownershipArrows(layout: Layout): readonly Arrow[] {
  return layout.arrows.filter((a) => a.kind === 'ownership');
}

function arrowByTarget(layout: Layout, toTypeId: string): Arrow | undefined {
  return ownershipArrows(layout).find((a) => a.toTypeId === toTypeId);
}

// ---------------------------------------------------------------------------
// GI-DRIFT-1 — an ownership arrow's driftClass is the TARGET type's class.
// arrowColor() in tree.ts switches on exactly this, so a wrong class here
// would paint the arrow the wrong colour. Verifying at the layout layer
// keeps the colour decision honest at its source.
// ---------------------------------------------------------------------------

describe('GI-DRIFT-1 — arrow.driftClass equals the target type drift class', () => {
  it('classifies canonical / below / above / sideways targets distinctly', () => {
    const layout = buildLayout({
      ...driftInputs(),
      fieldArrowsShown: allDriftedShown(),
      measureText: measure,
    });

    const cases: ReadonlyArray<readonly [string, DriftClass]> = [
      ['c::Canon', 'at_lca'],
      ['c::a::b::c::Below', 'drift_below'],
      ['c::Above', 'drift_above'],
      ['c::right::Sideways', 'drift_sideways'],
    ];
    for (const [target, expected] of cases) {
      const arrow = arrowByTarget(layout, target);
      expect(arrow, `ownership arrow to ${target} present`).toBeDefined();
      expect(arrow?.driftClass, `drift class for ${target}`).toBe(expected);
    }
    // Non-vacuous: all four arrows present together.
    expect(ownershipArrows(layout)).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// GI-DRIFT-2 — a field row's memberDriftClass mirrors the strongest drift
// among that row's targets. The drift DOT renders off exactly this field,
// so the dot colour decision starts here.
// ---------------------------------------------------------------------------

describe('GI-DRIFT-2 — field row memberDriftClass mirrors its target drift', () => {
  it('Hub.canon=canonical, Hub.below=drift_below; SideOwner.sw=sideways; AboveOwner.up=above', () => {
    const layout = buildLayout({
      ...driftInputs(),
      fieldArrowsShown: allDriftedShown(),
      measureText: measure,
    });
    const rowDrift = (typeId: string, field: string): DriftClass | null => {
      const box = layout.types.find((t) => t.id === typeId);
      const row = box?.fields.find((f) => f.name === field);
      return row?.memberDriftClass ?? null;
    };
    expect(rowDrift(HUB, 'canon')).toBe('at_lca');
    expect(rowDrift(HUB, 'below')).toBe('drift_below');
    expect(rowDrift(SIDE_OWNER, 'sw')).toBe('drift_sideways');
    expect(rowDrift(ABOVE_OWNER, 'up')).toBe('drift_above');
  });
});

// ---------------------------------------------------------------------------
// GI-DRIFT-3 — Canonical ownership arrows are ALWAYS visible, even when
// `fieldArrowsShown` is an empty set; drifted arrows are opt-in and absent
// until their row is revealed. This is the visibility contract the catalog
// flags as uncovered ("Canonical arrows ALWAYS visible").
// ---------------------------------------------------------------------------

describe('GI-DRIFT-3 — canonical arrows always visible, drift arrows opt-in', () => {
  it('empty fieldArrowsShown shows the canonical arrow but hides every drift arrow', () => {
    const layout = buildLayout({
      ...driftInputs(),
      fieldArrowsShown: new Set(), // user has revealed nothing
      measureText: measure,
    });
    const targets = new Set(ownershipArrows(layout).map((a) => a.toTypeId));
    // Canonical (at_lca) target is shown unconditionally.
    expect(targets.has('c::Canon'), 'canonical arrow visible by default').toBe(true);
    // None of the drifted targets are shown until opted in.
    expect(targets.has('c::a::b::c::Below'), 'drift_below hidden by default').toBe(false);
    expect(targets.has('c::Above'), 'drift_above hidden by default').toBe(false);
    expect(targets.has('c::right::Sideways'), 'drift_sideways hidden by default').toBe(false);
  });

  it('revealing one drifted row adds exactly that arrow, keeping canonical visible', () => {
    const layout = buildLayout({
      ...driftInputs(),
      fieldArrowsShown: new Set([rowArrowKey(HUB, 'below')]),
      measureText: measure,
    });
    const targets = new Set(ownershipArrows(layout).map((a) => a.toTypeId));
    expect(targets.has('c::Canon')).toBe(true); // still there
    expect(targets.has('c::a::b::c::Below')).toBe(true); // now revealed
    expect(targets.has('c::Above')).toBe(false); // still hidden
    expect(targets.has('c::right::Sideways')).toBe(false); // still hidden
  });

  it('undefined fieldArrowsShown (no per-row gating) reveals every arrow', () => {
    // When the host passes no fieldArrowsShown set at all, the layout falls
    // back to "show everything" — canonical and drifted alike.
    const layout = buildLayout({ ...driftInputs(), measureText: measure });
    const targets = new Set(ownershipArrows(layout).map((a) => a.toTypeId));
    expect(targets.has('c::Canon')).toBe(true);
    expect(targets.has('c::a::b::c::Below')).toBe(true);
    expect(targets.has('c::Above')).toBe(true);
    expect(targets.has('c::right::Sideways')).toBe(true);
  });
});
