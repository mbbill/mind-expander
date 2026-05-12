// Boundary-time normalization of the raw extractor JSON. Pure, deterministic;
// callers should treat the returned Facts as the single canonical view.
//
// Currently fixes one issue: the extractor walks the AST cfg-blind, so types
// defined under mutually exclusive `#[cfg(...)]` flavors (e.g. tracked-alloc's
// `Box`/`Vec`/`RegistrySnapshot` etc.) emit twice with the same `full_path`.
// We dedupe per module by `full_path` with two rules:
//   1. The non-`type_alias` variant wins as the structural representative —
//      a `pub struct` carries real fields; the alias form usually has a
//      synthetic single `<alias>` field that's useless for layout.
//   2. METHODS are unioned across all variants (deduped by name). cfg-gated
//      twins of the same type are meant to expose the same public surface,
//      but the extractor's impl-block walker sometimes attaches the methods
//      to the alias variant instead of the struct. Without the union, those
//      methods disappear from the row index — call edges into them then
//      look unresolved even though the function exists in the workspace.
// Remove this when cfg-aware extraction lands.

import type { CrateFacts, Facts, FnFacts, ModuleFacts, ReExport, TypeFacts } from './schema.ts';

export function canonicalize(facts: Facts): Facts {
  const crates: Record<string, CrateFacts> = {};
  for (const [name, crate] of Object.entries(facts.crates)) {
    const modules: Record<string, ModuleFacts> = {};
    for (const [path, mod] of Object.entries(crate.modules)) {
      modules[path] = {
        ...mod,
        types: dedupeByFullPath(mod.types),
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
  // Two passes: first collect every variant per full_path so we can union
  // methods across all of them; then pick one representative per path.
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
    out.push({ ...primary, methods: unionMethods(variants) });
  }
  return out;
}

function pickRepresentative(variants: readonly TypeFacts[]): TypeFacts {
  // Prefer the non-`type_alias` variant — its fields are real instead of
  // the synthetic `<alias>` placeholder. Falls back to the first variant
  // when only aliases exist.
  let best = variants[0] as TypeFacts;
  for (const v of variants) {
    if (best.kind === 'type_alias' && v.kind !== 'type_alias') best = v;
  }
  return best;
}

function unionMethods(variants: readonly TypeFacts[]): readonly FnFacts[] {
  const seen = new Set<string>();
  const merged: FnFacts[] = [];
  for (const v of variants) {
    for (const m of v.methods ?? []) {
      if (seen.has(m.name)) continue;
      seen.add(m.name);
      merged.push(m);
    }
  }
  return merged;
}

// Dedupe re-exports by `exposed_name` within a module. The extractor walks
// cfg branches blindly, so a `pub use ... as Foo;` gated under both
// `#[cfg(memprof)]` and `#[cfg(not(memprof))]` lands twice in the same
// module. Downstream, each re-export becomes a ghost row with id
// `${modulePath}::__re_${exposed_name}`; duplicates crash the band layout's
// unique-id assertion. Rust forbids two live `pub use` items exposing the
// same name in one module, so cfg-gated dups are by construction the same
// public surface — keeping the first occurrence is safe.
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
