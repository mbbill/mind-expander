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
  /** Synthetic kind used for visibility-grouped function "pseudo-types"
   *  inserted by `module_tree.ts`. The extractor never emits this. */
  | 'function_group';

export type Ownership =
  | 'owned'
  | 'borrow_immut'
  | 'borrow_mut'
  | 'indirection'
  | 'primitive'
  | 'other';

export interface FieldFacts {
  readonly name: string;
  readonly ty_text: string;
  readonly ownership: Ownership;
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
}

export interface FnFacts {
  readonly name: string;
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
}

export interface CrateFacts {
  readonly name: string;
  readonly modules: Readonly<Record<string, ModuleFacts>>;
}

export type EdgeKind =
  | 'owns'
  | 'borrows_immut'
  | 'borrows_mut'
  | 'indirection'
  | 'trait_impl';

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
}

export type CallKind = 'function' | 'associated_function' | 'method';

export type CallResolution = 'exact' | 'heuristic' | 'ambiguous';

export interface CallEdge {
  readonly caller: string;
  readonly callee: string;
  readonly kind: CallKind;
  readonly resolution: CallResolution;
  readonly origin: string;
}

export interface Facts {
  readonly crates: Readonly<Record<string, CrateFacts>>;
  readonly edges: readonly Edge[];
  readonly call_edges?: readonly CallEdge[];
}
