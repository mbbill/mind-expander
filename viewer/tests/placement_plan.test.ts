import { describe, expect, it } from 'vitest';
import { buildPlacementLayoutPlan } from '../src/layout/placement_plan.ts';
import { buildInputs, crateFacts, edge, mod, ty } from './fixtures/builders.ts';

describe('layout placement plan', () => {
  it('keeps rank depth and same-rank order independent from expansion state', () => {
    const c = crateFacts('c', [
      mod('m', [
        ty('c', 'm', 'ZuluOwner', [{ name: 'child', ty_text: 'Child' }]),
        ty('c', 'm', 'AlphaPlain'),
        ty('c', 'm', 'Child'),
      ]),
    ]);
    const edges = [edge('c::m::ZuluOwner', 'c::m::Child', 'field child')];
    const collapsed = buildInputs(c, edges, ['c']);
    const expanded = buildInputs(c, edges, ['c', 'c::m', 'c::m::ZuluOwner']);

    const collapsedPlan = buildPlacementLayoutPlan(
      collapsed.staticRoot,
      collapsed.depth,
      collapsed.ownership,
    );
    const expandedPlan = buildPlacementLayoutPlan(
      expanded.staticRoot,
      expanded.depth,
      expanded.ownership,
    );

    expect(expandedPlan.ranks.get('c::m::AlphaPlain')).toEqual(
      collapsedPlan.ranks.get('c::m::AlphaPlain'),
    );
    expect(expandedPlan.ranks.get('c::m::ZuluOwner')).toEqual(
      collapsedPlan.ranks.get('c::m::ZuluOwner'),
    );
    expect(expandedPlan.ranks.get('c::m::Child')).toEqual(collapsedPlan.ranks.get('c::m::Child'));
    expect(collapsedPlan.ranks.get('c::m::AlphaPlain')?.subrank).toBeLessThan(
      collapsedPlan.ranks.get('c::m::ZuluOwner')?.subrank ?? Number.POSITIVE_INFINITY,
    );
    expect(collapsedPlan.placementsById.get('c::m::Child')?.forwardPredecessors).toEqual([
      'c::m::ZuluOwner',
    ]);
  });

  it('places function groups in the prelude instead of normal rank depth', () => {
    const c = crateFacts('c', [
      {
        ...mod('m', [ty('c', 'm', 'RealType')]),
        functions: [
          { name: 'helper', visibility: 'pub', params: [], return_ty_text: '()' },
          { name: 'local', visibility: 'priv', params: [], return_ty_text: '()' },
        ],
      },
    ]);
    const inputs = buildInputs(c, [], ['c', 'c::m']);
    const plan = buildPlacementLayoutPlan(inputs.staticRoot, inputs.depth, inputs.ownership);
    const pubFn = plan.placementsById.get('c::m::__fn_pub');
    const real = plan.placementsById.get('c::m::RealType');

    expect(pubFn?.depth).toEqual({ kind: 'prelude' });
    expect(pubFn?.rankOrder).toBe(0);
    expect(real?.depth).toEqual({ kind: 'rank', depth: 0 });
    expect(real?.rankOrder).toBe(1);
  });

  it('classifies cyclic back edges as non-forward instead of hard frontiers', () => {
    const c = crateFacts('c', [mod('m', [ty('c', 'm', 'A'), ty('c', 'm', 'B')])]);
    const inputs = buildInputs(
      c,
      [edge('c::m::A', 'c::m::B', 'field b'), edge('c::m::B', 'c::m::A', 'field a')],
      ['c', 'c::m'],
    );
    const plan = buildPlacementLayoutPlan(inputs.staticRoot, inputs.depth, inputs.ownership);

    const a = plan.placementsById.get('c::m::A');
    const b = plan.placementsById.get('c::m::B');

    expect(a?.forwardPredecessors).toEqual([]);
    expect(a?.nonForwardPredecessors).toEqual(['c::m::B']);
    expect(b?.forwardPredecessors).toEqual(['c::m::A']);
    expect(b?.nonForwardPredecessors).toEqual([]);
  });
});
