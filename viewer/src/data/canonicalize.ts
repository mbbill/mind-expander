// Boundary-time normalization of the raw extractor JSON. Pure, deterministic;
// callers should treat the returned Facts as the single canonical view.
//
// Currently fixes one issue: the extractor walks the AST cfg-blind, so types
// defined under mutually exclusive `#[cfg(...)]` flavors (e.g. tracked-alloc's
// `Box`/`Vec`/`RegistrySnapshot` etc.) emit twice with the same `full_path`.
// We dedupe per module by `full_path`, preferring the non-`type_alias` variant
// since the alias is typically the facade and the struct is the meaningful
// definition. Remove this when cfg-aware extraction lands.

import type { CrateFacts, Facts, ModuleFacts, TypeFacts } from './schema.ts';

export function canonicalize(facts: Facts): Facts {
  const crates: Record<string, CrateFacts> = {};
  for (const [name, crate] of Object.entries(facts.crates)) {
    const modules: Record<string, ModuleFacts> = {};
    for (const [path, mod] of Object.entries(crate.modules)) {
      modules[path] = { ...mod, types: dedupeByFullPath(mod.types) };
    }
    crates[name] = { ...crate, modules };
  }
  return { crates, edges: facts.edges };
}

function dedupeByFullPath(types: readonly TypeFacts[]): readonly TypeFacts[] {
  const byPath = new Map<string, TypeFacts>();
  for (const t of types) {
    const existing = byPath.get(t.full_path);
    if (!existing || (existing.kind === 'type_alias' && t.kind !== 'type_alias')) {
      byPath.set(t.full_path, t);
    }
  }
  return [...byPath.values()];
}
