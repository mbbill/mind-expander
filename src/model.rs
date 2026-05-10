//! Output data model. Lives separate from extraction so the schema is
//! visible at a glance.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceFacts {
    /// Crates discovered, indexed by crate name.
    pub crates: BTreeMap<String, CrateFacts>,
    /// Flat list of every cross-type edge.
    pub edges: Vec<Edge>,
    /// Best-effort function caller/callee graph. Kept separate from
    /// ownership/reference edges so layout and ownership analysis do not
    /// accidentally treat executable calls as structural facts.
    #[serde(default)]
    pub call_edges: Vec<CallEdge>,
    /// Per-type aggregate edge profile (resolved name -> profile).
    pub edge_profiles: BTreeMap<String, EdgeProfile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrateFacts {
    pub name: String,
    pub root: String,
    /// Modules indexed by full path inside the crate (e.g. "vm::wasm").
    pub modules: BTreeMap<String, ModuleFacts>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModuleFacts {
    pub path: String,
    pub file: String,
    pub types: Vec<TypeFacts>,
    /// Free functions defined directly in this module.
    pub functions: Vec<FnFacts>,
    /// `pub use` re-exports declared in this module. Inherited-vis `use`
    /// statements (plain imports) are NOT re-exports and are not recorded.
    /// Globs (`use foo::*`) are also skipped — we can't enumerate them
    /// without modelling the resolver. Empty by default so old tooling
    /// chains keep parsing if downstream code doesn't care.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub re_exports: Vec<ReExport>,
    /// Count of `unsafe { ... }` blocks textually inside this module's items.
    pub unsafe_blocks: u32,
}

/// A `pub use` re-export — a publicly-exposed alias for an item declared
/// elsewhere in the workspace. The viewer renders these as ghost rows in
/// the re-exporting module, with an arrow back to the canonical
/// definition. We resolve `target_path` after the full type/function
/// registry is known; entries that don't resolve to a known item (e.g.
/// external-crate paths) are dropped at extraction time.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReExport {
    /// Name as exposed in this module — after `as Renamed` this is `Renamed`.
    pub exposed_name: String,
    /// Canonical full path of the original definition.
    pub target_path: String,
    /// Visibility of the `pub use` itself. We never record inherited-vis
    /// `use` statements; this is always one of `pub`, `pub(crate)`,
    /// `pub(super)`, `pub(in path)`.
    pub visibility: String,
    pub kind: ReExportKind,
    /// For type re-exports, the canonical's [`TypeKind`] (struct / enum /
    /// trait / …). `None` for function re-exports. The viewer uses this
    /// to render the per-row kind marker on ghost rows; without it,
    /// every ghost falls back to the "struct" default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_kind: Option<TypeKind>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReExportKind {
    Type,
    Function,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TypeFacts {
    pub name: String,
    /// Full canonical path, e.g. `sf-nano-core::vm::wasm::context::CompileContext`.
    pub full_path: String,
    pub kind: TypeKind,
    pub visibility: String,
    pub lifetime_params: Vec<String>,
    pub type_params: Vec<String>,
    pub derives: Vec<String>,
    /// Fields (structs) or variants (enums).
    pub fields: Vec<FieldFacts>,
    /// All methods across all `impl` blocks for this type, including trait impls.
    pub methods: Vec<FnFacts>,
    /// Names of traits implemented for this type (inherent impls excluded).
    pub trait_impls: Vec<String>,
    /// `unsafe` blocks textually inside `impl` blocks for this type.
    pub unsafe_blocks: u32,
    /// Doc comment first line (low-trust, surfaced for context only).
    pub doc_first_line: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TypeKind {
    Struct,
    Enum,
    Union,
    Trait,
    TypeAlias,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FieldFacts {
    /// Field name, or variant name for enums.
    pub name: String,
    /// Pretty-printed type expression.
    pub ty_text: String,
    /// Ownership relation that this field declares to its inner type(s).
    pub ownership: Ownership,
    /// Resolved inner-type names (best-effort textual resolution).
    pub referenced: Vec<String>,
    /// Per-reference cardinality, parallel to [`FieldFacts::referenced`].
    pub cardinality: Vec<Cardinality>,
    /// Lifetime names that appear in the field type.
    pub lifetimes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FnFacts {
    pub name: String,
    pub visibility: String,
    pub self_kind: SelfKind,
    pub is_unsafe: bool,
    pub is_const: bool,
    pub is_async: bool,
    /// Lifetime parameters declared on the fn itself.
    pub lifetime_params: Vec<String>,
    pub params: Vec<ParamFacts>,
    pub return_ty_text: String,
    pub return_ownership: Ownership,
    pub return_referenced: Vec<String>,
    /// Per-reference cardinality, parallel to [`FnFacts::return_referenced`].
    pub return_cardinality: Vec<Cardinality>,
    /// True if any input lifetime appears in the return type — i.e. the
    /// return value carries a borrow from one of the inputs.
    pub lifetime_flows_through: bool,
    /// `unsafe { ... }` blocks textually in the body.
    pub unsafe_blocks: u32,
    pub doc_first_line: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParamFacts {
    pub name: String,
    pub ty_text: String,
    pub ownership: Ownership,
    pub referenced: Vec<String>,
    /// Per-reference cardinality, parallel to [`ParamFacts::referenced`].
    pub cardinality: Vec<Cardinality>,
    pub lifetimes: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SelfKind {
    /// No `self` parameter — associated function (e.g. `fn new(...)`).
    None,
    /// `self` by value (consumes).
    ByValue,
    /// `&self`.
    Ref,
    /// `&mut self`.
    RefMut,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Ownership {
    /// Plain owned value: `T`, `Vec<T>`, `Box<T>`, `Option<T>`, smart-pointer
    /// containers that own the inner T.
    Owned,
    /// Shared borrow: `&T`, `&'a T`.
    BorrowImmut,
    /// Mutable borrow: `&mut T`, `&'a mut T`.
    BorrowMut,
    /// Raw pointer or other ownership-breaking indirection: `*const T`,
    /// `*mut T`, `NonNull<T>`.
    Indirection,
    /// Primitive / standalone (no referenced user type).
    Primitive,
    /// Could not classify (function pointer, complex generic, etc.).
    Other,
}

/// How many of the referenced inner type the surrounding type expression
/// can hold. Determined by the dominant multi-valued container along the
/// path from the outer type to the user-type reference. Smart-pointer wrappers
/// (`Box`, `Arc`, `Rc`, `Cell`, `RefCell`, …) pass through unchanged.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum Cardinality {
    /// Default: the reference appears exactly once. Includes `Box<T>`,
    /// `Arc<T>`, `Rc<T>`, `Cell<T>`, `RefCell<T>`, `Mutex<T>`, etc.
    One,
    /// At most one: the reference is wrapped in `Option<T>`.
    Optional,
    /// Many ordered or set-valued: `Vec<T>`, `VecDeque<T>`, `[T; N]`,
    /// `[T]`, `BTreeSet<T>`, `HashSet<T>`, `LinkedList<T>`.
    Many,
    /// Many addressed by key: `BTreeMap<K, V>`, `HashMap<K, V>`. Both K
    /// and V receive this cardinality (one of each per entry, many entries).
    ManyKeyed,
}

impl Cardinality {
    fn rank(self) -> u8 {
        match self {
            Cardinality::One => 0,
            Cardinality::Optional => 1,
            Cardinality::Many => 2,
            Cardinality::ManyKeyed => 3,
        }
    }
    /// Return the more-multiplying of the two cardinalities. Used when a
    /// type reference appears in multiple positions of a type expression
    /// (e.g. `(Vec<T>, T)`) — we keep the strongest cardinality so the
    /// edge reflects the worst-case fan-out.
    pub fn dominate(self, other: Cardinality) -> Cardinality {
        if self.rank() >= other.rank() {
            self
        } else {
            other
        }
    }
}

/// The *relation* the edge declares between `from` and `to`.
///
/// Orthogonal to [`ViaKind`]; the two together form the full edge taxonomy.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum EdgeKind {
    /// Owned by-value: `T`, `Vec<T>`, `Box<T>`, etc.
    Owns,
    /// Shared borrow: `&T`, `&'a T`.
    BorrowsImmut,
    /// Mutable borrow: `&mut T`, `&'a mut T`.
    BorrowsMut,
    /// Raw pointer or ownership-breaking indirection: `*const T`, `NonNull<T>`.
    Indirection,
    /// `impl Trait for Type` — the source type implements the target trait.
    TraitImpl,
}

/// *Where* the edge was declared. Independent of the relation kind.
///
/// Distinguishes structural composition (struct/union field) from sum
/// composition (enum variant payload), and separates field-derived edges
/// from function-derived edges.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ViaKind {
    /// Field of a struct or tuple struct.
    StructField,
    /// Field of a `union`.
    UnionField,
    /// Payload of an `enum` variant.
    EnumVariantPayload,
    /// Function parameter (free fn or method).
    FnParam,
    /// Function return type.
    FnReturn,
    /// `impl Trait for X` block — pairs only with [`EdgeKind::TraitImpl`].
    TraitImplBlock,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Edge {
    /// Source: the type whose field/method declares the relation, or the
    /// implementing type for TraitImpl.
    pub from: String,
    /// Target: the type being referred to.
    pub to: String,
    pub kind: EdgeKind,
    pub via: ViaKind,
    pub cardinality: Cardinality,
    /// Origin description (field name, fn name, etc.) — handy for follow-up.
    pub origin: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum CallKind {
    /// `foo(...)` or `module::foo(...)`.
    Function,
    /// `Type::foo(...)` or `Self::foo(...)`.
    AssociatedFunction,
    /// `receiver.foo(...)`.
    Method,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum CallResolution {
    /// The syntax points at a single known workspace function/method.
    Exact,
    /// Textual context picked one likely target, but this is not rustc name
    /// resolution. A semantic backend can replace these later.
    Heuristic,
    /// Multiple known workspace functions/methods could match the call.
    Ambiguous,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CallEdge {
    /// Fully-qualified caller function or method id.
    pub caller: String,
    /// Fully-qualified callee function or method id.
    pub callee: String,
    pub kind: CallKind,
    pub resolution: CallResolution,
    /// Textual callee expression, e.g. `foo`, `Type::new`, or `.push`.
    pub origin: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EdgeProfile {
    /// Edges where this type is the *target*, bucketed by [`EdgeKind`].
    pub inbound: BTreeMap<String, u32>,
    /// Edges where this type is the *source*, bucketed by [`EdgeKind`].
    pub outbound: BTreeMap<String, u32>,
    /// Edges where this type is the *target*, bucketed by [`ViaKind`].
    pub inbound_via: BTreeMap<String, u32>,
    /// Edges where this type is the *source*, bucketed by [`ViaKind`].
    pub outbound_via: BTreeMap<String, u32>,
    /// Distinct source types in inbound.
    pub inbound_distinct_sources: u32,
    /// Distinct target types in outbound.
    pub outbound_distinct_targets: u32,
}
