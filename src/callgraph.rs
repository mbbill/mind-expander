//! Function call graph extraction.
//!
//! This module is intentionally separate from ownership/reference edge
//! extraction. The current backend is a `syn` best-effort pass; keeping a
//! narrow provider contract lets us replace it with rust-analyzer or rustc
//! semantics later without making ownership edges carry executable behavior.

use std::collections::{BTreeMap, BTreeSet};

use anyhow::Result;
use rayon::prelude::*;
use syn::spanned::Spanned;
use syn::visit::Visit;
use syn::{
    Expr, ExprCall, ExprMethodCall, File, FnArg, ImplItem, Item, ItemImpl, ItemMod, ItemTrait, Pat,
    TraitItem, Type,
};

use crate::extract::SourceFile;
use crate::model::{
    CallEdge, CallKind, CallResolution, CrateFacts, ModuleFacts, TypeFacts, WorkspaceFacts,
};

pub struct SynCallGraphProvider;

impl SynCallGraphProvider {
    /// Visit every source file in parallel to collect call edges.
    /// Each thread reads + parses + visits one file at a time; the
    /// per-file `seen` set folds repeated calls within a file (e.g.
    /// three call sites to `foo()`) into one edge, and cross-file
    /// duplicates collapse during the final `sort + dedup`.
    ///
    /// Files are re-parsed here even though the entity pass also
    /// parsed them — see the comment on `SourceFile` for why the
    /// AST cannot be cached across passes.
    pub fn extract_call_edges_from_source(
        &self,
        workspace: &WorkspaceFacts,
        source_files: &[SourceFile],
    ) -> Result<Vec<CallEdge>> {
        let registry = FunctionRegistry::from_workspace(workspace);
        let mut out: Vec<CallEdge> = source_files
            .par_iter()
            .flat_map_iter(|sf| {
                let mut file_out = Vec::new();
                let mut file_seen = BTreeSet::new();
                if let Ok(src) = std::fs::read_to_string(&sf.file) {
                    if let Ok(ast) = syn::parse_file(&src) {
                        collect_file_call_edges(
                            &sf.crate_name,
                            &sf.module_path,
                            &ast,
                            &registry,
                            &mut file_out,
                            &mut file_seen,
                        );
                    }
                }
                file_out.into_iter()
            })
            .collect();
        out.sort_by(|a, b| {
            (&a.caller, &a.callee, a.kind, a.resolution, &a.origin).cmp(&(
                &b.caller,
                &b.callee,
                b.kind,
                b.resolution,
                &b.origin,
            ))
        });
        out.dedup_by(|a, b| {
            a.caller == b.caller
                && a.callee == b.callee
                && a.kind == b.kind
                && a.resolution == b.resolution
                && a.origin == b.origin
        });
        Ok(out)
    }
}

#[derive(Default)]
struct FunctionRegistry {
    free_by_name: BTreeMap<String, Vec<String>>,
    method_by_name: BTreeMap<String, Vec<String>>,
    methods_by_type: BTreeMap<String, BTreeMap<String, Vec<String>>>,
    types_by_name: BTreeMap<String, Vec<String>>,
}

impl FunctionRegistry {
    fn from_workspace(workspace: &WorkspaceFacts) -> Self {
        let mut registry = Self::default();
        for krate in workspace.crates.values() {
            registry.add_crate(krate);
        }
        registry
    }

    fn add_crate(&mut self, krate: &CrateFacts) {
        for module in krate.modules.values() {
            self.add_module(krate, module);
        }
    }

    fn add_module(&mut self, krate: &CrateFacts, module: &ModuleFacts) {
        let module_path = module_full_path(&krate.name, &module.path);
        for f in &module.functions {
            let full_path = format!("{module_path}::{}", f.name);
            push_unique_map(&mut self.free_by_name, &f.name, full_path);
        }
        for ty in &module.types {
            push_unique_map(&mut self.types_by_name, &ty.name, ty.full_path.clone());
            self.add_type_methods(ty);
        }
    }

    fn add_type_methods(&mut self, ty: &TypeFacts) {
        for method in &ty.methods {
            let full_path = format!("{}::{}", ty.full_path, method.name);
            push_unique_map(&mut self.method_by_name, &method.name, full_path.clone());
            let by_name = self
                .methods_by_type
                .entry(ty.full_path.clone())
                .or_default();
            push_unique_map(by_name, &method.name, full_path);
        }
    }

    fn resolve_free_call(
        &self,
        segments: &[String],
        current_module_full_path: &str,
    ) -> Option<ResolvedTargets> {
        let name = segments.last()?;
        let candidates = self.free_by_name.get(name)?;
        if segments.len() == 1 {
            let local = format!("{current_module_full_path}::{name}");
            if candidates.contains(&local) {
                return Some(ResolvedTargets {
                    paths: vec![local],
                    resolution: CallResolution::Exact,
                });
            }
        }
        resolve_function_candidates(candidates, segments, current_module_full_path)
    }

    fn resolve_associated_call(
        &self,
        segments: &[String],
        current_module_full_path: &str,
        current_type: Option<&str>,
    ) -> Option<ResolvedTargets> {
        if segments.len() < 2 {
            return None;
        }
        let method_name = segments.last()?;
        let owner_segments = &segments[..segments.len() - 1];
        let owners =
            self.resolve_type_segments(owner_segments, current_module_full_path, current_type)?;

        let mut targets = Vec::new();
        for owner in &owners.paths {
            if let Some(methods) = self
                .methods_by_type
                .get(owner)
                .and_then(|by_name| by_name.get(method_name))
            {
                for method in methods {
                    push_unique(&mut targets, method.clone());
                }
            }
        }
        if targets.is_empty() {
            return None;
        }
        let resolution = if targets.len() > 1 {
            CallResolution::Ambiguous
        } else {
            owners.resolution
        };
        Some(ResolvedTargets {
            paths: targets,
            resolution,
        })
    }

    fn resolve_method_call(
        &self,
        method_name: &str,
        current_type: Option<&str>,
        receiver_is_self: bool,
    ) -> Option<ResolvedTargets> {
        if receiver_is_self {
            let current_type = current_type?;
            let methods = self.methods_by_type.get(current_type)?.get(method_name)?;
            return Some(ResolvedTargets {
                paths: methods.clone(),
                resolution: if methods.len() == 1 {
                    CallResolution::Exact
                } else {
                    CallResolution::Ambiguous
                },
            });
        }

        let methods = self.method_by_name.get(method_name)?;
        if methods.len() == 1 {
            return Some(ResolvedTargets {
                paths: methods.clone(),
                resolution: CallResolution::Heuristic,
            });
        }

        // `syn` has no receiver type information. Emitting every method named
        // `push`/`new`/`len` would drown the graph, so ambiguous receiver
        // calls are deliberately left for a semantic backend.
        None
    }

    fn resolve_type_segments(
        &self,
        segments: &[String],
        current_module_full_path: &str,
        current_type: Option<&str>,
    ) -> Option<ResolvedTargets> {
        let type_name = segments.last()?;
        if type_name == "Self" {
            return Some(ResolvedTargets {
                paths: vec![current_type?.to_string()],
                resolution: CallResolution::Exact,
            });
        }
        let candidates = self.types_by_name.get(type_name)?;
        if segments.len() == 1 {
            let local = format!("{current_module_full_path}::{type_name}");
            if candidates.contains(&local) {
                return Some(ResolvedTargets {
                    paths: vec![local],
                    resolution: CallResolution::Exact,
                });
            }
        }
        resolve_function_candidates(candidates, segments, current_module_full_path)
    }
}

#[derive(Debug, Clone)]
struct ResolvedTargets {
    paths: Vec<String>,
    resolution: CallResolution,
}

struct FileCallCollector<'a> {
    crate_name: &'a str,
    module_stack: Vec<String>,
    registry: &'a FunctionRegistry,
    out: &'a mut Vec<CallEdge>,
    seen: &'a mut BTreeSet<(String, String, CallKind, CallResolution, String)>,
}

impl FileCallCollector<'_> {
    fn current_module_path(&self) -> String {
        self.module_stack.last().cloned().unwrap_or_default()
    }

    fn current_module_full_path(&self) -> String {
        module_full_path(self.crate_name, &self.current_module_path())
    }

    fn visit_item(&mut self, item: &Item) {
        match item {
            Item::Mod(m) => self.visit_mod(m),
            Item::Fn(f) => self.visit_free_fn(f),
            Item::Impl(i) => self.visit_impl(i),
            Item::Trait(t) => self.visit_trait(t),
            _ => {}
        }
    }

    fn visit_mod(&mut self, m: &ItemMod) {
        let Some((_, items)) = &m.content else {
            return;
        };
        let parent = self.current_module_path();
        let new_path = if parent.is_empty() {
            m.ident.to_string()
        } else {
            format!("{parent}::{}", m.ident)
        };
        self.module_stack.push(new_path);
        for item in items {
            self.visit_item(item);
        }
        self.module_stack.pop();
    }

    fn visit_free_fn(&mut self, f: &syn::ItemFn) {
        let module = self.current_module_full_path();
        let caller = format!("{module}::{}", f.sig.ident);
        collect_body_calls(
            &caller,
            self.crate_name,
            &self.current_module_path(),
            None,
            &f.sig.inputs,
            &f.block,
            self.registry,
            self.out,
            self.seen,
        );
    }

    fn visit_impl(&mut self, i: &ItemImpl) {
        let Some(self_name) = self_type_name(&i.self_ty) else {
            return;
        };
        let module = self.current_module_full_path();
        let Some(owner) = self
            .registry
            .resolve_type_segments(&[self_name], &module, None)
            .and_then(|resolved| resolved.paths.into_iter().next())
        else {
            return;
        };

        for item in &i.items {
            if let ImplItem::Fn(f) = item {
                let caller = format!("{owner}::{}", f.sig.ident);
                collect_body_calls(
                    &caller,
                    self.crate_name,
                    &self.current_module_path(),
                    Some(&owner),
                    &f.sig.inputs,
                    &f.block,
                    self.registry,
                    self.out,
                    self.seen,
                );
            }
        }
    }

    fn visit_trait(&mut self, t: &ItemTrait) {
        let owner = format!("{}::{}", self.current_module_full_path(), t.ident);
        for item in &t.items {
            if let TraitItem::Fn(f) = item {
                if let Some(block) = &f.default {
                    let caller = format!("{owner}::{}", f.sig.ident);
                    collect_body_calls(
                        &caller,
                        self.crate_name,
                        &self.current_module_path(),
                        Some(&owner),
                        &f.sig.inputs,
                        block,
                        self.registry,
                        self.out,
                        self.seen,
                    );
                }
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn collect_body_calls(
    caller: &str,
    crate_name: &str,
    module_path: &str,
    current_type: Option<&str>,
    inputs: &syn::punctuated::Punctuated<FnArg, syn::token::Comma>,
    body: &syn::Block,
    registry: &FunctionRegistry,
    out: &mut Vec<CallEdge>,
    seen: &mut BTreeSet<(String, String, CallKind, CallResolution, String)>,
) {
    let mut locals = BTreeSet::new();
    for input in inputs {
        match input {
            FnArg::Receiver(_) => {
                locals.insert("self".to_string());
            }
            FnArg::Typed(pt) => collect_pat_names(&pt.pat, &mut locals),
        }
    }

    let mut visitor = BodyCallVisitor {
        caller,
        current_module_full_path: module_full_path(crate_name, module_path),
        current_type,
        registry,
        locals,
        out,
        seen,
    };
    visitor.visit_block(body);
}

struct BodyCallVisitor<'a> {
    caller: &'a str,
    current_module_full_path: String,
    current_type: Option<&'a str>,
    registry: &'a FunctionRegistry,
    locals: BTreeSet<String>,
    out: &'a mut Vec<CallEdge>,
    seen: &'a mut BTreeSet<(String, String, CallKind, CallResolution, String)>,
}

impl BodyCallVisitor<'_> {
    fn handle_path_call(
        &mut self,
        path: &syn::Path,
        callsite_start_line: u32,
        callsite_end_line: u32,
    ) {
        let segments = path_segments(path);
        if segments.is_empty() {
            return;
        }
        if segments.len() == 1 && self.locals.contains(&segments[0]) {
            return;
        }

        let origin = segments.join("::");
        if let Some(resolved) = self.registry.resolve_associated_call(
            &segments,
            &self.current_module_full_path,
            self.current_type,
        ) {
            self.push_edges(
                resolved,
                CallKind::AssociatedFunction,
                origin,
                callsite_start_line,
                callsite_end_line,
            );
            return;
        }

        if let Some(resolved) = self
            .registry
            .resolve_free_call(&segments, &self.current_module_full_path)
        {
            self.push_edges(
                resolved,
                CallKind::Function,
                origin,
                callsite_start_line,
                callsite_end_line,
            );
        }
    }

    fn handle_method_call(&mut self, node: &ExprMethodCall) {
        let method_name = node.method.to_string();
        let receiver_is_self = is_self_expr(&node.receiver);
        let Some(resolved) =
            self.registry
                .resolve_method_call(&method_name, self.current_type, receiver_is_self)
        else {
            return;
        };
        let span = node.span();
        let start = span.start().line as u32;
        let end = span.end().line as u32;
        self.push_edges(
            resolved,
            CallKind::Method,
            format!(".{method_name}"),
            start,
            end,
        );
    }

    fn push_edges(
        &mut self,
        resolved: ResolvedTargets,
        kind: CallKind,
        origin: String,
        callsite_start_line: u32,
        callsite_end_line: u32,
    ) {
        for callee in resolved.paths {
            let key = (
                self.caller.to_string(),
                callee.clone(),
                kind,
                resolved.resolution,
                origin.clone(),
            );
            if !self.seen.insert(key) {
                continue;
            }
            self.out.push(CallEdge {
                caller: self.caller.to_string(),
                callee,
                kind,
                resolution: resolved.resolution,
                origin: origin.clone(),
                callsite_start_line,
                callsite_end_line,
                side: crate::model::Side::default(),
            });
        }
    }
}

impl<'ast> Visit<'ast> for BodyCallVisitor<'_> {
    fn visit_expr_call(&mut self, node: &'ast ExprCall) {
        if let Expr::Path(p) = &*node.func {
            let span = node.span();
            let start = span.start().line as u32;
            let end = span.end().line as u32;
            self.handle_path_call(&p.path, start, end);
        }
        syn::visit::visit_expr_call(self, node);
    }

    fn visit_expr_method_call(&mut self, node: &'ast ExprMethodCall) {
        self.handle_method_call(node);
        syn::visit::visit_expr_method_call(self, node);
    }

    fn visit_local(&mut self, local: &'ast syn::Local) {
        // The binding is not in scope for its initializer, so visit the
        // initializer first and only then suppress same-named call targets.
        if let Some(init) = &local.init {
            self.visit_expr(&init.expr);
            if let Some((_, diverge)) = &init.diverge {
                self.visit_expr(diverge);
            }
        }
        collect_pat_names(&local.pat, &mut self.locals);
    }

    fn visit_item(&mut self, _node: &'ast Item) {
        // Local items have their own call ownership. The current extractor
        // does not assign stable ids to them, so calls inside local items are
        // deliberately not attributed to the enclosing function.
    }
}

fn collect_file_call_edges(
    crate_name: &str,
    module_path: &str,
    ast: &File,
    registry: &FunctionRegistry,
    out: &mut Vec<CallEdge>,
    seen: &mut BTreeSet<(String, String, CallKind, CallResolution, String)>,
) {
    let mut collector = FileCallCollector {
        crate_name,
        module_stack: vec![module_path.to_string()],
        registry,
        out,
        seen,
    };
    for item in &ast.items {
        collector.visit_item(item);
    }
}

fn resolve_function_candidates(
    candidates: &[String],
    segments: &[String],
    current_module_full_path: &str,
) -> Option<ResolvedTargets> {
    if candidates.is_empty() {
        return None;
    }

    let exact: Vec<String> = candidates
        .iter()
        .filter(|candidate| path_ends_with(candidate, segments))
        .cloned()
        .collect();
    if !exact.is_empty() {
        return Some(ResolvedTargets {
            resolution: if exact.len() == 1 {
                CallResolution::Exact
            } else {
                CallResolution::Ambiguous
            },
            paths: exact,
        });
    }

    let current: Vec<&str> = current_module_full_path.split("::").collect();
    let scored: Vec<(usize, String)> = candidates
        .iter()
        .map(|candidate| {
            let segs: Vec<&str> = candidate.split("::").collect();
            let module_len = segs.len().saturating_sub(1);
            let score = current
                .iter()
                .zip(segs.iter().take(module_len))
                .take_while(|(a, b)| a == b)
                .count();
            (score, candidate.clone())
        })
        .collect();
    let best = scored.iter().map(|(score, _)| *score).max().unwrap_or(0);
    if best > 0 {
        let paths: Vec<String> = scored
            .into_iter()
            .filter(|(score, _)| *score == best)
            .map(|(_, path)| path)
            .collect();
        return Some(ResolvedTargets {
            resolution: if paths.len() == 1 {
                CallResolution::Heuristic
            } else {
                CallResolution::Ambiguous
            },
            paths,
        });
    }

    Some(ResolvedTargets {
        resolution: if candidates.len() == 1 {
            CallResolution::Heuristic
        } else {
            CallResolution::Ambiguous
        },
        paths: candidates.to_vec(),
    })
}

fn path_ends_with(candidate: &str, suffix: &[String]) -> bool {
    let segs: Vec<&str> = candidate.split("::").collect();
    if suffix.len() > segs.len() {
        return false;
    }
    segs[segs.len() - suffix.len()..]
        .iter()
        .copied()
        .eq(suffix.iter().map(String::as_str))
}

fn path_segments(path: &syn::Path) -> Vec<String> {
    path.segments
        .iter()
        .map(|segment| segment.ident.to_string())
        .collect()
}

fn is_self_expr(expr: &Expr) -> bool {
    matches!(
        expr,
        Expr::Path(p)
            if p.path.segments.len() == 1
                && p.path.segments.first().is_some_and(|s| s.ident == "self")
    )
}

fn self_type_name(ty: &Type) -> Option<String> {
    match ty {
        Type::Path(tp) => tp
            .path
            .segments
            .last()
            .map(|segment| segment.ident.to_string()),
        _ => None,
    }
}

fn collect_pat_names(pat: &Pat, out: &mut BTreeSet<String>) {
    match pat {
        Pat::Ident(p) => {
            out.insert(p.ident.to_string());
            if let Some((_, subpat)) = &p.subpat {
                collect_pat_names(subpat, out);
            }
        }
        Pat::Reference(p) => collect_pat_names(&p.pat, out),
        Pat::Slice(p) => {
            for elem in &p.elems {
                collect_pat_names(elem, out);
            }
        }
        Pat::Struct(p) => {
            for field in &p.fields {
                collect_pat_names(&field.pat, out);
            }
        }
        Pat::Tuple(p) => {
            for elem in &p.elems {
                collect_pat_names(elem, out);
            }
        }
        Pat::TupleStruct(p) => {
            for elem in &p.elems {
                collect_pat_names(elem, out);
            }
        }
        Pat::Type(p) => collect_pat_names(&p.pat, out),
        Pat::Or(p) => {
            for case in &p.cases {
                collect_pat_names(case, out);
            }
        }
        _ => {}
    }
}

fn module_full_path(crate_name: &str, module_path: &str) -> String {
    if module_path.is_empty() {
        crate_name.to_string()
    } else {
        format!("{crate_name}::{module_path}")
    }
}

fn push_unique_map(map: &mut BTreeMap<String, Vec<String>>, key: &str, value: String) {
    push_unique(map.entry(key.to_string()).or_default(), value);
}

fn push_unique(values: &mut Vec<String>, value: String) {
    if !values.contains(&value) {
        values.push(value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{
        CrateFacts, FnFacts, ModuleFacts, Ownership, SelfKind, TypeFacts, TypeKind, WorkspaceFacts,
    };

    fn fn_facts(name: &str) -> FnFacts {
        FnFacts {
            name: name.to_string(),
            impl_trait: None,
            visibility: "pub".to_string(),
            self_kind: SelfKind::None,
            is_unsafe: false,
            is_const: false,
            is_async: false,
            lifetime_params: vec![],
            params: vec![],
            return_ty_text: "()".to_string(),
            return_ownership: Ownership::Primitive,
            return_referenced: vec![],
            return_cardinality: vec![],
            lifetime_flows_through: false,
            unsafe_blocks: 0,
            doc_first_line: None,
            span: None,
            prev_span: None,
            change_kind: None,
            side: crate::model::Side::default(),
        }
    }

    fn type_facts(name: &str, methods: &[&str]) -> TypeFacts {
        type_facts_in("", name, methods)
    }

    fn type_facts_in(module_path: &str, name: &str, methods: &[&str]) -> TypeFacts {
        let prefix = module_full_path("c", module_path);
        TypeFacts {
            name: name.to_string(),
            full_path: format!("{prefix}::{name}"),
            kind: TypeKind::Struct,
            visibility: "pub".to_string(),
            lifetime_params: vec![],
            type_params: vec![],
            derives: vec![],
            fields: vec![],
            methods: methods.iter().map(|m| fn_facts(m)).collect(),
            trait_impls: vec![],
            unsafe_blocks: 0,
            doc_first_line: None,
            span: None,
            prev_span: None,
            change_kind: None,
            side: crate::model::Side::default(),
        }
    }

    fn module_facts(path: &str, functions: &[&str], types: &[TypeFacts]) -> ModuleFacts {
        ModuleFacts {
            path: path.to_string(),
            file: if path.is_empty() {
                "src/lib.rs".to_string()
            } else {
                format!("src/{}.rs", path.replace("::", "/"))
            },
            types: types.to_vec(),
            functions: functions.iter().map(|f| fn_facts(f)).collect(),
            re_exports: vec![],
            unsafe_blocks: 0,
            side: crate::model::Side::default(),
        }
    }

    fn workspace(functions: &[&str], types: &[TypeFacts]) -> WorkspaceFacts {
        workspace_with_modules(vec![module_facts("", functions, types)])
    }

    fn workspace_with_modules(modules: Vec<ModuleFacts>) -> WorkspaceFacts {
        WorkspaceFacts {
            crates: BTreeMap::from([(
                "c".to_string(),
                CrateFacts {
                    name: "c".to_string(),
                    root: "src".to_string(),
                    modules: modules.into_iter().map(|m| (m.path.clone(), m)).collect(),
                    language: crate::model::Language::Rust,
                    side: crate::model::Side::default(),
                },
            )]),
            edges: vec![],
            call_edges: vec![],
            edge_profiles: BTreeMap::new(),
        }
    }

    fn collect(src: &str, ws: &WorkspaceFacts) -> Vec<CallEdge> {
        let registry = FunctionRegistry::from_workspace(ws);
        let ast = syn::parse_file(src).expect("parse test source");
        let mut out = Vec::new();
        let mut seen = BTreeSet::new();
        collect_file_call_edges("c", "", &ast, &registry, &mut out, &mut seen);
        out.sort_by(|a, b| {
            (&a.caller, &a.callee, &a.origin).cmp(&(&b.caller, &b.callee, &b.origin))
        });
        out
    }

    #[test]
    fn resolves_direct_free_function_calls() {
        let ws = workspace(&["caller", "callee"], &[]);
        let edges = collect("fn caller() { callee(); } fn callee() {}", &ws);
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].caller, "c::caller");
        assert_eq!(edges[0].callee, "c::callee");
        assert_eq!(edges[0].kind, CallKind::Function);
        assert_eq!(edges[0].resolution, CallResolution::Exact);
    }

    #[test]
    fn resolves_module_functions_and_type_member_functions_in_nested_modules() {
        let ws = workspace_with_modules(vec![
            module_facts("", &[], &[]),
            module_facts(
                "inner",
                &["module_caller", "module_callee"],
                &[type_facts_in(
                    "inner",
                    "Owner",
                    &["member_caller", "member_callee"],
                )],
            ),
        ]);
        let edges = collect(
            r#"
            mod inner {
                fn module_caller() { module_callee(); }
                fn module_callee() {}

                struct Owner;
                impl Owner {
                    fn member_caller(&self) { self.member_callee(); }
                    fn member_callee(&self) {}
                }
            }
            "#,
            &ws,
        );

        assert!(edges.iter().any(|edge| {
            edge.caller == "c::inner::module_caller"
                && edge.callee == "c::inner::module_callee"
                && edge.kind == CallKind::Function
                && edge.resolution == CallResolution::Exact
        }));
        assert!(edges.iter().any(|edge| {
            edge.caller == "c::inner::Owner::member_caller"
                && edge.callee == "c::inner::Owner::member_callee"
                && edge.kind == CallKind::Method
                && edge.resolution == CallResolution::Exact
        }));
    }

    #[test]
    fn suppresses_direct_calls_shadowed_by_locals() {
        let ws = workspace(&["caller", "callee"], &[]);
        let edges = collect(
            "fn caller() { let callee = || {}; callee(); } fn callee() {}",
            &ws,
        );
        assert!(edges.is_empty());
    }

    #[test]
    fn resolves_self_method_calls_to_the_current_type() {
        let ws = workspace(&[], &[type_facts("Owner", &["caller", "callee"])]);
        let edges = collect(
            "struct Owner; impl Owner { fn caller(&self) { self.callee(); } fn callee(&self) {} }",
            &ws,
        );
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].caller, "c::Owner::caller");
        assert_eq!(edges[0].callee, "c::Owner::callee");
        assert_eq!(edges[0].kind, CallKind::Method);
        assert_eq!(edges[0].resolution, CallResolution::Exact);
    }

    #[test]
    fn resolves_associated_function_calls() {
        let ws = workspace(&[], &[type_facts("Owner", &["caller", "new"])]);
        let edges = collect(
            "struct Owner; impl Owner { fn caller() { Owner::new(); Self::new(); } fn new() {} }",
            &ws,
        );
        let callees: Vec<&str> = edges.iter().map(|e| e.callee.as_str()).collect();
        assert_eq!(callees, vec!["c::Owner::new", "c::Owner::new"]);
        assert!(edges.iter().all(|e| e.kind == CallKind::AssociatedFunction));
        assert!(edges.iter().all(|e| e.resolution == CallResolution::Exact));
    }

    #[test]
    fn leaves_ambiguous_receiver_method_calls_for_a_semantic_backend() {
        let ws = workspace(
            &["caller"],
            &[type_facts("A", &["same"]), type_facts("B", &["same"])],
        );
        let edges = collect("fn caller(a: A) { a.same(); }", &ws);
        assert!(edges.is_empty());
    }

    #[test]
    fn resolves_unique_receiver_method_calls_as_heuristic() {
        let ws = workspace(&["caller"], &[type_facts("A", &["unique"])]);
        let edges = collect("fn caller(a: A) { a.unique(); }", &ws);
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].callee, "c::A::unique");
        assert_eq!(edges[0].resolution, CallResolution::Heuristic);
    }
}
