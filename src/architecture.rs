//! Module-level architecture printer.
//!
//! Projects the global type-edge graph onto modules: each edge `from → to`
//! contributes to a module pair `(module_of(from), module_of(to))`. Per
//! module we print size, outbound module-dependencies, inbound dependents,
//! and intra-module edge count. Strongly-connected components (cycles) are
//! detected via Tarjan's algorithm and listed at the end.
//!
//! All counts are facts directly derived from `WorkspaceFacts.edges`. No
//! labels, no rollup. Tests modules and inter-crate edges are excluded by
//! default — both are known to inflate signal-to-noise without telling the
//! reader anything new about the architecture.

use std::collections::{BTreeMap, BTreeSet};

use crate::model::WorkspaceFacts;

#[derive(Default)]
struct ModuleEdgeData {
    count: u32,
    by_kind: BTreeMap<String, u32>,
}

#[derive(Default)]
struct ModuleData {
    types: u32,
    fns: u32,
    intra_edges: u32,
}

pub fn print(ws: &WorkspaceFacts, krate: Option<&str>) {
    // Modules in scope: every module that exists in the source tree of
    // matching crates and isn't a tests module.
    let mut module_data: BTreeMap<String, ModuleData> = BTreeMap::new();
    let mut crate_of_module: BTreeMap<String, String> = BTreeMap::new();
    for cf in ws.crates.values() {
        if let Some(k) = krate {
            if cf.name != k {
                continue;
            }
        }
        for m in cf.modules.values() {
            let full = if m.path.is_empty() {
                cf.name.clone()
            } else {
                format!("{}::{}", cf.name, m.path)
            };
            if is_tests_path(&full) {
                continue;
            }
            let entry = module_data.entry(full.clone()).or_default();
            entry.types += m.types.len() as u32;
            entry.fns += m.functions.len() as u32;
            crate_of_module.insert(full, cf.name.clone());
        }
    }
    if module_data.is_empty() {
        println!("(no modules in scope)");
        return;
    }

    // Pair edges between modules. Filter: same crate, neither end in tests.
    let mut pairs: BTreeMap<(String, String), ModuleEdgeData> = BTreeMap::new();
    for e in &ws.edges {
        if !same_crate(&e.from, &e.to) {
            continue;
        }
        let from_mod = module_of(&e.from);
        let to_mod = module_of(&e.to);
        if is_tests_path(from_mod) || is_tests_path(to_mod) {
            continue;
        }
        // Per `--krate` filter: keep only edges whose modules are in scope.
        if !module_data.contains_key(from_mod) || !module_data.contains_key(to_mod) {
            continue;
        }
        if from_mod == to_mod {
            module_data.get_mut(from_mod).unwrap().intra_edges += 1;
            continue;
        }
        let entry = pairs
            .entry((from_mod.to_string(), to_mod.to_string()))
            .or_default();
        entry.count += 1;
        *entry.by_kind.entry(format!("{:?}", e.kind)).or_insert(0) += 1;
    }

    // Build adjacency for SCC.
    let mut adj: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (from, to) in pairs.keys() {
        adj.entry(from.clone()).or_default().push(to.clone());
    }

    // Header.
    let scope = match krate {
        Some(k) => format!("krate: {k}"),
        None => "whole workspace".to_string(),
    };
    println!("module architecture ({scope})");
    println!(
        "filters: tests modules excluded; inter-crate edges excluded; intra-module edges aggregated"
    );
    println!();

    // Per-module sections, alphabetical.
    for (mod_path, data) in &module_data {
        // Outbound: pairs where this module is the source.
        let mut out_rows: Vec<(&str, &ModuleEdgeData)> = pairs
            .iter()
            .filter_map(|((f, t), d)| {
                if f == mod_path {
                    Some((t.as_str(), d))
                } else {
                    None
                }
            })
            .collect();
        // Inbound: pairs where this module is the target.
        let mut in_rows: Vec<(&str, &ModuleEdgeData)> = pairs
            .iter()
            .filter_map(|((f, t), d)| {
                if t == mod_path {
                    Some((f.as_str(), d))
                } else {
                    None
                }
            })
            .collect();
        out_rows.sort_by(|a, b| b.1.count.cmp(&a.1.count).then_with(|| a.0.cmp(b.0)));
        in_rows.sort_by(|a, b| b.1.count.cmp(&a.1.count).then_with(|| a.0.cmp(b.0)));

        println!("=== {mod_path} ===");
        println!(
            "   types: {}   fns: {}   intra-module edges: {}",
            data.types, data.fns, data.intra_edges
        );
        if out_rows.is_empty() {
            println!("   imports → (none)");
        } else {
            println!("   imports →");
            for (target, d) in &out_rows {
                let breakdown = format_kind_breakdown(&d.by_kind);
                println!("     {:<60} {:>5}{}", target, d.count, breakdown);
            }
        }
        if in_rows.is_empty() {
            println!("   imported by ← (none)");
        } else {
            println!("   imported by ←");
            for (source, d) in &in_rows {
                let breakdown = format_kind_breakdown(&d.by_kind);
                println!("     {:<60} {:>5}{}", source, d.count, breakdown);
            }
        }
        println!();
    }

    // SCC.
    let modules: Vec<String> = module_data.keys().cloned().collect();
    let sccs = tarjan_scc(&modules, &adj);
    let cycles: Vec<&Vec<String>> = sccs.iter().filter(|c| c.len() > 1).collect();
    println!("=== cycles ===");
    if cycles.is_empty() {
        println!("   none.");
    } else {
        for (i, cycle) in cycles.iter().enumerate() {
            println!("   cycle {} ({} modules):", i + 1, cycle.len());
            for m in *cycle {
                println!("     {m}");
            }
            // List the edges that constitute the cycle within this SCC.
            let scc_set: BTreeSet<&str> = cycle.iter().map(String::as_str).collect();
            let mut scc_edges: Vec<((&str, &str), u32)> = pairs
                .iter()
                .filter_map(|((f, t), d)| {
                    if scc_set.contains(f.as_str()) && scc_set.contains(t.as_str()) {
                        Some(((f.as_str(), t.as_str()), d.count))
                    } else {
                        None
                    }
                })
                .collect();
            scc_edges.sort();
            println!("     edges within this cycle:");
            for ((f, t), c) in scc_edges {
                println!("       {f}  →  {t}    ({c})");
            }
            println!();
        }
    }
}

fn module_of(path: &str) -> &str {
    match path.rfind("::") {
        Some(i) => &path[..i],
        None => path,
    }
}

fn crate_of(path: &str) -> &str {
    path.split("::").next().unwrap_or("")
}

fn same_crate(a: &str, b: &str) -> bool {
    crate_of(a) == crate_of(b)
}

fn is_tests_path(path: &str) -> bool {
    path.split("::").any(|seg| seg == "tests")
}

fn format_kind_breakdown(map: &BTreeMap<String, u32>) -> String {
    if map.is_empty() {
        return String::new();
    }
    let mut rows: Vec<(&String, &u32)> = map.iter().collect();
    rows.sort_by(|a, b| b.1.cmp(a.1).then_with(|| a.0.cmp(b.0)));
    let parts: Vec<String> = rows.iter().map(|(k, v)| format!("{k} {v}")).collect();
    format!("  ({})", parts.join(", "))
}

// ── Tarjan's SCC ──────────────────────────────────────────────────────────

fn tarjan_scc(nodes: &[String], adj: &BTreeMap<String, Vec<String>>) -> Vec<Vec<String>> {
    let mut state = TarjanState {
        index: 0,
        stack: Vec::new(),
        on_stack: BTreeSet::new(),
        indices: BTreeMap::new(),
        lowlinks: BTreeMap::new(),
        sccs: Vec::new(),
    };
    for n in nodes {
        if !state.indices.contains_key(n) {
            tarjan_visit(n, adj, &mut state);
        }
    }
    state.sccs
}

struct TarjanState {
    index: u32,
    stack: Vec<String>,
    on_stack: BTreeSet<String>,
    indices: BTreeMap<String, u32>,
    lowlinks: BTreeMap<String, u32>,
    sccs: Vec<Vec<String>>,
}

fn tarjan_visit(v: &str, adj: &BTreeMap<String, Vec<String>>, s: &mut TarjanState) {
    s.indices.insert(v.to_string(), s.index);
    s.lowlinks.insert(v.to_string(), s.index);
    s.index += 1;
    s.stack.push(v.to_string());
    s.on_stack.insert(v.to_string());

    if let Some(neighbors) = adj.get(v) {
        for w in neighbors {
            if !s.indices.contains_key(w) {
                tarjan_visit(w, adj, s);
                let w_low = *s.lowlinks.get(w).unwrap();
                let v_low = *s.lowlinks.get(v).unwrap();
                s.lowlinks.insert(v.to_string(), v_low.min(w_low));
            } else if s.on_stack.contains(w) {
                let w_idx = *s.indices.get(w).unwrap();
                let v_low = *s.lowlinks.get(v).unwrap();
                s.lowlinks.insert(v.to_string(), v_low.min(w_idx));
            }
        }
    }

    let v_low = *s.lowlinks.get(v).unwrap();
    let v_idx = *s.indices.get(v).unwrap();
    if v_low == v_idx {
        let mut scc = Vec::new();
        loop {
            let w = s.stack.pop().expect("stack invariant");
            s.on_stack.remove(&w);
            let done = w == v;
            scc.push(w);
            if done {
                break;
            }
        }
        scc.sort();
        s.sccs.push(scc);
    }
}
