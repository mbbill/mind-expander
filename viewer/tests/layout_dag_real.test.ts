import { describe, expect, it } from 'vitest';
import { type Geometry, computeGeometry } from '../src/layout/geometry.ts';
import { buildInputs, crateFacts, edge, mod, ty } from './fixtures/builders.ts';

// Ownership-DAG placement regressions originally found in sf-nano-core
// (StorageType/ValueType cross-module ownership; GlobalInst/GlobalCell
// single-owner-near-owner). The fixtures are reconstructed from builders
// to be structurally equivalent — the bugs were about the placement RULE,
// not the specific crate.
//
// The cross-module "owned type to the right of its visible owner" case is
// covered by LP-14 in tests/areas/layout-placement.layout.test.ts
// (target.x >= owner.x + owner.width); not duplicated here.

const measure = (s: string): number => s.length * 7;

describe('layout ownership-DAG placement — regression suite', () => {
  // A single-owner target's horizontal floor comes from its OWN forward
  // predecessor (its owner), not from a band-wide rank-0 frontier
  // (docs/layout.md "Stable Logical Plan": "should not be pushed after
  // unrelated types that merely have smaller ranks"). So the target sits
  // next to its owner regardless of how many UNRELATED rank-0 types share
  // the band. The strong, non-vacuous oracle is independence: the target's
  // offset from its owner is identical no matter how many unrelated rank-0
  // types exist. A global-rank-frontier regression would push the target
  // further right as the unrelated count grows, breaking the equality.
  function nearOwner(unrelatedCount: number): Geometry {
    const types = [
      ty('c', 'm', 'Owner', [{ name: 't', ty_text: 'Target' }]),
      ty('c', 'm', 'Target'),
      ...Array.from({ length: unrelatedCount }, (_, i) => ty('c', 'm', `U${i}`)),
    ];
    const c = crateFacts('c', [mod('m', types)]);
    const edges = [edge('c::m::Owner', 'c::m::Target', 'field t')];
    return computeGeometry({ ...buildInputs(c, edges, ['c', 'c::m']), measureText: measure });
  }

  // Acceptance test for the predecessor-relative placement fix
  // (grid_placement.ts): a single-owner target is floored by its OWNER, not by
  // the whole rank-0 block, and packs down at the owner's column rather than
  // sliding right past unrelated same-depth types. Before the fix this landed
  // at col 105 with 24 unrelated types (offset 840); now it stays next to its
  // owner (offset constant) for any unrelated count. (sf-nano
  // GlobalInst/GlobalCell regression.)
  it('keeps a single-owner target next to its owner, independent of unrelated rank-0 types', () => {
    const few = nearOwner(1);
    const many = nearOwner(24);

    const get = (g: Geometry, id: string) => {
      const t = g.typesById.get(id);
      if (t === undefined) throw new Error(`missing ${id}`);
      return t;
    };
    const ownerFew = get(few, 'c::m::Owner');
    const targetFew = get(few, 'c::m::Target');
    const ownerMany = get(many, 'c::m::Owner');
    const targetMany = get(many, 'c::m::Target');

    // Rule 1: the owned target is to the right of its owner in both builds.
    expect(targetFew.x).toBeGreaterThan(ownerFew.x);
    expect(targetMany.x).toBeGreaterThan(ownerMany.x);

    // Predecessor frontier (the load-bearing oracle): the target's offset
    // from its owner does not change when 23 more unrelated rank-0 types are
    // added to the band. If placement used a band-wide rank-0 frontier, the
    // crowded build would shove Target right and this equality would fail.
    expect(targetMany.x - ownerMany.x).toBe(targetFew.x - ownerFew.x);
  });
});
