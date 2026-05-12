import { describe, expect, it } from 'vitest';
import { canonicalize } from '../src/data/canonicalize.ts';
import type {
  CrateFacts,
  Facts,
  ModuleFacts,
  ReExport,
  TypeFacts,
  TypeKind,
} from '../src/data/schema.ts';

function ty(
  crate: string,
  modPath: string,
  name: string,
  kind: TypeKind,
  methodNames: readonly string[] = [],
): TypeFacts {
  const full = modPath === '' ? `${crate}::${name}` : `${crate}::${modPath}::${name}`;
  return {
    name,
    full_path: full,
    kind,
    visibility: 'pub',
    fields: [],
    methods: methodNames.map((n) => ({ name: n, visibility: 'pub' })),
  };
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

  it('keeps the first non-alias variant as the structural representative', () => {
    // Two struct variants of the same path → first wins as representative
    // (no alias variant to deprioritise). Identity of the result is not
    // pinned because method-union builds a new object even when no methods
    // were merged.
    const first = ty('c', '', 'S', 'struct');
    const second: TypeFacts = { ...first };
    const out = canonicalize(facts('c', [mod('', [first, second])]));
    const got = typesAt(out, 'c', '');
    expect(got).toHaveLength(1);
    expect(got[0]?.kind).toBe('struct');
    expect(got[0]?.full_path).toBe(first.full_path);
  });

  it('unions methods across cfg-deduplicated variants of the same type', () => {
    // Real-world: tracked-alloc's `Vec` lands as TWO TypeFacts at the same
    // full_path — a `type_alias` (which the extractor's impl walker happens
    // to load the methods onto) and a `struct` (which carries the real
    // field shape but no methods). Canonicalize must keep the struct's
    // shape AND retain the methods, or call edges into `Vec::resize` etc.
    // get flagged "no matched graph row" downstream.
    const alias = ty('c', '', 'Vec', 'type_alias', ['new', 'resize', 'push']);
    const struct = ty('c', '', 'Vec', 'struct', []);
    const out = canonicalize(facts('c', [mod('', [alias, struct])]));
    const got = typesAt(out, 'c', '');
    expect(got).toHaveLength(1);
    expect(got[0]?.kind).toBe('struct');
    expect(got[0]?.methods?.map((m) => m.name)).toEqual(['new', 'resize', 'push']);
  });

  it('dedupes methods by name when both variants list the same one', () => {
    // Same-name methods in both variants resolve to one entry — the first
    // occurrence wins. Prevents the row index from carrying duplicate
    // (caller_path, method_name) pairs that would double-count calls.
    const alias = ty('c', '', 'T', 'type_alias', ['shared', 'alias_only']);
    const struct = ty('c', '', 'T', 'struct', ['shared', 'struct_only']);
    const out = canonicalize(facts('c', [mod('', [alias, struct])]));
    const got = typesAt(out, 'c', '');
    expect(got[0]?.methods?.map((m) => m.name)).toEqual([
      'shared',
      'alias_only',
      'struct_only',
    ]);
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

  it('dedupes re-exports that share an exposed_name in the same module', () => {
    // cfg-blind extraction emits `pub use ... as String;` twice (one per
    // cfg branch). The ghost-row id is `${module}::__re_${exposed_name}`,
    // so duplicates would crash the band layout's unique-id assertion.
    // The first occurrence wins — cfg-gated dups expose the same name by
    // construction.
    const re = (exposed_name: string, target_path: string): ReExport => ({
      exposed_name,
      target_path,
      visibility: 'pub',
      kind: 'type',
      target_kind: 'struct',
    });
    const input: Facts = facts('c', [
      {
        ...mod('string', []),
        re_exports: [
          re('String', 'c::String'),
          re('String', 'c::String'),
          re('ToString', 'c::string::ToString'),
        ],
      },
    ]);
    const out = canonicalize(input);
    const re_exports = out.crates['c']?.modules['string']?.re_exports ?? [];
    expect(re_exports.map((r) => r.exposed_name)).toEqual(['String', 'ToString']);
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
