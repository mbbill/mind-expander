// Mirror of the slice of `tools/mind-expander/src/model.rs` consumed by the viewer.
// Only the fields we actually read are declared here. The Rust extractor emits
// a superset; TypeScript ignores the rest.
//
// When the viewer starts consuming new fields, add them here first and keep
// this file the single source of truth on the JS side.

export type TypeKind =
  | 'struct'
  | 'enum'
  | 'union'
  | 'trait'
  | 'type_alias'
  /** TypeScript `class`. Kept distinct from `struct` so the renderer
   *  can paint a class-specific icon. */
  | 'class'
  /** TypeScript `interface`. Trait-shaped contract but not a Rust
   *  trait; kept distinct for icon and labeling. */
  | 'interface'
  /** Synthetic kind used for visibility-grouped function "pseudo-types"
   *  inserted by `module_tree.ts`. The extractor never emits this. */
  | 'function_group';

/** Source-file span for an item — emitted by the extractor when it has
 *  the information. The viewer's code panel uses this to scroll to and
 *  highlight the lines that define the item. All optional so older
 *  facts files (without span info) still load. */
export interface Span {
  readonly file: string;
  /** 1-indexed, inclusive. */
  readonly start_line: number;
  /** 1-indexed, inclusive. */
  readonly end_line: number;
}

export type Ownership =
  | 'owned'
  | 'borrow_immut'
  | 'borrow_mut'
  | 'indirection'
  | 'primitive'
  | 'other';

/** Which snapshot an entity belongs to in union-diff view.
 *  - `base` = present only in base (deleted in head).
 *  - `head` = present only in head (added) — or single-snapshot mode.
 *  - `both` = present in both, body unchanged.
 *  - `modified` = present in both, body changed. The entity carries
 *    `prev_span` with the base location alongside the canonical
 *    head `span`.
 *  Defaults to `'head'` for single-snapshot output (the server omits
 *  the field in non-diff mode so the viewer treats everything as
 *  head; absent === 'head' in TypeScript consumers). */
export type Side = 'base' | 'head' | 'both' | 'modified';

/** Sub-classification of a `Side::Modified` entity. Drives the
 *  diagram bar's colour:
 *   - 'add'   → solid green bar  (body has `+` lines only)
 *   - 'del'   → solid red bar    (body has `−` lines only)
 *   - 'mixed' → dual red+green bar (body has both)
 *  Absent when `side !== 'modified'`. */
export type ChangeKind = 'add' | 'del' | 'mixed';

export interface FieldFacts {
  readonly name: string;
  readonly ty_text: string;
  readonly ownership: Ownership;
  readonly span?: Span;
  /** Base location for `side === 'modified'` fields. Carries the
   *  field's span in the base snapshot so the code panel can
   *  compute the union frame across base+head. Absent for all
   *  other sides. */
  readonly prev_span?: Span;
  readonly change_kind?: ChangeKind;
  readonly side?: Side;
}

export interface TypeFacts {
  readonly name: string;
  readonly full_path: string;
  readonly kind: TypeKind;
  /** Raw visibility token from the extractor: `"pub"`, `"pub(crate)"`,
   *  `"pub(super)"`, `"pub(in some::path)"`, `"pub(self)"`, or `"priv"`.
   *  Bucketing into the 5 display groups happens in view/encoding.ts. */
  readonly visibility: string;
  readonly fields: readonly FieldFacts[];
  /** Methods across every `impl` block for this type, including trait
   *  impls. Optional — older facts files won't have it, in which case
   *  the viewer treats the type as having no method visualisation. */
  readonly methods?: readonly FnFacts[];
  readonly span?: Span;
  /** Base location for `side === 'modified'` types. */
  readonly prev_span?: Span;
  readonly change_kind?: ChangeKind;
  readonly side?: Side;
}

export interface FnFacts {
  readonly name: string;
  /** For methods inside `impl Trait for Type`: trait name (last path
   *  segment). `undefined` for inherent methods and free functions.
   *  Disambiguates same-name methods across multiple impl blocks
   *  (e.g. two `from`s from `impl From<A> for X` + `impl From<B> for X`). */
  readonly impl_trait?: string;
  /** Raw extractor visibility token: `"pub"`, `"pub(crate)"`, …, `"priv"`,
   *  or sentinels like `"<orphan-impl>"` that the viewer filters out. */
  readonly visibility: string;
  /** Position-ordered parameter list. Each entry has the param name and
   *  the rendered type text exactly as the extractor pretty-prints it
   *  (e.g. `"&'a mut Foo<T>"`). Optional — older facts files predate
   *  this field; the viewer just shows the method name in that case. */
  readonly params?: readonly { readonly name: string; readonly ty_text: string }[];
  /** Pretty-printed return type, e.g. `"Result<(), Error>"` or `"()"`. */
  readonly return_ty_text?: string;
  /** Receiver shape: `'none'` for free functions / associated fns,
   *  `'by_value'` for `self`, `'ref'` for `&self`, `'ref_mut'` for
   *  `&mut self`. */
  readonly self_kind?: 'none' | 'by_value' | 'ref' | 'ref_mut';
  readonly is_unsafe?: boolean;
  readonly is_const?: boolean;
  readonly is_async?: boolean;
  readonly span?: Span;
  /** Base location for `side === 'modified'` functions/methods. */
  readonly prev_span?: Span;
  readonly change_kind?: ChangeKind;
  readonly side?: Side;
}

/**
 * A `pub use` re-export — a "ghost" path to an existing item (type or
 * function) declared elsewhere. The viewer renders these as visually
 * distinct rows in the re-exporting module with an arrow back to the
 * canonical source. Optional: old facts.json files without re-export
 * tracking simply have no entries here, making the feature inert.
 */
export interface ReExport {
  /** Name as exposed in this module — after `as Baz` this is `Baz`. */
  readonly exposed_name: string;
  /** Canonical full path to the original definition. */
  readonly target_path: string;
  /** Visibility of the `pub use` statement, capped by the target's
   *  intrinsic visibility (so a `pub use foo::Bar` of a `pub(crate)`
   *  Bar lands here as `pub(crate)`). */
  readonly visibility: string;
  readonly kind: 'type' | 'function';
  /** Canonical's TypeKind for type re-exports. Absent for function
   *  re-exports and for older facts files without this field — the
   *  ghost synthesiser falls back to `'struct'` so the row still
   *  renders. */
  readonly target_kind?: TypeKind;
  readonly span?: Span;
}

export interface ModuleFacts {
  readonly path: string;
  readonly file: string;
  readonly types: readonly TypeFacts[];
  /** Free functions defined directly in this module. */
  readonly functions: readonly FnFacts[];
  /** `pub use` re-exports declared in this module. Optional — old facts
   *  files without re-export tracking just have no entries, and the
   *  re-export-rendering feature stays inert. */
  readonly re_exports?: readonly ReExport[];
  readonly side?: Side;
}

/** Source language this crate was extracted from — stamped by the
 *  owning Rust-side `LanguageFrontend`. Optional + defaults to
 *  `'rust'` in old JSON dumps (the field was added when TS landed). */
export type Language = 'rust' | 'typescript';

export interface CrateFacts {
  readonly name: string;
  readonly modules: Readonly<Record<string, ModuleFacts>>;
  readonly side?: Side;
  /** See `Language`. Omitted on pre-language JSON — treat absent
   *  as `'rust'`. */
  readonly language?: Language;
}

export type EdgeKind =
  | 'owns'
  | 'borrows_immut'
  | 'borrows_mut'
  | 'indirection'
  | 'trait_impl'
  /** TypeScript `class Child extends Parent` — single inheritance.
   *  Distinct from `trait_impl` so the renderer can use a different
   *  arrow style (dashed) for inheritance vs interface implementation. */
  | 'extends';

export type ViaKind =
  | 'struct_field'
  | 'union_field'
  | 'enum_variant_payload'
  | 'fn_param'
  | 'fn_return'
  | 'trait_impl_block';

export interface Edge {
  readonly from: string;
  readonly to: string;
  readonly kind: EdgeKind;
  readonly via: ViaKind;
  /**
   * Free-text descriptor of where the edge was declared.
   * For `struct_field`/`union_field` vias: `field {fieldName}`.
   * For `enum_variant_payload`: `field {Variant}::{payloadName}` (or just `field {Variant}` for unit-like).
   * For `fn_param`/`fn_return`: `fn {fnName} param {paramName}` / `fn {fnName} return`.
   */
  readonly origin: string;
  /** Union-diff side: `'head'` when the edge exists only in head,
   *  `'base'` only in base, `'both'` when matched on both sides.
   *  `'head'` in single-snapshot mode. */
  readonly side?: Side;
}

export type CallKind = 'function' | 'associated_function' | 'method';

export type CallResolution = 'exact' | 'heuristic' | 'ambiguous';

export interface CallEdge {
  readonly caller: string;
  readonly callee: string;
  readonly kind: CallKind;
  readonly resolution: CallResolution;
  readonly origin: string;
  /** Union-diff side; same semantics as `Edge.side`. */
  readonly side?: Side;
}

export interface Facts {
  readonly crates: Readonly<Record<string, CrateFacts>>;
  readonly edges: readonly Edge[];
  readonly call_edges?: readonly CallEdge[];
}
