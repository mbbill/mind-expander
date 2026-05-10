import { describe, expect, it } from 'vitest';
import { canonicalize } from '../src/data/canonicalize.ts';
import type { CrateFacts, Facts, ModuleFacts, TypeFacts, TypeKind } from '../src/data/schema.ts';

function ty(crate: string, modPath: string, name: string, kind: TypeKind): TypeFacts {
  const full = modPath === '' ? `${crate}::${name}` : `${crate}::${modPath}::${name}`;
  return { name, full_path: full, kind, visibility: 'pub', fields: [] };
}

function mod(path: string, types: TypeFacts[]): ModuleFacts {
  const file = path === '' ? 'src/lib.rs' : `src/${path.replace(/::/g, '/')}.rs`;
  return { path, types, file, functions: [] };
}

function facts(crate: string, modules: ModuleFacts[]): Facts {
  const c: CrateFacts = {
    name: crate,
    modules: Object.fromEntries(modules.map((m) => [m.path, m])),
  };
  return { crates: { [crate]: c }, edges: [] };
}

function typesAt(out: Facts, crate: string, modPath: string): readonly TypeFacts[] {
  return out.crates[crate]?.modules[modPath]?.types ?? [];
}

describe('canonicalize', () => {
  it('drops a type_alias when a same-path struct exists', () => {
    const out = canonicalize(
      facts('c', [mod('', [ty('c', '', 'Box', 'type_alias'), ty('c', '', 'Box', 'struct')])]),
    );
    const got = typesAt(out, 'c', '');
    expect(got).toHaveLength(1);
    expect(got[0]?.kind).toBe('struct');
  });

  it('keeps the type_alias if no struct counterpart exists', () => {
    const out = canonicalize(facts('c', [mod('', [ty('c', '', 'Alias', 'type_alias')])]));
    const got = typesAt(out, 'c', '');
    expect(got).toHaveLength(1);
    expect(got[0]?.kind).toBe('type_alias');
  });

  it('keeps last-seen when both duplicates have non-alias kinds', () => {
    const first = ty('c', '', 'S', 'struct');
    const second: TypeFacts = { ...first };
    const out = canonicalize(facts('c', [mod('', [first, second])]));
    const got = typesAt(out, 'c', '');
    expect(got).toHaveLength(1);
    // The fallback is "first wins among non-aliases" — both have kind 'struct',
    // so the first entry stays.
    expect(got[0]).toBe(first);
  });

  it('does not collapse types that share name but differ in full_path', () => {
    const out = canonicalize(
      facts('c', [
        mod('a', [ty('c', 'a', 'Foo', 'struct')]),
        mod('b', [ty('c', 'b', 'Foo', 'struct')]),
      ]),
    );
    expect(typesAt(out, 'c', 'a')).toHaveLength(1);
    expect(typesAt(out, 'c', 'b')).toHaveLength(1);
  });

  it('leaves crates without duplicates untouched in shape', () => {
    const input = facts('c', [
      mod('', []),
      mod('a', [ty('c', 'a', 'X', 'struct'), ty('c', 'a', 'Y', 'enum')]),
    ]);
    const out = canonicalize(input);
    expect(typesAt(out, 'c', 'a').map((t) => t.name)).toEqual(['X', 'Y']);
  });

  it('preserves call edges while normalizing type facts', () => {
    const input: Facts = {
      ...facts('c', [mod('', [ty('c', '', 'Owner', 'struct')])]),
      call_edges: [
        {
          caller: 'c::caller',
          callee: 'c::callee',
          kind: 'function',
          resolution: 'exact',
          origin: 'callee',
        },
      ],
    };
    const out = canonicalize(input);
    expect(out.call_edges).toBe(input.call_edges);
  });
});
