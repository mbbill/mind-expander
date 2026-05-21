// Boundary-time normalization of the raw extractor JSON. Pure, deterministic;
// callers should treat the returned Facts as the single canonical view.
//
// The extractor walks the AST cfg-blind, so types defined under mutually
// exclusive `#[cfg(...)]` flavors (e.g. tracked-alloc's `Box`/`Vec`/
// `RegistrySnapshot` etc.) emit twice with the same `full_path`. We
// dedupe per module by `full_path` with these rules:
//   1. The richest variant (most fields + methods, type_alias penalized)
//      wins as the structural representative — picks the cfg branch that
//      actually carries the struct body rather than the empty placeholder.
//   2. FIELDS are unioned across all variants, deduped by name. cfg-gated
//      twins may carry their own fields under different cfg flavors; the
//      union ensures the merged TypeFacts exposes every field's source
//      span to the byFile reverse index.
//   3. METHODS are unioned across all variants, deduped by (name +
//      impl_trait). Methods sometimes attach to the alias variant
//      instead of the struct depending on cfg.
//   4. SIDE is picked across variants: Modified > Both > Head > Base.
//      Modified must win because it carries the only `prev_span` data;
//      collapsing it would drop the base location and break the union
//      focus frame.
//
// Rust's unified_facts now emits ONE record per conceptual entity
// (including `Side::Modified` for body-changed entities present in
// both snapshots). The dedup keys here are name-only (or
// name + impl_trait for methods) — there is no need to keep multiple
// sided halves of the same entity distinct, since Rust no longer
// produces them. When cfg-aware extraction lands, this whole module
// can be removed.

import type {
  CrateFacts,
  Facts,
  FieldFacts,
  FnFacts,
  ModuleFacts,
  ReExport,
  Side,
  TypeFacts,
} from './schema.ts';

export function canonicalize(facts: Facts): Facts {
  const crates: Record<string, CrateFacts> = {};
  for (const [name, crate] of Object.entries(facts.crates)) {
    const modules: Record<string, ModuleFacts> = {};
    for (const [path, mod] of Object.entries(crate.modules)) {
      modules[path] = {
        ...mod,
        types: dedupeByFullPath(mod.types),
        functions: dedupeFunctions(mod.functions),
        ...(mod.re_exports !== undefined
          ? { re_exports: dedupeReExports(mod.re_exports) }
          : {}),
      };
    }
    crates[name] = { ...crate, modules };
  }
  return {
    crates,
    edges: facts.edges,
    ...(facts.call_edges !== undefined ? { call_edges: facts.call_edges } : {}),
  };
}

function dedupeByFullPath(types: readonly TypeFacts[]): readonly TypeFacts[] {
  const byPath = new Map<string, TypeFacts[]>();
  const order: string[] = [];
  for (const t of types) {
    let bucket = byPath.get(t.full_path);
    if (bucket === undefined) {
      bucket = [];
      byPath.set(t.full_path, bucket);
      order.push(t.full_path);
    }
    bucket.push(t);
  }
  const out: TypeFacts[] = [];
  for (const path of order) {
    const variants = byPath.get(path) ?? [];
    if (variants.length === 1) {
      out.push(variants[0] as TypeFacts);
      continue;
    }
    const primary = pickRepresentative(variants);
    const side = pickSide(variants);
    // When the merged side is `modified`, lift the prev_span from
    // whichever variant carries it (might not be the structural
    // representative). Otherwise drop any stale prev_span the
    // representative happened to carry.
    const modVariant = variants.find((v) => v.side === 'modified');
    // Strip primary's prev_span first, then re-add it only when the
    // merged side is `modified` and a variant carries it. Avoids
    // dragging a stale prev_span from a non-modified primary.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { prev_span: _drop, ...primaryWithoutPrev } = primary;
    const mergedPrev =
      side === 'modified' ? modVariant?.prev_span : undefined;
    out.push({
      ...primaryWithoutPrev,
      side,
      ...(mergedPrev !== undefined ? { prev_span: mergedPrev } : {}),
      fields: unionFields(variants),
      methods: unionMethods(variants),
    });
  }
  return out;
}

function pickRepresentative(variants: readonly TypeFacts[]): TypeFacts {
  // Pick the richest variant — most fields + methods, with `type_alias`
  // heavily penalized. The alias variant's `fields` is typically a
  // synthetic single placeholder, useless for layout. Ties resolved by
  // insertion order.
  const rank = (t: TypeFacts): number =>
    (t.kind === 'type_alias' ? -100 : 0) +
    (t.fields?.length ?? 0) +
    (t.methods?.length ?? 0);
  let best = variants[0] as TypeFacts;
  let bestRank = rank(best);
  for (let i = 1; i < variants.length; i++) {
    const v = variants[i] as TypeFacts;
    const r = rank(v);
    if (r > bestRank) {
      best = v;
      bestRank = r;
    }
  }
  return best;
}

function pickSide(variants: readonly TypeFacts[]): Side {
  // Modified > Both > Head > Base. Modified must win because it
  // carries the only prev_span data; collapsing it into Both would
  // drop the base location and break the union focus frame.
  let hasModified = false;
  let hasBoth = false;
  let hasHead = false;
  let hasBase = false;
  for (const v of variants) {
    const s = v.side ?? 'head';
    if (s === 'modified') hasModified = true;
    else if (s === 'both') hasBoth = true;
    else if (s === 'head') hasHead = true;
    else if (s === 'base') hasBase = true;
  }
  if (hasModified) return 'modified';
  if (hasBoth) return 'both';
  if (hasHead) return 'head';
  if (hasBase) return 'base';
  return 'head';
}

function unionFields(variants: readonly TypeFacts[]): readonly FieldFacts[] {
  // Dedup key is name-only. Rust's merge emits at most one record per
  // conceptual field (Both / Head / Base / Modified). Cfg-blind
  // duplicates collapse cleanly; the Modified variant wins over any
  // other when both exist (it carries the prev_span).
  const seen = new Map<string, FieldFacts>();
  const order: string[] = [];
  for (const v of variants) {
    for (const f of v.fields ?? []) {
      const existing = seen.get(f.name);
      if (existing === undefined) {
        seen.set(f.name, f);
        order.push(f.name);
        continue;
      }
      if (f.side === 'modified' && existing.side !== 'modified') {
        seen.set(f.name, f);
      }
    }
  }
  return order.map((n) => seen.get(n) as FieldFacts);
}

// Module-level free functions go through `merge_module`'s free-fn
// merge in Rust, which emits at most one record per conceptual
// function. The cfg-blind extractor still produces duplicates
// (one per cfg branch), so we collapse them here.
function dedupeFunctions(fns: readonly FnFacts[]): readonly FnFacts[] {
  const seen = new Map<string, FnFacts>();
  const order: string[] = [];
  for (const f of fns) {
    const key = `${f.name}${f.impl_trait ?? ''}`;
    const existing = seen.get(key);
    if (existing === undefined) {
      seen.set(key, f);
      order.push(key);
      continue;
    }
    if (f.side === 'modified' && existing.side !== 'modified') {
      seen.set(key, f);
    }
  }
  return order.map((k) => seen.get(k) as FnFacts);
}

function unionMethods(variants: readonly TypeFacts[]): readonly FnFacts[] {
  // Methods can legitimately share a name across impl blocks
  // (two `from` methods from different `impl From<X> for T`)
  // disambiguated by `impl_trait`. Cfg-blind dups (same name +
  // impl_trait) collapse here; Modified wins over the same key.
  const seen = new Map<string, FnFacts>();
  const order: string[] = [];
  for (const v of variants) {
    for (const m of v.methods ?? []) {
      const key = `${m.name}${m.impl_trait ?? ''}`;
      const existing = seen.get(key);
      if (existing === undefined) {
        seen.set(key, m);
        order.push(key);
        continue;
      }
      if (m.side === 'modified' && existing.side !== 'modified') {
        seen.set(key, m);
      }
    }
  }
  return order.map((k) => seen.get(k) as FnFacts);
}

// Dedupe re-exports by `exposed_name` within a module. The extractor walks
// cfg branches blindly, so a `pub use ... as Foo;` gated under both
// `#[cfg(memprof)]` and `#[cfg(not(memprof))]` lands twice in the same
// module. Downstream, each re-export becomes a ghost row with id
// `${modulePath}::__re_${exposed_name}`; duplicates crash the band
// layout's unique-id assertion. Rust forbids two live `pub use` items
// exposing the same name in one module, so cfg-gated dups are by
// construction the same public surface — keeping the first is safe.
function dedupeReExports(reExports: readonly ReExport[]): readonly ReExport[] {
  const seen = new Set<string>();
  const out: ReExport[] = [];
  for (const re of reExports) {
    if (seen.has(re.exposed_name)) continue;
    seen.add(re.exposed_name);
    out.push(re);
  }
  return out;
}
