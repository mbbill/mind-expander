//! Ownership tree printer.
//!
//! Builds a forest from *structural* ownership edges — `kind == Owns` with
//! `via` in {StructField, UnionField}. Enum variant payloads are excluded by
//! default because sum-composition is not the same as runtime containment;
//! they can be re-included with `include_variants = true`.
//!
//! Annotations are inline text, not glyphs. At a node's *primary* expansion
//! site, the parens list its other owners (capped at 3, then "+N more"). At
//! repeat occurrences, the parens point at the parent under which the full
//! subtree was already expanded, so the reader knows where to find it.

use std::collections::{BTreeMap, BTreeSet};

use crate::model::{Cardinality, EdgeKind, ViaKind, WorkspaceFacts};

/// At most this many other-owner names are listed inline before
/// collapsing the rest to "+N more".
const MAX_LISTED_OWNERS: usize = 3;

pub fn print_tree(ws: &WorkspaceFacts, krate: Option<&str>, include_variants: bool) {
    // Scoped type set: every type defined in the selected crate(s).
    let mut scoped: BTreeSet<String> = BTreeSet::new();
    for cf in ws.crates.values() {
        if let Some(k) = krate {
            if cf.name != k {
                continue;
            }
        }
        for m in cf.modules.values() {
            for t in &m.types {
                scoped.insert(t.full_path.clone());
            }
        }
    }
    if scoped.is_empty() {
        println!("(no types in scope)");
        return;
    }

    // Owns / owners maps, restricted to scoped types and deduplicated.
    // Include only structural ownership: struct fields and union fields.
    // Enum variant payloads come along when `include_variants` is set.
    //
    // `card` records the dominant cardinality across edges between a (parent,
    // child) pair — when a parent owns a child via multiple fields with
    // different containers (e.g. `Vec<T>` and `Option<T>`), we report the
    // most-multiplying one.
    let mut owns: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut owners: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut card: BTreeMap<(String, String), Cardinality> = BTreeMap::new();
    for e in &ws.edges {
        if e.kind != EdgeKind::Owns {
            continue;
        }
        let via_ok = matches!(e.via, ViaKind::StructField | ViaKind::UnionField)
            || (include_variants && e.via == ViaKind::EnumVariantPayload);
        if !via_ok {
            continue;
        }
        if !scoped.contains(&e.from) || !scoped.contains(&e.to) {
            continue;
        }
        owns.entry(e.from.clone()).or_default().insert(e.to.clone());
        owners
            .entry(e.to.clone())
            .or_default()
            .insert(e.from.clone());
        card.entry((e.from.clone(), e.to.clone()))
            .and_modify(|c| *c = c.dominate(e.cardinality))
            .or_insert(e.cardinality);
    }

    // Roots: scoped types nobody owns by-field.
    let mut roots: Vec<String> = scoped
        .iter()
        .filter(|p| !owners.contains_key(*p))
        .cloned()
        .collect();
    // Order: types with the largest reachable subtree first; ties by name.
    roots.sort_by(|a, b| {
        let da = subtree_size(a, &owns);
        let db = subtree_size(b, &owns);
        db.cmp(&da).then_with(|| a.cmp(b))
    });

    let scope = match krate {
        Some(k) => format!("krate: {k}"),
        None => "whole workspace".to_string(),
    };
    let edges_used = if include_variants {
        "structural fields + enum variant payloads"
    } else {
        "structural fields only (struct/union)"
    };
    // Compute display names: shortest path-suffix unique within scope so
    // that distinct types with the same simple name (e.g., per-arch
    // `BranchFixup`) become visually distinguishable.
    let display_names = compute_display_names(&scoped);

    println!("ownership forest ({scope}; {edges_used})");
    println!();

    let mut visited: BTreeSet<String> = BTreeSet::new();
    // For every visited node, the display name of the parent under which its
    // subtree was first expanded. Roots have no parent and don't appear here.
    let mut primary_parent: BTreeMap<String, String> = BTreeMap::new();

    let mut leaf_roots: Vec<&String> = Vec::new();
    for r in &roots {
        if owns.get(r).map_or(true, |s| s.is_empty()) {
            leaf_roots.push(r);
        } else {
            print_subtree(
                r,
                &owns,
                &owners,
                &card,
                &display_names,
                &mut visited,
                &mut primary_parent,
                "",
                false,
                true,
                None,
            );
            println!();
        }
    }

    if !leaf_roots.is_empty() {
        println!("(roots with no owned-field children)");
        leaf_roots.sort();
        for r in leaf_roots {
            println!("  {}", display_name(r, &display_names));
        }
    }
}

/// For each full path in `paths`, choose the shortest path-suffix unique
/// across the set. When two distinct types share a simple name (e.g.
/// per-arch `Backend`), every member of that group is rendered with enough
/// leading segments to disambiguate within the group.
fn compute_display_names(paths: &BTreeSet<String>) -> BTreeMap<String, String> {
    let mut groups: BTreeMap<String, Vec<&str>> = BTreeMap::new();
    for p in paths {
        let simple = p.rsplit("::").next().unwrap_or(p).to_string();
        groups.entry(simple).or_default().push(p.as_str());
    }
    let mut out: BTreeMap<String, String> = BTreeMap::new();
    for (_, members) in groups {
        if members.len() == 1 {
            let p = members[0];
            out.insert(p.to_string(), short_name(p).to_string());
            continue;
        }
        let segs: Vec<Vec<&str>> = members.iter().map(|p| p.split("::").collect()).collect();
        let max_depth = segs.iter().map(|s| s.len()).max().unwrap_or(1);
        let mut k = 1usize;
        let chosen: Vec<String> = loop {
            let suffixes: Vec<String> = segs
                .iter()
                .map(|s| {
                    let n = s.len();
                    let start = n.saturating_sub(k);
                    s[start..].join("::")
                })
                .collect();
            let unique = {
                let set: BTreeSet<&String> = suffixes.iter().collect();
                set.len() == suffixes.len()
            };
            if unique || k >= max_depth {
                break suffixes;
            }
            k += 1;
        };
        for (i, p) in members.iter().enumerate() {
            out.insert((*p).to_string(), chosen[i].clone());
        }
    }
    out
}

/// Look up a path's display name; fall back to the simple name if the
/// path isn't in the map (e.g. an out-of-scope reference).
fn display_name(path: &str, names: &BTreeMap<String, String>) -> String {
    names
        .get(path)
        .cloned()
        .unwrap_or_else(|| short_name(path).to_string())
}

fn subtree_size(path: &str, owns: &BTreeMap<String, BTreeSet<String>>) -> usize {
    let mut visited: BTreeSet<String> = BTreeSet::new();
    let mut stack = vec![path.to_string()];
    while let Some(n) = stack.pop() {
        if !visited.insert(n.clone()) {
            continue;
        }
        if let Some(c) = owns.get(&n) {
            for child in c {
                stack.push(child.clone());
            }
        }
    }
    visited.len().saturating_sub(1)
}

fn print_subtree(
    path: &str,
    owns: &BTreeMap<String, BTreeSet<String>>,
    owners: &BTreeMap<String, BTreeSet<String>>,
    card: &BTreeMap<(String, String), Cardinality>,
    display_names: &BTreeMap<String, String>,
    visited: &mut BTreeSet<String>,
    primary_parent: &mut BTreeMap<String, String>,
    prefix: &str,
    is_last: bool,
    is_root: bool,
    parent_path: Option<&str>,
) {
    let already = visited.contains(path);
    let edge_card = parent_path
        .and_then(|p| card.get(&(p.to_string(), path.to_string())).copied())
        .unwrap_or(Cardinality::One);
    let annotation = build_annotation(
        path,
        owners,
        primary_parent,
        parent_path,
        already,
        edge_card,
        display_names,
    );

    let name = display_name(path, display_names);
    let display = match annotation {
        None => name.clone(),
        Some(text) => format!("{name}   {text}"),
    };

    if is_root {
        println!("{}", display);
    } else {
        let connector = if is_last { "└── " } else { "├── " };
        println!("{prefix}{connector}{display}");
    }

    if already {
        return;
    }
    visited.insert(path.to_string());
    if let Some(p) = parent_path {
        primary_parent.insert(path.to_string(), display_name(p, display_names));
    }

    let mut children: Vec<&String> = owns
        .get(path)
        .map(|s| s.iter().collect())
        .unwrap_or_default();
    children.sort();
    let n = children.len();

    let new_prefix = if is_root {
        String::new()
    } else if is_last {
        format!("{prefix}    ")
    } else {
        format!("{prefix}│   ")
    };

    for (i, child) in children.iter().enumerate() {
        let child_is_last = i + 1 == n;
        print_subtree(
            child,
            owns,
            owners,
            card,
            display_names,
            visited,
            primary_parent,
            &new_prefix,
            child_is_last,
            false,
            Some(path),
        );
    }
}

/// Compute the inline annotation for a node. Components, joined by `; ` in
/// a single parens block:
/// - cardinality of the (parent → this node) edge, if not `One`
/// - on a *repeat* occurrence: where the primary expansion lives
/// - on a *primary* multi-owner occurrence: the other owners
/// Returns `None` when none of the components apply.
fn build_annotation(
    path: &str,
    owners: &BTreeMap<String, BTreeSet<String>>,
    primary_parent: &BTreeMap<String, String>,
    parent_path: Option<&str>,
    already: bool,
    edge_card: Cardinality,
    display_names: &BTreeMap<String, String>,
) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();

    if let Some(s) = cardinality_phrase(edge_card) {
        parts.push(s.to_string());
    }

    if already {
        if let Some(primary) = primary_parent.get(path) {
            parts.push(format!("expanded above under {primary}"));
        }
    } else if let Some(owner_set) = owners.get(path) {
        if owner_set.len() > 1 {
            let mut other: Vec<&str> = owner_set
                .iter()
                .filter(|p| Some(p.as_str()) != parent_path)
                .map(|s| s.as_str())
                .collect();
            other.sort();
            let total_other = other.len();
            let listed: Vec<String> = other
                .iter()
                .take(MAX_LISTED_OWNERS)
                .map(|s| display_name(s, display_names))
                .collect();
            let extra = total_other.saturating_sub(MAX_LISTED_OWNERS);
            let suffix = if extra > 0 {
                format!(", +{extra} more")
            } else {
                String::new()
            };
            parts.push(format!("also owned by: {}{}", listed.join(", "), suffix));
        }
    }

    if parts.is_empty() {
        None
    } else {
        Some(format!("({})", parts.join("; ")))
    }
}

/// Return the human-readable phrase for non-default cardinalities; `None`
/// for `One` (the default case stays unannotated).
fn cardinality_phrase(c: Cardinality) -> Option<&'static str> {
    match c {
        Cardinality::One => None,
        Cardinality::Optional => Some("optional"),
        Cardinality::Many => Some("many"),
        Cardinality::ManyKeyed => Some("many, keyed"),
    }
}

fn short_name(full_path: &str) -> &str {
    full_path.rsplit("::").next().unwrap_or(full_path)
}
