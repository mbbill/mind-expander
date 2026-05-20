//! Merge two `WorkspaceFacts` (base + head) into a single union fact
//! set tagged by `Side`. Used by the server in diff mode so the viewer
//! can render removed/added/modified entities in one diagram.
//!
//! Merge algorithm:
//!   • Walk the union of crate names. For each crate:
//!       - in both → produce a Both-tagged crate; merge its modules.
//!       - base only → tag the whole crate Base; cascade Base to all
//!         its modules and entities.
//!       - head only → mirror, Head.
//!   • Within a Both-tagged crate, do the same union over module
//!     paths. Both module → merge its entities. Base/Head-only
//!     module → cascade.
//!   • Within a Both-tagged module, types are matched by name and
//!     kind; functions by name. Match → Both. Unmatched → Base- or
//!     Head-only. Field-level matching inside Both types: match by
//!     name (Rust forbids duplicates, so name is unique per type).
//!
//! Edges are merged separately by (from, to, kind) keys.
//!
//! `body_modified` detection is left for a follow-up pass that
//! intersects diff hunks with each Both-entity's head span.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;
use std::process::Command;

use anyhow::{Context, Result, bail};

use crate::diff::{DiffOutcome, diff_file};
use crate::model::{
    CallEdge, CrateFacts, Edge, EdgeProfile, FieldFacts, FnFacts, ModuleFacts, ReExport, Side,
    TypeFacts, TypeKind, WorkspaceFacts,
};

/// Build the unified facts set by merging two snapshots. `base` and
/// `head` come from two independent calls to
/// `extract::extract_workspace`; sides on input entities are
/// ignored (extract always emits Head) — this function assigns the
/// real side based on presence in each snapshot.
pub fn build_unified(base: WorkspaceFacts, head: WorkspaceFacts) -> WorkspaceFacts {
    let mut out_crates: BTreeMap<String, CrateFacts> = BTreeMap::new();
    let crate_names: BTreeSet<String> = base
        .crates
        .keys()
        .chain(head.crates.keys())
        .cloned()
        .collect();
    for name in crate_names {
        let b = base.crates.get(&name);
        let h = head.crates.get(&name);
        match (b, h) {
            (Some(bc), Some(hc)) => {
                out_crates.insert(name.clone(), merge_crate(bc.clone(), hc.clone()));
            }
            (Some(bc), None) => {
                out_crates.insert(name.clone(), tag_crate(bc.clone(), Side::Base));
            }
            (None, Some(hc)) => {
                out_crates.insert(name.clone(), tag_crate(hc.clone(), Side::Head));
            }
            (None, None) => unreachable!(),
        }
    }

    let edges = merge_edges(&base.edges, &head.edges);
    let call_edges = merge_call_edges(&base.call_edges, &head.call_edges);
    // edge_profiles are per-type aggregates; keep the head's by
    // default and union in base-only types. They're a viewer hint,
    // not an invariant, so a simple union by key suffices.
    let mut edge_profiles: BTreeMap<String, EdgeProfile> = head.edge_profiles.clone();
    for (k, v) in base.edge_profiles {
        edge_profiles.entry(k).or_insert(v);
    }

    WorkspaceFacts {
        crates: out_crates,
        edges,
        call_edges,
        edge_profiles,
    }
}

fn merge_crate(b: CrateFacts, h: CrateFacts) -> CrateFacts {
    let mut modules: BTreeMap<String, ModuleFacts> = BTreeMap::new();
    let module_paths: BTreeSet<String> =
        b.modules.keys().chain(h.modules.keys()).cloned().collect();
    for p in module_paths {
        let bm = b.modules.get(&p);
        let hm = h.modules.get(&p);
        match (bm, hm) {
            (Some(bm), Some(hm)) => {
                modules.insert(p.clone(), merge_module(bm.clone(), hm.clone()));
            }
            (Some(bm), None) => {
                modules.insert(p.clone(), tag_module(bm.clone(), Side::Base));
            }
            (None, Some(hm)) => {
                modules.insert(p.clone(), tag_module(hm.clone(), Side::Head));
            }
            _ => unreachable!(),
        }
    }
    CrateFacts {
        name: h.name,
        // Prefer head's root; for base-only crates this is unreachable
        // because we take the `tag_crate` branch above.
        root: h.root,
        modules,
        side: Side::Both,
    }
}

fn merge_module(b: ModuleFacts, h: ModuleFacts) -> ModuleFacts {
    // Types matched by (name, kind). Rust disallows the same name
    // sharing a kind in one scope, so (name, kind) is unique within a
    // module — the matcher is safe.
    let mut types: Vec<TypeFacts> = Vec::new();
    let mut b_types: BTreeMap<(String, TypeKind), TypeFacts> = b
        .types
        .into_iter()
        .map(|t| ((t.name.clone(), t.kind.clone()), t))
        .collect();
    for ht in h.types {
        let key = (ht.name.clone(), ht.kind.clone());
        if let Some(bt) = b_types.remove(&key) {
            types.push(merge_type(bt, ht));
        } else {
            types.push(tag_type(ht, Side::Head));
        }
    }
    for (_, bt) in b_types {
        types.push(tag_type(bt, Side::Base));
    }

    let mut functions: Vec<FnFacts> = Vec::new();
    let mut b_fns: BTreeMap<String, FnFacts> =
        b.functions.into_iter().map(|f| (f.name.clone(), f)).collect();
    for hf in h.functions {
        if let Some(bf) = b_fns.remove(&hf.name) {
            functions.push(merge_fn(bf, hf));
        } else {
            functions.push(tag_fn(hf, Side::Head));
        }
    }
    for (_, bf) in b_fns {
        functions.push(tag_fn(bf, Side::Base));
    }

    // Re-exports are matched by `exposed_name + kind + target_path`.
    let mut re_exports: Vec<ReExport> = Vec::new();
    let mut b_re: BTreeMap<(String, String), ReExport> = b
        .re_exports
        .into_iter()
        .map(|r| ((r.exposed_name.clone(), r.target_path.clone()), r))
        .collect();
    for hr in h.re_exports {
        let key = (hr.exposed_name.clone(), hr.target_path.clone());
        if b_re.remove(&key).is_some() {
            // Identical re-export on both sides; keep head's copy.
            re_exports.push(hr);
        } else {
            re_exports.push(hr);
        }
    }
    for (_, br) in b_re {
        // Base-only re-export: kept but the viewer treats it as a
        // base-side marker via its target's side (no dedicated side
        // field on ReExport — keeping the model minimal).
        re_exports.push(br);
    }

    ModuleFacts {
        path: h.path,
        file: h.file,
        types,
        functions,
        re_exports,
        // unsafe_blocks: not a meaningful merge — keep head's count.
        unsafe_blocks: h.unsafe_blocks,
        side: Side::Both,
    }
}

fn merge_type(b: TypeFacts, h: TypeFacts) -> TypeFacts {
    // Field merge inside a Both type. Fields matched by name (Rust
    // forbids duplicates inside a struct/enum). Base-only fields are
    // kept and tagged Base; head-only are tagged Head.
    let mut fields: Vec<FieldFacts> = Vec::new();
    let mut b_fields: BTreeMap<String, FieldFacts> =
        b.fields.into_iter().map(|f| (f.name.clone(), f)).collect();
    for hf in h.fields {
        if let Some(bf) = b_fields.remove(&hf.name) {
            // Both-side field — keep head's data, tag Both. We don't
            // detect per-field body_modified in v1.
            let _ = bf;
            fields.push(FieldFacts {
                side: Side::Both,
                ..hf
            });
        } else {
            fields.push(FieldFacts {
                side: Side::Head,
                ..hf
            });
        }
    }
    for (_, bf) in b_fields {
        fields.push(FieldFacts {
            side: Side::Base,
            ..bf
        });
    }

    // Methods merge: same as functions inside a module.
    let mut methods: Vec<FnFacts> = Vec::new();
    let mut b_methods: BTreeMap<String, FnFacts> =
        b.methods.into_iter().map(|f| (f.name.clone(), f)).collect();
    for hm in h.methods {
        if let Some(bm) = b_methods.remove(&hm.name) {
            methods.push(merge_fn(bm, hm));
        } else {
            methods.push(tag_fn(hm, Side::Head));
        }
    }
    for (_, bm) in b_methods {
        methods.push(tag_fn(bm, Side::Base));
    }

    TypeFacts {
        name: h.name,
        full_path: h.full_path,
        kind: h.kind,
        visibility: h.visibility,
        lifetime_params: h.lifetime_params,
        type_params: h.type_params,
        derives: h.derives,
        fields,
        methods,
        trait_impls: h.trait_impls,
        unsafe_blocks: h.unsafe_blocks,
        doc_first_line: h.doc_first_line,
        span: h.span,
        side: Side::Both,
        // body_modified is left false here — a follow-up pass sets
        // it based on diff hunk intersection. Doing it lazily keeps
        // this merge dependency-free.
        body_modified: false,
    }
}

fn merge_fn(_b: FnFacts, h: FnFacts) -> FnFacts {
    FnFacts {
        side: Side::Both,
        body_modified: false,
        ..h
    }
}

fn tag_crate(mut c: CrateFacts, side: Side) -> CrateFacts {
    c.side = side;
    let mut modules: BTreeMap<String, ModuleFacts> = BTreeMap::new();
    for (k, m) in c.modules {
        modules.insert(k, tag_module(m, side));
    }
    c.modules = modules;
    c
}

fn tag_module(mut m: ModuleFacts, side: Side) -> ModuleFacts {
    m.side = side;
    m.types = m.types.into_iter().map(|t| tag_type(t, side)).collect();
    m.functions = m.functions.into_iter().map(|f| tag_fn(f, side)).collect();
    m
}

fn tag_type(mut t: TypeFacts, side: Side) -> TypeFacts {
    t.side = side;
    t.body_modified = false;
    t.fields = t
        .fields
        .into_iter()
        .map(|f| FieldFacts { side, ..f })
        .collect();
    t.methods = t.methods.into_iter().map(|f| tag_fn(f, side)).collect();
    t
}

fn tag_fn(mut f: FnFacts, side: Side) -> FnFacts {
    f.side = side;
    f.body_modified = false;
    f
}

// ─── Edge merging ──────────────────────────────────────────────────────────

fn edge_key(e: &Edge) -> (String, String, String) {
    // `from`, `to`, and `via` together discriminate enough for v1.
    // Edge sides aren't yet tagged on the Edge struct itself —
    // edges still appear once. The viewer can derive base/head/both
    // edge semantics from endpoint sides in a follow-up.
    (e.from.clone(), e.to.clone(), format!("{:?}", e.kind))
}

fn merge_edges(base: &[Edge], head: &[Edge]) -> Vec<Edge> {
    let mut seen: BTreeSet<(String, String, String)> = BTreeSet::new();
    let mut out: Vec<Edge> = Vec::new();
    for e in head.iter().chain(base.iter()) {
        let key = edge_key(e);
        if seen.insert(key) {
            out.push(e.clone());
        }
    }
    out
}

fn call_edge_key(c: &CallEdge) -> (String, String, u32, String) {
    (
        c.caller.clone(),
        c.callee.clone(),
        c.callsite_start_line,
        format!("{:?}", c.kind),
    )
}

fn merge_call_edges(base: &[CallEdge], head: &[CallEdge]) -> Vec<CallEdge> {
    let mut seen: BTreeSet<(String, String, u32, String)> = BTreeSet::new();
    let mut out: Vec<CallEdge> = Vec::new();
    for c in head.iter().chain(base.iter()) {
        let key = call_edge_key(c);
        if seen.insert(key) {
            out.push(c.clone());
        }
    }
    out
}

// ─── body_modified pass ────────────────────────────────────────────────────

/// For each `Both`-tagged entity (type / method / free function) whose
/// head-side span overlaps a diff hunk, set `body_modified = true`.
/// Hunks come from `git diff base..head` per file. The pass walks each
/// file once, collects its hunks, and then sweeps the facts in a
/// single linear pass.
///
/// `head_workspace_root` is the directory the head parser saw — the
/// extractor records absolute paths under it in `span.file`, so we
/// strip that prefix to derive the repo-relative path `git diff`
/// expects. When `head_sha` is `None` the diff is computed against the
/// working tree.
pub fn mark_body_modified(
    facts: &mut WorkspaceFacts,
    repo_root: &Path,
    base_sha: &str,
    head_sha: Option<&str>,
    head_workspace_root: &Path,
) -> Result<()> {
    // 1. Enumerate every file that has any hunk and load its line
    //    ranges. `--name-only` would do for the file list, but we
    //    re-use `diff_file` to also get the hunk spans in one go.
    //    Files unchanged in base..head produce empty entries and are
    //    skipped.
    let changed = list_changed_files(repo_root, base_sha, head_sha)?;
    let mut hunks_by_file: HashMap<String, Vec<(u32, u32)>> = HashMap::new();
    for rel in &changed {
        if let Ok(DiffOutcome::Changed(d)) =
            diff_file(repo_root, base_sha, head_sha, rel)
        {
            // Track the head-side line range each hunk occupies.
            let h: Vec<(u32, u32)> = d
                .hunks
                .iter()
                .filter(|h| h.new_count > 0)
                .map(|h| (h.new_start, h.new_start + h.new_count.saturating_sub(1)))
                .collect();
            if !h.is_empty() {
                hunks_by_file.insert(rel.clone(), h);
            }
        }
    }

    // 2. Canonicalize the head workspace root once so prefix-strip in
    //    the hot loop sees a stable path regardless of `..` / symlinks.
    let head_canon = std::fs::canonicalize(head_workspace_root)
        .unwrap_or_else(|_| head_workspace_root.to_owned());

    let head_rel = |abs_file: &str| -> Option<String> {
        let p = Path::new(abs_file);
        let p_canon = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_owned());
        p_canon
            .strip_prefix(&head_canon)
            .ok()
            .map(|r| r.to_string_lossy().into_owned())
    };

    let overlaps = |hunks: &[(u32, u32)], start: u32, end: u32| -> bool {
        hunks.iter().any(|&(hs, he)| !(end < hs || start > he))
    };

    // 3. Sweep the facts. Only `Both` entities can be body_modified —
    //    base/head-only entities already communicate their state via
    //    side, so a body_modified flag would be redundant noise.
    for crate_facts in facts.crates.values_mut() {
        for module in crate_facts.modules.values_mut() {
            for ty in module.types.iter_mut() {
                if ty.side != Side::Both {
                    continue;
                }
                if let Some(span) = &ty.span {
                    if let Some(rel) = head_rel(&span.file) {
                        if let Some(hunks) = hunks_by_file.get(&rel) {
                            if overlaps(hunks, span.start_line, span.end_line) {
                                ty.body_modified = true;
                            }
                        }
                    }
                }
                for m in ty.methods.iter_mut() {
                    if m.side != Side::Both {
                        continue;
                    }
                    if let Some(span) = &m.span {
                        if let Some(rel) = head_rel(&span.file) {
                            if let Some(hunks) = hunks_by_file.get(&rel) {
                                if overlaps(hunks, span.start_line, span.end_line) {
                                    m.body_modified = true;
                                }
                            }
                        }
                    }
                }
            }
            for f in module.functions.iter_mut() {
                if f.side != Side::Both {
                    continue;
                }
                if let Some(span) = &f.span {
                    if let Some(rel) = head_rel(&span.file) {
                        if let Some(hunks) = hunks_by_file.get(&rel) {
                            if overlaps(hunks, span.start_line, span.end_line) {
                                f.body_modified = true;
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

fn list_changed_files(
    repo: &Path,
    base: &str,
    head: Option<&str>,
) -> Result<Vec<String>> {
    let mut cmd = Command::new("git");
    cmd.args(["-C"]).arg(repo).args(["diff", "--name-only", base]);
    if let Some(h) = head {
        cmd.arg(h);
    }
    let out = cmd
        .output()
        .context("invoking `git diff --name-only`")?;
    if !out.status.success() {
        bail!(
            "git diff --name-only failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    let text =
        String::from_utf8(out.stdout).context("git diff --name-only output not utf-8")?;
    Ok(text.lines().map(|s| s.to_string()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::*;

    fn mk_type(name: &str, kind: TypeKind) -> TypeFacts {
        TypeFacts {
            name: name.to_string(),
            full_path: format!("c::{name}"),
            kind,
            visibility: "pub".into(),
            lifetime_params: vec![],
            type_params: vec![],
            derives: vec![],
            fields: vec![],
            methods: vec![],
            trait_impls: vec![],
            unsafe_blocks: 0,
            doc_first_line: None,
            span: None,
            side: Side::Head,
            body_modified: false,
        }
    }

    fn mk_module(path: &str, types: Vec<TypeFacts>) -> ModuleFacts {
        ModuleFacts {
            path: path.to_string(),
            file: format!("/x/{path}.rs"),
            types,
            functions: vec![],
            re_exports: vec![],
            unsafe_blocks: 0,
            side: Side::Head,
        }
    }

    fn mk_crate(name: &str, modules: Vec<ModuleFacts>) -> CrateFacts {
        CrateFacts {
            name: name.to_string(),
            root: format!("/{name}"),
            modules: modules.into_iter().map(|m| (m.path.clone(), m)).collect(),
            side: Side::Head,
        }
    }

    fn mk_facts(crates: Vec<CrateFacts>) -> WorkspaceFacts {
        WorkspaceFacts {
            crates: crates.into_iter().map(|c| (c.name.clone(), c)).collect(),
            edges: vec![],
            call_edges: vec![],
            edge_profiles: BTreeMap::new(),
        }
    }

    #[test]
    fn type_present_in_both_becomes_both() {
        let t = mk_type("Foo", TypeKind::Struct);
        let m_base = mk_module("m", vec![t.clone()]);
        let m_head = mk_module("m", vec![t.clone()]);
        let base = mk_facts(vec![mk_crate("c", vec![m_base])]);
        let head = mk_facts(vec![mk_crate("c", vec![m_head])]);
        let u = build_unified(base, head);
        let c = u.crates.get("c").unwrap();
        assert_eq!(c.side, Side::Both);
        let m = c.modules.get("m").unwrap();
        assert_eq!(m.side, Side::Both);
        let t = m.types.iter().find(|t| t.name == "Foo").unwrap();
        assert_eq!(t.side, Side::Both);
    }

    #[test]
    fn type_only_in_head_becomes_head() {
        let m_base = mk_module("m", vec![]);
        let m_head = mk_module("m", vec![mk_type("Foo", TypeKind::Struct)]);
        let base = mk_facts(vec![mk_crate("c", vec![m_base])]);
        let head = mk_facts(vec![mk_crate("c", vec![m_head])]);
        let u = build_unified(base, head);
        let t = u
            .crates
            .get("c")
            .unwrap()
            .modules
            .get("m")
            .unwrap()
            .types
            .iter()
            .find(|t| t.name == "Foo")
            .unwrap();
        assert_eq!(t.side, Side::Head);
    }

    #[test]
    fn type_only_in_base_becomes_base() {
        let m_base = mk_module("m", vec![mk_type("Old", TypeKind::Struct)]);
        let m_head = mk_module("m", vec![]);
        let base = mk_facts(vec![mk_crate("c", vec![m_base])]);
        let head = mk_facts(vec![mk_crate("c", vec![m_head])]);
        let u = build_unified(base, head);
        let t = u
            .crates
            .get("c")
            .unwrap()
            .modules
            .get("m")
            .unwrap()
            .types
            .iter()
            .find(|t| t.name == "Old")
            .unwrap();
        assert_eq!(t.side, Side::Base);
    }

    #[test]
    fn crate_only_in_base_cascades_base_side() {
        let base = mk_facts(vec![mk_crate(
            "gone",
            vec![mk_module("m", vec![mk_type("X", TypeKind::Struct)])],
        )]);
        let head = mk_facts(vec![]);
        let u = build_unified(base, head);
        let c = u.crates.get("gone").unwrap();
        assert_eq!(c.side, Side::Base);
        let m = c.modules.get("m").unwrap();
        assert_eq!(m.side, Side::Base);
        let t = m.types.iter().find(|t| t.name == "X").unwrap();
        assert_eq!(t.side, Side::Base);
    }

    #[test]
    fn crate_only_in_head_cascades_head_side() {
        let base = mk_facts(vec![]);
        let head = mk_facts(vec![mk_crate(
            "new",
            vec![mk_module("m", vec![mk_type("X", TypeKind::Struct)])],
        )]);
        let u = build_unified(base, head);
        let c = u.crates.get("new").unwrap();
        assert_eq!(c.side, Side::Head);
    }

    #[test]
    fn same_name_different_kind_becomes_two_entities() {
        // Pathological: mod foo in base, struct Foo in head — different
        // kinds at the same name. Both should survive as distinct
        // entries (Rust doesn't actually allow this collision in a
        // single module, but the model has to be defensive).
        let m_base = mk_module("m", vec![mk_type("Foo", TypeKind::Trait)]);
        let m_head = mk_module("m", vec![mk_type("Foo", TypeKind::Struct)]);
        let base = mk_facts(vec![mk_crate("c", vec![m_base])]);
        let head = mk_facts(vec![mk_crate("c", vec![m_head])]);
        let u = build_unified(base, head);
        let m = u.crates.get("c").unwrap().modules.get("m").unwrap();
        // Trait-named-Foo is base-only; Struct-named-Foo is head-only.
        let mut sides_by_kind: BTreeMap<String, Side> = BTreeMap::new();
        for t in &m.types {
            sides_by_kind.insert(format!("{:?}", t.kind), t.side);
        }
        assert_eq!(sides_by_kind.get("Trait").copied(), Some(Side::Base));
        assert_eq!(sides_by_kind.get("Struct").copied(), Some(Side::Head));
    }
}
