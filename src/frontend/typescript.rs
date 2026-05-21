//! TypeScript frontend. Feature-gated behind `--features typescript`.
//!
//! Mirrors the Rust extractor's shape: walks the filesystem under a
//! package root, parses each `.ts` / `.tsx` file with swc, and emits
//! the language-agnostic [`WorkspaceFacts`] the rest of the tool
//! already consumes.
//!
//! Scope of this first cut:
//!   - Top-level classes, interfaces, type aliases, enums, functions.
//!   - Class fields and methods (including constructors).
//!   - Interface property + method signatures.
//!   - Owns edges from field-type references (all TS ownership is
//!     `Owned` per the design decision — TS has no borrow concept).
//!   - `Extends` edges from `class C extends Parent`.
//!   - `TraitImpl` edges from `class C implements I` and `interface
//!     I extends J` (interface inheritance is shape-merging, modeled
//!     as TraitImpl rather than Extends because there is no
//!     single-parent runtime relationship).
//!   - Cardinality classification of field types: `T[]` → Many,
//!     `Map<K,V>` / `Record<K,V>` → ManyKeyed, `T | undefined` /
//!     `T | null` / `T?` → Optional, otherwise One.
//!
//! Out of scope for the first cut (call graph, lifetime modelling,
//! re-exports, namespace handling). Call edges return empty; the rest
//! of the tool already tolerates that.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use walkdir::WalkDir;

use swc_common::{sync::Lrc, FileName, SourceMap};
use swc_ecma_ast::{
    ClassDecl, ClassMember, Decl, DefaultDecl, EsVersion, ExportDecl, ExportDefaultDecl,
    FnDecl, ModuleDecl, ModuleItem, Stmt, TsArrayType, TsEntityName, TsEnumDecl, TsInterfaceDecl,
    TsKeywordType, TsKeywordTypeKind, TsType, TsTypeAliasDecl, TsTypeAnn, TsTypeElement,
    TsTypeRef, TsUnionType,
};
use swc_ecma_parser::{lexer::Lexer, Parser, StringInput, Syntax, TsSyntax};

use crate::frontend::LanguageFrontend;
use crate::model::{
    Cardinality, CrateFacts, Edge, EdgeKind, FieldFacts, FnFacts, ModuleFacts, Ownership,
    ParamFacts, SelfKind, Span, TypeFacts, TypeKind, ViaKind, WorkspaceFacts,
};

mod calls;

pub struct TypeScriptFrontend;

impl LanguageFrontend for TypeScriptFrontend {
    fn name(&self) -> &'static str {
        "typescript"
    }

    fn extract(&self, root: &Path) -> Result<Option<WorkspaceFacts>> {
        let packages = discover_packages(root);
        if packages.is_empty() {
            return Ok(None);
        }
        let mut workspace = WorkspaceFacts {
            crates: Default::default(),
            edges: Vec::new(),
            call_edges: Vec::new(),
            edge_profiles: Default::default(),
        };
        for pkg in &packages {
            let cf = extract_package(pkg)?;
            workspace.crates.insert(pkg.name.clone(), cf);
        }
        let edges = build_edges(&workspace);
        workspace.edge_profiles = build_profiles(&edges);
        workspace.edges = edges;
        // Call graph extraction is a separate pass over source files:
        // it needs the full workspace to resolve callee names against
        // the function/method registry, so it runs only after all
        // entity extraction has finished.
        workspace.call_edges = calls::extract_workspace_calls(&packages, &workspace)?;
        Ok(Some(workspace))
    }
}

/// A discovered TS package — a directory containing tsconfig.json or
/// package.json, with `src/` (or the project root) as its source root.
#[derive(Debug, Clone)]
pub(super) struct PackageRoot {
    /// Package name (from package.json `name`, or the directory name).
    pub(super) name: String,
    /// Directory holding the source files we'll parse.
    pub(super) src_root: PathBuf,
}

/// Walk for tsconfig.json (preferred) and package.json (fallback).
/// The first marker wins per directory; we don't dedupe parent/child
/// packages because TS monorepos commonly nest sub-packages.
fn discover_packages(root: &Path) -> Vec<PackageRoot> {
    let mut out = Vec::new();
    for entry in WalkDir::new(root)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !matches!(name.as_ref(), "target" | "node_modules" | ".git" | "dist" | "build")
        })
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy();
        // tsconfig is the strong signal — presence of a tsconfig means
        // this directory is a TS project (or root). package.json alone
        // could be a JS-only project; we'll only treat it as TS if
        // there are .ts files under src/, checked below.
        let is_tsconfig = file_name == "tsconfig.json";
        let is_pkgjson = file_name == "package.json";
        if !is_tsconfig && !is_pkgjson {
            continue;
        }
        let pkg_dir = match path.parent() {
            Some(p) => p,
            None => continue,
        };
        let src = pkg_dir.join("src");
        let src_root = if src.is_dir() { src } else { pkg_dir.to_path_buf() };
        // For package.json-only directories, require at least one .ts
        // file under src_root before claiming this as a TS package.
        if !is_tsconfig && !has_ts_files(&src_root) {
            continue;
        }
        let name = read_package_name(pkg_dir)
            .or_else(|| pkg_dir.file_name().map(|s| s.to_string_lossy().to_string()))
            .unwrap_or_else(|| "unnamed".to_string());
        // Dedupe: if this src_root was already claimed (e.g. tsconfig
        // and package.json side by side), keep the first entry.
        if out.iter().any(|p: &PackageRoot| p.src_root == src_root) {
            continue;
        }
        out.push(PackageRoot { name, src_root });
    }
    out
}

fn has_ts_files(root: &Path) -> bool {
    WalkDir::new(root)
        .into_iter()
        .filter_map(|e| e.ok())
        .any(|e| is_ts_source(e.path()))
}

pub(super) fn is_ts_source(path: &Path) -> bool {
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
    matches!(ext, "ts" | "tsx") && !path.to_string_lossy().contains(".d.ts")
}

fn read_package_name(pkg_dir: &Path) -> Option<String> {
    let raw = fs::read_to_string(pkg_dir.join("package.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    v.get("name")?.as_str().map(|s| s.to_string())
}

fn extract_package(pkg: &PackageRoot) -> Result<CrateFacts> {
    let mut modules: std::collections::BTreeMap<String, ModuleFacts> = Default::default();
    for entry in WalkDir::new(&pkg.src_root)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !matches!(name.as_ref(), "node_modules" | ".git" | "dist" | "build")
        })
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if !path.is_file() || !is_ts_source(path) {
            continue;
        }
        let module_path = file_to_module_path(&pkg.src_root, path);
        let module = parse_file(&pkg.name, &module_path, path)
            .with_context(|| format!("parsing {}", path.display()))?;
        modules.insert(module_path, module);
    }
    Ok(CrateFacts {
        name: pkg.name.clone(),
        root: pkg.src_root.to_string_lossy().into_owned(),
        modules,
        side: Default::default(),
    })
}

/// Map a source file path to a module path like `foo::bar::baz`.
/// File stem becomes the last segment; `index.ts` collapses to its
/// parent directory so `foo/bar/index.ts` becomes `foo::bar`.
pub(super) fn file_to_module_path(root: &Path, file: &Path) -> String {
    let rel = file.strip_prefix(root).unwrap_or(file);
    let mut segments: Vec<String> = rel
        .with_extension("")
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    if segments.last().map(|s| s == "index").unwrap_or(false) {
        segments.pop();
    }
    segments.join("::")
}

fn parse_file(crate_name: &str, module_path: &str, path: &Path) -> Result<ModuleFacts> {
    let cm: Lrc<SourceMap> = Default::default();
    let src = fs::read_to_string(path)?;
    let fm = cm.new_source_file(FileName::Real(path.to_path_buf()).into(), src);
    let is_tsx = path.extension().and_then(|s| s.to_str()) == Some("tsx");
    let syntax = Syntax::Typescript(TsSyntax {
        tsx: is_tsx,
        decorators: true,
        dts: false,
        no_early_errors: true,
        disallow_ambiguous_jsx_like: false,
    });
    let lexer = Lexer::new(
        syntax,
        EsVersion::Es2022,
        StringInput::from(&*fm),
        None,
    );
    let mut parser = Parser::new_from(lexer);
    let module = parser
        .parse_module()
        .map_err(|e| anyhow::anyhow!("swc parse error: {:?}", e.kind()))?;

    let mut ctx = Ctx {
        cm: cm.clone(),
        file: path.to_string_lossy().into_owned(),
        crate_name: crate_name.to_string(),
        module_path: module_path.to_string(),
        types: Vec::new(),
        functions: Vec::new(),
    };
    for item in &module.body {
        ctx.visit_module_item(item);
    }
    Ok(ModuleFacts {
        path: module_path.to_string(),
        file: ctx.file.clone(),
        types: ctx.types,
        functions: ctx.functions,
        re_exports: Vec::new(),
        unsafe_blocks: 0,
        side: Default::default(),
    })
}

struct Ctx {
    cm: Lrc<SourceMap>,
    file: String,
    crate_name: String,
    module_path: String,
    types: Vec<TypeFacts>,
    functions: Vec<FnFacts>,
}

impl Ctx {
    fn visit_module_item(&mut self, item: &ModuleItem) {
        match item {
            // Non-exported top-level declarations are file-local —
            // emit `"priv"` so the viewer's visibility bucketing
            // classifies them as `private` (grey dot). Exporting an
            // item upgrades it to `"pub"` (red dot). TS has no
            // crate / parent-module visibility concepts at this
            // level, so we never emit `"pub(crate)"` etc. for
            // top-level decls.
            ModuleItem::Stmt(Stmt::Decl(decl)) => self.visit_decl(decl, "priv"),
            ModuleItem::ModuleDecl(ModuleDecl::ExportDecl(ExportDecl { decl, .. })) => {
                self.visit_decl(decl, "pub")
            }
            ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultDecl(ExportDefaultDecl {
                decl,
                ..
            })) => match decl {
                DefaultDecl::Class(c) => {
                    if let Some(ident) = &c.ident {
                        self.emit_class(&ident.sym, &c.class, "pub");
                    }
                }
                DefaultDecl::Fn(f) => {
                    if let Some(ident) = &f.ident {
                        self.emit_fn(&ident.sym, &f.function, "pub");
                    }
                }
                DefaultDecl::TsInterfaceDecl(i) => self.emit_interface(i, "pub"),
            },
            _ => {}
        }
    }

    fn visit_decl(&mut self, decl: &Decl, vis: &str) {
        match decl {
            Decl::Class(ClassDecl { ident, class, .. }) => {
                self.emit_class(&ident.sym, class, vis);
            }
            Decl::Fn(FnDecl {
                ident, function, ..
            }) => {
                self.emit_fn(&ident.sym, function, vis);
            }
            Decl::TsInterface(i) => self.emit_interface(i, vis),
            Decl::TsTypeAlias(a) => self.emit_type_alias(a, vis),
            Decl::TsEnum(e) => self.emit_enum(e, vis),
            // Var / Using / TsModule (namespaces) are skipped in the
            // first cut. Namespaces are uncommon in modern TS; vars
            // don't fit the entity model the viewer expects.
            _ => {}
        }
    }

    fn emit_class(&mut self, name: &str, class: &swc_ecma_ast::Class, vis: &str) {
        let full_path = self.fq(name);
        let span = self.span(class.span);
        let mut fields: Vec<FieldFacts> = Vec::new();
        let mut methods: Vec<FnFacts> = Vec::new();
        let mut trait_impls: Vec<String> = Vec::new();
        // `extends Parent` — recorded as a derive-like marker so the
        // edge builder can synthesise an Extends edge later.
        let mut derives: Vec<String> = Vec::new();
        if let Some(superclass) = &class.super_class {
            if let Some(name) = expr_name(superclass) {
                derives.push(format!("@extends {name}"));
            }
        }
        for impl_clause in &class.implements {
            if let Some(name) = ts_entity_name_root(&impl_clause.expr) {
                trait_impls.push(name);
            }
        }

        for member in &class.body {
            match member {
                ClassMember::ClassProp(p) => {
                    let prop_name = match &p.key {
                        swc_ecma_ast::PropName::Ident(i) => i.sym.to_string(),
                        swc_ecma_ast::PropName::Str(s) => s.value.to_atom_lossy().to_string(),
                        _ => continue,
                    };
                    let (ty_text, refs, card) = type_info(p.type_ann.as_deref(), p.is_optional);
                    // Accessibility on fields drives the dot color in
                    // the viewer. FieldFacts has no `visibility` field
                    // today, so the field-level distinction shows up
                    // only when the parent type bucket-groups by it.
                    // Captured but unused below until FieldFacts grows
                    // a vis field.
                    let _field_vis = accessibility_to_vis(p.accessibility);
                    fields.push(FieldFacts {
                        name: prop_name,
                        ty_text,
                        ownership: Ownership::Owned,
                        referenced: refs,
                        cardinality: card,
                        lifetimes: Vec::new(),
                        span: Some(self.span(p.span)),
                        prev_span: None,
                        change_kind: None,
                        side: Default::default(),
                    });
                }
                ClassMember::Method(m) => {
                    let method_name = match &m.key {
                        swc_ecma_ast::PropName::Ident(i) => i.sym.to_string(),
                        swc_ecma_ast::PropName::Str(s) => s.value.to_atom_lossy().to_string(),
                        _ => continue,
                    };
                    let member_vis = accessibility_to_vis(m.accessibility);
                    methods.push(self.method_fn_facts(&method_name, &m.function, member_vis));
                }
                ClassMember::Constructor(c) => {
                    let mut params: Vec<ParamFacts> = Vec::new();
                    for p in &c.params {
                        if let swc_ecma_ast::ParamOrTsParamProp::Param(p) = p {
                            params.push(self.param_facts(&p.pat));
                        }
                    }
                    methods.push(FnFacts {
                        name: "constructor".to_string(),
                        impl_trait: None,
                        visibility: accessibility_to_vis(c.accessibility).to_string(),
                        self_kind: SelfKind::None,
                        is_unsafe: false,
                        is_const: false,
                        is_async: false,
                        lifetime_params: Vec::new(),
                        params,
                        return_ty_text: String::new(),
                        return_ownership: Ownership::Other,
                        return_referenced: Vec::new(),
                        return_cardinality: Vec::new(),
                        lifetime_flows_through: false,
                        unsafe_blocks: 0,
                        doc_first_line: None,
                        span: Some(self.span(c.span)),
                        prev_span: None,
                        change_kind: None,
                        side: Default::default(),
                    });
                }
                _ => {}
            }
        }

        self.types.push(TypeFacts {
            name: name.to_string(),
            full_path,
            kind: TypeKind::Class,
            visibility: vis.to_string(),
            lifetime_params: Vec::new(),
            type_params: Vec::new(),
            derives,
            fields,
            methods,
            trait_impls,
            unsafe_blocks: 0,
            doc_first_line: None,
            span: Some(span),
            prev_span: None,
            change_kind: None,
            side: Default::default(),
        });
    }

    fn emit_interface(&mut self, i: &TsInterfaceDecl, vis: &str) {
        let name = i.id.sym.to_string();
        let full_path = self.fq(&name);
        let span = self.span(i.span);
        let mut fields: Vec<FieldFacts> = Vec::new();
        let mut methods: Vec<FnFacts> = Vec::new();
        // `interface I extends J, K` — modeled as TraitImpl edges
        // (shape merging), recorded in `trait_impls`.
        let mut trait_impls: Vec<String> = Vec::new();
        for ext in &i.extends {
            if let Some(name) = ts_entity_name_root(&ext.expr) {
                trait_impls.push(name);
            }
        }
        for el in &i.body.body {
            match el {
                TsTypeElement::TsPropertySignature(p) => {
                    let prop_name = match &*p.key {
                        swc_ecma_ast::Expr::Ident(i) => i.sym.to_string(),
                        _ => continue,
                    };
                    let (ty_text, refs, card) = type_info(p.type_ann.as_deref(), p.optional);
                    fields.push(FieldFacts {
                        name: prop_name,
                        ty_text,
                        ownership: Ownership::Owned,
                        referenced: refs,
                        cardinality: card,
                        lifetimes: Vec::new(),
                        span: Some(self.span(p.span)),
                        prev_span: None,
                        change_kind: None,
                        side: Default::default(),
                    });
                }
                TsTypeElement::TsMethodSignature(m) => {
                    let method_name = match &*m.key {
                        swc_ecma_ast::Expr::Ident(i) => i.sym.to_string(),
                        _ => continue,
                    };
                    let (ret_text, ret_refs, ret_card) = type_info(m.type_ann.as_deref(), false);
                    methods.push(FnFacts {
                        name: method_name,
                        impl_trait: None,
                        visibility: "pub".to_string(),
                        // Interface method signatures: no explicit
                        // receiver in TS syntax. See `method_fn_facts`
                        // for the rationale.
                        self_kind: SelfKind::None,
                        is_unsafe: false,
                        is_const: false,
                        is_async: false,
                        lifetime_params: Vec::new(),
                        params: Vec::new(),
                        return_ty_text: ret_text,
                        return_ownership: Ownership::Owned,
                        return_referenced: ret_refs,
                        return_cardinality: ret_card,
                        lifetime_flows_through: false,
                        unsafe_blocks: 0,
                        doc_first_line: None,
                        span: Some(self.span(m.span)),
                        prev_span: None,
                        change_kind: None,
                        side: Default::default(),
                    });
                }
                _ => {}
            }
        }
        self.types.push(TypeFacts {
            name,
            full_path,
            kind: TypeKind::Interface,
            visibility: vis.to_string(),
            lifetime_params: Vec::new(),
            type_params: Vec::new(),
            derives: Vec::new(),
            fields,
            methods,
            trait_impls,
            unsafe_blocks: 0,
            doc_first_line: None,
            span: Some(span),
            prev_span: None,
            change_kind: None,
            side: Default::default(),
        });
    }

    fn emit_type_alias(&mut self, a: &TsTypeAliasDecl, vis: &str) {
        let name = a.id.sym.to_string();
        let full_path = self.fq(&name);
        self.types.push(TypeFacts {
            name,
            full_path,
            kind: TypeKind::TypeAlias,
            visibility: vis.to_string(),
            lifetime_params: Vec::new(),
            type_params: Vec::new(),
            derives: Vec::new(),
            fields: Vec::new(),
            methods: Vec::new(),
            trait_impls: Vec::new(),
            unsafe_blocks: 0,
            doc_first_line: None,
            span: Some(self.span(a.span)),
            prev_span: None,
            change_kind: None,
            side: Default::default(),
        });
    }

    fn emit_enum(&mut self, e: &TsEnumDecl, vis: &str) {
        let name = e.id.sym.to_string();
        let full_path = self.fq(&name);
        let fields: Vec<FieldFacts> = e
            .members
            .iter()
            .map(|m| {
                let variant_name = match &m.id {
                    swc_ecma_ast::TsEnumMemberId::Ident(i) => i.sym.to_string(),
                    swc_ecma_ast::TsEnumMemberId::Str(s) => s.value.to_atom_lossy().to_string(),
                };
                FieldFacts {
                    name: variant_name,
                    ty_text: String::new(),
                    ownership: Ownership::Primitive,
                    referenced: Vec::new(),
                    cardinality: Vec::new(),
                    lifetimes: Vec::new(),
                    span: Some(self.span(m.span)),
                    prev_span: None,
                    change_kind: None,
                    side: Default::default(),
                }
            })
            .collect();
        self.types.push(TypeFacts {
            name,
            full_path,
            kind: TypeKind::Enum,
            visibility: vis.to_string(),
            lifetime_params: Vec::new(),
            type_params: Vec::new(),
            derives: Vec::new(),
            fields,
            methods: Vec::new(),
            trait_impls: Vec::new(),
            unsafe_blocks: 0,
            doc_first_line: None,
            span: Some(self.span(e.span)),
            prev_span: None,
            change_kind: None,
            side: Default::default(),
        });
    }

    fn emit_fn(&mut self, name: &str, function: &swc_ecma_ast::Function, vis: &str) {
        let fn_facts = FnFacts {
            name: name.to_string(),
            impl_trait: None,
            visibility: vis.to_string(),
            self_kind: SelfKind::None,
            is_unsafe: false,
            is_const: false,
            is_async: function.is_async,
            lifetime_params: Vec::new(),
            params: function.params.iter().map(|p| self.param_facts(&p.pat)).collect(),
            return_ty_text: type_info(function.return_type.as_deref(), false).0,
            return_ownership: Ownership::Owned,
            return_referenced: type_info(function.return_type.as_deref(), false).1,
            return_cardinality: type_info(function.return_type.as_deref(), false).2,
            lifetime_flows_through: false,
            unsafe_blocks: 0,
            doc_first_line: None,
            span: Some(self.span(function.span)),
            prev_span: None,
            change_kind: None,
            side: Default::default(),
        };
        self.functions.push(fn_facts);
    }

    fn method_fn_facts(
        &self,
        name: &str,
        function: &swc_ecma_ast::Function,
        vis: &'static str,
    ) -> FnFacts {
        let (ret_text, ret_refs, ret_card) = type_info(function.return_type.as_deref(), false);
        FnFacts {
            name: name.to_string(),
            impl_trait: None,
            visibility: vis.to_string(),
            // TS methods have an implicit `this` receiver, but the
            // viewer renders `SelfKind::Ref` as the literal Rust text
            // `&self`, which is wrong syntax for TS. `None` reads as
            // an associated function in the viewer (no explicit
            // receiver row), matching how TS methods are written.
            self_kind: SelfKind::None,
            is_unsafe: false,
            is_const: false,
            is_async: function.is_async,
            lifetime_params: Vec::new(),
            params: function.params.iter().map(|p| self.param_facts(&p.pat)).collect(),
            return_ty_text: ret_text,
            return_ownership: Ownership::Owned,
            return_referenced: ret_refs,
            return_cardinality: ret_card,
            lifetime_flows_through: false,
            unsafe_blocks: 0,
            doc_first_line: None,
            span: Some(self.span(function.span)),
            prev_span: None,
            change_kind: None,
            side: Default::default(),
        }
    }

    fn param_facts(&self, pat: &swc_ecma_ast::Pat) -> ParamFacts {
        let (name, type_ann) = match pat {
            swc_ecma_ast::Pat::Ident(i) => (i.id.sym.to_string(), i.type_ann.as_deref()),
            _ => ("_".to_string(), None),
        };
        let (ty_text, refs, card) = type_info(type_ann, false);
        ParamFacts {
            name,
            ty_text,
            ownership: Ownership::Owned,
            referenced: refs,
            cardinality: card,
            lifetimes: Vec::new(),
        }
    }

    fn fq(&self, name: &str) -> String {
        if self.module_path.is_empty() {
            format!("{}::{}", self.crate_name, name)
        } else {
            format!("{}::{}::{}", self.crate_name, self.module_path, name)
        }
    }

    fn span(&self, sp: swc_common::Span) -> Span {
        let lo = self.cm.lookup_char_pos(sp.lo);
        let hi = self.cm.lookup_char_pos(sp.hi);
        Span {
            file: self.file.clone(),
            start_line: lo.line as u32,
            end_line: hi.line as u32,
        }
    }
}

/// Translate a swc `Accessibility` to the viewer's visibility token
/// vocabulary. `None` defaults to `pub` because TS class members are
/// public by default. `Protected` reuses the `pub(super)` slot per
/// the design decision (visible to a related scope — subclasses
/// here, parent module in Rust); `Private` collapses to `priv`.
fn accessibility_to_vis(a: Option<swc_ecma_ast::Accessibility>) -> &'static str {
    use swc_ecma_ast::Accessibility::*;
    match a {
        None | Some(Public) => "pub",
        Some(Protected) => "pub(super)",
        Some(Private) => "priv",
    }
}

/// Pretty-print a TS type, plus extract referenced names and per-ref
/// cardinality. `optional` is set by the caller (e.g. `x?: T`).
fn type_info(
    ann: Option<&TsTypeAnn>,
    optional: bool,
) -> (String, Vec<String>, Vec<Cardinality>) {
    let Some(ann) = ann else {
        return (String::new(), Vec::new(), Vec::new());
    };
    let mut refs: Vec<String> = Vec::new();
    let mut cards: Vec<Cardinality> = Vec::new();
    let base_card = if optional { Cardinality::Optional } else { Cardinality::One };
    classify_ts_type(&ann.type_ann, base_card, &mut refs, &mut cards);
    let text = render_ts_type(&ann.type_ann);
    (text, refs, cards)
}

fn classify_ts_type(
    ty: &TsType,
    card: Cardinality,
    refs: &mut Vec<String>,
    cards: &mut Vec<Cardinality>,
) {
    match ty {
        TsType::TsArrayType(TsArrayType { elem_type, .. }) => {
            classify_ts_type(elem_type, Cardinality::Many, refs, cards);
        }
        TsType::TsUnionOrIntersectionType(u) => {
            // `T | undefined` / `T | null` → optional; otherwise treat
            // members independently with the inherited cardinality.
            if let swc_ecma_ast::TsUnionOrIntersectionType::TsUnionType(TsUnionType { types, .. }) =
                u
            {
                let has_nullish = types.iter().any(|t| is_nullish_keyword(t));
                let inner_card = if has_nullish { Cardinality::Optional } else { card };
                for t in types {
                    if is_nullish_keyword(t) {
                        continue;
                    }
                    classify_ts_type(t, inner_card, refs, cards);
                }
            }
        }
        TsType::TsTypeRef(TsTypeRef { type_name, type_params, .. }) => {
            let name = entity_name_to_string(type_name);
            // Container-aware cardinality for well-known generics.
            let (effective_card, descend_args): (Cardinality, bool) =
                match (name.as_str(), type_params.as_deref()) {
                    ("Array" | "ReadonlyArray" | "Set" | "ReadonlySet", Some(_)) => {
                        (Cardinality::Many, true)
                    }
                    ("Map" | "ReadonlyMap" | "Record", Some(_)) => (Cardinality::ManyKeyed, true),
                    ("Promise", Some(_)) => (card, true),
                    ("Partial" | "Readonly" | "NonNullable", Some(_)) => (card, true),
                    _ => (card, false),
                };
            if !is_builtin_type(&name) {
                refs.push(name);
                cards.push(effective_card);
            }
            if descend_args {
                if let Some(tp) = type_params {
                    for p in &tp.params {
                        classify_ts_type(p, effective_card, refs, cards);
                    }
                }
            }
        }
        _ => {
            // Tuples, fn types, mapped types, literals, etc. — not
            // modeled in the first cut. They don't surface named
            // refs; we leave them out rather than guessing.
        }
    }
}

fn is_nullish_keyword(ty: &TsType) -> bool {
    matches!(
        ty,
        TsType::TsKeywordType(TsKeywordType {
            kind: TsKeywordTypeKind::TsUndefinedKeyword | TsKeywordTypeKind::TsNullKeyword,
            ..
        })
    )
}

fn is_builtin_type(name: &str) -> bool {
    matches!(
        name,
        "string"
            | "number"
            | "boolean"
            | "bigint"
            | "symbol"
            | "void"
            | "any"
            | "unknown"
            | "never"
            | "object"
            | "null"
            | "undefined"
            | "Date"
            | "RegExp"
            | "Error"
            | "Function"
            | "Object"
            | "String"
            | "Number"
            | "Boolean"
            // Container generics — the classify pass descends into
            // their type parameters and emits edges to the inner type.
            // Filtering the container name itself prevents a spurious
            // edge to "Map" / "Set" / "Array" appearing in the graph.
            | "Array"
            | "ReadonlyArray"
            | "Set"
            | "ReadonlySet"
            | "Map"
            | "ReadonlyMap"
            | "Record"
            | "Promise"
            | "Partial"
            | "Readonly"
            | "NonNullable"
            | "Required"
    )
}

fn entity_name_to_string(name: &TsEntityName) -> String {
    match name {
        TsEntityName::Ident(i) => i.sym.to_string(),
        TsEntityName::TsQualifiedName(q) => {
            format!("{}.{}", entity_name_to_string(&q.left), q.right.sym)
        }
    }
}

/// Best-effort: only the root identifier of `Foo.Bar.Baz`.
fn ts_entity_name_root(expr: &swc_ecma_ast::Expr) -> Option<String> {
    match expr {
        swc_ecma_ast::Expr::Ident(i) => Some(i.sym.to_string()),
        swc_ecma_ast::Expr::Member(m) => ts_entity_name_root(&m.obj),
        swc_ecma_ast::Expr::TsInstantiation(t) => ts_entity_name_root(&t.expr),
        _ => None,
    }
}

fn expr_name(e: &swc_ecma_ast::Expr) -> Option<String> {
    ts_entity_name_root(e)
}

/// Pretty-print a TS type to a short string. Not exhaustive — the goal
/// is "human-readable for the viewer", not roundtrip fidelity.
fn render_ts_type(ty: &TsType) -> String {
    match ty {
        TsType::TsKeywordType(k) => match k.kind {
            TsKeywordTypeKind::TsStringKeyword => "string".into(),
            TsKeywordTypeKind::TsNumberKeyword => "number".into(),
            TsKeywordTypeKind::TsBooleanKeyword => "boolean".into(),
            TsKeywordTypeKind::TsVoidKeyword => "void".into(),
            TsKeywordTypeKind::TsAnyKeyword => "any".into(),
            TsKeywordTypeKind::TsUnknownKeyword => "unknown".into(),
            TsKeywordTypeKind::TsNeverKeyword => "never".into(),
            TsKeywordTypeKind::TsNullKeyword => "null".into(),
            TsKeywordTypeKind::TsUndefinedKeyword => "undefined".into(),
            TsKeywordTypeKind::TsBigIntKeyword => "bigint".into(),
            TsKeywordTypeKind::TsSymbolKeyword => "symbol".into(),
            TsKeywordTypeKind::TsObjectKeyword => "object".into(),
            _ => "?".into(),
        },
        TsType::TsArrayType(a) => format!("{}[]", render_ts_type(&a.elem_type)),
        TsType::TsTypeRef(r) => {
            let name = entity_name_to_string(&r.type_name);
            match &r.type_params {
                Some(tp) => {
                    let inner: Vec<String> = tp.params.iter().map(|p| render_ts_type(p)).collect();
                    format!("{}<{}>", name, inner.join(", "))
                }
                None => name,
            }
        }
        TsType::TsUnionOrIntersectionType(u) => match u {
            swc_ecma_ast::TsUnionOrIntersectionType::TsUnionType(u) => u
                .types
                .iter()
                .map(|t| render_ts_type(t))
                .collect::<Vec<_>>()
                .join(" | "),
            swc_ecma_ast::TsUnionOrIntersectionType::TsIntersectionType(i) => i
                .types
                .iter()
                .map(|t| render_ts_type(t))
                .collect::<Vec<_>>()
                .join(" & "),
        },
        _ => "<expr>".into(),
    }
}

/// Resolve a short type name to the full path of a known type in the
/// workspace, when there is exactly one match. Returns the short name
/// unchanged when there is no match or multiple matches — the viewer
/// already tolerates dangling edge targets.
fn resolve_ref(name: &str, registry: &std::collections::BTreeMap<String, Vec<String>>) -> String {
    match registry.get(name) {
        Some(paths) if paths.len() == 1 => paths[0].clone(),
        _ => name.to_string(),
    }
}

fn build_registry(
    ws: &WorkspaceFacts,
) -> std::collections::BTreeMap<String, Vec<String>> {
    let mut reg: std::collections::BTreeMap<String, Vec<String>> = Default::default();
    for cf in ws.crates.values() {
        for m in cf.modules.values() {
            for t in &m.types {
                reg.entry(t.name.clone()).or_default().push(t.full_path.clone());
            }
        }
    }
    reg
}

fn build_edges(ws: &WorkspaceFacts) -> Vec<Edge> {
    let registry = build_registry(ws);
    let mut edges = Vec::new();
    for cf in ws.crates.values() {
        for m in cf.modules.values() {
            for ty in &m.types {
                let from = ty.full_path.clone();
                // extends — only one parent class allowed in TS.
                for d in &ty.derives {
                    if let Some(parent) = d.strip_prefix("@extends ") {
                        edges.push(Edge {
                            from: from.clone(),
                            to: resolve_ref(parent, &registry),
                            kind: EdgeKind::Extends,
                            via: ViaKind::TraitImplBlock,
                            cardinality: Cardinality::One,
                            origin: format!("extends {parent}"),
                            side: Default::default(),
                        });
                    }
                }
                // implements (class) / extends (interface) — TraitImpl.
                for impl_name in &ty.trait_impls {
                    edges.push(Edge {
                        from: from.clone(),
                        to: resolve_ref(impl_name, &registry),
                        kind: EdgeKind::TraitImpl,
                        via: ViaKind::TraitImplBlock,
                        cardinality: Cardinality::One,
                        origin: format!("implements {impl_name}"),
                        side: Default::default(),
                    });
                }
                // Field refs — Owns edges only (TS has no borrow).
                let via = match ty.kind {
                    TypeKind::Class | TypeKind::Interface => ViaKind::StructField,
                    _ => continue,
                };
                for f in &ty.fields {
                    for (i, refname) in f.referenced.iter().enumerate() {
                        let card = f.cardinality.get(i).copied().unwrap_or(Cardinality::One);
                        edges.push(Edge {
                            from: from.clone(),
                            to: resolve_ref(refname, &registry),
                            kind: EdgeKind::Owns,
                            via,
                            cardinality: card,
                            origin: format!("field {}", f.name),
                            side: Default::default(),
                        });
                    }
                }
            }
        }
    }
    edges
}

fn build_profiles(
    edges: &[Edge],
) -> std::collections::BTreeMap<String, crate::model::EdgeProfile> {
    use crate::model::EdgeProfile;
    let mut out: std::collections::BTreeMap<String, EdgeProfile> = Default::default();
    for e in edges {
        let from = out.entry(e.from.clone()).or_default();
        let kind_key = serde_json::to_value(e.kind)
            .ok()
            .and_then(|v| v.as_str().map(|s| s.to_string()))
            .unwrap_or_default();
        *from.outbound.entry(kind_key.clone()).or_insert(0) += 1;
        let to = out.entry(e.to.clone()).or_default();
        *to.inbound.entry(kind_key).or_insert(0) += 1;
    }
    out
}
