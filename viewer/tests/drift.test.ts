import { describe, expect, it } from 'vitest';
import { computeDrift, isCanonicalTarget } from '../src/analysis/drift.ts';
import { buildOwnershipIndex } from '../src/analysis/ownership.ts';
import type { Edge, Facts } from '../src/data/schema.ts';

function edge(from: string, to: string, origin = 'field x'): Edge {
  return { from, to, kind: 'owns', via: 'struct_field', origin };
}

function facts(edges: Edge[]): Facts {
  return { crates: {}, edges };
}

function tm(entries: [string, string][]): Map<string, string> {
  return new Map(entries);
}

describe('computeDrift', () => {
  it('type at LCA gets at_lca', () => {
    // Owners in `c::a` and `c::b` → LCA = `c`. Target lives in `c`. → at_lca.
    const idx = buildOwnershipIndex(facts([edge('c::a::A', 'c::T'), edge('c::b::B', 'c::T')]));
    const drift = computeDrift(
      idx,
      tm([
        ['c::a::A', 'a'],
        ['c::b::B', 'b'],
        ['c::T', ''],
      ]),
    );
    expect(drift.typeClass.get('c::T')).toBe('at_lca');
  });

  it('type within budget (depth-diff = 1, default maxBelowLca=1)', () => {
    const idx = buildOwnershipIndex(
      facts([edge('c::a::A', 'c::a::sub::T'), edge('c::a::B', 'c::a::sub::T')]),
      );
    const drift = computeDrift(
      idx,
      tm([
        ['c::a::A', 'a'],
        ['c::a::B', 'a'],
        ['c::a::sub::T', 'a::sub'],
      ]),
    );
    expect(drift.typeClass.get('c::a::sub::T')).toBe('within_budget');
  });

  it('type drifted below budget (depth-diff > maxBelowLca)', () => {
    const idx = buildOwnershipIndex(facts([edge('c::a::A', 'c::a::sub::deeper::T')]));
    const drift = computeDrift(
      idx,
      tm([
        ['c::a::A', 'a'],
        ['c::a::sub::deeper::T', 'a::sub::deeper'],
      ]),
    );
    expect(drift.typeClass.get('c::a::sub::deeper::T')).toBe('drift_below');
  });

  it('type drifted above (LCA descends from typeMod)', () => {
    // Owners in c::a::sub. LCA = c::a::sub. Target lives at c (above LCA).
    const idx = buildOwnershipIndex(
      facts([edge('c::a::sub::A', 'c::T'), edge('c::a::sub::B', 'c::T')]),
      );
    const drift = computeDrift(
      idx,
      tm([
        ['c::a::sub::A', 'a::sub'],
        ['c::a::sub::B', 'a::sub'],
        ['c::T', ''],
      ]),
    );
    expect(drift.typeClass.get('c::T')).toBe('drift_above');
  });

  it('type drifted sideways (target in unrelated subtree)', () => {
    // Owner in c::a, target in c::b. LCA = c. Target's modulePath = 'b'.
    // 'b' is not at LCA (''), not a descendant of '', actually 'b' IS a
    // descendant of '' (LCA = empty crate root). So target_b is within
    // depth_diff=1 of LCA... → within_budget. Hmm let me pick a setup where
    // the target is unambiguously sideways.
    //
    // Force sideways: owners in c::x::a, target in c::y::T. LCA = c. Target
    // mod = c::y, depth-diff from LCA = 1 → within_budget by default policy.
    // To force drift_sideways, we need lca && typeMod with neither
    // ancestor-of nor descendant-of — but isDescendantOf('y','') is true
    // (everything descends from root). So sideways requires a non-empty LCA.
    //
    // Setup: owners in c::x::a and c::x::b → LCA = c::x. Target in c::y::T.
    // 'y' is not a descendant of 'x' nor an ancestor. → sideways.
    const idx = buildOwnershipIndex(
      facts([edge('c::x::a::A', 'c::y::T'), edge('c::x::b::B', 'c::y::T')]),
      );
    const drift = computeDrift(
      idx,
      tm([
        ['c::x::a::A', 'x::a'],
        ['c::x::b::B', 'x::b'],
        ['c::y::T', 'y'],
      ]),
    );
    expect(drift.typeClass.get('c::y::T')).toBe('drift_sideways');
  });

  it('type with no owners defaults to at_lca', () => {
    const idx = buildOwnershipIndex(facts([]));
    const drift = computeDrift(idx, tm([['c::Loner', '']]));
    expect(drift.typeClass.get('c::Loner')).toBe('at_lca');
  });

  it('isCanonicalTarget agrees with the four-way classification', () => {
    const idx = buildOwnershipIndex(
      facts([
        edge('c::a::A', 'c::a::sub::T'), // within_budget
        edge('c::a::B', 'c::a::sub::deeper::U'), // drift_below
      ]),
      );
    const drift = computeDrift(
      idx,
      tm([
        ['c::a::A', 'a'],
        ['c::a::B', 'a'],
        ['c::a::sub::T', 'a::sub'],
        ['c::a::sub::deeper::U', 'a::sub::deeper'],
      ]),
    );
    expect(isCanonicalTarget('c::a::sub::T', drift)).toBe(true);
    expect(isCanonicalTarget('c::a::sub::deeper::U', drift)).toBe(false);
  });
});
