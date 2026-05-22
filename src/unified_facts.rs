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
//! Edges are merged separately by (from, to, kind, via) keys.
//!
//! **Split-on-change**: when an entity exists in both snapshots, the
//! merge decides between emitting a single `Both` (truly unchanged)
//! vs a `Base(b) + Head(h)` pair (signature or body differs). The
//! decision uses diff-hunk intersection — same logic as the old
//! `mark_body_modified` pass, but driven into the merge so split
//! pairs flow out directly and the viewer never sees a "Both with a
//! modified body" state.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, bail};

use crate::diff::{DiffOutcome, LineKind, diff_file};
use crate::model::ChangeKind;
use crate::model::{
    CallEdge, CrateFacts, Edge, EdgeProfile, FieldFacts, FnFacts, ModuleFacts, ReExport, Side,
    Span, TypeFacts, TypeKind, WorkspaceFacts,
};

/// Pre-computed per-file hunk ranges for both snapshots. Passed into
/// [`build_unified`] so the merge can decide split-vs-Both per entity
/// in a single pass, without re-running `git diff`. `hunks_by_*` keys
/// are repo-relative paths (matching `git diff --name-only` output);
/// values are inclusive `(start, end)` line ranges in the respective
/// snapshot's coordinates.
pub struct Hunks {
    pub head_workspace_root: PathBuf,
    pub base_workspace_root: PathBuf,
    pub hunks_by_file_head: HashMap<String, Vec<(u32, u32)>>,
    pub hunks_by_file_base: HashMap<String, Vec<(u32, u32)>>,
}

impl Hunks {
    /// Build the hunk bundle by running `git diff base..head` once and
    /// recording each hunk's old- and new-line ranges per file.
    pub fn collect(
        repo_root: &Path,
        base_sha: &str,
        head_sha: Option<&str>,
        head_workspace_root: &Path,
        base_workspace_root: &Path,
    ) -> Result<Self> {
        let changed = list_changed_files(repo_root, base_sha, head_sha)?;
        let mut head_map: HashMap<String, Vec<(u32, u32)>> = HashMap::new();
        let mut base_map: HashMap<String, Vec<(u32, u32)>> = HashMap::new();
        for rel in &changed {
            if let Ok(DiffOutcome::Changed(d)) = diff_file(repo_root, base_sha, head_sha, rel) {
                // Build per-side ranges from the ACTUAL `+` and `−` lines
                // only — NOT from `(new_start, new_count)` which includes
                // git's `-U3` context padding. A function placed
                // immediately under a hunk whose context lines reach down
                // to its first line would otherwise be flagged Modified
                // even though its own body is unchanged.
                let head_ranges: Vec<(u32, u32)> = d
                    .hunks
                    .iter()
                    .filter_map(|h| range_of_kind(h, LineKind::Add, |l| l.new))
                    .collect();
                if !head_ranges.is_empty() {
                    head_map.insert(rel.clone(), head_ranges);
                }
                let base_ranges: Vec<(u32, u32)> = d
                    .hunks
                    .iter()
                    .filter_map(|h| range_of_kind(h, LineKind::Del, |l| l.old))
                    .collect();
                if !base_ranges.is_empty() {
                    base_map.insert(rel.clone(), base_ranges);
                }
            }
        }
        Ok(Hunks {
            head_workspace_root: canonical(head_workspace_root),
            base_workspace_root: canonical(base_workspace_root),
            hunks_by_file_head: head_map,
            hunks_by_file_base: base_map,
        })
    }
}

fn canonical(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_owned())
}

/// Min/max line range of all `kind`-matching lines in `hunk`.
/// `pick` extracts the relevant gutter number (`l.new` for Add,
/// `l.old` for Del) — context lines are skipped because their
/// gutters belong to both sides but their content is unchanged.
/// Returns None when no line of `kind` exists in the hunk.
fn range_of_kind(
    hunk: &crate::diff::Hunk,
    kind: LineKind,
    pick: impl Fn(&crate::diff::DiffLine) -> Option<u32>,
) -> Option<(u32, u32)> {
    let mut lo: Option<u32> = None;
    let mut hi: Option<u32> = None;
    for line in &hunk.lines {
        if line.kind != kind {
            continue;
        }
        let Some(n) = pick(line) else {
            continue;
        };
        lo = Some(lo.map_or(n, |cur| cur.min(n)));
        hi = Some(hi.map_or(n, |cur| cur.max(n)));
    }
    match (lo, hi) {
        (Some(a), Some(b)) => Some((a, b)),
        _ => None,
    }
}

/// True when `span` overlaps any hunk for the file `span.file` points
/// at. `side` selects which side's coordinate space to interpret the
/// span in. Spanless entities return false (nothing to compare).
fn body_changed(span: Option<&Span>, hunks: Option<&Hunks>, side: Side) -> bool {
    let (Some(span), Some(hunks)) = (span, hunks) else {
        return false;
    };
    let (root, map) = match side {
        Side::Head => (&hunks.head_workspace_root, &hunks.hunks_by_file_head),
        Side::Base => (&hunks.base_workspace_root, &hunks.hunks_by_file_base),
        // `Both` and `Modified` are *output* tags assigned by the merger;
        // they are never used as a query side here.
        Side::Both | Side::Modified => return false,
    };
    let p = canonical(Path::new(&span.file));
    let Ok(rel) = p.strip_prefix(root) else {
        return false;
    };
    let rel = rel.to_string_lossy();
    let Some(ranges) = map.get(rel.as_ref()) else {
        return false;
    };
    ranges
        .iter()
        .any(|&(hs, he)| !(span.end_line < hs || span.start_line > he))
}

/// Decide the side for an *orphan* head-side entity — one whose
/// structural match (name + kind, or name + impl_trait for methods)
/// failed against the paired base type/module. If its span overlaps
/// a hunk on the head side, the lines are genuinely new in head →
/// tag `Head`. Otherwise the lines are unchanged in the file (no
/// hunk overlap → identical in both snapshots), so the entity must
/// exist in base too even though the (cfg-blind) extractor's match
/// missed it → tag `Both`. The latter case is common with
/// `#[cfg]`-gated dual definitions where the variants don't pair up
/// cleanly by position.
fn orphan_head_side(span: Option<&Span>, hunks: Option<&Hunks>) -> Side {
    // Promote to Both only when we have BOTH the diff hunks AND the
    // entity's span and the span genuinely doesn't intersect a head
    // hunk. Without hunks info (single-snapshot mode or test setups
    // that don't supply them) we can't make the unchanged-line
    // determination → fall back to the structural decision (Head).
    let (Some(span), Some(_)) = (span, hunks) else {
        return Side::Head;
    };
    if body_changed(Some(span), hunks, Side::Head) {
        Side::Head
    } else {
        Side::Both
    }
}

/// Mirror of `orphan_head_side` for the base-side drain pass.
fn orphan_base_side(span: Option<&Span>, hunks: Option<&Hunks>) -> Side {
    let (Some(span), Some(_)) = (span, hunks) else {
        return Side::Base;
    };
    if body_changed(Some(span), hunks, Side::Base) {
        Side::Base
    } else {
        Side::Both
    }
}

/// Build the unified facts set by merging two snapshots. `base` and
/// `head` come from two independent calls to
/// `extract::extract_workspace`; sides on input entities are ignored
/// (extract always emits Head) — this function assigns the real side
/// based on presence in each snapshot AND, when `hunks` is supplied,
/// whether the entity's body intersects any diff hunk in either
/// snapshot. Body-changed entities split into Base + Head pairs;
/// truly-unchanged entities collapse into a single Both. Pass `None`
/// in tests / non-diff paths to disable splitting (every same-name
/// match becomes Both).
pub fn build_unified(
    base: WorkspaceFacts,
    head: WorkspaceFacts,
    hunks: Option<&Hunks>,
) -> WorkspaceFacts {
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
                out_crates.insert(name.clone(), merge_crate(bc.clone(), hc.clone(), hunks));
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

fn merge_crate(b: CrateFacts, h: CrateFacts, hunks: Option<&Hunks>) -> CrateFacts {
    let mut modules: BTreeMap<String, ModuleFacts> = BTreeMap::new();
    let module_paths: BTreeSet<String> =
        b.modules.keys().chain(h.modules.keys()).cloned().collect();
    for p in module_paths {
        let bm = b.modules.get(&p);
        let hm = h.modules.get(&p);
        match (bm, hm) {
            (Some(bm), Some(hm)) => {
                modules.insert(p.clone(), merge_module(bm.clone(), hm.clone(), hunks));
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
        // Head and base have the same language (would be the same
        // file paths under the same crate). Take it from head.
        language: h.language,
        side: Side::Both,
    }
}

fn merge_module(b: ModuleFacts, h: ModuleFacts, hunks: Option<&Hunks>) -> ModuleFacts {
    // Types matched by (name, kind), then PAIRED BY POSITION within
    // each bucket. The cfg-blind extractor emits the same name twice
    // when a type is defined under mutually-exclusive `#[cfg]`
    // flavors (e.g. tracked-alloc's `AllocationHandle` lives under
    // both `#[cfg(memprof)]` and `#[cfg(not(memprof))]`); a flat
    // BTreeMap collapses them and methods of the dropped variant
    // lose their base counterpart in the merge. Keeping each bucket
    // as a Vec and pairing the Nth head with the Nth base preserves
    // every variant's body-changed signal — the syn walker visits
    // AST items in source order, so position is a stable match.
    let mut types: Vec<TypeFacts> = Vec::new();
    let mut b_types: BTreeMap<(String, TypeKind), Vec<TypeFacts>> = BTreeMap::new();
    for bt in b.types {
        b_types
            .entry((bt.name.clone(), bt.kind.clone()))
            .or_default()
            .push(bt);
    }
    for ht in h.types {
        let key = (ht.name.clone(), ht.kind.clone());
        let bv = b_types.get_mut(&key);
        // VecDeque-free position match: take the first base variant
        // in the bucket so head's first pairs with base's first.
        let paired = match bv {
            Some(bucket) if !bucket.is_empty() => Some(bucket.remove(0)),
            _ => None,
        };
        match paired {
            Some(bt) => types.push(merge_type(bt, ht, hunks)),
            None => {
                let side = orphan_head_side(ht.span.as_ref(), hunks);
                types.push(tag_type(ht, side));
            }
        }
    }
    // Drain remaining base variants. A base type whose lines are
    // unchanged across snapshots almost certainly exists in head
    // too (extractor's structural pairing just missed it); promote
    // it to Both rather than mark it Base-only erroneously.
    for (_, bucket) in b_types {
        for bt in bucket {
            let side = orphan_base_side(bt.span.as_ref(), hunks);
            types.push(tag_type(bt, side));
        }
    }

    // Free functions split on change: a body-modified function emits
    // both the base and head variants as separate sided entities. The
    // viewer then renders two boxes (red + green) instead of one
    // body-modified Both — single-coord per entity makes diff↔diagram
    // mapping symmetric. Functions are matched by name only (free
    // fns can't share names in the same module).
    let mut functions: Vec<FnFacts> = Vec::new();
    let mut b_fns: BTreeMap<String, FnFacts> =
        b.functions.into_iter().map(|f| (f.name.clone(), f)).collect();
    for hf in h.functions {
        if let Some(bf) = b_fns.remove(&hf.name) {
            functions.extend(merge_fn(bf, hf, hunks));
        } else {
            let side = orphan_head_side(hf.span.as_ref(), hunks);
            functions.push(tag_fn(hf, side));
        }
    }
    for (_, bf) in b_fns {
        let side = orphan_base_side(bf.span.as_ref(), hunks);
        functions.push(tag_fn(bf, side));
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

fn merge_type(b: TypeFacts, h: TypeFacts, hunks: Option<&Hunks>) -> TypeFacts {
    // Field merge: emit a single `Side::Modified` record when a
    // matched field's declaration line overlaps a diff hunk on
    // either side. `span` carries the head location (current
    // state), `prev_span` the base. `change_kind` distinguishes
    // add-only / del-only / mixed for the diagram bar's colour.
    // Truly-unchanged fields stay `Both`.
    let mut fields: Vec<FieldFacts> = Vec::new();
    let mut b_fields: BTreeMap<String, FieldFacts> =
        b.fields.into_iter().map(|f| (f.name.clone(), f)).collect();
    for hf in h.fields {
        if let Some(bf) = b_fields.remove(&hf.name) {
            let (side, change_kind) =
                classify_change(hf.span.as_ref(), bf.span.as_ref(), hunks);
            if side == Side::Modified {
                fields.push(FieldFacts {
                    side,
                    prev_span: bf.span.clone(),
                    change_kind,
                    ..hf
                });
            } else {
                fields.push(FieldFacts { side: Side::Both, ..hf });
            }
        } else {
            let side = orphan_head_side(hf.span.as_ref(), hunks);
            fields.push(FieldFacts { side, ..hf });
        }
    }
    for (_, bf) in b_fields {
        let side = orphan_base_side(bf.span.as_ref(), hunks);
        fields.push(FieldFacts { side, ..bf });
    }

    // Methods merge: same shape as free-function merge above, but
    // matched on `(name, impl_trait)` so two methods named `from`
    // from `impl From<A> for X` and `impl From<B> for X` stay
    // distinct rather than colliding into one Both. impl_trait was
    // added in Phase 1; that disambiguation is required for split-
    // on-change because otherwise the two `from` head halves would
    // both want the same Base partner.
    let mut methods: Vec<FnFacts> = Vec::new();
    let mut b_methods: BTreeMap<(String, Option<String>), FnFacts> = b
        .methods
        .into_iter()
        .map(|f| ((f.name.clone(), f.impl_trait.clone()), f))
        .collect();
    for hm in h.methods {
        let key = (hm.name.clone(), hm.impl_trait.clone());
        if let Some(bm) = b_methods.remove(&key) {
            methods.extend(merge_fn(bm, hm, hunks));
        } else {
            let side = orphan_head_side(hm.span.as_ref(), hunks);
            methods.push(tag_fn(hm, side));
        }
    }
    for (_, bm) in b_methods {
        let side = orphan_base_side(bm.span.as_ref(), hunks);
        methods.push(tag_fn(bm, side));
    }

    // Type-level Modified: if the type's declaration span (which
    // covers the whole `struct/enum/trait { ... }` block) overlaps
    // a hunk on either side, mark the type itself Modified and
    // carry the base location in `prev_span`. `change_kind` drives
    // the bar's colour: add-only → solid green, del-only → solid
    // red, mixed → dual.
    let (side, change_kind) =
        classify_change(h.span.as_ref(), b.span.as_ref(), hunks);
    let prev_span = if side == Side::Modified { b.span.clone() } else { None };

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
        prev_span,
        change_kind,
        side,
    }
}

/// Returns `[Both(h)]` when neither snapshot's body span intersects a
/// hunk; otherwise a single `[Modified(h, prev_span=b.span, change_kind)]`.
/// `change_kind` is `Add` for additions only, `Del` for deletions only,
/// `Mixed` for both.
fn merge_fn(b: FnFacts, h: FnFacts, hunks: Option<&Hunks>) -> Vec<FnFacts> {
    let (side, change_kind) =
        classify_change(h.span.as_ref(), b.span.as_ref(), hunks);
    if side == Side::Modified {
        vec![FnFacts {
            side,
            prev_span: b.span.clone(),
            change_kind,
            ..h
        }]
    } else {
        vec![FnFacts { side: Side::Both, ..h }]
    }
}

/// Decide `(Side, ChangeKind)` from whether the head/base spans
/// overlap `+`/`-` lines in their respective sides. `head_span`
/// in head coords, `base_span` in base coords.
fn classify_change(
    head_span: Option<&Span>,
    base_span: Option<&Span>,
    hunks: Option<&Hunks>,
) -> (Side, Option<ChangeKind>) {
    let has_head_add = body_changed(head_span, hunks, Side::Head);
    let has_base_del = body_changed(base_span, hunks, Side::Base);
    match (has_head_add, has_base_del) {
        (false, false) => (Side::Both, None),
        (true, false) => (Side::Modified, Some(ChangeKind::Add)),
        (false, true) => (Side::Modified, Some(ChangeKind::Del)),
        (true, true) => (Side::Modified, Some(ChangeKind::Mixed)),
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
    f
}

// ─── Edge merging ──────────────────────────────────────────────────────────

fn edge_key(e: &Edge) -> (String, String, String, String) {
    // `from`, `to`, `kind`, and `via` together discriminate an edge
    // identity. We do NOT include side in the key — the merge promotes
    // a same-key (base, head) pair to a single `Both` edge rather than
    // emitting two separate entries.
    (
        e.from.clone(),
        e.to.clone(),
        format!("{:?}", e.kind),
        format!("{:?}", e.via),
    )
}

fn merge_edges(base: &[Edge], head: &[Edge]) -> Vec<Edge> {
    // Walk head first → tag `Head`. For each base edge that matches a
    // previously-seen head edge on (from, to, kind, via), upgrade the
    // existing entry to `Both`. Otherwise insert as `Base`. The result
    // contains exactly one entry per edge identity, with a side that
    // tells the viewer whether to paint it red, green, or neutral.
    let mut out: Vec<Edge> = Vec::new();
    let mut idx: BTreeMap<(String, String, String, String), usize> = BTreeMap::new();
    for e in head {
        let key = edge_key(e);
        if !idx.contains_key(&key) {
            idx.insert(key, out.len());
            let mut tagged = e.clone();
            tagged.side = Side::Head;
            out.push(tagged);
        }
    }
    for e in base {
        let key = edge_key(e);
        if let Some(&i) = idx.get(&key) {
            out[i].side = Side::Both;
        } else {
            let pos = out.len();
            idx.insert(key, pos);
            let mut tagged = e.clone();
            tagged.side = Side::Base;
            out.push(tagged);
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
    // Same shape as `merge_edges`: head first → Head; base that matches
    // an existing entry upgrades to Both; otherwise Base.
    let mut out: Vec<CallEdge> = Vec::new();
    let mut idx: BTreeMap<(String, String, u32, String), usize> = BTreeMap::new();
    for c in head {
        let key = call_edge_key(c);
        if !idx.contains_key(&key) {
            idx.insert(key, out.len());
            let mut tagged = c.clone();
            tagged.side = Side::Head;
            out.push(tagged);
        }
    }
    for c in base {
        let key = call_edge_key(c);
        if let Some(&i) = idx.get(&key) {
            out[i].side = Side::Both;
        } else {
            let pos = out.len();
            idx.insert(key, pos);
            let mut tagged = c.clone();
            tagged.side = Side::Base;
            out.push(tagged);
        }
    }
    out
}

// `mark_body_modified` was removed; its hunk-intersection logic now
// lives in `body_changed` (line ~75 above) and is invoked inline by
// the merge so split decisions happen during `build_unified` instead
// of in a separate post-pass.

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
            prev_span: None,
            change_kind: None,
            side: Side::Head,
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
            language: crate::model::Language::Rust,
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
        let u = build_unified(base, head, None);
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
        let u = build_unified(base, head, None);
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
        let u = build_unified(base, head, None);
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
        let u = build_unified(base, head, None);
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
        let u = build_unified(base, head, None);
        let c = u.crates.get("new").unwrap();
        assert_eq!(c.side, Side::Head);
    }

    fn mk_edge(from: &str, to: &str, kind: EdgeKind, via: ViaKind, origin: &str) -> Edge {
        Edge {
            from: from.into(),
            to: to.into(),
            kind,
            via,
            cardinality: Cardinality::One,
            origin: origin.into(),
            side: Side::default(),
        }
    }

    fn mk_facts_with_edges(crates: Vec<CrateFacts>, edges: Vec<Edge>) -> WorkspaceFacts {
        WorkspaceFacts {
            crates: crates.into_iter().map(|c| (c.name.clone(), c)).collect(),
            edges,
            call_edges: vec![],
            edge_profiles: BTreeMap::new(),
        }
    }

    #[test]
    fn edge_in_both_snapshots_is_tagged_both() {
        // Same (from, to, kind, via) on both sides → one Both edge.
        let e_base = mk_edge("c::A", "c::B", EdgeKind::Owns, ViaKind::StructField, "field f");
        let e_head = mk_edge("c::A", "c::B", EdgeKind::Owns, ViaKind::StructField, "field f");
        let base = mk_facts_with_edges(vec![mk_crate("c", vec![])], vec![e_base]);
        let head = mk_facts_with_edges(vec![mk_crate("c", vec![])], vec![e_head]);
        let u = build_unified(base, head, None);
        assert_eq!(u.edges.len(), 1);
        assert_eq!(u.edges[0].side, Side::Both);
    }

    #[test]
    fn edge_only_in_head_is_tagged_head() {
        let e_head = mk_edge("c::A", "c::B", EdgeKind::Owns, ViaKind::StructField, "field f");
        let base = mk_facts_with_edges(vec![mk_crate("c", vec![])], vec![]);
        let head = mk_facts_with_edges(vec![mk_crate("c", vec![])], vec![e_head]);
        let u = build_unified(base, head, None);
        assert_eq!(u.edges.len(), 1);
        assert_eq!(u.edges[0].side, Side::Head);
    }

    #[test]
    fn edge_only_in_base_is_tagged_base() {
        let e_base = mk_edge("c::A", "c::B", EdgeKind::Owns, ViaKind::StructField, "field f");
        let base = mk_facts_with_edges(vec![mk_crate("c", vec![])], vec![e_base]);
        let head = mk_facts_with_edges(vec![mk_crate("c", vec![])], vec![]);
        let u = build_unified(base, head, None);
        assert_eq!(u.edges.len(), 1);
        assert_eq!(u.edges[0].side, Side::Base);
    }

    #[test]
    fn edge_kind_change_emits_distinct_sided_entries() {
        // Same endpoints but different EdgeKind on each side → two
        // separate edges, each tagged with its own snapshot.
        let e_base = mk_edge("c::A", "c::B", EdgeKind::Owns, ViaKind::StructField, "field f");
        let e_head =
            mk_edge("c::A", "c::B", EdgeKind::BorrowsImmut, ViaKind::StructField, "field f");
        let base = mk_facts_with_edges(vec![mk_crate("c", vec![])], vec![e_base]);
        let head = mk_facts_with_edges(vec![mk_crate("c", vec![])], vec![e_head]);
        let u = build_unified(base, head, None);
        assert_eq!(u.edges.len(), 2);
        let mut sides_by_kind: BTreeMap<String, Side> = BTreeMap::new();
        for e in &u.edges {
            sides_by_kind.insert(format!("{:?}", e.kind), e.side);
        }
        assert_eq!(sides_by_kind.get("Owns").copied(), Some(Side::Base));
        assert_eq!(sides_by_kind.get("BorrowsImmut").copied(), Some(Side::Head));
    }

    // ─── Split-on-change merge ──────────────────────────────────────

    fn mk_fn(name: &str, file: &str, start: u32, end: u32) -> FnFacts {
        FnFacts {
            name: name.to_string(),
            impl_trait: None,
            visibility: "pub".into(),
            self_kind: SelfKind::None,
            is_unsafe: false,
            is_const: false,
            is_async: false,
            lifetime_params: vec![],
            params: vec![],
            return_ty_text: "()".into(),
            return_ownership: Ownership::Primitive,
            return_referenced: vec![],
            return_cardinality: vec![],
            lifetime_flows_through: false,
            unsafe_blocks: 0,
            doc_first_line: None,
            span: Some(Span {
                file: file.into(),
                start_line: start,
                end_line: end,
            }),
            prev_span: None,
            change_kind: None,
            side: Side::Head,
        }
    }

    fn mk_module_with_fns(path: &str, file: &str, fns: Vec<FnFacts>) -> ModuleFacts {
        ModuleFacts {
            path: path.into(),
            file: file.into(),
            types: vec![],
            functions: fns,
            re_exports: vec![],
            unsafe_blocks: 0,
            side: Side::Head,
        }
    }

    // Build a hunks bundle directly without invoking git — keeps the
    // tests pure. Pretend both workspaces are rooted at "/h" and "/b";
    // span.file is the absolute path the extractor would have recorded.
    fn mk_hunks(
        head_ranges: &[(&str, &[(u32, u32)])],
        base_ranges: &[(&str, &[(u32, u32)])],
    ) -> Hunks {
        let mut head_map: HashMap<String, Vec<(u32, u32)>> = HashMap::new();
        for (rel, ranges) in head_ranges {
            head_map.insert((*rel).into(), ranges.to_vec());
        }
        let mut base_map: HashMap<String, Vec<(u32, u32)>> = HashMap::new();
        for (rel, ranges) in base_ranges {
            base_map.insert((*rel).into(), ranges.to_vec());
        }
        Hunks {
            head_workspace_root: PathBuf::from("/h"),
            base_workspace_root: PathBuf::from("/b"),
            hunks_by_file_head: head_map,
            hunks_by_file_base: base_map,
        }
    }

    #[test]
    fn unchanged_fn_with_same_name_collapses_to_both() {
        // Same function, identical span, no overlapping hunk → Both.
        // Test path uses `/h` and `/b` workspace roots so the strip
        // logic in body_changed picks the right rel path.
        let bf = mk_fn("foo", "/b/m.rs", 10, 20);
        let hf = mk_fn("foo", "/h/m.rs", 10, 20);
        let m_base = mk_module_with_fns("m", "/b/m.rs", vec![bf]);
        let m_head = mk_module_with_fns("m", "/h/m.rs", vec![hf]);
        let base = mk_facts(vec![mk_crate("c", vec![m_base])]);
        let head = mk_facts(vec![mk_crate("c", vec![m_head])]);
        let hunks = mk_hunks(&[], &[]);
        let u = build_unified(base, head, Some(&hunks));
        let fns = &u.crates.get("c").unwrap().modules.get("m").unwrap().functions;
        let foos: Vec<&FnFacts> = fns.iter().filter(|f| f.name == "foo").collect();
        assert_eq!(foos.len(), 1, "expected exactly one Both `foo`");
        assert_eq!(foos[0].side, Side::Both);
    }

    #[test]
    fn body_changed_fn_emits_modified_with_prev_span() {
        // foo's head span overlaps a head hunk AND base span overlaps
        // a base hunk → Mixed Modified record.
        let bf = mk_fn("foo", "/b/m.rs", 10, 18);
        let hf = mk_fn("foo", "/h/m.rs", 12, 22);
        let m_base = mk_module_with_fns("m", "/b/m.rs", vec![bf]);
        let m_head = mk_module_with_fns("m", "/h/m.rs", vec![hf]);
        let base = mk_facts(vec![mk_crate("c", vec![m_base])]);
        let head = mk_facts(vec![mk_crate("c", vec![m_head])]);
        let hunks = mk_hunks(&[("m.rs", &[(15, 16)])], &[("m.rs", &[(15, 16)])]);
        let u = build_unified(base, head, Some(&hunks));
        let fns = &u.crates.get("c").unwrap().modules.get("m").unwrap().functions;
        let foos: Vec<&FnFacts> = fns.iter().filter(|f| f.name == "foo").collect();
        assert_eq!(foos.len(), 1, "expected one Modified record");
        assert_eq!(foos[0].side, Side::Modified);
        assert_eq!(foos[0].change_kind, Some(ChangeKind::Mixed));
        assert_eq!(foos[0].span.as_ref().unwrap().start_line, 12);
        assert_eq!(foos[0].prev_span.as_ref().unwrap().start_line, 10);
    }

    #[test]
    fn pure_addition_inside_fn_body_emits_modified_add() {
        // A `+`-only hunk inside foo's head span (no base-side
        // deletion in foo's base span). `change_kind=Add` →
        // renderer paints a SOLID GREEN bar.
        let bf = mk_fn("foo", "/b/m.rs", 10, 20);
        let hf = mk_fn("foo", "/h/m.rs", 10, 22);
        let m_base = mk_module_with_fns("m", "/b/m.rs", vec![bf]);
        let m_head = mk_module_with_fns("m", "/h/m.rs", vec![hf]);
        let base = mk_facts(vec![mk_crate("c", vec![m_base])]);
        let head = mk_facts(vec![mk_crate("c", vec![m_head])]);
        let hunks = mk_hunks(&[("m.rs", &[(15, 16)])], &[]);
        let u = build_unified(base, head, Some(&hunks));
        let fns = &u.crates.get("c").unwrap().modules.get("m").unwrap().functions;
        let foos: Vec<&FnFacts> = fns.iter().filter(|f| f.name == "foo").collect();
        assert_eq!(foos.len(), 1);
        assert_eq!(foos[0].side, Side::Modified);
        assert_eq!(foos[0].change_kind, Some(ChangeKind::Add));
    }

    #[test]
    fn pure_deletion_inside_fn_body_emits_modified_del() {
        // A `−`-only hunk inside foo's base span. `change_kind=Del`
        // → renderer paints a SOLID RED bar.
        let bf = mk_fn("foo", "/b/m.rs", 10, 22);
        let hf = mk_fn("foo", "/h/m.rs", 10, 20);
        let m_base = mk_module_with_fns("m", "/b/m.rs", vec![bf]);
        let m_head = mk_module_with_fns("m", "/h/m.rs", vec![hf]);
        let base = mk_facts(vec![mk_crate("c", vec![m_base])]);
        let head = mk_facts(vec![mk_crate("c", vec![m_head])]);
        let hunks = mk_hunks(&[], &[("m.rs", &[(15, 16)])]);
        let u = build_unified(base, head, Some(&hunks));
        let fns = &u.crates.get("c").unwrap().modules.get("m").unwrap().functions;
        let foos: Vec<&FnFacts> = fns.iter().filter(|f| f.name == "foo").collect();
        assert_eq!(foos.len(), 1);
        assert_eq!(foos[0].side, Side::Modified);
        assert_eq!(foos[0].change_kind, Some(ChangeKind::Del));
    }

    #[test]
    fn hunks_none_disables_splitting() {
        // No hunks → every same-name match collapses to Both. This is
        // the path taken by single-snapshot tests and the fallback
        // when hunk collection fails at the server.
        let bf = mk_fn("foo", "/b/m.rs", 10, 18);
        let hf = mk_fn("foo", "/h/m.rs", 12, 22);
        let m_base = mk_module_with_fns("m", "/b/m.rs", vec![bf]);
        let m_head = mk_module_with_fns("m", "/h/m.rs", vec![hf]);
        let base = mk_facts(vec![mk_crate("c", vec![m_base])]);
        let head = mk_facts(vec![mk_crate("c", vec![m_head])]);
        let u = build_unified(base, head, None);
        let fns = &u.crates.get("c").unwrap().modules.get("m").unwrap().functions;
        let foos: Vec<&FnFacts> = fns.iter().filter(|f| f.name == "foo").collect();
        assert_eq!(foos.len(), 1);
        assert_eq!(foos[0].side, Side::Both);
    }

    #[test]
    fn orphan_head_method_with_unchanged_span_becomes_both() {
        // Repro for the AllocationHandle::new mistag. Setup: base has
        // ONE AllocationHandle (no methods — the non-memprof variant);
        // head has ONE AllocationHandle (with method `new` at span
        // 1308-1310). Without orphan promotion, head's `new` has no
        // base counterpart → tagged Head, even though lines 1308-1310
        // are unchanged in the file diff (no hunk overlaps them).
        // With the heuristic, the lines are recognised as unchanged
        // and the method is promoted to Both.
        let mut empty_base = mk_type("AllocationHandle", TypeKind::Struct);
        empty_base.span = Some(Span { file: "/b/lib.rs".into(), start_line: 436, end_line: 438 });
        let mut empty_head = mk_type("AllocationHandle", TypeKind::Struct);
        empty_head.span = Some(Span { file: "/h/lib.rs".into(), start_line: 436, end_line: 438 });

        let mut new_method = mk_fn("new", "/h/lib.rs", 1308, 1310);
        new_method.span = Some(Span { file: "/h/lib.rs".into(), start_line: 1308, end_line: 1310 });
        empty_head.methods = vec![new_method];

        let m_base = mk_module("m", vec![empty_base]);
        let m_head = mk_module("m", vec![empty_head]);
        let base = mk_facts(vec![mk_crate("c", vec![m_base])]);
        let head = mk_facts(vec![mk_crate("c", vec![m_head])]);
        // Hunks exist elsewhere in the file but NOT inside [1308,1310].
        let hunks = mk_hunks(&[("lib.rs", &[(53, 55)])], &[("lib.rs", &[(53, 55)])]);
        let u = build_unified(base, head, Some(&hunks));
        let t = u.crates.get("c").unwrap().modules.get("m").unwrap().types.iter()
            .find(|t| t.name == "AllocationHandle").unwrap();
        let new_m = t.methods.iter().find(|m| m.name == "new").expect("`new` missing");
        // Unchanged-line orphan → Both, NOT Head.
        assert_eq!(new_m.side, Side::Both);
    }

    #[test]
    fn orphan_head_method_inside_hunk_stays_head() {
        // Counterpart to the above: a head-orphan method whose span
        // DOES overlap a hunk is genuinely new in head → keep tagging
        // it Head, not Both. The heuristic only promotes orphans whose
        // lines are unchanged.
        let mut empty_base = mk_type("Foo", TypeKind::Struct);
        empty_base.span = Some(Span { file: "/b/lib.rs".into(), start_line: 10, end_line: 12 });
        let mut head_type = mk_type("Foo", TypeKind::Struct);
        head_type.span = Some(Span { file: "/h/lib.rs".into(), start_line: 10, end_line: 12 });
        let mut new_method = mk_fn("new_method", "/h/lib.rs", 100, 110);
        new_method.span = Some(Span { file: "/h/lib.rs".into(), start_line: 100, end_line: 110 });
        head_type.methods = vec![new_method];

        let m_base = mk_module("m", vec![empty_base]);
        let m_head = mk_module("m", vec![head_type]);
        let base = mk_facts(vec![mk_crate("c", vec![m_base])]);
        let head = mk_facts(vec![mk_crate("c", vec![m_head])]);
        // Hunk overlaps the method's head span.
        let hunks = mk_hunks(&[("lib.rs", &[(100, 110)])], &[]);
        let u = build_unified(base, head, Some(&hunks));
        let t = u.crates.get("c").unwrap().modules.get("m").unwrap().types.iter()
            .find(|t| t.name == "Foo").unwrap();
        let m = t.methods.iter().find(|m| m.name == "new_method").expect("missing");
        assert_eq!(m.side, Side::Head);
    }

    #[test]
    fn cfg_gated_duplicate_types_pair_by_position() {
        // Repro for the AllocationHandle / materialize mistag: the
        // cfg-blind extractor emits the same (name, kind) twice per
        // snapshot. Before the fix, BTreeMap.collect kept only the
        // last variant per side, so the dropped variant's methods
        // had no base counterpart and the merge tagged them Head-
        // only. With position pairing, base[0]↔head[0] and
        // base[1]↔head[1] each merge to Both (and split-on-change
        // fires per-pair when bodies differ).
        let mut t1_base = mk_type("AllocationHandle", TypeKind::Struct);
        t1_base.span = Some(Span {
            file: "/b/lib.rs".into(),
            start_line: 436,
            end_line: 438,
        });
        let mut t2_base = mk_type("AllocationHandle", TypeKind::Struct);
        t2_base.span = Some(Span {
            file: "/b/lib.rs".into(),
            start_line: 1241,
            end_line: 1247,
        });
        let mut t1_head = mk_type("AllocationHandle", TypeKind::Struct);
        t1_head.span = Some(Span {
            file: "/h/lib.rs".into(),
            start_line: 436,
            end_line: 438,
        });
        let mut t2_head = mk_type("AllocationHandle", TypeKind::Struct);
        t2_head.span = Some(Span {
            file: "/h/lib.rs".into(),
            start_line: 1241,
            end_line: 1247,
        });
        let m_base = mk_module("m", vec![t1_base, t2_base]);
        let m_head = mk_module("m", vec![t1_head, t2_head]);
        let base = mk_facts(vec![mk_crate("c", vec![m_base])]);
        let head = mk_facts(vec![mk_crate("c", vec![m_head])]);
        let u = build_unified(base, head, None);
        let m = u.crates.get("c").unwrap().modules.get("m").unwrap();
        let allocs: Vec<&TypeFacts> = m.types.iter().filter(|t| t.name == "AllocationHandle").collect();
        assert_eq!(allocs.len(), 2, "both variants must survive the merge");
        // Both pairs merged → both end up tagged Both (no hunks
        // supplied, so the bodies are considered identical).
        for t in &allocs {
            assert_eq!(t.side, Side::Both, "matched variants should be Both");
        }
        // Position pairing: head[0] (span starting 436) merged with
        // base[0] (span starting 436), and head[1] (span 1241) with
        // base[1] (span 1241). The merge takes head's span via the
        // `..h` spread in `merge_type`, so the output spans match
        // head's coordinates.
        let starts: Vec<u32> = allocs
            .iter()
            .filter_map(|t| t.span.as_ref().map(|s| s.start_line))
            .collect();
        assert!(starts.contains(&436));
        assert!(starts.contains(&1241));
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
        let u = build_unified(base, head, None);
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
