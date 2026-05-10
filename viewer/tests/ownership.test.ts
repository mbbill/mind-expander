import { describe, expect, it } from 'vitest';
import { buildOwnershipIndex, computeOwnershipDepth } from '../src/analysis/ownership.ts';
import type { Edge, Facts } from '../src/data/schema.ts';

function edge(
  from: string,
  to: string,
  via: Edge['via'] = 'struct_field',
  origin = 'field x',
): Edge {
  return { from, to, kind: 'owns', via, origin };
}

function facts(edges: Edge[]): Facts {
  return { crates: {}, edges };
}

describe('buildOwnershipIndex', () => {
  it('keeps only kind=owns with structural via', () => {
    const f = facts([
      edge('c::A', 'c::B', 'struct_field'),
      edge('c::A', 'c::C', 'fn_param'),
      edge('c::A', 'c::D', 'enum_variant_payload'),
      edge('c::A', 'c::E', 'fn_return'),
      { from: 'c::A', to: 'c::F', kind: 'borrows_immut', via: 'struct_field', origin: 'field f' },
    ]);
    const idx = buildOwnershipIndex(f, 'c');
    expect(idx.owns.get('c::A')).toEqual(['c::B', 'c::D']);
  });

  it('drops cross-crate edges', () => {
    const f = facts([
      edge('c::A', 'd::X', 'struct_field'),
      edge('e::Y', 'c::B', 'struct_field'),
      edge('c::A', 'c::B', 'struct_field'),
    ]);
    const idx = buildOwnershipIndex(f, 'c');
    expect(idx.owns.get('c::A')).toEqual(['c::B']);
    expect(idx.ownedBy.get('c::B')).toEqual(['c::A']);
  });

  it('drops self-loops', () => {
    const f = facts([edge('c::A', 'c::A', 'struct_field')]);
    const idx = buildOwnershipIndex(f, 'c');
    expect(idx.owns.has('c::A')).toBe(false);
  });

  it('dedupes parallel edges', () => {
    const f = facts([
      edge('c::A', 'c::B', 'struct_field'),
      edge('c::A', 'c::B', 'enum_variant_payload'),
    ]);
    const idx = buildOwnershipIndex(f, 'c');
    expect(idx.owns.get('c::A')).toEqual(['c::B']);
  });
});

describe('buildOwnershipIndex — function signature edges', () => {
  it('does not treat fn_param/fn_return edges as member arrows', () => {
    const idx = buildOwnershipIndex(
      facts([
        { from: 'c::Foo', to: 'c::Bar', kind: 'owns', via: 'fn_param', origin: 'fn m param x' },
        { from: 'c::Foo', to: 'c::Baz', kind: 'owns', via: 'fn_return', origin: 'fn m -> ret' },
      ]),
      'c',
    );
    expect(idx.methodTargets.size).toBe(0);
    expect(idx.owns.get('c::Foo')).toBeUndefined();
  });
});

describe('computeOwnershipDepth', () => {
  it('roots get depth 0, owned types get longest-path depth', () => {
    const idx = buildOwnershipIndex(
      facts([edge('c::A', 'c::B'), edge('c::B', 'c::C'), edge('c::A', 'c::C')]),
      'c',
    );
    const d = computeOwnershipDepth(idx, ['c::A', 'c::B', 'c::C']);
    expect(d.get('c::A')).toBe(0);
    expect(d.get('c::B')).toBe(1);
    expect(d.get('c::C')).toBe(2); // longest path A→B→C, not A→C directly
  });

  it('isolated types get depth 0', () => {
    const idx = buildOwnershipIndex(facts([]), 'c');
    const d = computeOwnershipDepth(idx, ['c::Foo', 'c::Bar']);
    expect(d.get('c::Foo')).toBe(0);
    expect(d.get('c::Bar')).toBe(0);
  });

  it('fieldTargets indexes by parsed field name from origin', () => {
    const idx = buildOwnershipIndex(
      facts([
        edge('c::A', 'c::B', 'struct_field', 'field cmd'),
        edge('c::A', 'c::C', 'struct_field', 'field other'),
        edge('c::E', 'c::F', 'enum_variant_payload', 'field Some::value'),
        edge('c::E', 'c::G', 'enum_variant_payload', 'field Other'),
      ]),
      'c',
    );
    expect(idx.fieldTargets.get('c::A')?.get('cmd')).toEqual(['c::B']);
    expect(idx.fieldTargets.get('c::A')?.get('other')).toEqual(['c::C']);
    // Enum variant payloads keep the full `Variant::payload` form so that
    // tuple variants with multiple positions (Variant::0, Variant::1, …)
    // get distinct keys and the renderer can find each row's targets by
    // matching `TypeFacts.fields[i].name`.
    expect(idx.fieldTargets.get('c::E')?.get('Some::value')).toEqual(['c::F']);
    expect(idx.fieldTargets.get('c::E')?.get('Other')).toEqual(['c::G']);
  });

  it('cycle members get distinct depths via DFS back-edge breaking', () => {
    // A → B and B → A form a cycle. DFS starting from C → A → B finds the
    // edge B → A as a back-edge (A is still on the DFS stack). Excluding
    // it from depth computation lets C bump A to 1 and A bump B to 2.
    const idx = buildOwnershipIndex(
      facts([edge('c::A', 'c::B'), edge('c::B', 'c::A'), edge('c::C', 'c::A')]),
      'c',
    );
    const d = computeOwnershipDepth(idx, ['c::A', 'c::B', 'c::C']);
    expect(d.get('c::C')).toBe(0);
    expect(d.get('c::A')).toBe(1);
    expect(d.get('c::B')).toBe(2);
  });
});
