//! Compact label-free survey: counters, module table, type lines, rankings,
//! isolated types, lifetime-declaring types, unsafe locations, trait-impls.
//!
//! No interpretation. Every line is a count, a name, a derived attribute, or
//! a tabular cell. Designed to fit a few screens of console output for fast
//! orientation.

use std::collections::BTreeMap;

use std::collections::BTreeSet;

use crate::model::{
    Edge, EdgeProfile, FieldFacts, FnFacts, ModuleFacts, Ownership, SelfKind, TypeFacts, TypeKind,
    WorkspaceFacts,
};

pub fn survey(ws: &WorkspaceFacts, krate: Option<&str>, top: usize, show_types: bool) {
    let crates: Vec<&crate::model::CrateFacts> = ws
        .crates
        .values()
        .filter(|c| krate.map(|k| c.name == k).unwrap_or(true))
        .collect();
    if crates.is_empty() {
        println!("(no crates matched filter)");
        return;
    }

    let mut all_types: Vec<&TypeFacts> = Vec::new();
    let mut all_fns: Vec<(String, &FnFacts)> = Vec::new(); // (full-path, fn)
    let mut module_lines: Vec<ModuleLine> = Vec::new();
    let mut surviving_paths: BTreeSet<String> = BTreeSet::new();

    for cf in &crates {
        for m in cf.modules.values() {
            for t in &m.types {
                all_types.push(t);
                surviving_paths.insert(t.full_path.clone());
            }
            for f in &m.functions {
                let mp = if m.path.is_empty() {
                    cf.name.clone()
                } else {
                    format!("{}::{}", cf.name, m.path)
                };
                let fp = format!("{mp}::{}", f.name);
                surviving_paths.insert(fp.clone());
                all_fns.push((fp, f));
            }
            module_lines.push(module_line(cf.name.as_str(), m));
        }
    }
    module_lines.sort_by(|a, b| a.path.cmp(&b.path));

    // Filter edges to only those originating from surviving items so the
    // counters reflect the same scope as the rest of the survey.
    let scoped_edges: Vec<&Edge> = ws
        .edges
        .iter()
        .filter(|e| surviving_paths.contains(&e.from))
        .collect();

    print_header(&crates);
    print_global_counters(&all_types, &all_fns, &scoped_edges);
    println!();
    print_module_table(&module_lines);
    println!();
    if show_types {
        print_type_table(&all_types, &ws.edge_profiles);
        println!();
    }
    print_inbound_ranking(&all_types, &ws.edge_profiles, top);
    println!();
    print_outbound_ranking(&all_types, &ws.edge_profiles, top);
    println!();
    print_isolated_types(&all_types, &ws.edge_profiles);
    println!();
    print_lifetime_section(&all_types, &all_fns);
    println!();
    print_unsafe_section(&all_types, &all_fns);
    println!();
    print_trait_impls(&all_types);
    println!();
    print_visibility_distribution(&all_types);
}

struct ModuleLine {
    path: String,
    file: String,
    types: u32,
    structs: u32,
    enums: u32,
    traits: u32,
    unions: u32,
    aliases: u32,
    fns: u32,
    is_tests: bool,
    type_unsafe_blocks: u32,
    types_with_lt: u32,
}

fn module_line(crate_name: &str, m: &ModuleFacts) -> ModuleLine {
    let mut structs = 0;
    let mut enums = 0;
    let mut traits = 0;
    let mut unions = 0;
    let mut aliases = 0;
    let mut type_unsafe = 0;
    let mut with_lt = 0;
    for t in &m.types {
        match t.kind {
            TypeKind::Struct => structs += 1,
            TypeKind::Enum => enums += 1,
            TypeKind::Trait => traits += 1,
            TypeKind::Union => unions += 1,
            TypeKind::TypeAlias => aliases += 1,
        }
        type_unsafe += t.unsafe_blocks;
        if !t.lifetime_params.is_empty() {
            with_lt += 1;
        }
    }
    let path = if m.path.is_empty() {
        crate_name.to_string()
    } else {
        format!("{crate_name}::{}", m.path)
    };
    ModuleLine {
        is_tests: m.path.split("::").any(|seg| seg == "tests"),
        path,
        file: m.file.clone(),
        types: m.types.len() as u32,
        structs,
        enums,
        traits,
        unions,
        aliases,
        fns: m.functions.len() as u32,
        type_unsafe_blocks: type_unsafe + m.unsafe_blocks,
        types_with_lt: with_lt,
    }
}

fn print_header(crates: &[&crate::model::CrateFacts]) {
    println!("== mind-expander survey");
    print!("crates: {} [", crates.len());
    let names: Vec<&str> = crates.iter().map(|c| c.name.as_str()).collect();
    print!("{}", names.join(", "));
    println!("]");
}

fn print_global_counters(types: &[&TypeFacts], fns: &[(String, &FnFacts)], edges: &[&Edge]) {
    let mut k_struct = 0;
    let mut k_enum = 0;
    let mut k_trait = 0;
    let mut k_union = 0;
    let mut k_alias = 0;
    let mut types_with_lt = 0;
    let mut total_unsafe_blocks = 0u32;
    let mut field_total = 0;
    let mut field_owned = 0;
    let mut field_b_immut = 0;
    let mut field_b_mut = 0;
    let mut field_indir = 0;
    let mut field_prim = 0;
    let mut field_other = 0;
    let mut method_total = 0;
    let mut m_none = 0;
    let mut m_byval = 0;
    let mut m_ref = 0;
    let mut m_refmut = 0;
    let mut m_unsafe_fn = 0;
    let mut m_lt_flow = 0;
    for t in types {
        match t.kind {
            TypeKind::Struct => k_struct += 1,
            TypeKind::Enum => k_enum += 1,
            TypeKind::Trait => k_trait += 1,
            TypeKind::Union => k_union += 1,
            TypeKind::TypeAlias => k_alias += 1,
        }
        if !t.lifetime_params.is_empty() {
            types_with_lt += 1;
        }
        total_unsafe_blocks += t.unsafe_blocks;
        for f in &t.fields {
            field_total += 1;
            match f.ownership {
                Ownership::Owned => field_owned += 1,
                Ownership::BorrowImmut => field_b_immut += 1,
                Ownership::BorrowMut => field_b_mut += 1,
                Ownership::Indirection => field_indir += 1,
                Ownership::Primitive => field_prim += 1,
                Ownership::Other => field_other += 1,
            }
        }
        for m in &t.methods {
            method_total += 1;
            match m.self_kind {
                SelfKind::None => m_none += 1,
                SelfKind::ByValue => m_byval += 1,
                SelfKind::Ref => m_ref += 1,
                SelfKind::RefMut => m_refmut += 1,
            }
            if m.is_unsafe {
                m_unsafe_fn += 1;
            }
            if m.lifetime_flows_through {
                m_lt_flow += 1;
            }
            total_unsafe_blocks += m.unsafe_blocks;
        }
    }

    let mut fns_with_lt = 0;
    let mut fns_unsafe = 0;
    let mut fn_unsafe_blocks = 0u32;
    for (_, f) in fns {
        if f.lifetime_flows_through {
            fns_with_lt += 1;
        }
        if f.is_unsafe {
            fns_unsafe += 1;
        }
        fn_unsafe_blocks += f.unsafe_blocks;
        if f.is_unsafe {
            // counted above
        }
    }
    total_unsafe_blocks += fn_unsafe_blocks;

    let mut edges_by_kind: BTreeMap<String, u32> = BTreeMap::new();
    let mut edges_by_via: BTreeMap<String, u32> = BTreeMap::new();
    for e in edges {
        *edges_by_kind.entry(format!("{:?}", e.kind)).or_insert(0) += 1;
        *edges_by_via.entry(format!("{:?}", e.via)).or_insert(0) += 1;
    }

    println!(
        "totals: types={} fns_free={} type_methods={} edges={}",
        types.len(),
        fns.len(),
        method_total,
        edges.len()
    );
    println!(
        "type kinds: struct={} enum={} trait={} union={} alias={} | with-lifetime-params={}",
        k_struct, k_enum, k_trait, k_union, k_alias, types_with_lt
    );
    println!(
        "fields: total={} owned={} b_immut={} b_mut={} indirection={} primitive={} other={}",
        field_total, field_owned, field_b_immut, field_b_mut, field_indir, field_prim, field_other
    );
    println!(
        "methods: total={} none={} by_value={} &self={} &mut_self={} unsafe_fn={} lifetime_flow={}",
        method_total, m_none, m_byval, m_ref, m_refmut, m_unsafe_fn, m_lt_flow
    );
    println!(
        "free fns: total={} unsafe_fn={} unsafe_blocks={} lifetime_flow={}",
        fns.len(),
        fns_unsafe,
        fn_unsafe_blocks,
        fns_with_lt
    );
    println!("unsafe blocks total (types+fns): {}", total_unsafe_blocks);
    print!("edges by kind:");
    for (k, v) in &edges_by_kind {
        print!(" {k}={v}");
    }
    println!();
    print!("edges by via :");
    for (k, v) in &edges_by_via {
        print!(" {k}={v}");
    }
    println!();
}

fn print_module_table(lines: &[ModuleLine]) {
    println!("modules:");
    println!(
        "  {:<55} {:>4} {:>5} {:>4} {:>4} {:>4} {:>4} {:>5} {:>3} {:>5}",
        "path", "T", "S/E/T/U/A", "F", "U", "L", "tst", "file", "", ""
    );
    println!(
        "  {:<55} {:>4} {:>5} {:>4} {:>4} {:>4} {:>4}",
        "----", "-", "---------", "-", "-", "-", "---"
    );
    for m in lines {
        let kinds = format!(
            "{}/{}/{}/{}/{}",
            m.structs, m.enums, m.traits, m.unions, m.aliases
        );
        println!(
            "  {:<55} {:>4} {:>9} {:>4} {:>4} {:>4} {:>4}  {}",
            truncate(&m.path, 55),
            m.types,
            kinds,
            m.fns,
            m.type_unsafe_blocks,
            m.types_with_lt,
            if m.is_tests { "Y" } else { "-" },
            short_file(&m.file),
        );
    }
    println!("  legend: T=types  S/E/T/U/A=struct/enum/trait/union/alias  F=fns  U=unsafe blocks  L=types-with-lifetime  tst=tests-module");
}

fn print_type_table(types: &[&TypeFacts], profiles: &BTreeMap<String, EdgeProfile>) {
    let mut sorted: Vec<&&TypeFacts> = types.iter().collect();
    sorted.sort_by(|a, b| a.full_path.cmp(&b.full_path));
    println!("types ({} total):", types.len());
    println!(
        "  {:<6} {:<70} {:<3} {:<24} {:<22} {:<22} {:>5} {:>5} {}",
        "kind",
        "full_path",
        "lt",
        "derives",
        "fields O/Bi/Bm/I/P",
        "methods N/V/&/&m/u",
        "in",
        "out",
        "vis"
    );
    println!(
        "  {:<6} {:<70} {:<3} {:<24} {:<22} {:<22} {:>5} {:>5} {}",
        "------",
        "----",
        "--",
        "------",
        "-----------------",
        "-------------------",
        "--",
        "---",
        "---"
    );
    for t in sorted {
        let kind = match t.kind {
            TypeKind::Struct => "struct",
            TypeKind::Enum => "enum",
            TypeKind::Trait => "trait",
            TypeKind::Union => "union",
            TypeKind::TypeAlias => "alias",
        };
        let lt = t.lifetime_params.len();
        let derives = if t.derives.is_empty() {
            "-".to_string()
        } else {
            t.derives.join(",")
        };
        let fp = field_counts(&t.fields);
        let fields_s = format!(
            "{}/{}/{}/{}/{}",
            fp.owned, fp.b_immut, fp.b_mut, fp.indir, fp.prim
        );
        let mp = method_counts(&t.methods);
        let methods_s = format!(
            "{}/{}/{}/{}/{}",
            mp.none, mp.byval, mp.r, mp.rm, mp.unsafe_fn
        );
        let prof = profiles.get(&t.full_path);
        let inbound = prof.map(|p| p.inbound.values().sum::<u32>()).unwrap_or(0);
        let outbound = prof.map(|p| p.outbound.values().sum::<u32>()).unwrap_or(0);
        println!(
            "  {:<6} {:<70} {:<3} {:<24} {:<22} {:<22} {:>5} {:>5} {}",
            kind,
            truncate(&t.full_path, 70),
            lt,
            truncate(&derives, 24),
            fields_s,
            methods_s,
            inbound,
            outbound,
            t.visibility,
        );
    }
}

fn print_inbound_ranking(
    types: &[&TypeFacts],
    profiles: &BTreeMap<String, EdgeProfile>,
    top: usize,
) {
    let mut rows: Vec<(&TypeFacts, u32, u32, &EdgeProfile)> = Vec::new();
    for t in types {
        if let Some(p) = profiles.get(&t.full_path) {
            let total: u32 = p.inbound.values().sum();
            rows.push((t, total, p.inbound_distinct_sources, p));
        }
    }
    rows.sort_by(|a, b| b.1.cmp(&a.1).then(b.2.cmp(&a.2)));
    println!(
        "inbound top {} (sorted by total inbound, then distinct sources):",
        top.min(rows.len())
    );
    for (t, total, srcs, p) in rows.iter().take(top) {
        let by_kind: Vec<String> = p.inbound.iter().map(|(k, v)| format!("{k}={v}")).collect();
        let by_via: Vec<String> = p
            .inbound_via
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect();
        println!(
            "  {:>5} in · {:>4} sources   {}",
            total,
            srcs,
            truncate(&t.full_path, 70),
        );
        println!("        kind: {}", by_kind.join(", "));
        println!("        via : {}", by_via.join(", "));
    }
}

fn print_outbound_ranking(
    types: &[&TypeFacts],
    profiles: &BTreeMap<String, EdgeProfile>,
    top: usize,
) {
    let mut rows: Vec<(&TypeFacts, u32, u32, &EdgeProfile)> = Vec::new();
    for t in types {
        if let Some(p) = profiles.get(&t.full_path) {
            let total: u32 = p.outbound.values().sum();
            rows.push((t, total, p.outbound_distinct_targets, p));
        }
    }
    rows.sort_by(|a, b| b.1.cmp(&a.1).then(b.2.cmp(&a.2)));
    println!(
        "outbound top {} (sorted by total outbound, then distinct targets):",
        top.min(rows.len())
    );
    for (t, total, tgts, p) in rows.iter().take(top) {
        let by_kind: Vec<String> = p.outbound.iter().map(|(k, v)| format!("{k}={v}")).collect();
        let by_via: Vec<String> = p
            .outbound_via
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect();
        println!(
            "  {:>5} out · {:>4} targets   {}",
            total,
            tgts,
            truncate(&t.full_path, 70),
        );
        println!("        kind: {}", by_kind.join(", "));
        println!("        via : {}", by_via.join(", "));
    }
}

fn print_isolated_types(types: &[&TypeFacts], profiles: &BTreeMap<String, EdgeProfile>) {
    let mut rows: Vec<&&TypeFacts> = types
        .iter()
        .filter(|t| {
            let inbound: u32 = profiles
                .get(&t.full_path)
                .map(|p| p.inbound.values().sum())
                .unwrap_or(0);
            inbound == 0
        })
        .collect();
    rows.sort_by(|a, b| a.full_path.cmp(&b.full_path));
    println!("zero-inbound types ({} total):", rows.len());
    for t in rows {
        let kind = match t.kind {
            TypeKind::Struct => "struct",
            TypeKind::Enum => "enum",
            TypeKind::Trait => "trait",
            TypeKind::Union => "union",
            TypeKind::TypeAlias => "alias",
        };
        let outbound: u32 = profiles
            .get(&t.full_path)
            .map(|p| p.outbound.values().sum())
            .unwrap_or(0);
        println!(
            "  {:<6} {:<70} out={} vis={}",
            kind,
            truncate(&t.full_path, 70),
            outbound,
            t.visibility
        );
    }
}

fn print_lifetime_section(types: &[&TypeFacts], fns: &[(String, &FnFacts)]) {
    let mut t_rows: Vec<&&TypeFacts> = types
        .iter()
        .filter(|t| !t.lifetime_params.is_empty())
        .collect();
    t_rows.sort_by(|a, b| a.full_path.cmp(&b.full_path));
    println!("types declaring lifetimes ({} total):", t_rows.len());
    for t in t_rows {
        let lts: Vec<String> = t.lifetime_params.iter().map(|s| format!("'{s}")).collect();
        let mut grounded: Vec<String> = Vec::new();
        for f in &t.fields {
            if !f.lifetimes.is_empty() {
                let lts_s: Vec<String> = f.lifetimes.iter().map(|s| format!("'{s}")).collect();
                let to: Vec<String> = f.referenced.clone();
                grounded.push(format!("{}={}->{}", f.name, lts_s.join(","), to.join(",")));
            }
        }
        println!(
            "  {:<70} [{}]   fields_with_lt: {}",
            truncate(&t.full_path, 70),
            lts.join(","),
            if grounded.is_empty() {
                "-".to_string()
            } else {
                grounded.join("; ")
            }
        );
    }
    let lt_flow_fns: Vec<&(String, &FnFacts)> = fns
        .iter()
        .filter(|(_, f)| f.lifetime_flows_through)
        .collect();
    println!("free fns with lifetime_flow ({} total):", lt_flow_fns.len());
    for (path, f) in lt_flow_fns {
        println!(
            "  {:<70} -> {}",
            truncate(path, 70),
            truncate(&f.return_ty_text, 80)
        );
    }
}

fn print_unsafe_section(types: &[&TypeFacts], fns: &[(String, &FnFacts)]) {
    println!("unsafe locations:");
    let mut found = false;
    for t in types {
        if t.unsafe_blocks > 0 {
            found = true;
            println!(
                "  type {:<70} unsafe_blocks={}",
                truncate(&t.full_path, 70),
                t.unsafe_blocks
            );
        }
        for m in &t.methods {
            if m.is_unsafe || m.unsafe_blocks > 0 {
                found = true;
                println!(
                    "  method {:<60}::{}() unsafe_fn={} unsafe_blocks={}",
                    truncate(&t.full_path, 60),
                    m.name,
                    m.is_unsafe,
                    m.unsafe_blocks
                );
            }
        }
    }
    for (path, f) in fns {
        if f.is_unsafe || f.unsafe_blocks > 0 {
            found = true;
            println!(
                "  free   {:<70} unsafe_fn={} unsafe_blocks={}",
                truncate(path, 70),
                f.is_unsafe,
                f.unsafe_blocks
            );
        }
    }
    if !found {
        println!("  (none)");
    }
}

fn print_trait_impls(types: &[&TypeFacts]) {
    let mut by_trait: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for t in types {
        for tr in &t.trait_impls {
            by_trait
                .entry(tr.clone())
                .or_default()
                .push(t.full_path.clone());
        }
    }
    println!("trait impls ({} traits used):", by_trait.len());
    for (tr, impls) in by_trait {
        println!("  {:<30} {}", tr, impls.join(", "));
    }
}

fn print_visibility_distribution(types: &[&TypeFacts]) {
    let mut counts: BTreeMap<String, u32> = BTreeMap::new();
    for t in types {
        *counts.entry(t.visibility.clone()).or_insert(0) += 1;
    }
    print!("type visibility:");
    for (v, c) in counts {
        print!(" {v}={c}");
    }
    println!();
}

// ── small helpers ─────────────────────────────────────────────────────────

struct FCounts {
    owned: u32,
    b_immut: u32,
    b_mut: u32,
    indir: u32,
    prim: u32,
}
fn field_counts(fields: &[FieldFacts]) -> FCounts {
    let mut c = FCounts {
        owned: 0,
        b_immut: 0,
        b_mut: 0,
        indir: 0,
        prim: 0,
    };
    for f in fields {
        match f.ownership {
            Ownership::Owned => c.owned += 1,
            Ownership::BorrowImmut => c.b_immut += 1,
            Ownership::BorrowMut => c.b_mut += 1,
            Ownership::Indirection => c.indir += 1,
            Ownership::Primitive => c.prim += 1,
            Ownership::Other => {}
        }
    }
    c
}
struct MCounts {
    none: u32,
    byval: u32,
    r: u32,
    rm: u32,
    unsafe_fn: u32,
}
fn method_counts(methods: &[FnFacts]) -> MCounts {
    let mut c = MCounts {
        none: 0,
        byval: 0,
        r: 0,
        rm: 0,
        unsafe_fn: 0,
    };
    for m in methods {
        match m.self_kind {
            SelfKind::None => c.none += 1,
            SelfKind::ByValue => c.byval += 1,
            SelfKind::Ref => c.r += 1,
            SelfKind::RefMut => c.rm += 1,
        }
        if m.is_unsafe {
            c.unsafe_fn += 1;
        }
    }
    c
}

fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n {
        s.to_string()
    } else {
        format!("{}…", &s[..n.saturating_sub(1)])
    }
}

fn short_file(s: &str) -> String {
    // keep last two path components, e.g. "wasm/decode.rs"
    let parts: Vec<&str> = s.split('/').collect();
    if parts.len() <= 2 {
        s.to_string()
    } else {
        parts[parts.len() - 2..].join("/")
    }
}
