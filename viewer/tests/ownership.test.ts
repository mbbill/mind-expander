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

describe('buildOwnershipIndex — methodTargets', () => {
  function methodEdge(
    from: string,
    to: string,
    via: 'fn_param' | 'fn_return',
    methodName: string,
    paramName?: string,
    kind: Edge['kind'] = 'owns',
  ): Edge {
    const origin =
      via === 'fn_return'
        ? `fn ${methodName} -> ret`
        : `fn ${methodName} param ${paramName ?? '?'}`;
    return { from, to, kind, via, origin };
  }

  it('indexes method targets by parsed method name from origin', () => {
    const idx = buildOwnershipIndex(
      facts([
        methodEdge('c::Foo', 'c::Bar', 'fn_param', 'do_thing', 'arg'),
        methodEdge('c::Foo', 'c::Baz', 'fn_return', 'do_thing'),
        methodEdge('c::Foo', 'c::Qux', 'fn_param', 'helper', 'x'),
      ]),
      'c',
    );
    // do_thing references both its param type AND its return type — both
    // surface under the same method-name key.
    expect(idx.methodTargets.get('c::Foo')?.get('do_thing')).toEqual(['c::Bar', 'c::Baz']);
    expect(idx.methodTargets.get('c::Foo')?.get('helper')).toEqual(['c::Qux']);
  });

  it('includes borrow/indirection method-edges (not just owns)', () => {
    // Methods are inherently uses, not structural composition. A
    // `&Foo` parameter is still a "this method touches Foo" relation
    // worth showing as an arrow — unlike fields where borrow-from-
    // a-field is excluded by design.
    const idx = buildOwnershipIndex(
      facts([
        methodEdge('c::Foo', 'c::Bar', 'fn_param', 'a', 'x', 'borrows_immut'),
        methodEdge('c::Foo', 'c::Baz', 'fn_param', 'b', 'x', 'borrows_mut'),
        methodEdge('c::Foo', 'c::Qux', 'fn_param', 'c', 'x', 'indirection'),
      ]),
      'c',
    );
    expect(idx.methodTargets.get('c::Foo')?.get('a')).toEqual(['c::Bar']);
    expect(idx.methodTargets.get('c::Foo')?.get('b')).toEqual(['c::Baz']);
    expect(idx.methodTargets.get('c::Foo')?.get('c')).toEqual(['c::Qux']);
  });

  it('skips trait_impl edges (they have via=trait_impl_block, not fn_*)', () => {
    const idx = buildOwnershipIndex(
      facts([
        {
          from: 'c::Foo',
          to: 'c::SomeTrait',
          kind: 'trait_impl',
          via: 'trait_impl_block',
          origin: 'impl',
        },
      ]),
      'c',
    );
    expect(idx.methodTargets.get('c::Foo')).toBeUndefined();
  });

  it('drops cross-crate method edges (mirrors field-edge behaviour)', () => {
    const idx = buildOwnershipIndex(
      facts([
        methodEdge('c::Foo', 'd::External', 'fn_param', 'm', 'x'),
        methodEdge('e::Other', 'c::Foo', 'fn_param', 'n', 'x'),
        methodEdge('c::Foo', 'c::Bar', 'fn_param', 'm', 'x'),
      ]),
      'c',
    );
    // Only the intra-crate edge survives.
    expect(idx.methodTargets.get('c::Foo')?.get('m')).toEqual(['c::Bar']);
  });

  it('dedupes parallel method-targets (param + return both pointing at the same type)', () => {
    const idx = buildOwnershipIndex(
      facts([
        methodEdge('c::Foo', 'c::Bar', 'fn_param', 'roundtrip', 'arg'),
        methodEdge('c::Foo', 'c::Bar', 'fn_return', 'roundtrip'),
      ]),
      'c',
    );
    expect(idx.methodTargets.get('c::Foo')?.get('roundtrip')).toEqual(['c::Bar']);
  });

  it('handles a method with no spaces in its origin (single-word method name)', () => {
    // Defensive: parseMethodName splits on the first space after `fn `.
    // Origins are always well-formed by the extractor, but this pins the
    // edge case so a stray `fn name` (no following grammar) doesn't
    // produce undefined.
    const idx = buildOwnershipIndex(
      facts([{ from: 'c::Foo', to: 'c::Bar', kind: 'owns', via: 'fn_param', origin: 'fn lonely' }]),
      'c',
    );
    expect(idx.methodTargets.get('c::Foo')?.get('lonely')).toEqual(['c::Bar']);
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
