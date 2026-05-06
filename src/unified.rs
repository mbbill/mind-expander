//! Unified base view: module hierarchy + ownership in one analysis.
//!
//! For every type T in scope we compute the LCA of T's owners' modules,
//! compare to T's actual module, and classify the placement. In a perfect
//! project, every type is at its LCA (or within a small relaxation budget
//! of descendant levels). Anything else is drift.
//!
//! The default output is a *drift report* — only the actionable cases.
//! `--full` produces the complete outline grouped by module, with every
//! type's classification annotated.
//!
//! Scope filters: intra-crate edges only, `::tests::` modules excluded
//! from both sides of any edge.

use std::collections::{BTreeMap, BTreeSet};

use crate::model::{EdgeKind, ViaKind, WorkspaceFacts};

/// Configurable rules for what placement counts as "correct."
///
/// Designed to grow: when new policies emerge (e.g. allowing T to live
/// above LCA when widely borrowed, special-casing certain module roots),
/// add fields here rather than threading new parameters through.
#[derive(Debug, Clone)]
pub struct Policy {
    /// How many levels T may live below LCA before counting as drift.
    /// `0` = strict (T must be exactly at LCA).
    /// `1` = default (T tucked one folder deeper than LCA is OK).
    pub max_below_lca: u32,
    /// If true, enum-variant payloads count as ownership when computing LCA.
    /// Default false because sum-composition ≠ runtime containment, and
    /// wide error/result enums otherwise pull every payload type's LCA up
    /// to the crate root (a known artifact, not a real architectural fact).
    pub include_variants: bool,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            max_below_lca: 1,
            include_variants: false,
        }
    }
}

/// How a single type's placement relates to its owners' LCA.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Classification {
    /// Type has no owners under our edge-kind filter — exempt from the
    /// LCA rule. Lives wherever the designer chose.
    NoOwners,
    /// Actual module exactly equals LCA.
    AtLca,
    /// Actual module is a descendant of LCA, within `max_below_lca` levels.
    BelowLcaWithinBudget { levels: u32 },
    /// Actual module is a strict ancestor of LCA — T is shallower than its
    /// owners' LCA, exposing it more widely than needed.
    DriftAbove { levels: u32 },
    /// Actual module is a descendant of LCA but exceeds `max_below_lca`.
    DriftBelow { levels: u32 },
    /// Actual module shares no ancestor relation with LCA — T sits in an
    /// entirely different subtree from its owners' LCA.
    DriftSideways,
}

#[derive(Debug)]
struct Analysis {
    type_path: String,
    type_module: String,
    /// Distinct modules of T's owners, sorted for deterministic output.
    owner_modules: Vec<String>,
    /// LCA of `owner_modules`. None when `owner_modules` is empty.
    lca: Option<String>,
    classification: Classification,
}

impl Analysis {
    /// A single number representing how off the placement is. For below/above
    /// LCA, it's the depth difference; for sideways, the path distance via
    /// the common module ancestor. Returns 0 for non-drift classifications.
    fn severity(&self) -> u32 {
        match self.classification {
            Classification::DriftAbove { levels } | Classification::DriftBelow { levels } => levels,
            Classification::DriftSideways => match &self.lca {
                Some(lca) => sideways_distance(&self.type_module, lca),
                None => 0,
            },
            _ => 0,
        }
    }

    /// Common module ancestor path for a sideways drift. None for other
    /// classifications.
    fn sideways_common(&self) -> Option<String> {
        match self.classification {
            Classification::DriftSideways => self
                .lca
                .as_ref()
                .map(|lca| lca_of_two(&self.type_module, lca)),
            _ => None,
        }
    }
}

pub fn print(ws: &WorkspaceFacts, krate: Option<&str>, policy: &Policy, full: bool) {
    // 1. Scope: types in the selected crate(s), excluding `::tests::` modules.
    //    `scoped_types` preserves source-order; `scoped_paths` is for fast
    //    membership checks when filtering edges.
    let mut scoped_types: Vec<(String, String)> = Vec::new();
    let mut scoped_paths: BTreeSet<String> = BTreeSet::new();
    for cf in ws.crates.values() {
        if let Some(k) = krate {
            if cf.name != k {
                continue;
            }
        }
        for m in cf.modules.values() {
            let mod_full = if m.path.is_empty() {
                cf.name.clone()
            } else {
                format!("{}::{}", cf.name, m.path)
            };
            if is_tests_path(&mod_full) {
                continue;
            }
            for t in &m.types {
                scoped_paths.insert(t.full_path.clone());
                scoped_types.push((t.full_path.clone(), mod_full.clone()));
            }
        }
    }
    if scoped_types.is_empty() {
        println!("(no types in scope)");
        return;
    }

    // 2. Owners and outbound maps. For each scoped type T, `owners` collects
    //    the type paths that own T; `outbound` collects the type paths that
    //    T owns (used by the --full printer for per-type edge listings).
    let mut owners: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut outbound: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for e in &ws.edges {
        if e.kind != EdgeKind::Owns {
            continue;
        }
        let via_ok = matches!(e.via, ViaKind::StructField | ViaKind::UnionField)
            || (policy.include_variants && e.via == ViaKind::EnumVariantPayload);
        if !via_ok {
            continue;
        }
        if e.from == e.to {
            continue;
        }
        if !same_crate(&e.from, &e.to) {
            continue;
        }
        if !scoped_paths.contains(&e.from) || !scoped_paths.contains(&e.to) {
            continue;
        }
        let from_mod = module_of(&e.from);
        if is_tests_path(from_mod) {
            continue;
        }
        owners
            .entry(e.to.clone())
            .or_default()
            .insert(e.from.clone());
        outbound
            .entry(e.from.clone())
            .or_default()
            .insert(e.to.clone());
    }

    // 3. Per-type analysis.
    let mut analyses: Vec<Analysis> = Vec::with_capacity(scoped_types.len());
    for (type_path, type_module) in &scoped_types {
        let owner_set = owners.get(type_path);
        let owner_modules: Vec<String> = match owner_set {
            None => Vec::new(),
            Some(set) => {
                let mut mods: BTreeSet<String> = BTreeSet::new();
                for owner_path in set {
                    mods.insert(module_of(owner_path).to_string());
                }
                mods.into_iter().collect()
            }
        };
        if owner_modules.is_empty() {
            analyses.push(Analysis {
                type_path: type_path.clone(),
                type_module: type_module.clone(),
                owner_modules,
                lca: None,
                classification: Classification::NoOwners,
            });
            continue;
        }
        let lca = lca_of_modules(&owner_modules);
        let classification = classify(type_module, &lca, policy.max_below_lca);
        analyses.push(Analysis {
            type_path: type_path.clone(),
            type_module: type_module.clone(),
            owner_modules,
            lca: Some(lca),
            classification,
        });
    }

    if full {
        print_full(&analyses, &outbound, krate, policy);
    } else {
        print_drift(&analyses, krate, policy);
    }
}

// ── Classification ────────────────────────────────────────────────────────

fn classify(type_module: &str, lca: &str, max_below: u32) -> Classification {
    if type_module == lca {
        return Classification::AtLca;
    }
    if is_strict_descendant_of(type_module, lca) {
        let levels = depth_diff(type_module, lca);
        if levels <= max_below {
            Classification::BelowLcaWithinBudget { levels }
        } else {
            Classification::DriftBelow { levels }
        }
    } else if is_strict_descendant_of(lca, type_module) {
        let levels = depth_diff(lca, type_module);
        Classification::DriftAbove { levels }
    } else {
        Classification::DriftSideways
    }
}

// ── Output ────────────────────────────────────────────────────────────────

fn print_drift(analyses: &[Analysis], krate: Option<&str>, policy: &Policy) {
    let scope = krate
        .map(|k| format!("krate: {k}"))
        .unwrap_or_else(|| "whole workspace".into());
    println!(
        "drift report ({scope}; policy: max_below_lca={}{})",
        policy.max_below_lca,
        if policy.include_variants {
            "; counting enum variant payloads as ownership"
        } else {
            ""
        }
    );
    println!("filters: intra-crate edges only; ::tests:: modules excluded");
    println!();

    let total = analyses.len();
    let no_owners = count(analyses, |a| {
        matches!(a.classification, Classification::NoOwners)
    });
    let at_lca = count(analyses, |a| {
        matches!(a.classification, Classification::AtLca)
    });
    let within = count(analyses, |a| {
        matches!(
            a.classification,
            Classification::BelowLcaWithinBudget { .. }
        )
    });
    let drift_above = count(analyses, |a| {
        matches!(a.classification, Classification::DriftAbove { .. })
    });
    let drift_below = count(analyses, |a| {
        matches!(a.classification, Classification::DriftBelow { .. })
    });
    let drift_side = count(analyses, |a| {
        matches!(a.classification, Classification::DriftSideways)
    });
    let total_drift = drift_above + drift_below + drift_side;

    println!("summary:");
    println!("  total types in scope     : {total}");
    println!("  no owners (root/exempt)  : {no_owners}");
    println!("  at LCA                   : {at_lca}");
    println!("  below LCA within budget  : {within}");
    println!("  drift above LCA          : {drift_above}");
    println!("  drift below LCA          : {drift_below}");
    println!("  drift sideways           : {drift_side}");
    println!("  ── total drift           : {total_drift}");
    println!();

    if total_drift == 0 {
        println!("no drift detected.");
        return;
    }

    print_severity_distribution(analyses);
    println!();

    print_drift_section(
        analyses,
        "drift above LCA (T is shallower than its owners; visibility wider than needed)",
        |c| matches!(c, Classification::DriftAbove { .. }),
    );
    print_drift_section(
        analyses,
        "drift below LCA (T is buried beneath the relaxation budget)",
        |c| matches!(c, Classification::DriftBelow { .. }),
    );
    print_drift_section(
        analyses,
        "drift sideways (T sits in a different subtree from its owners)",
        |c| matches!(c, Classification::DriftSideways),
    );
}

fn print_drift_section<F: Fn(Classification) -> bool>(
    analyses: &[Analysis],
    header: &str,
    pred: F,
) {
    let mut drifts: Vec<&Analysis> = analyses.iter().filter(|a| pred(a.classification)).collect();
    if drifts.is_empty() {
        return;
    }
    // Worst first; ties broken by path for determinism.
    drifts.sort_by(|a, b| {
        b.severity()
            .cmp(&a.severity())
            .then_with(|| a.type_path.cmp(&b.type_path))
    });
    println!("== {header} ==");
    for a in drifts {
        let lca = a.lca.as_deref().unwrap_or("?");
        let severity_tag = match a.classification {
            Classification::DriftAbove { levels } => format!("[d={levels} above]"),
            Classification::DriftBelow { levels } => format!("[d={levels} below]"),
            Classification::DriftSideways => format!("[d={} sideways]", a.severity()),
            _ => String::new(),
        };
        println!("  {}   {severity_tag}", a.type_path);
        println!("    LCA of owners : {lca}");
        if let Some(common) = a.sideways_common() {
            // Show the divergence point so the reader can see exactly where
            // actual and LCA part ways.
            println!("    common ancestor: {common}");
        }
        println!("    owners ({}):", a.owner_modules.len());
        for m in &a.owner_modules {
            println!("      {m}");
        }
        println!();
    }
}

/// Print a small table showing the count of drift entries at each severity
/// value, separately for below-LCA depth and sideways distance. Lets the
/// reader see at a glance whether the codebase has a heavy tail.
fn print_severity_distribution(analyses: &[Analysis]) {
    let mut by_below: BTreeMap<u32, u32> = BTreeMap::new();
    let mut by_sideways: BTreeMap<u32, u32> = BTreeMap::new();
    for a in analyses {
        match a.classification {
            Classification::DriftBelow { levels } => {
                *by_below.entry(levels).or_insert(0) += 1;
            }
            Classification::DriftSideways => {
                *by_sideways.entry(a.severity()).or_insert(0) += 1;
            }
            _ => {}
        }
    }
    let all: BTreeSet<u32> = by_below.keys().chain(by_sideways.keys()).copied().collect();
    if all.is_empty() {
        return;
    }
    println!("severity distribution:");
    println!("  metric   below-lca   sideways");
    for sev in all {
        let bc = by_below.get(&sev).copied().unwrap_or(0);
        let sc = by_sideways.get(&sev).copied().unwrap_or(0);
        let bc_s = if bc == 0 {
            "-".to_string()
        } else {
            bc.to_string()
        };
        let sc_s = if sc == 0 {
            "-".to_string()
        } else {
            sc.to_string()
        };
        println!("  {sev:>6}   {bc_s:>9}   {sc_s:>8}");
    }
}

fn print_full(
    analyses: &[Analysis],
    outbound: &BTreeMap<String, BTreeSet<String>>,
    krate: Option<&str>,
    policy: &Policy,
) {
    let scope = krate
        .map(|k| format!("krate: {k}"))
        .unwrap_or_else(|| "whole workspace".into());
    println!(
        "unified base view ({scope}; policy: max_below_lca={}{})",
        policy.max_below_lca,
        if policy.include_variants {
            "; counting enum variant payloads as ownership"
        } else {
            ""
        }
    );
    println!();
    println!("legend:");
    println!("  per type:  [root] | ✓ | ✓ (+N within budget) | ⚠ above/below/sideways");
    println!("  per edge:  (here) | ↑ ancestor | ↓ descendant ⚠ | ↗ sibling/lateral ⚠");
    println!();

    // Group analyses by their containing module.
    let mut by_module: BTreeMap<String, Vec<&Analysis>> = BTreeMap::new();
    for a in analyses {
        by_module.entry(a.type_module.clone()).or_default().push(a);
    }
    // Stable order for types within a module: alphabetical by full path.
    for v in by_module.values_mut() {
        v.sort_by(|a, b| a.type_path.cmp(&b.type_path));
    }

    // Module paths sorted lexicographically — this gives a depth-first walk
    // because `a` < `a::*` < `aa` for any `a`, `aa` (since ':' = 0x3A is
    // less than any letter).
    let modules: Vec<&String> = by_module.keys().collect();
    if modules.is_empty() {
        return;
    }
    let depth_offset = modules
        .iter()
        .map(|m| m.matches("::").count())
        .min()
        .unwrap_or(0);

    for module in modules {
        let depth = module.matches("::").count() - depth_offset;
        let indent = "  ".repeat(depth);
        let leaf = module.rsplit("::").next().unwrap_or(module);
        println!("{indent}{leaf}/");

        let types = &by_module[module];
        for t in types {
            let short = t.type_path.rsplit("::").next().unwrap_or(&t.type_path);
            let tag = format_type_tag(t.classification);
            println!("{indent}  {short:<46} {tag}");
            if let Some(lca) = &t.lca {
                if !matches!(
                    t.classification,
                    Classification::AtLca | Classification::NoOwners
                ) {
                    println!("{indent}    LCA = {lca}");
                }
            }
            // Outbound owns-edges, with each edge's direction classified.
            if let Some(targets) = outbound.get(&t.type_path) {
                for target in targets {
                    let target_short = target.rsplit("::").next().unwrap_or(target);
                    let target_module = module_of(target);
                    let dir = format_direction(&t.type_module, target_module);
                    println!("{indent}      owns {target_short:<40} {dir}");
                }
            }
        }
    }
}

fn format_type_tag(c: Classification) -> String {
    match c {
        Classification::NoOwners => "[root]".to_string(),
        Classification::AtLca => "✓".to_string(),
        Classification::BelowLcaWithinBudget { levels } => format!("✓ (+{levels})"),
        Classification::DriftAbove { levels } => format!("⚠ {levels} above LCA"),
        Classification::DriftBelow { levels } => format!("⚠ {levels} below LCA"),
        Classification::DriftSideways => "⚠ sideways".to_string(),
    }
}

/// Classify one outbound ownership edge by the relation of the target's
/// module to the source's module.
fn format_direction(source_module: &str, target_module: &str) -> String {
    if source_module == target_module {
        "(here)".to_string()
    } else if is_strict_descendant_of(source_module, target_module) {
        // source is below target → target is an ancestor of source.
        format!("↑ {target_module}")
    } else if is_strict_descendant_of(target_module, source_module) {
        // source is an ancestor of target → edge points downward.
        format!("↓ {target_module}  ⚠ downward")
    } else {
        // Neither is an ancestor of the other.
        format!("↗ {target_module}  ⚠ sibling/lateral")
    }
}

// ── Path utilities ────────────────────────────────────────────────────────

fn module_of(full_path: &str) -> &str {
    match full_path.rfind("::") {
        Some(i) => &full_path[..i],
        None => full_path,
    }
}

fn crate_of(full_path: &str) -> &str {
    full_path.split("::").next().unwrap_or("")
}

fn same_crate(a: &str, b: &str) -> bool {
    crate_of(a) == crate_of(b)
}

fn is_tests_path(path: &str) -> bool {
    path.split("::").any(|seg| seg == "tests")
}

/// True iff `descendant` is a strict descendant of `ancestor` in the module
/// tree — i.e. `ancestor` is a proper prefix of `descendant` along `::`
/// boundaries. Equal paths return `false` (use `==` for that case).
fn is_strict_descendant_of(descendant: &str, ancestor: &str) -> bool {
    if descendant.len() <= ancestor.len() {
        return false;
    }
    if !descendant.starts_with(ancestor) {
        return false;
    }
    descendant[ancestor.len()..].starts_with("::")
}

/// Levels between `descendant` and its `ancestor`. Caller must ensure
/// `is_strict_descendant_of(descendant, ancestor)`.
fn depth_diff(descendant: &str, ancestor: &str) -> u32 {
    let tail = &descendant[ancestor.len() + 2..];
    (tail.matches("::").count() as u32) + 1
}

/// Number of `::`-separated segments in a module path. Empty path = 0.
fn seg_count(path: &str) -> u32 {
    if path.is_empty() {
        0
    } else {
        path.matches("::").count() as u32 + 1
    }
}

/// Common module-ancestor path of two module paths. Empty if no shared
/// segment exists at all (which never happens for paths within a single
/// crate, since they share the crate name).
fn lca_of_two(a: &str, b: &str) -> String {
    let a_segs: Vec<&str> = a.split("::").collect();
    let b_segs: Vec<&str> = b.split("::").collect();
    let mut common = 0;
    while common < a_segs.len() && common < b_segs.len() && a_segs[common] == b_segs[common] {
        common += 1;
    }
    a_segs[..common].join("::")
}

/// Path distance between two modules via their common ancestor — the
/// number of module-tree edges you'd walk to go from `a` to `b` through
/// the closest shared parent.
fn sideways_distance(a: &str, b: &str) -> u32 {
    let common = lca_of_two(a, b);
    let c = seg_count(&common);
    let da = seg_count(a);
    let db = seg_count(b);
    (da - c) + (db - c)
}

/// LCA module path over a set of module paths.
fn lca_of_modules(modules: &[String]) -> String {
    if modules.is_empty() {
        return String::new();
    }
    let segs: Vec<Vec<&str>> = modules.iter().map(|m| m.split("::").collect()).collect();
    let mut common: usize = segs[0].len();
    for s in &segs[1..] {
        let mut k = 0;
        while k < common && k < s.len() && segs[0][k] == s[k] {
            k += 1;
        }
        common = k;
        if common == 0 {
            break;
        }
    }
    segs[0][..common].join("::")
}

fn count<P: Fn(&Analysis) -> bool>(analyses: &[Analysis], p: P) -> usize {
    analyses.iter().filter(|a| p(a)).count()
}
