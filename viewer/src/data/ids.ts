import type { FnFacts } from './schema.ts';

// Centralised id construction for entities, so producers and consumers
// agree on the exact string used as a key in the span index, in click
// handlers, in arrow targets, and in side-lookup maps.
//
// Methods need a wrinkle: a type can have two `from` methods if it
// implements `From<A>` and `From<B>` via separate impl blocks. Without
// disambiguation those collide on `${typePath}::from`. We suffix the
// trait name when present (`@Trait`) so the id remains unique. Inherent
// methods (no `impl_trait`) keep the legacy `${typePath}::${name}` form
// so existing arrows, urls, and persisted state stay valid.

export function methodId(typeFullPath: string, fn: FnFacts): string {
  return fn.impl_trait === undefined
    ? `${typeFullPath}::${fn.name}`
    : `${typeFullPath}::${fn.name}@${fn.impl_trait}`;
}

// Fields don't need impl_trait disambiguation — Rust forbids duplicate
// field names within a struct. Centralised here so the spelling stays
// consistent if we ever change it.
export function fieldId(typeFullPath: string, fieldName: string): string {
  return `${typeFullPath}::${fieldName}`;
}
