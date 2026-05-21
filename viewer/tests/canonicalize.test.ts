import { describe, expect, it } from 'vitest';
import { canonicalize } from '../src/data/canonicalize.ts';
import type {
  CrateFacts,
  Facts,
  FnFacts,
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

  it('unions fields across cfg-gated variants', () => {
    // Real-world repro: tracked-alloc's `AllocationProfile` has a
    // non-memprof `pub struct AllocationProfile;` (no fields) and a
    // memprof `pub struct AllocationProfile { now_ns, snapshot, ... }`
    // (six fields). Pre-fix, canonicalize picked the empty variant as
    // representative and dropped every field; the click-handler then
    // couldn't resolve `snapshot` because it wasn't in the byFile
    // reverse index. Union-fields fixes that.
    const fld = (name: string): TypeFacts['fields'][number] => ({
      name,
      ty_text: 'u64',
      ownership: 'primitive',
      referenced: [],
    });
    const empty: TypeFacts = { ...ty('c', '', 'AllocationProfile', 'struct'), fields: [] };
    const rich: TypeFacts = {
      ...ty('c', '', 'AllocationProfile', 'struct'),
      fields: [fld('now_ns'), fld('snapshot'), fld('timeline')],
    };
    const out = canonicalize(facts('c', [mod('', [empty, rich])]));
    const got = typesAt(out, 'c', '');
    expect(got).toHaveLength(1);
    // Richest variant wins as representative — three fields unioned in.
    expect(got[0]?.fields?.map((f) => f.name)).toEqual(['now_ns', 'snapshot', 'timeline']);
  });

  it('picks Both as the merged side when any variant is Both', () => {
    // Union-merge can emit cfg-gated dups where one variant is Both
    // (unchanged across base/head) and the other is Head (the other
    // cfg branch changed). The merged type is unchanged at the macro
    // level — it exists in at least one cfg branch as Both — so the
    // type-row gets no side-bar; per-member sides still drive row
    // colours.
    const a: TypeFacts = { ...ty('c', '', 'X', 'struct'), side: 'both' };
    const b: TypeFacts = { ...ty('c', '', 'X', 'struct'), side: 'head' };
    const out = canonicalize(facts('c', [mod('', [a, b])]));
    expect(typesAt(out, 'c', '')[0]?.side).toBe('both');
  });

  it('collapses cfg-gated dups to a single entry so band layout ids stay unique', () => {
    // Regression for the `Band layout item ids must be unique` crash:
    // before the fix, dedup keyed by (full_path, side) let both
    // variants through, and `assertUniqueItemIds` blew up on the
    // first redraw. The full_path-keyed dedup must collapse them to
    // exactly one TypeFacts.
    const a: TypeFacts = {
      ...ty('c', '', 'AggregateEntry', 'struct'),
      side: 'both',
      span: { file: '/lib.rs', start_line: 358, end_line: 368 },
    };
    const b: TypeFacts = {
      ...ty('c', '', 'AggregateEntry', 'struct'),
      side: 'head',
      span: { file: '/lib.rs', start_line: 573, end_line: 583 },
    };
    const out = canonicalize(facts('c', [mod('', [a, b])]));
    const got = typesAt(out, 'c', '');
    expect(got).toHaveLength(1);
    // Only one item id per full_path — what the band layout requires.
    expect(got[0]?.full_path).toBe('c::AggregateEntry');
  });

  it('preserves a method split-pair across canonicalize', () => {
    // Split-on-change emits two FnFacts with the same `name` but
    // different sides (Base + Head). The dedup key must include
    // side so the diagram can render the pair as two rows; before
    // the fix, unionMethods kept only the first occurrence by name,
    // silently dropping the Head half.
    const baseHalf: TypeFacts['methods'][number] = {
      name: 'materialize',
      visibility: 'pub',
      side: 'base',
    };
    const headHalf: TypeFacts['methods'][number] = {
      name: 'materialize',
      visibility: 'pub',
      side: 'head',
    };
    const variant: TypeFacts = {
      ...ty('c', '', 'Handle', 'struct'),
      methods: [baseHalf, headHalf],
    };
    const out = canonicalize(facts('c', [mod('', [variant])]));
    const got = typesAt(out, 'c', '');
    expect(got).toHaveLength(1);
    const mats = got[0]?.methods?.filter((m) => m.name === 'materialize') ?? [];
    expect(mats).toHaveLength(2);
    const sides = mats.map((m) => m.side).sort();
    expect(sides).toEqual(['base', 'head']);
  });

  it('preserves a field split-pair across canonicalize', () => {
    // Mirror of the method-split case for fields.
    const fld = (side: 'base' | 'head' | 'both'): TypeFacts['fields'][number] => ({
      name: 'shape',
      ty_text: 'u32',
      ownership: 'primitive',
      referenced: [],
      side,
    });
    const variant: TypeFacts = {
      ...ty('c', '', 'Snap', 'struct'),
      fields: [fld('base'), fld('head')],
    };
    const out = canonicalize(facts('c', [mod('', [variant])]));
    const shapes = (typesAt(out, 'c', '')[0]?.fields ?? []).filter(
      (f) => f.name === 'shape',
    );
    expect(shapes).toHaveLength(2);
    expect(shapes.map((f) => f.side).sort()).toEqual(['base', 'head']);
  });

  it('still collapses cfg-blind duplicate methods sharing a side', () => {
    // Two cfg-gated `struct Vec` variants with the same `push`
    // method (both tagged Head). The dedup must still squash these
    // to one — they are the same conceptual method, just emitted
    // twice by the cfg-blind walker.
    const cfgA: TypeFacts = {
      ...ty('c', '', 'Vec', 'struct'),
      methods: [{ name: 'push', visibility: 'pub', side: 'head' }],
    };
    const cfgB: TypeFacts = {
      ...ty('c', '', 'Vec', 'struct'),
      methods: [{ name: 'push', visibility: 'pub', side: 'head' }],
    };
    const out = canonicalize(facts('c', [mod('', [cfgA, cfgB])]));
    const got = typesAt(out, 'c', '');
    expect(got).toHaveLength(1);
    const pushes = got[0]?.methods?.filter((m) => m.name === 'push') ?? [];
    expect(pushes).toHaveLength(1);
  });

  it('dedupes module-level free functions sharing name and side', () => {
    // Repro for the `pub fn (20)` doubling regression: cfg-blind
    // extractor emits the same module-level function twice (one per
    // cfg branch), and `merge_module`'s free-fn merge collapses one
    // pair but orphan-promotes the other → two identical Both-tagged
    // FnFacts. Canonicalize must dedup to a single entry.
    const fn = (side: 'base' | 'head' | 'both'): FnFacts => ({
      name: 'snapshot',
      visibility: 'pub',
      side,
    });
    const m = {
      ...mod('', []),
      functions: [fn('both'), fn('both')],
    };
    const input = facts('c', [m]);
    const out = canonicalize(input);
    const fns = out.crates['c']?.modules['']?.functions ?? [];
    const snaps = fns.filter((f) => f.name === 'snapshot');
    expect(snaps).toHaveLength(1);
  });

  it('keeps a Modified function and lifts its prev_span via dedup', () => {
    // Rust now emits ONE record per modified entity (Side::Modified
    // with span=head, prev_span=base). Cfg-blind dups may produce a
    // Both variant alongside the Modified one; canonicalize must
    // keep the Modified record (it carries the prev_span; collapsing
    // to Both would lose the base location).
    const both: FnFacts = { name: 'rebuild', visibility: 'pub', side: 'both' };
    const modified: FnFacts = {
      name: 'rebuild',
      visibility: 'pub',
      side: 'modified',
      span: { file: '/h/m.rs', start_line: 10, end_line: 20 },
      prev_span: { file: '/b/m.rs', start_line: 8, end_line: 18 },
    };
    const m = { ...mod('', []), functions: [both, modified] };
    const out = canonicalize(facts('c', [m]));
    const fns = out.crates['c']?.modules['']?.functions ?? [];
    expect(fns).toHaveLength(1);
    expect(fns[0]?.side).toBe('modified');
    expect(fns[0]?.prev_span?.start_line).toBe(8);
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
