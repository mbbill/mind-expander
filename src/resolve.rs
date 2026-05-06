//! Type-text classification.
//!
//! Given a `syn::Type`, decide its `Ownership` relation, extract the
//! user-defined type names it references (with per-reference cardinality),
//! and the lifetimes it mentions.
//!
//! Resolution is textual only — we don't run rustc's name resolver. For our
//! purposes "did this struct field own a `Vec<TypeContext>` or borrow a
//! `&TypeContext`" is decidable from the type expression alone.

use std::collections::{BTreeMap, BTreeSet};

use quote::ToTokens;
use syn::{GenericArgument, PathArguments, Type, TypePath, TypeReference};

use crate::model::{Cardinality, Ownership};

/// Builtin/primitive type names we don't surface as "referenced types."
const PRIMITIVES: &[&str] = &[
    "bool", "char", "str", "String", "u8", "u16", "u32", "u64", "u128", "usize", "i8", "i16",
    "i32", "i64", "i128", "isize", "f32", "f64", "()", "!",
];

/// Container types whose generic argument is *owned* by the outer type.
/// Cardinality is decided separately by [`container_cardinality`].
const OWNING_CONTAINERS: &[&str] = &[
    "Vec",
    "VecDeque",
    "HashMap",
    "HashSet",
    "BTreeMap",
    "BTreeSet",
    "LinkedList",
    "Box",
    "Rc",
    "Arc",
    "Cell",
    "RefCell",
    "Mutex",
    "RwLock",
    "Option",
    "Result",
    "Cow",
    "PhantomData",
];

/// Container types that break ownership (raw pointer-like).
const INDIRECTION_TYPES: &[&str] = &["NonNull", "ManuallyDrop", "MaybeUninit"];

/// Cardinality contributed by a container at this level. `Box`, `Arc`, etc.
/// don't multiply, so they yield `One` and the surrounding context wins.
fn container_cardinality(name: &str) -> Cardinality {
    match name {
        "Option" => Cardinality::Optional,
        "Vec" | "VecDeque" | "BTreeSet" | "HashSet" | "LinkedList" => Cardinality::Many,
        "BTreeMap" | "HashMap" => Cardinality::ManyKeyed,
        _ => Cardinality::One,
    }
}

/// Pretty-print a syn::Type to a compact string.
pub fn type_text(ty: &Type) -> String {
    let s = ty.to_token_stream().to_string();
    // Compact whitespace introduced by tokenization.
    let mut out = String::with_capacity(s.len());
    let mut prev_space = false;
    for ch in s.chars() {
        if ch.is_whitespace() {
            if !prev_space {
                out.push(' ');
            }
            prev_space = true;
        } else {
            out.push(ch);
            prev_space = false;
        }
    }
    out.replace(" ::", "::")
        .replace(":: ", "::")
        .replace(" < ", "<")
        .replace(" >", ">")
        .replace("< ", "<")
        .replace(" ,", ",")
        .replace(" ;", ";")
}

/// Classify a top-level type expression.
///
/// Returns:
/// - the field/param/return ownership relation,
/// - referenced user-type names paired with per-reference cardinality,
/// - lifetime names mentioned in the expression.
pub fn classify(ty: &Type) -> (Ownership, Vec<(String, Cardinality)>, Vec<String>) {
    let mut referenced: BTreeMap<String, Cardinality> = BTreeMap::new();
    let mut lifetimes: BTreeSet<String> = BTreeSet::new();
    let ownership = classify_inner(ty, &mut referenced, &mut lifetimes, true, Cardinality::One);
    let mut out: Vec<(String, Cardinality)> = referenced
        .into_iter()
        .filter(|(name, _)| !PRIMITIVES.contains(&name.as_str()))
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    let lifetimes: Vec<String> = lifetimes.into_iter().collect();
    (ownership, out, lifetimes)
}

fn record_ref(map: &mut BTreeMap<String, Cardinality>, name: String, c: Cardinality) {
    map.entry(name)
        .and_modify(|e| *e = e.dominate(c))
        .or_insert(c);
}

fn classify_inner(
    ty: &Type,
    referenced: &mut BTreeMap<String, Cardinality>,
    lifetimes: &mut BTreeSet<String>,
    top: bool,
    card: Cardinality,
) -> Ownership {
    match ty {
        Type::Reference(TypeReference {
            mutability,
            elem,
            lifetime,
            ..
        }) => {
            if let Some(lt) = lifetime {
                lifetimes.insert(lt.ident.to_string());
            }
            classify_inner(elem, referenced, lifetimes, false, card);
            if mutability.is_some() {
                Ownership::BorrowMut
            } else {
                Ownership::BorrowImmut
            }
        }
        Type::Ptr(p) => {
            classify_inner(&p.elem, referenced, lifetimes, false, card);
            Ownership::Indirection
        }
        Type::Path(TypePath { path, .. }) => {
            let last = match path.segments.last() {
                Some(seg) => seg,
                None => return Ownership::Other,
            };
            let name = last.ident.to_string();

            // Cardinality contributed by *this* container level.
            let inner_card = card.dominate(container_cardinality(&name));

            if let PathArguments::AngleBracketed(args) = &last.arguments {
                for arg in &args.args {
                    match arg {
                        GenericArgument::Lifetime(lt) => {
                            lifetimes.insert(lt.ident.to_string());
                        }
                        GenericArgument::Type(t) => {
                            classify_inner(t, referenced, lifetimes, false, inner_card);
                        }
                        _ => {}
                    }
                }
            }
            if name == "Self" {
                return Ownership::Owned;
            }
            if PRIMITIVES.contains(&name.as_str()) {
                if top {
                    Ownership::Primitive
                } else {
                    Ownership::Owned
                }
            } else if INDIRECTION_TYPES.contains(&name.as_str()) {
                if top {
                    Ownership::Indirection
                } else {
                    Ownership::Owned
                }
            } else if OWNING_CONTAINERS.contains(&name.as_str()) {
                Ownership::Owned
            } else {
                record_ref(referenced, name, card);
                Ownership::Owned
            }
        }
        Type::Tuple(tup) => {
            for elem in &tup.elems {
                classify_inner(elem, referenced, lifetimes, false, card);
            }
            if top && tup.elems.is_empty() {
                Ownership::Primitive
            } else {
                Ownership::Owned
            }
        }
        Type::Array(arr) => {
            // Array elements: many.
            let inner = card.dominate(Cardinality::Many);
            classify_inner(&arr.elem, referenced, lifetimes, false, inner);
            Ownership::Owned
        }
        Type::Slice(slc) => {
            let inner = card.dominate(Cardinality::Many);
            classify_inner(&slc.elem, referenced, lifetimes, false, inner);
            Ownership::Owned
        }
        Type::Paren(p) => classify_inner(&p.elem, referenced, lifetimes, top, card),
        Type::Group(g) => classify_inner(&g.elem, referenced, lifetimes, top, card),
        Type::ImplTrait(_) | Type::TraitObject(_) | Type::BareFn(_) => {
            harvest_textually(ty, referenced, lifetimes, card);
            Ownership::Other
        }
        Type::Infer(_) | Type::Macro(_) | Type::Never(_) | Type::Verbatim(_) => Ownership::Other,
        _ => Ownership::Other,
    }
}

fn harvest_textually(
    ty: &Type,
    referenced: &mut BTreeMap<String, Cardinality>,
    lifetimes: &mut BTreeSet<String>,
    card: Cardinality,
) {
    let s = ty.to_token_stream().to_string();
    for tok in s.split(|c: char| !c.is_alphanumeric() && c != '_') {
        if let Some(rest) = tok.strip_prefix('\'') {
            if !rest.is_empty() {
                lifetimes.insert(rest.to_string());
            }
        } else if let Some(c) = tok.chars().next() {
            if c.is_uppercase()
                && !PRIMITIVES.contains(&tok)
                && !OWNING_CONTAINERS.contains(&tok)
                && !INDIRECTION_TYPES.contains(&tok)
            {
                record_ref(referenced, tok.to_string(), card);
            }
        }
    }
}
