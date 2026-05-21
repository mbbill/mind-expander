//! TypeScript call-graph extraction. Mirrors the shape of the Rust
//! [`crate::callgraph::SynCallGraphProvider`] but for swc ASTs.
//!
//! Strategy: re-parse every `.ts` / `.tsx` file in every package, run
//! a [`CallVisitor`] that tracks the currently-enclosing function or
//! method as a caller stack, and emit one [`CallEdge`] per
//! `CallExpression` and `NewExpression` it observes. After collection,
//! resolve each callee against a workspace function/method registry
//! and tag the resolution as `Exact` (one match), `Heuristic` (no
//! match — best textual guess), or `Ambiguous` (multiple matches).
//!
//! Limitations (same as the Rust side):
//! - Receiver type for `obj.foo()` is not inferred, so method calls
//!   resolve textually and become `Heuristic`/`Ambiguous` whenever
//!   the method name is shared across types.
//! - Cross-file imports are not modelled; identifiers are matched
//!   against the global short-name → FQ-paths registry. Works when
//!   names are workspace-unique, falls back to heuristic otherwise.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
use walkdir::WalkDir;

use swc_common::{sync::Lrc, FileName, SourceMap};
use swc_ecma_ast::{
    CallExpr, Callee, ClassDecl, ClassMethod, Constructor, EsVersion, Expr, FnDecl, MemberProp,
    NewExpr, SuperProp, SuperPropExpr,
};
use swc_ecma_parser::{lexer::Lexer, Parser, StringInput, Syntax, TsSyntax};
use swc_ecma_visit::{Visit, VisitWith};

use super::{file_to_module_path, is_ts_source, PackageRoot};
use crate::model::{CallEdge, CallKind, CallResolution, WorkspaceFacts};

type Registry = BTreeMap<String, Vec<String>>;

/// Walk every package, parse every source file, and collect call
/// edges. Returns the merged vector ready to drop into
/// `WorkspaceFacts.call_edges`.
pub(super) fn extract_workspace_calls(
    packages: &[PackageRoot],
    ws: &WorkspaceFacts,
) -> Result<Vec<CallEdge>> {
    let registry = build_fn_registry(ws);
    let mut out: Vec<CallEdge> = Vec::new();
    for pkg in packages {
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
            extract_file_calls(&pkg.name, &module_path, path, &registry, &mut out)
                .with_context(|| format!("call extraction in {}", path.display()))?;
        }
    }
    Ok(out)
}

/// Short-name → FQ-path registry across the whole workspace. The
/// registry maps both type names (so `new Server(...)` resolves to
/// `crate::module::Server::constructor`) and function/method names
/// (so `foo(...)` and `.bar()` resolve to their `crate::...::name`).
fn build_fn_registry(ws: &WorkspaceFacts) -> Registry {
    let mut reg: Registry = Default::default();
    for cf in ws.crates.values() {
        for m in cf.modules.values() {
            // Free functions live directly under the module.
            for f in &m.functions {
                let fq = if m.path.is_empty() {
                    format!("{}::{}", cf.name, f.name)
                } else {
                    format!("{}::{}::{}", cf.name, m.path, f.name)
                };
                reg.entry(f.name.clone()).or_default().push(fq);
            }
            // Class / interface methods + constructors.
            for t in &m.types {
                for fn_ in &t.methods {
                    let fq = format!("{}::{}", t.full_path, fn_.name);
                    reg.entry(fn_.name.clone()).or_default().push(fq);
                }
                // Also index the type name itself for `new Type(...)`
                // → `Type::constructor` resolution downstream.
                reg.entry(t.name.clone()).or_default().push(t.full_path.clone());
            }
        }
    }
    reg
}

fn extract_file_calls(
    crate_name: &str,
    module_path: &str,
    path: &Path,
    registry: &Registry,
    out: &mut Vec<CallEdge>,
) -> Result<()> {
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
    let lexer = Lexer::new(syntax, EsVersion::Es2022, StringInput::from(&*fm), None);
    let mut parser = Parser::new_from(lexer);
    let module = parser
        .parse_module()
        .map_err(|e| anyhow::anyhow!("swc parse error: {:?}", e.kind()))?;

    let mut visitor = CallVisitor {
        cm: cm.clone(),
        crate_name: crate_name.to_string(),
        module_path: module_path.to_string(),
        caller_stack: Vec::new(),
        class_stack: Vec::new(),
        registry,
        edges: Vec::new(),
    };
    module.visit_with(&mut visitor);
    out.extend(visitor.edges);
    Ok(())
}

struct CallVisitor<'a> {
    cm: Lrc<SourceMap>,
    crate_name: String,
    module_path: String,
    /// Stack of fully-qualified caller paths. Empty stack = call seen
    /// at top level (e.g. module init code) — we skip those because
    /// there's no caller entity to attach the edge to.
    caller_stack: Vec<String>,
    /// Stack of fully-qualified class names being walked. Used to
    /// resolve `this.foo()` against the enclosing class's methods.
    class_stack: Vec<String>,
    registry: &'a Registry,
    edges: Vec<CallEdge>,
}

impl<'a> CallVisitor<'a> {
    fn fq(&self, name: &str) -> String {
        if self.module_path.is_empty() {
            format!("{}::{}", self.crate_name, name)
        } else {
            format!("{}::{}::{}", self.crate_name, self.module_path, name)
        }
    }

    fn line_range(&self, sp: swc_common::Span) -> (u32, u32) {
        let lo = self.cm.lookup_char_pos(sp.lo);
        let hi = self.cm.lookup_char_pos(sp.hi);
        (lo.line as u32, hi.line as u32)
    }

    /// Resolve `callee_short` against the registry. The optional
    /// `hint` is a fully-qualified prefix used when the call has
    /// structural context (e.g. `this.foo` inside class `C` → try
    /// `C::foo` first before falling back to global lookup).
    fn resolve(&self, callee_short: &str, hint: Option<&str>) -> (String, CallResolution) {
        if let Some(prefix) = hint {
            let expected = format!("{prefix}::{callee_short}");
            if let Some(matches) = self.registry.get(callee_short) {
                if matches.iter().any(|m| m == &expected) {
                    return (expected, CallResolution::Exact);
                }
            }
        }
        match self.registry.get(callee_short) {
            None => (callee_short.to_string(), CallResolution::Heuristic),
            Some(matches) if matches.len() == 1 => (matches[0].clone(), CallResolution::Exact),
            Some(_) => (callee_short.to_string(), CallResolution::Ambiguous),
        }
    }

    /// Inspect a callee `Expr` and emit a CallEdge if the caller
    /// stack is non-empty. `span` is the whole call-expression span.
    fn emit_for_callee(&mut self, callee_expr: &Expr, span: swc_common::Span) {
        let Some(caller) = self.caller_stack.last().cloned() else {
            return;
        };
        let (origin, kind, callee_short, hint): (String, CallKind, String, Option<String>) =
            match callee_expr {
                Expr::Ident(i) => {
                    let name = i.sym.to_string();
                    (name.clone(), CallKind::Function, name, None)
                }
                Expr::Member(m) => {
                    // The rightmost segment is the callee name. The
                    // receiver shape (Ident vs This) decides kind.
                    let prop_name = match &m.prop {
                        MemberProp::Ident(i) => i.sym.to_string(),
                        // Computed members like `obj["foo"]()` are
                        // dynamic; we can't extract a stable name.
                        _ => return,
                    };
                    let (kind, hint) = match &*m.obj {
                        // `this.foo()` — hint is the enclosing class.
                        Expr::This(_) => (CallKind::Method, self.class_stack.last().cloned()),
                        // `Type.foo()` — looks like a static call.
                        Expr::Ident(i) => {
                            let recv = i.sym.to_string();
                            let starts_upper = recv
                                .chars()
                                .next()
                                .map(|c| c.is_ascii_uppercase())
                                .unwrap_or(false);
                            if starts_upper {
                                // Classic UpperCamelCase identifier =
                                // probably a class/namespace. Use the
                                // receiver as the hint so we prefer
                                // `Type::foo` resolutions when the
                                // global short-name set has many
                                // entries.
                                (CallKind::AssociatedFunction, lookup_fq_for_type(self.registry, &recv))
                            } else {
                                (CallKind::Method, None)
                            }
                        }
                        _ => (CallKind::Method, None),
                    };
                    let origin = origin_text_for_member(m);
                    (origin, kind, prop_name, hint)
                }
                Expr::SuperProp(SuperPropExpr { prop, .. }) => {
                    // `super.foo(...)` — like `this.foo` but resolves
                    // against the parent class. We don't model
                    // inheritance for resolution; emit a heuristic.
                    let prop_name = match prop {
                        SuperProp::Ident(i) => i.sym.to_string(),
                        SuperProp::Computed(_) => return,
                    };
                    (
                        format!("super.{prop_name}"),
                        CallKind::Method,
                        prop_name,
                        None,
                    )
                }
                // Higher-order calls (`(expr)(args)`, `arr[0]()`,
                // function expressions, etc.) have no stable callee
                // name. Skipping mirrors the Rust visitor.
                _ => return,
            };
        let (callee_fq, resolution) = self.resolve(&callee_short, hint.as_deref());
        let (start, end) = self.line_range(span);
        self.edges.push(CallEdge {
            caller,
            callee: callee_fq,
            kind,
            resolution,
            origin,
            callsite_start_line: start,
            callsite_end_line: end,
            side: Default::default(),
        });
    }
}

/// Resolve a UPPERCASE identifier (likely a class name) to its
/// fully-qualified path. Used to seed the `hint` in
/// `Type.foo()`-style calls so the registry lookup prefers
/// `Type::foo` over collisions in other classes.
fn lookup_fq_for_type(registry: &Registry, short: &str) -> Option<String> {
    match registry.get(short) {
        Some(matches) if matches.len() == 1 => Some(matches[0].clone()),
        _ => None,
    }
}

fn origin_text_for_member(m: &swc_ecma_ast::MemberExpr) -> String {
    let prop = match &m.prop {
        MemberProp::Ident(i) => i.sym.to_string(),
        MemberProp::Computed(_) => "[…]".to_string(),
        MemberProp::PrivateName(p) => format!("#{}", p.name),
    };
    match &*m.obj {
        Expr::Ident(i) => format!("{}.{prop}", i.sym),
        Expr::This(_) => format!("this.{prop}"),
        _ => format!(".{prop}"),
    }
}

impl<'a> Visit for CallVisitor<'a> {
    fn visit_fn_decl(&mut self, n: &FnDecl) {
        let fq = self.fq(&n.ident.sym);
        self.caller_stack.push(fq);
        n.visit_children_with(self);
        self.caller_stack.pop();
    }

    fn visit_class_decl(&mut self, n: &ClassDecl) {
        let fq = self.fq(&n.ident.sym);
        self.class_stack.push(fq);
        n.visit_children_with(self);
        self.class_stack.pop();
    }

    fn visit_class_method(&mut self, n: &ClassMethod) {
        let method_name = match &n.key {
            swc_ecma_ast::PropName::Ident(i) => Some(i.sym.to_string()),
            swc_ecma_ast::PropName::Str(s) => Some(s.value.to_atom_lossy().to_string()),
            _ => None,
        };
        if let (Some(name), Some(class_fq)) = (method_name, self.class_stack.last().cloned()) {
            self.caller_stack.push(format!("{class_fq}::{name}"));
            n.visit_children_with(self);
            self.caller_stack.pop();
        } else {
            n.visit_children_with(self);
        }
    }

    fn visit_constructor(&mut self, n: &Constructor) {
        if let Some(class_fq) = self.class_stack.last().cloned() {
            self.caller_stack.push(format!("{class_fq}::constructor"));
            n.visit_children_with(self);
            self.caller_stack.pop();
        } else {
            n.visit_children_with(self);
        }
    }

    fn visit_call_expr(&mut self, n: &CallExpr) {
        if let Callee::Expr(callee) = &n.callee {
            self.emit_for_callee(callee, n.span);
        }
        // Recurse so calls nested in argument expressions are also
        // captured.
        n.visit_children_with(self);
    }

    fn visit_new_expr(&mut self, n: &NewExpr) {
        // `new Type(args)` resolves to `Type::constructor`.
        if let Expr::Ident(i) = &*n.callee {
            if let Some(caller) = self.caller_stack.last().cloned() {
                let recv = i.sym.to_string();
                let class_fq = lookup_fq_for_type(self.registry, &recv);
                let callee_fq = match &class_fq {
                    Some(fq) => format!("{fq}::constructor"),
                    None => format!("{recv}::constructor"),
                };
                let resolution = if class_fq.is_some() {
                    CallResolution::Exact
                } else {
                    CallResolution::Heuristic
                };
                let (start, end) = self.line_range(n.span);
                self.edges.push(CallEdge {
                    caller,
                    callee: callee_fq,
                    kind: CallKind::AssociatedFunction,
                    resolution,
                    origin: format!("new {recv}"),
                    callsite_start_line: start,
                    callsite_end_line: end,
                    side: Default::default(),
                });
            }
        }
        n.visit_children_with(self);
    }
}
