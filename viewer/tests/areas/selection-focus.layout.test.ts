// Tier-2 layout / analysis invariants for the `selection-focus` area
// (node env, no DOM). These pin the PURE pieces behind the diagram⇄code
// selection loop: arrow-endpoint resolution, arrow-hit zone semantics,
// owner-reveal field-key derivation, the atomic end-to-end reveal through
// buildLayout, member-row point lookup, and disambig grouping at scale.
//
// The oracle in every case is the strong correct-behavior assertion from
// test-plan/selection-focus.md — e.g. SF-T2-01 asserts the nav point is
// the layout arrow's OWN waypoint and is invariant to the (noisy) click
// anchor, not a re-derived geometry (the historical "pans to cursor" bug).

import { describe, expect, it } from 'vitest';
import { pickArrowsAtPoint } from '../../src/analysis/arrow_hit.ts';
import type { Arrow, Layout } from '../../src/analysis/layout_model.ts';
import { rowArrowKey } from '../../src/analysis/layout_model.ts';
import { buildSpanIndex, containingTypeBoxIdFor } from '../../src/data/spans.ts';
import { buildLayout } from '../../src/layout/pipeline.ts';
import { groupArrowHits } from '../../src/view/arrow_disambig.ts';
import { arrowEndpointLayoutPoint } from '../../src/view/arrow_navigation.ts';
import { lookupMemberRowPoint } from '../../src/view/layout_lookup.ts';
import { fieldKey } from '../../src/view/tree.ts';
import { ownerFieldsPointingTo } from '../../src/view/type_expansion.ts';
import { buildInputs, crateFacts, edge, facts, mod, ty } from '../fixtures/builders.ts';
import { denseHighFanout } from '../fixtures/dense.ts';
import { smallFixtureInputs } from '../fixtures/small.ts';

const measure = (s: string): number => s.length * 7;

const SMALL_EXPANDED = [
  'c',
  'c::core',
  'c::render',
  'c::App',
  'c::core::Engine',
  'c::render::Renderer',
];

function smallLayout(expanded: string[] = SMALL_EXPANDED): Layout {
  return buildLayout({ ...smallFixtureInputs(expanded), measureText: measure });
}

/** First call arrow `App.engine → Engine` in the small fixture layout. */
function appEngineArrow(layout: Layout): Arrow {
  const a = layout.arrows.find(
    (arrow) => arrow.fromTypeId === 'c::App' && arrow.toTypeId === 'c::core::Engine',
  );
  if (a === undefined) throw new Error('expected App→Engine arrow in small layout');
  return a;
}

describe('SF-T2-01/02 — single-arrow nav resolves to the layout arrow waypoint', () => {
  it('source-zone click resolves to the TARGET endpoint = arrow last waypoint, independent of anchor', () => {
    const layout = smallLayout();
    const arrow = appEngineArrow(layout);
    const last = arrow.waypoints[arrow.waypoints.length - 1];
    expect(last).toBeDefined();

    // `arrowEndpointLayoutPoint` re-finds the freshly-routed arrow by edge
    // identity and reads its own waypoint. The screen anchor where the user
    // clicked in the source zone never enters this computation — so the
    // resolved data-space point is identical for any in-zone click.
    const p = arrowEndpointLayoutPoint(layout, arrow, 'target');
    expect(p).toEqual({ x: last?.x, y: last?.y });

    // A stale copy of the same edge (different cached waypoints) still
    // resolves to the FRESH layout arrow's endpoint — proving the point is
    // the producer's waypoint, not anything carried on the click.
    const stale: Arrow = {
      ...arrow,
      waypoints: [
        { x: -999, y: -999 },
        { x: -888, y: -888 },
      ],
    };
    expect(arrowEndpointLayoutPoint(layout, stale, 'target')).toEqual({ x: last?.x, y: last?.y });
  });

  it('target-zone click mirrors to the SOURCE endpoint = arrow first waypoint', () => {
    const layout = smallLayout();
    const arrow = appEngineArrow(layout);
    const first = arrow.waypoints[0];
    expect(first).toBeDefined();
    expect(arrowEndpointLayoutPoint(layout, arrow, 'source')).toEqual({ x: first?.x, y: first?.y });
  });
});

describe('SF-T2-03 — containingTypeBoxIdFor maps element kinds to their visible box', () => {
  it('type → itself; field T::x → T', () => {
    const f = facts(
      crateFacts('c', [
        mod('', [ty('c', '', 'App', [{ name: 'engine', ty_text: 'core::Engine' }])]),
        mod('core', [ty('c', 'core', 'Engine', [{ name: 'cyl', ty_text: 'Cylinder' }])]),
      ]),
      [],
    );
    const index = buildSpanIndex(f);

    // A type box is its own container.
    expect(containingTypeBoxIdFor(index, 'c::App', 'type')).toBe('c::App');
    expect(containingTypeBoxIdFor(index, 'c::core::Engine', 'type')).toBe('c::core::Engine');
    // A field resolves to its owning type box (so selecting it expands a
    // real container; otherwise the row never renders).
    expect(containingTypeBoxIdFor(index, 'c::App::engine', 'field')).toBe('c::App');
    expect(containingTypeBoxIdFor(index, 'c::core::Engine::cyl', 'field')).toBe('c::core::Engine');
  });
});

describe('SF-T2-05 — owner reveal selects the owner field pointing at the target', () => {
  it('ownerFieldsPointingTo(App, Engine) includes the engine field; reveal adds its fieldKey', () => {
    const inputs = smallFixtureInputs(SMALL_EXPANDED);
    const fields = ownerFieldsPointingTo(inputs.ownership, 'c::App', 'c::core::Engine');
    expect(fields).toContain('engine');

    // The reveal affordance adds `fieldKey(owner, field, 'field')` for each
    // pointing field — expanding the owner alone is insufficient (the drift
    // routing filter is per-field, not per-owner).
    const selectedFields = new Set<string>();
    for (const name of fields) selectedFields.add(fieldKey('c::App', name, 'field'));
    expect(selectedFields.has(fieldKey('c::App', 'engine', 'field'))).toBe(true);
  });
});

describe('SF-T2-06 — owner-arrows-active reflects ALL pointing fields selected, not any', () => {
  // Owner with TWO fields pointing at the SAME target. The single-owner
  // toggle direction depends on "every pointing field selected" (true) vs
  // "some/none" (false) — `any` would flip the toggle one click early.
  const c = crateFacts('c', [
    mod('', [
      ty('c', '', 'App', [
        { name: 'engine', ty_text: 'core::Engine' },
        { name: 'spare', ty_text: 'core::Engine' },
      ]),
    ]),
    mod('core', [ty('c', 'core', 'Engine')]),
  ]);
  const edges = [
    edge('c::App', 'c::core::Engine', 'field engine'),
    edge('c::App', 'c::core::Engine', 'field spare'),
  ];
  const inputs = buildInputs(c, edges, ['c', 'c::core', 'c::App']);
  const ownership = inputs.ownership;

  // Mirror of main.ts's private `ownerArrowsActive` closure, built from the
  // exported helpers it is composed of, so the oracle is the real one.
  const ownerArrowsActive = (selected: ReadonlySet<string>): boolean => {
    const fields = ownerFieldsPointingTo(ownership, 'c::App', 'c::core::Engine');
    if (fields.length === 0) return false;
    return fields.every((name) => selected.has(fieldKey('c::App', name, 'field')));
  };

  it('false when zero fields selected', () => {
    expect(ownerArrowsActive(new Set())).toBe(false);
  });

  it('false when only SOME pointing fields are selected', () => {
    expect(ownerArrowsActive(new Set([fieldKey('c::App', 'engine', 'field')]))).toBe(false);
  });

  it('true only when EVERY pointing field is selected', () => {
    const both = new Set([
      fieldKey('c::App', 'engine', 'field'),
      fieldKey('c::App', 'spare', 'field'),
    ]);
    expect(ownerArrowsActive(both)).toBe(true);
  });

  it('false for a target the owner does not point at (no pointing fields)', () => {
    const fields = ownerFieldsPointingTo(ownership, 'c::App', 'c::core::Nope');
    expect(fields.length).toBe(0);
  });
});

describe('SF-T2-07 — atomic owner reveal: the field key makes buildLayout emit the DRIFTED arrow', () => {
  // The per-field gate (geometry.ts:730) only opts-in DRIFTED member arrows;
  // canonical structure is always shown. So the atomic-reveal invariant must
  // be exercised on a drifted edge. Here `Owner` lives at `c::a::b` and owns
  // `Target` at the crate root, which classifies as `drift_above` — exactly
  // the anomalous ownership the red-dot reveal is for. Revealing the owner
  // ROW alone is insufficient; the field key must be present for the arrow
  // to route.
  const driftInputs = buildInputs(
    crateFacts('c', [
      mod('', [ty('c', '', 'Target')]),
      mod('a::b', [ty('c', 'a::b', 'Owner', [{ name: 'tgt', ty_text: 'Target' }])]),
    ]),
    [edge('c::a::b::Owner', 'c::Target', 'field tgt')],
    ['c', 'c::a', 'c::a::b', 'c::a::b::Owner', 'c::Target'],
  );

  const hasDriftArrow = (layout: Layout): boolean =>
    layout.arrows.some((a) => a.fromTypeId === 'c::a::b::Owner' && a.toTypeId === 'c::Target');

  it('confirms the edge is drifted (precondition for the per-field gate)', () => {
    expect(driftInputs.drift.typeClass.get('c::Target')).toBe('drift_above');
  });

  it('omitting the field key suppresses the drifted Owner.tgt→Target arrow; adding it emits it', () => {
    const suppressed = buildLayout({
      ...driftInputs,
      measureText: measure,
      fieldArrowsShown: new Set<string>(),
    });
    expect(hasDriftArrow(suppressed)).toBe(false);

    const revealed = buildLayout({
      ...driftInputs,
      measureText: measure,
      fieldArrowsShown: new Set<string>([rowArrowKey('c::a::b::Owner', 'tgt')]),
    });
    expect(hasDriftArrow(revealed)).toBe(true);
  });
});

describe('SF-T2-10 — arrow-hit zone splits the polyline into source/target halves', () => {
  // The split is by ARC LENGTH along the polyline (corner at half length),
  // not the geometric midpoint — single-arrow direct nav direction depends
  // on this. A click in the first half ⇒ 'source' (go to target); second
  // half ⇒ 'target' (go back to source). No dead middle zone.
  function pointAtFraction(arrow: Arrow, frac: number): { x: number; y: number } {
    const wps = arrow.waypoints;
    let total = 0;
    for (let i = 1; i < wps.length; i++) {
      total += Math.hypot(
        (wps[i]?.x ?? 0) - (wps[i - 1]?.x ?? 0),
        (wps[i]?.y ?? 0) - (wps[i - 1]?.y ?? 0),
      );
    }
    let target = total * frac;
    for (let i = 1; i < wps.length; i++) {
      const a = wps[i - 1];
      const b = wps[i];
      if (a === undefined || b === undefined) continue;
      const seg = Math.hypot(b.x - a.x, b.y - a.y);
      if (target <= seg || i === wps.length - 1) {
        const t = seg === 0 ? 0 : target / seg;
        return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      }
      target -= seg;
    }
    const last = wps[wps.length - 1];
    return { x: last?.x ?? 0, y: last?.y ?? 0 };
  }

  it('classifies a 25%-length click as source and a 75%-length click as target', () => {
    const layout = smallLayout();
    const arrow = appEngineArrow(layout);

    const earlyHits = pickArrowsAtPoint(pointAtFraction(arrow, 0.25), [arrow], {
      hitTolerance: 1,
    });
    const lateHits = pickArrowsAtPoint(pointAtFraction(arrow, 0.75), [arrow], {
      hitTolerance: 1,
    });

    // Both register a hit (on the polyline) and land in opposite zones.
    expect(earlyHits.length).toBe(1);
    expect(lateHits.length).toBe(1);
    expect(earlyHits[0]?.zone).toBe('source');
    expect(lateHits[0]?.zone).toBe('target');
  });
});

describe('SF-T2-11 — lookupMemberRowPoint: null for collapsed type, point for expanded', () => {
  it('returns null when the owning type is collapsed, a finite row point when expanded', () => {
    // Engine collapsed: its `cyl` row is not in view, so nav must skip the
    // pan rather than aim at an invisible row.
    const collapsed = smallLayout(['c', 'c::core', 'c::App']);
    expect(lookupMemberRowPoint(collapsed, 'c::core::Engine', 'cyl', 'field')).toBeNull();

    // Engine expanded: the `cyl` field row resolves to a finite point.
    const expanded = smallLayout([...SMALL_EXPANDED]);
    const pt = lookupMemberRowPoint(expanded, 'c::core::Engine', 'cyl', 'field');
    expect(pt).not.toBeNull();
    expect(Number.isFinite(pt?.x ?? Number.NaN)).toBe(true);
    expect(Number.isFinite(pt?.y ?? Number.NaN)).toBe(true);
  });
});

describe('SF-T2-09 — disambig grouping holds at SCALE with many overlapping arrows', () => {
  // The redundant-rows bug only surfaces when several arrows share an
  // endpoint. `denseHighFanout` builds one owner per module fanning out to
  // many single-type modules. We synthesize the hit stack from real layout
  // arrows that share a SOURCE (fan-out) or a TARGET (funnel) and assert the
  // grouping compresses the shared side into ONE group.
  const layout = buildLayout({ ...denseHighFanout(8), measureText: measure });

  it('one source fanning to >=6 targets groups into a single by-source group', () => {
    // Pick the owner type that emits the most outgoing arrows.
    const bySource = new Map<string, Arrow[]>();
    for (const a of layout.arrows) {
      const key = `${a.fromTypeId}\x1F${a.fromFieldName}`;
      const list = bySource.get(key) ?? [];
      list.push(a);
      bySource.set(key, list);
    }
    // The fanout preset routes all of one owner's fields from distinct
    // field rows, so group by the shared SOURCE TYPE instead: collect arrows
    // that share fromTypeId.
    const byOwner = new Map<string, Arrow[]>();
    for (const a of layout.arrows) {
      const list = byOwner.get(a.fromTypeId) ?? [];
      list.push(a);
      byOwner.set(a.fromTypeId, list);
    }
    let widest: Arrow[] = [];
    for (const list of byOwner.values()) if (list.length > widest.length) widest = list;
    expect(widest.length).toBeGreaterThanOrEqual(6);

    // Build hits whose SOURCE is shared (same fromTypeId+field+kind) so the
    // grouping decision is unambiguous: force a single source identity.
    const sharedSourceHits = widest.map((a) => ({
      arrow: {
        ...a,
        fromFieldName: 'f',
        fromRowKind: 'field' as const,
      } as Arrow,
      zone: 'source' as const,
      distance: 1,
    }));
    const groups = groupArrowHits(sharedSourceHits);
    expect(groups.length).toBe(1);
    expect(groups[0]?.kind).toBe('by-source');
    expect(groups[0]?.others.length).toBe(widest.length);
  });

  it('many sources merging to one target groups into a single by-target group', () => {
    // Find the target type with the most incoming arrows.
    const byTarget = new Map<string, Arrow[]>();
    for (const a of layout.arrows) {
      const list = byTarget.get(a.toTypeId) ?? [];
      list.push(a);
      byTarget.set(a.toTypeId, list);
    }
    let widest: Arrow[] = [];
    for (const list of byTarget.values()) if (list.length > widest.length) widest = list;
    expect(widest.length).toBeGreaterThanOrEqual(2);

    // Force a single shared TARGET identity and distinct sources so the
    // distinct-target count (1) < distinct-source count ⇒ group by target.
    const sharedTargetHits = widest.map((a, i) => ({
      arrow: {
        ...a,
        fromTypeId: `${a.fromTypeId}#${i}`,
        toFieldName: undefined,
        toRowKind: undefined,
      } as unknown as Arrow,
      zone: 'target' as const,
      distance: 1,
    }));
    const groups = groupArrowHits(sharedTargetHits);
    expect(groups.length).toBe(1);
    expect(groups[0]?.kind).toBe('by-target');
    expect(groups[0]?.others.length).toBe(widest.length);
  });
});
