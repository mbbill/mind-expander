//! Human-readable digest printer. Prints facts only; never labels a role.

use std::collections::BTreeMap;

use crate::model::{
    EdgeProfile, FieldFacts, FnFacts, Ownership, SelfKind, TypeFacts, TypeKind, WorkspaceFacts,
};

pub fn digest(ws: &WorkspaceFacts, module_filter: &str) {
    // Collect every type's full path so we can filter by prefix.
    let mut all_types: Vec<&TypeFacts> = Vec::new();
    for cf in ws.crates.values() {
        for m in cf.modules.values() {
            for ty in &m.types {
                all_types.push(ty);
            }
        }
    }
    all_types.sort_by(|a, b| a.full_path.cmp(&b.full_path));

    let prefix = module_filter.trim();
    let filter = |fp: &str| -> bool {
        if prefix.is_empty() {
            return true;
        }
        // Match against the path with crate name first, but also allow the
        // user to omit the crate prefix.
        fp.contains(prefix)
    };

    println!("# mind-expander digest");
    if !prefix.is_empty() {
        println!("filter: {prefix}");
    }
    println!();

    // Per-module summaries.
    for cf in ws.crates.values() {
        for m in cf.modules.values() {
            let any = m.types.iter().any(|t| filter(&t.full_path))
                || m.functions
                    .iter()
                    .any(|_| filter(&format!("{}::{}", cf.name, m.path)));
            if !any {
                continue;
            }
            let mod_path = if m.path.is_empty() {
                cf.name.clone()
            } else {
                format!("{}::{}", cf.name, m.path)
            };
            println!("== module {mod_path}");
            println!("   file: {}", m.file);
            println!(
                "   types: {} | free fns: {} | unsafe blocks (free fns): {}",
                m.types.len(),
                m.functions.len(),
                m.unsafe_blocks
            );
            for ty in &m.types {
                if !filter(&ty.full_path) {
                    continue;
                }
                print_type(ty, &ws.edge_profiles);
            }
            for f in &m.functions {
                let from = format!("{}::{}::{}", cf.name, m.path, f.name).replace("::::", "::");
                if !filter(&from) {
                    continue;
                }
                print_fn(f, "  ");
            }
        }
    }
}

fn print_type(ty: &TypeFacts, profiles: &BTreeMap<String, EdgeProfile>) {
    let kind = match ty.kind {
        TypeKind::Struct => "struct",
        TypeKind::Enum => "enum",
        TypeKind::Union => "union",
        TypeKind::Trait => "trait",
        TypeKind::TypeAlias => "type",
        TypeKind::Class => "class",
        TypeKind::Interface => "interface",
    };
    let lifetimes = if ty.lifetime_params.is_empty() {
        "0".to_string()
    } else {
        format!(
            "[{}]",
            ty.lifetime_params
                .iter()
                .map(|s| format!("'{s}"))
                .collect::<Vec<_>>()
                .join(", ")
        )
    };
    let generics = if ty.type_params.is_empty() {
        "0".to_string()
    } else {
        format!("[{}]", ty.type_params.join(", "))
    };
    println!();
    println!("  -- {} {} ({})", kind, ty.full_path, ty.visibility);
    if let Some(d) = &ty.doc_first_line {
        println!("     doc: {d}");
    }
    println!(
        "     lifetimes: {} | generics: {} | derives: [{}]",
        lifetimes,
        generics,
        ty.derives.join(", ")
    );

    // Field profile.
    if !ty.fields.is_empty() {
        let prof = field_profile(&ty.fields);
        println!(
            "     fields: total {} | owned {} | borrow-immut {} | borrow-mut {} | indirection {} | primitive {} | other {}",
            ty.fields.len(),
            prof.owned, prof.b_immut, prof.b_mut, prof.indirection, prof.primitive, prof.other
        );
        for f in &ty.fields {
            let oship = oship_short(f.ownership);
            let refs = if f.referenced.is_empty() {
                String::new()
            } else {
                format!(" -> [{}]", f.referenced.join(", "))
            };
            let lts = if f.lifetimes.is_empty() {
                String::new()
            } else {
                format!(
                    " lt:[{}]",
                    f.lifetimes
                        .iter()
                        .map(|s| format!("'{s}"))
                        .collect::<Vec<_>>()
                        .join(",")
                )
            };
            println!("       {} {}: {}{}{}", oship, f.name, f.ty_text, refs, lts);
        }
    }

    // Method profile.
    if !ty.methods.is_empty() {
        let mp = method_profile(&ty.methods);
        println!(
            "     methods: total {} | none {} | by-value {} | &self {} | &mut self {} | unsafe-fns {} | lifetime-flowthru {} | unsafe-blocks {}",
            ty.methods.len(), mp.none, mp.by_value, mp.r, mp.r_mut, mp.unsafe_fns, mp.lifetime_flow, ty.unsafe_blocks
        );
        for m in &ty.methods {
            print_fn(m, "       ");
        }
    }

    if !ty.trait_impls.is_empty() {
        println!("     trait-impls: [{}]", ty.trait_impls.join(", "));
    }

    if let Some(prof) = profiles.get(&ty.full_path) {
        println!(
            "     edges: inbound {} from {} sources | outbound {} to {} targets",
            prof.inbound.values().sum::<u32>(),
            prof.inbound_distinct_sources,
            prof.outbound.values().sum::<u32>(),
            prof.outbound_distinct_targets,
        );
        if !prof.inbound.is_empty() {
            print!("       in: ");
            let parts: Vec<String> = prof
                .inbound
                .iter()
                .map(|(k, v)| format!("{k}={v}"))
                .collect();
            println!("{}", parts.join(", "));
        }
        if !prof.outbound.is_empty() {
            print!("       out: ");
            let parts: Vec<String> = prof
                .outbound
                .iter()
                .map(|(k, v)| format!("{k}={v}"))
                .collect();
            println!("{}", parts.join(", "));
        }
    }
}

fn print_fn(f: &FnFacts, indent: &str) {
    let self_kind = match f.self_kind {
        SelfKind::None => "none",
        SelfKind::ByValue => "self",
        SelfKind::Ref => "&self",
        SelfKind::RefMut => "&mut self",
    };
    let mut tags = vec![self_kind.to_string()];
    if f.is_unsafe {
        tags.push("unsafe-fn".into());
    }
    if f.is_const {
        tags.push("const".into());
    }
    if f.is_async {
        tags.push("async".into());
    }
    if f.lifetime_flows_through {
        tags.push("lifetime-flow".into());
    }
    if f.unsafe_blocks > 0 {
        tags.push(format!("unsafe-blocks={}", f.unsafe_blocks));
    }
    let params: Vec<String> = f
        .params
        .iter()
        .map(|p| {
            format!(
                "{}:{}{}",
                p.name,
                oship_short(p.ownership),
                if p.referenced.is_empty() {
                    String::new()
                } else {
                    format!("({})", p.referenced.join(","))
                }
            )
        })
        .collect();
    let ret = format!(
        "-> {} {}",
        oship_short(f.return_ownership),
        if f.return_referenced.is_empty() {
            f.return_ty_text.clone()
        } else {
            format!("{} ({})", f.return_ty_text, f.return_referenced.join(","))
        }
    );
    println!(
        "{indent}fn {} ({}) [{}] ({})",
        f.name,
        params.join(", "),
        tags.join(","),
        ret
    );
}

fn oship_short(o: Ownership) -> &'static str {
    match o {
        Ownership::Owned => "OWN",
        Ownership::BorrowImmut => "BRW",
        Ownership::BorrowMut => "MUT",
        Ownership::Indirection => "PTR",
        Ownership::Primitive => "PRIM",
        Ownership::Other => "?",
    }
}

#[derive(Default)]
struct FieldProfile {
    owned: u32,
    b_immut: u32,
    b_mut: u32,
    indirection: u32,
    primitive: u32,
    other: u32,
}
fn field_profile(fields: &[FieldFacts]) -> FieldProfile {
    let mut p = FieldProfile::default();
    for f in fields {
        match f.ownership {
            Ownership::Owned => p.owned += 1,
            Ownership::BorrowImmut => p.b_immut += 1,
            Ownership::BorrowMut => p.b_mut += 1,
            Ownership::Indirection => p.indirection += 1,
            Ownership::Primitive => p.primitive += 1,
            Ownership::Other => p.other += 1,
        }
    }
    p
}

#[derive(Default)]
struct MethodProfile {
    none: u32,
    by_value: u32,
    r: u32,
    r_mut: u32,
    unsafe_fns: u32,
    lifetime_flow: u32,
}
fn method_profile(methods: &[FnFacts]) -> MethodProfile {
    let mut p = MethodProfile::default();
    for m in methods {
        match m.self_kind {
            SelfKind::None => p.none += 1,
            SelfKind::ByValue => p.by_value += 1,
            SelfKind::Ref => p.r += 1,
            SelfKind::RefMut => p.r_mut += 1,
        }
        if m.is_unsafe {
            p.unsafe_fns += 1;
        }
        if m.lifetime_flows_through {
            p.lifetime_flow += 1;
        }
    }
    p
}
