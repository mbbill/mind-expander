//! Workspace traversal and per-file parsing with `syn`.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use rayon::prelude::*;
use syn::spanned::Spanned;
use syn::visit::Visit;
use syn::{
    File, ImplItem, Item, ItemEnum, ItemImpl, ItemMod, ItemStruct, ItemTrait, ItemType, ItemUnion,
    ItemUse, ReturnType, UseTree,
};
use walkdir::WalkDir;

use crate::callgraph::SynCallGraphProvider;
use crate::model::{
    CrateFacts, Edge, EdgeKind, EdgeProfile, FieldFacts, FnFacts, ModuleFacts, Ownership,
    ParamFacts, ReExport, ReExportKind, SelfKind, Span, TypeFacts, TypeKind, ViaKind,
    WorkspaceFacts,
};

/// Canonical type-kind lookup keyed by full path. Built once per
/// workspace and consumed by the re-export resolver to stamp the
/// canonical's `TypeKind` onto each `ReExport` it produces.
type TypeKindByPath = BTreeMap<String, TypeKind>;
use crate::resolve::{classify, type_text};

/// Cache schema version. Bump whenever any of `ModuleFacts`,
/// `PendingReExport`, `Span`, or other serialized fields change
/// in a way that would make older cache files mis-deserialize.
/// Cache files with a different version are silently discarded
/// and rebuilt — no migration logic.
const FACTS_CACHE_VERSION: u32 = 1;

/// Per-file slice of pass-1 entity extraction. Keyed by absolute
/// file path; validated by `(mtime_ns, size)` on read so an edit
/// that changes a file's contents always misses the cache.
#[derive(serde::Serialize, serde::Deserialize)]
struct CachedFile {
    mtime_ns: i128,
    size: u64,
    crate_name: String,
    module_path: String,
    modules: BTreeMap<String, ModuleFacts>,
    pending_re_exports: BTreeMap<String, Vec<PendingReExport>>,
}

/// One workspace's on-disk facts cache. The `cargo install` location
/// of the binary changes between releases, so a release with a
/// changed extractor would still mis-deserialize old cache files —
/// `version` defends against that.
#[derive(serde::Serialize, serde::Deserialize)]
struct FactsCache {
    version: u32,
    /// Pass-1 cache, file-by-file. Keyed by absolute file path as a
    /// string so the on-disk representation is portable.
    files: BTreeMap<String, CachedFile>,
    /// Pass-2 (call graph) cache + the per-entity edge list. These
    /// depend on the whole-workspace registry, so they're only valid
    /// when every entry in `files` produced a cache hit (i.e. nothing
    /// changed since the previous run).
    workspace_signature: u64,
    call_edges: Vec<crate::model::CallEdge>,
    edges: Vec<Edge>,
    edge_profiles: BTreeMap<String, EdgeProfile>,
}

/// Stable hash of (file path, mtime, size) for every source file —
/// distinguishes "the workspace is exactly as it was last run" from
/// "one file changed." If this matches the cache's value, the cached
/// `call_edges` / `edges` / `edge_profiles` can be reused wholesale;
/// otherwise the registry might have shifted underneath them.
///
/// Takes the `(path, mtime_ns, size)` tuples already gathered during
/// pass 1 (each file is stat'd exactly once, there) rather than
/// re-stat'ing — sorts them for order-independence, then folds them
/// into the hash behind the cache version.
fn workspace_signature(entries: &mut [(String, i128, u64)]) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    FACTS_CACHE_VERSION.hash(&mut h);
    entries.sort();
    for e in entries.iter() {
        e.hash(&mut h);
    }
    h.finish()
}

/// Root directory holding every workspace's facts cache. Shares the
/// cache root with the git worktrees (`crate::git_view`) so all of
/// mind-expander's on-disk state lives under one tree.
fn facts_cache_base() -> Option<PathBuf> {
    crate::git_view::dirs_cache_dir()
        .ok()
        .map(|base| base.join("mind-expander").join("facts"))
}

/// Workspace cache file path. Workspaces are keyed by a hash of
/// their absolute root path so two projects don't share a cache. For
/// a materialized worktree the root path already embeds the commit
/// SHA, so each git revision gets its own cache file automatically.
fn cache_file_path(workspace_root: &Path) -> Option<PathBuf> {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    workspace_root.display().to_string().hash(&mut h);
    let key = format!("{:016x}", h.finish());
    Some(
        facts_cache_base()?
            .join(key)
            .join(format!("v{FACTS_CACHE_VERSION}.json")),
    )
}

/// Best-effort GC of the facts cache. Keeps the `keep` most-recently
/// written workspace caches (by the cache file's mtime) and removes
/// the rest. Never touches `current` (the cache about to be used) and
/// never fails extraction — disk hygiene only.
///
/// SHA-keyed worktree caches are immutable single-use artifacts
/// (reviewed once, rarely again) so their mtimes age out first; the
/// live working-tree cache is rewritten whenever files change, so it
/// stays recent and survives. That's the eviction order we want.
fn prune_facts_cache(keep: usize, current: Option<&Path>) {
    let Some(base) = facts_cache_base() else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(&base) else {
        return;
    };
    // Each workspace cache is `<base>/<hash>/vN.json`. Collect the
    // workspace dirs paired with their cache file's mtime.
    let mut dirs: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let cache_file = dir.join(format!("v{FACTS_CACHE_VERSION}.json"));
        let mtime = std::fs::metadata(&cache_file)
            .and_then(|m| m.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        dirs.push((mtime, dir));
    }
    if dirs.len() <= keep {
        return;
    }
    // Newest first; drop everything past `keep` except the current one.
    dirs.sort_by(|a, b| b.0.cmp(&a.0));
    let current_dir = current.and_then(|p| p.parent());
    for (_, dir) in dirs.into_iter().skip(keep) {
        if Some(dir.as_path()) == current_dir {
            continue;
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}

fn load_cache(path: &Path) -> Option<FactsCache> {
    // JSON (not bincode) because `ModuleFacts` and its transitive
    // fields use `#[serde(skip_serializing_if = ...)]`, which bincode
    // and other binary formats cannot reliably round-trip — a skipped
    // field on serialize is read as the *next* field's discriminant
    // on deserialize, producing "tag for enum is not valid" errors.
    // JSON is bigger and slower to parse but the only format that
    // honors `skip_serializing_if` natively.
    let bytes = std::fs::read(path).ok()?;
    let cache: FactsCache = serde_json::from_slice(&bytes).ok()?;
    if cache.version != FACTS_CACHE_VERSION {
        return None;
    }
    Some(cache)
}

fn save_cache(path: &Path, cache: &FactsCache) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(bytes) = serde_json::to_vec(cache) {
        // Atomic-ish write: tmp + rename. Best-effort — a failure
        // here just means the next run rebuilds from scratch.
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, &bytes).is_ok() {
            let _ = std::fs::rename(&tmp, path);
        }
    }
}

/// Per-file metadata used to drive both the entity extractor and
/// the call-graph extractor. Holds only `Send` data so the parallel
/// passes can each `par_iter` over a shared `&[SourceFile]`.
///
/// We don't cache the parsed `syn::File` across passes because syn
/// ASTs aren't `Send` (proc-macro2 bridges to the compiler's
/// non-thread-safe `Span` type whenever the `proc-macro` feature is
/// enabled, which Cargo's feature unification forces on for any
/// workspace that pulls in syn-using proc-macros — async-trait,
/// clap_derive, etc.). The two passes therefore re-parse per file,
/// but each pass runs `par_iter`, so the wall-clock cost on an
/// 8-core machine still beats a sequential single-parse pipeline by
/// a wide margin.
pub(crate) struct SourceFile {
    pub(crate) crate_name: String,
    pub(crate) file: PathBuf,
    pub(crate) module_path: String,
}

pub fn extract_workspace(root: &Path) -> Result<WorkspaceFacts> {
    let crates = discover_crates(root)?;
    let mut workspace = WorkspaceFacts {
        crates: BTreeMap::new(),
        edges: Vec::new(),
        call_edges: Vec::new(),
        edge_profiles: BTreeMap::new(),
    };

    // Pending re-exports — collected per file during the walk, resolved
    // at the end of this function once the global type/function registry
    // is built. Keyed by (crate_name, module_path) so we can route the
    // resolved entries back to the right `ModuleFacts`.
    let mut pending_re_exports: BTreeMap<(String, String), Vec<PendingReExport>> = BTreeMap::new();

    // Discover every .rs source file across every crate (sequential,
    // tiny cost). Parsing + visiting happens in parallel below.
    let mut source_files: Vec<SourceFile> = Vec::new();
    for (name, crate_root) in &crates {
        for path in discover_rs_files(crate_root) {
            let module_path = derive_module_path(crate_root, &path);
            source_files.push(SourceFile {
                crate_name: name.clone(),
                file: path,
                module_path,
            });
        }
        workspace
            .crates
            .insert(name.clone(), empty_crate_facts(name, crate_root));
    }

    // Load the cross-session cache. (The workspace signature is
    // computed *after* pass 1 from the per-file stats it already
    // gathers — see below — so we don't stat every file twice.)
    let cache_path = cache_file_path(root);
    let cache: Option<FactsCache> = cache_path.as_deref().and_then(load_cache);

    // GC old workspace caches (best-effort, never touches the current
    // one). Cheap directory scan; only deletes when over budget.
    prune_facts_cache(24, cache_path.as_deref());

    // Pass 1 — for each file, stat it ONCE, then return either the
    // cached pass-1 output (mtime + size match) or a freshly parsed
    // one. Run in parallel. Each result carries `(path, mtime, size)`
    // for the workspace signature plus an optional `CachedFile`
    // (`None` when the file failed to parse — it still contributes to
    // the signature so a fix that makes it parseable busts the cache).
    type PassOne = (String, i128, u64, Option<CachedFile>);
    let per_file: Vec<PassOne> = source_files
        .par_iter()
        .map(|sf| -> Result<PassOne> {
            let path_key = sf.file.display().to_string();
            let meta = std::fs::metadata(&sf.file)
                .with_context(|| format!("stat {}", sf.file.display()))?;
            let size = meta.len();
            let mtime_ns: i128 = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_nanos() as i128)
                .unwrap_or(0);

            // Cache hit — same file content as last run.
            if let Some(cached) = cache.as_ref().and_then(|c| c.files.get(&path_key)) {
                if cached.mtime_ns == mtime_ns
                    && cached.size == size
                    && cached.crate_name == sf.crate_name
                    && cached.module_path == sf.module_path
                {
                    let row = CachedFile {
                        mtime_ns,
                        size,
                        crate_name: cached.crate_name.clone(),
                        module_path: cached.module_path.clone(),
                        modules: cached.modules.clone(),
                        pending_re_exports: cached.pending_re_exports.clone(),
                    };
                    return Ok((path_key, mtime_ns, size, Some(row)));
                }
            }

            // Cache miss — parse + visit.
            let src = std::fs::read_to_string(&sf.file)
                .with_context(|| format!("reading {}", sf.file.display()))?;
            let ast: File = match syn::parse_file(&src) {
                Ok(f) => f,
                Err(_) => return Ok((path_key, mtime_ns, size, None)),
            };
            let mut ctx = Ctx {
                crate_name: sf.crate_name.clone(),
                file: sf.file.display().to_string(),
                module_stack: vec![sf.module_path.clone()],
                modules: BTreeMap::new(),
                pending_re_exports: BTreeMap::new(),
            };
            ctx.ensure_module(&sf.module_path);
            for item in &ast.items {
                ctx.visit_item(item);
            }
            let row = CachedFile {
                mtime_ns,
                size,
                crate_name: sf.crate_name.clone(),
                module_path: sf.module_path.clone(),
                modules: ctx.modules,
                pending_re_exports: ctx.pending_re_exports,
            };
            Ok((path_key, mtime_ns, size, Some(row)))
        })
        .collect::<Result<Vec<_>>>()?;

    // Workspace signature from the stats pass 1 already gathered (one
    // stat per file, no second sweep). If it matches the cached one,
    // every file is byte-identical to the previous run, so the cache
    // on disk is already exactly what we'd write back — we can reuse
    // the cached call graph and skip the multi-MB rewrite.
    let mut sig_entries: Vec<(String, i128, u64)> = per_file
        .iter()
        .map(|(path, mtime, size, _)| (path.clone(), *mtime, *size))
        .collect();
    let signature = workspace_signature(&mut sig_entries);
    let signature_matches = cache
        .as_ref()
        .map(|c| c.workspace_signature == signature)
        .unwrap_or(false);

    // Merge per-file outputs into the workspace AND collect the new
    // cache index in one pass. We clone the maps off the row so the
    // row itself can move into `new_cache_files` for later write-back.
    let mut new_cache_files: BTreeMap<String, CachedFile> = BTreeMap::new();
    for (path_key, _, _, row) in per_file {
        let Some(row) = row else { continue };
        let crate_name = row.crate_name.clone();
        let cf = workspace
            .crates
            .get_mut(&crate_name)
            .expect("crate registered above");
        for (path, m) in &row.modules {
            cf.modules
                .entry(path.clone())
                .and_modify(|existing| merge_module(existing, m))
                .or_insert_with(|| m.clone());
        }
        for (mod_path, pendings_list) in &row.pending_re_exports {
            pending_re_exports
                .entry((crate_name.clone(), mod_path.clone()))
                .or_default()
                .extend(pendings_list.iter().cloned());
        }
        new_cache_files.insert(path_key, row);
    }

    // Build the global type registry: short-name -> set of canonical paths.
    let registry = build_type_registry(&workspace);
    let fn_registry = build_fn_registry(&workspace);
    let type_kinds = build_type_kinds(&workspace);

    // Resolve pending re-exports against the registries and attach the
    // ones we can resolve to their owning ModuleFacts. Unresolvable
    // entries (external crates, macro-emitted names, etc.) are silently
    // dropped — they're not actionable for a crate-local view.
    for ((crate_name, module_path), pendings) in pending_re_exports {
        let Some(cf) = workspace.crates.get_mut(&crate_name) else {
            continue;
        };
        let Some(module) = cf.modules.get_mut(&module_path) else {
            continue;
        };
        let source = if module_path.is_empty() {
            crate_name.clone()
        } else {
            format!("{crate_name}::{module_path}")
        };
        for p in pendings {
            if let Some(re) = resolve_re_export(&p, &registry, &fn_registry, &type_kinds, &source) {
                module.re_exports.push(re);
            }
        }
    }

    // Build edges by re-scanning every type, function, and impl across all
    // crates. We carry the source full-path so edges have a `from` anchor.
    let mut edges = Vec::new();
    for cf in workspace.crates.values() {
        for module in cf.modules.values() {
            for ty in &module.types {
                emit_edges_from_type(ty, &registry, &mut edges);
            }
            for f in &module.functions {
                let from = format!("{}::{}::{}", cf.name, module.path, f.name);
                let from = from.replace("::::", "::");
                emit_edges_from_fn(&from, f, &registry, &mut edges);
            }
        }
    }

    workspace.edge_profiles = build_profiles(&edges);
    workspace.edges = edges;

    // Pass 2 — call graph. If the workspace signature matches the
    // cached one, NOTHING has changed since the previous run, so
    // every call edge's resolution is identical and we can use the
    // cached vector. Otherwise re-run the (parallel) call-graph pass.
    if signature_matches {
        // Safe to unwrap — `signature_matches` implies cache is Some.
        let c = cache.as_ref().unwrap();
        workspace.call_edges = c.call_edges.clone();
        // edges/edge_profiles were just rebuilt from cached modules,
        // which should be identical to the cached snapshot. We could
        // assert equality, but the rebuild is cheap so we just trust it.
    } else {
        workspace.call_edges =
            SynCallGraphProvider.extract_call_edges_from_source(&workspace, &source_files)?;
    }

    // Write-back, unless the on-disk cache is already current. When
    // `signature_matches`, the file we'd write is byte-for-byte what's
    // already there, so skipping it avoids a pointless multi-MB
    // serialize+write on the hot reload path. Failures elsewhere are
    // best-effort — the next run just rebuilds.
    if let (Some(path), false) = (cache_path, signature_matches) {
        let new_cache = FactsCache {
            version: FACTS_CACHE_VERSION,
            files: new_cache_files,
            workspace_signature: signature,
            call_edges: workspace.call_edges.clone(),
            edges: workspace.edges.clone(),
            edge_profiles: workspace.edge_profiles.clone(),
        };
        save_cache(&path, &new_cache);
    }

    Ok(workspace)
}

/// Walk the workspace tree and collect (crate-name, src_root) pairs by
/// looking at every Cargo.toml.
fn discover_crates(root: &Path) -> Result<Vec<(String, PathBuf)>> {
    let mut out = Vec::new();
    for entry in WalkDir::new(root)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !matches!(name.as_ref(), "target" | "tmp" | ".git" | "node_modules")
        })
        .filter_map(|e| e.ok())
    {
        if entry.file_name() == "Cargo.toml" {
            let path = entry.path();
            // Skip the workspace-only root Cargo.toml.
            let txt = std::fs::read_to_string(path).unwrap_or_default();
            if !txt.contains("[package]") {
                continue;
            }
            let crate_name = parse_crate_name(&txt).unwrap_or_else(|| {
                path.parent()
                    .and_then(|p| p.file_name())
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default()
            });
            let src = path.parent().unwrap().join("src");
            if src.is_dir() {
                out.push((crate_name, src));
            }
        }
    }
    out.sort();
    Ok(out)
}

fn parse_crate_name(toml: &str) -> Option<String> {
    let mut in_pkg = false;
    for line in toml.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_pkg = trimmed == "[package]";
            continue;
        }
        if in_pkg {
            if let Some(rest) = trimmed.strip_prefix("name") {
                let rest = rest.trim_start_matches(|c: char| c == ' ' || c == '=' || c == '\t');
                let rest = rest.trim();
                let rest = rest.trim_matches('"');
                if !rest.is_empty() {
                    return Some(rest.to_string());
                }
            }
        }
    }
    None
}

fn empty_crate_facts(name: &str, src_root: &Path) -> CrateFacts {
    CrateFacts {
        name: name.to_string(),
        root: src_root.display().to_string(),
        modules: BTreeMap::new(),
        // Rust frontend overwrites this in `src/frontend/rust.rs`,
        // but the default = Rust covers callers that go through
        // this path without the wrapper too.
        language: crate::model::Language::default(),
        side: crate::model::Side::default(),
    }
}

/// Walk one crate's src/ tree and return every `.rs` file path,
/// sorted deterministically. Tiny cost (sequential `WalkDir` over a
/// small tree); the heavy lifting — read, parse, visit — happens in
/// parallel in the caller.
fn discover_rs_files(src_root: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = WalkDir::new(src_root)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|entry| {
            entry.file_type().is_file()
                && entry.path().extension().map(|e| e == "rs").unwrap_or(false)
        })
        .map(|entry| entry.path().to_path_buf())
        .collect();
    out.sort();
    out
}

/// Translate a file path under src/ to a "::"-delimited module path.
/// `src/lib.rs` and `src/main.rs` -> "" (crate root).
fn derive_module_path(src_root: &Path, file: &Path) -> String {
    let rel = file.strip_prefix(src_root).unwrap_or(file);
    let mut parts: Vec<String> = rel
        .with_extension("")
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .collect();
    if let Some(last) = parts.last() {
        if last == "mod" || last == "lib" || last == "main" {
            parts.pop();
        }
    }
    parts.join("::")
}

fn merge_module(into: &mut ModuleFacts, from: &ModuleFacts) {
    into.types.extend(from.types.iter().cloned());
    into.functions.extend(from.functions.iter().cloned());
    into.unsafe_blocks += from.unsafe_blocks;
    if into.file.is_empty() {
        into.file = from.file.clone();
    }
}

struct Ctx {
    crate_name: String,
    file: String,
    module_stack: Vec<String>,
    modules: BTreeMap<String, ModuleFacts>,
    /// Re-exports collected during the walk, keyed by the module path
    /// they were declared in. Resolved against the registry at the
    /// workspace level once all crates have been parsed.
    pending_re_exports: BTreeMap<String, Vec<PendingReExport>>,
}

/// Buffered `pub use` entry. `segments` is the textual path from the use
/// tree (after merging `Path` / `Group` prefixes onto each leaf), still
/// containing leading `crate`/`self`/`super` if the user wrote them. We
/// resolve it against the global type/function registry at the workspace
/// level — by name, scored by prefix similarity.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct PendingReExport {
    exposed_name: String,
    segments: Vec<String>,
    visibility: String,
    span: Option<Span>,
}

impl Ctx {
    fn current_module_path(&self) -> String {
        self.module_stack.last().cloned().unwrap_or_default()
    }

    fn ensure_module(&mut self, path: &str) -> &mut ModuleFacts {
        let key = path.to_string();
        let file = self.file.clone();
        self.modules
            .entry(key.clone())
            .or_insert_with(|| ModuleFacts {
                path: path.to_string(),
                file,
                ..Default::default()
            })
    }

    fn full_path(&self, name: &str) -> String {
        let module = self.current_module_path();
        if module.is_empty() {
            format!("{}::{}", self.crate_name, name)
        } else {
            format!("{}::{}::{}", self.crate_name, module, name)
        }
    }

    fn visit_item(&mut self, item: &Item) {
        match item {
            Item::Mod(m) => self.visit_mod(m),
            Item::Struct(s) => self.visit_struct(s),
            Item::Enum(e) => self.visit_enum(e),
            Item::Union(u) => self.visit_union(u),
            Item::Trait(t) => self.visit_trait(t),
            Item::Type(t) => self.visit_type_alias(t),
            Item::Impl(i) => self.visit_impl(i),
            Item::Fn(f) => {
                let name = f.sig.ident.to_string();
                let visibility = vis_text(&f.vis);
                let span = Some(fn_span_of(&self.file, &f.sig, Some(&f.block)));
                let facts = build_fn_facts(
                    &name,
                    None,
                    visibility,
                    &f.sig,
                    Some(&f.block),
                    &f.attrs,
                    span,
                );
                let module_path = self.current_module_path();
                self.ensure_module(&module_path).functions.push(facts);
            }
            Item::Use(u) => self.visit_use(u),
            _ => {}
        }
    }

    /// Buffer pending re-exports for any `pub*` `use` statement. Inherited
    /// visibility is skipped — those are imports for in-module use, not
    /// re-exports. Globs are skipped because we'd need to model the
    /// resolver to enumerate them.
    fn visit_use(&mut self, u: &ItemUse) {
        if matches!(u.vis, syn::Visibility::Inherited) {
            return;
        }
        let visibility = vis_text(&u.vis);
        let module_path = self.current_module_path();
        let use_span = span_of(&self.file, u.span());
        let mut leaves: Vec<PendingReExport> = Vec::new();
        walk_use_tree(
            &u.tree,
            &mut Vec::new(),
            &visibility,
            Some(&use_span),
            &mut leaves,
        );
        if !leaves.is_empty() {
            self.pending_re_exports
                .entry(module_path)
                .or_default()
                .extend(leaves);
        }
    }

    fn visit_mod(&mut self, m: &ItemMod) {
        if let Some((_, items)) = &m.content {
            let parent = self.current_module_path();
            let new_path = if parent.is_empty() {
                m.ident.to_string()
            } else {
                format!("{}::{}", parent, m.ident)
            };
            self.module_stack.push(new_path);
            for item in items {
                self.visit_item(item);
            }
            self.module_stack.pop();
        }
        // For `mod foo;` (file-based), the other file gets walked separately.
    }

    fn visit_struct(&mut self, s: &ItemStruct) {
        let name = s.ident.to_string();
        let full_path = self.full_path(&name);
        let derives = collect_derives(&s.attrs);
        let lifetime_params = lifetime_params_of(&s.generics);
        let type_params = type_params_of(&s.generics);
        let visibility = vis_text(&s.vis);
        let doc = doc_first_line(&s.attrs);
        let fields = fields_from_struct(&s.fields, &self.file);
        let span = Some(span_of(&self.file, s.span()));
        let facts = TypeFacts {
            name,
            full_path,
            kind: TypeKind::Struct,
            visibility,
            lifetime_params,
            type_params,
            derives,
            fields,
            methods: Vec::new(),
            trait_impls: Vec::new(),
            unsafe_blocks: 0,
            doc_first_line: doc,
            span,
            prev_span: None,
            change_kind: None,
            side: crate::model::Side::default(),
        };
        let module_path = self.current_module_path();
        self.ensure_module(&module_path).types.push(facts);
    }

    fn visit_enum(&mut self, e: &ItemEnum) {
        let name = e.ident.to_string();
        let full_path = self.full_path(&name);
        let derives = collect_derives(&e.attrs);
        let lifetime_params = lifetime_params_of(&e.generics);
        let type_params = type_params_of(&e.generics);
        let visibility = vis_text(&e.vis);
        let doc = doc_first_line(&e.attrs);

        let mut fields = Vec::new();
        for variant in &e.variants {
            let var_name = variant.ident.to_string();
            let var_span = Some(span_of(&self.file, variant.span()));
            let inner = fields_from_struct(&variant.fields, &self.file);
            if inner.is_empty() {
                fields.push(FieldFacts {
                    name: var_name,
                    ty_text: "()".into(),
                    ownership: Ownership::Primitive,
                    referenced: vec![],
                    cardinality: vec![],
                    lifetimes: vec![],
                    span: var_span,
                    prev_span: None,
                    change_kind: None,
                    side: crate::model::Side::default(),
                });
            } else {
                for f in inner {
                    fields.push(FieldFacts {
                        name: format!("{}::{}", var_name, f.name),
                        ..f
                    });
                }
            }
        }

        let span = Some(span_of(&self.file, e.span()));
        let facts = TypeFacts {
            name,
            full_path,
            kind: TypeKind::Enum,
            visibility,
            lifetime_params,
            type_params,
            derives,
            fields,
            methods: Vec::new(),
            trait_impls: Vec::new(),
            unsafe_blocks: 0,
            doc_first_line: doc,
            span,
            prev_span: None,
            change_kind: None,
            side: crate::model::Side::default(),
        };
        let module_path = self.current_module_path();
        self.ensure_module(&module_path).types.push(facts);
    }

    fn visit_union(&mut self, u: &ItemUnion) {
        let name = u.ident.to_string();
        let full_path = self.full_path(&name);
        let derives = collect_derives(&u.attrs);
        let lifetime_params = lifetime_params_of(&u.generics);
        let type_params = type_params_of(&u.generics);
        let visibility = vis_text(&u.vis);
        let doc = doc_first_line(&u.attrs);
        let fields: Vec<FieldFacts> = u
            .fields
            .named
            .iter()
            .map(|f| field_from_named(f, &self.file))
            .collect();
        let span = Some(span_of(&self.file, u.span()));
        let facts = TypeFacts {
            name,
            full_path,
            kind: TypeKind::Union,
            visibility,
            lifetime_params,
            type_params,
            derives,
            fields,
            methods: Vec::new(),
            trait_impls: Vec::new(),
            unsafe_blocks: 0,
            doc_first_line: doc,
            span,
            prev_span: None,
            change_kind: None,
            side: crate::model::Side::default(),
        };
        let module_path = self.current_module_path();
        self.ensure_module(&module_path).types.push(facts);
    }

    fn visit_trait(&mut self, t: &ItemTrait) {
        let name = t.ident.to_string();
        let full_path = self.full_path(&name);
        let lifetime_params = lifetime_params_of(&t.generics);
        let type_params = type_params_of(&t.generics);
        let visibility = vis_text(&t.vis);
        let doc = doc_first_line(&t.attrs);

        // Trait method signatures count as method facts on the trait itself.
        let mut methods = Vec::new();
        for item in &t.items {
            if let syn::TraitItem::Fn(f) = item {
                let name = f.sig.ident.to_string();
                let visibility = "pub".to_string();
                let block_ref = f.default.as_ref();
                let span = Some(fn_span_of(&self.file, &f.sig, block_ref));
                let facts =
                    build_fn_facts(&name, None, visibility, &f.sig, block_ref, &f.attrs, span);
                methods.push(facts);
            }
        }
        let span = Some(span_of(&self.file, t.span()));
        let facts = TypeFacts {
            name,
            full_path,
            kind: TypeKind::Trait,
            visibility,
            lifetime_params,
            type_params,
            derives: vec![],
            fields: Vec::new(),
            methods,
            trait_impls: Vec::new(),
            unsafe_blocks: 0,
            doc_first_line: doc,
            span,
            prev_span: None,
            change_kind: None,
            side: crate::model::Side::default(),
        };
        let module_path = self.current_module_path();
        self.ensure_module(&module_path).types.push(facts);
    }

    fn visit_type_alias(&mut self, t: &ItemType) {
        let name = t.ident.to_string();
        let full_path = self.full_path(&name);
        let lifetime_params = lifetime_params_of(&t.generics);
        let type_params = type_params_of(&t.generics);
        let visibility = vis_text(&t.vis);
        let doc = doc_first_line(&t.attrs);
        let (ownership, refs, lifetimes) = classify(&t.ty);
        let (referenced, cardinality) = split_refs(refs);
        let item_span = Some(span_of(&self.file, t.span()));
        let fields = vec![FieldFacts {
            name: "<alias>".to_string(),
            ty_text: type_text(&t.ty),
            ownership,
            referenced,
            cardinality,
            lifetimes,
            span: item_span.clone(),
            prev_span: None,
            change_kind: None,
            side: crate::model::Side::default(),
        }];
        let facts = TypeFacts {
            name,
            full_path,
            kind: TypeKind::TypeAlias,
            visibility,
            lifetime_params,
            type_params,
            derives: vec![],
            fields,
            methods: Vec::new(),
            trait_impls: Vec::new(),
            unsafe_blocks: 0,
            doc_first_line: doc,
            span: item_span,
            prev_span: None,
            change_kind: None,
            side: crate::model::Side::default(),
        };
        let module_path = self.current_module_path();
        self.ensure_module(&module_path).types.push(facts);
    }

    fn visit_impl(&mut self, i: &ItemImpl) {
        // Identify the Self type by name (last path segment) — heuristic.
        let self_name = match &*i.self_ty {
            syn::Type::Path(tp) => tp.path.segments.last().map(|s| s.ident.to_string()),
            _ => None,
        };
        let Some(self_name) = self_name else {
            return;
        };

        let trait_name = i
            .trait_
            .as_ref()
            .and_then(|(_, p, _)| p.segments.last())
            .map(|s| s.ident.to_string());

        let mut unsafe_blocks: u32 = 0;
        let mut methods = Vec::new();
        for item in &i.items {
            if let ImplItem::Fn(f) = item {
                let name = f.sig.ident.to_string();
                let vis = vis_text(&f.vis);
                let span = Some(fn_span_of(&self.file, &f.sig, Some(&f.block)));
                let facts = build_fn_facts(
                    &name,
                    trait_name.clone(),
                    vis,
                    &f.sig,
                    Some(&f.block),
                    &f.attrs,
                    span,
                );
                unsafe_blocks += facts.unsafe_blocks;
                methods.push(facts);
            }
        }

        // Attach to the matching type in the current module by name. If not
        // found in current module, scan the whole crate's collected modules.
        let module_path = self.current_module_path();
        let trait_clone = trait_name.clone();
        if let Some(m) = self.modules.get_mut(&module_path) {
            if let Some(ty) = m.types.iter_mut().find(|t| t.name == self_name) {
                ty.methods.extend(methods.clone());
                ty.unsafe_blocks += unsafe_blocks;
                if let Some(t) = trait_clone.clone() {
                    ty.trait_impls.push(t);
                }
                return;
            }
        }
        // Search anywhere in the crate's already-built modules.
        for m in self.modules.values_mut() {
            if let Some(ty) = m.types.iter_mut().find(|t| t.name == self_name) {
                ty.methods.extend(methods.clone());
                ty.unsafe_blocks += unsafe_blocks;
                if let Some(t) = trait_name.clone() {
                    ty.trait_impls.push(t);
                }
                return;
            }
        }
        // Otherwise: orphan impl block (impl for a type defined in another
        // file). Stash a stub-type entry so the methods are not lost.
        let stub = TypeFacts {
            name: self_name.clone(),
            full_path: self.full_path(&self_name),
            kind: TypeKind::Struct,
            visibility: "<orphan-impl>".into(),
            lifetime_params: vec![],
            type_params: vec![],
            derives: vec![],
            fields: vec![],
            methods,
            trait_impls: trait_name.clone().into_iter().collect(),
            unsafe_blocks,
            doc_first_line: None,
            span: None,
            prev_span: None,
            change_kind: None,
            side: crate::model::Side::default(),
        };
        let module_path_owned = module_path;
        self.ensure_module(&module_path_owned).types.push(stub);
    }
}

fn collect_derives(attrs: &[syn::Attribute]) -> Vec<String> {
    let mut out = Vec::new();
    for attr in attrs {
        if !attr.path().is_ident("derive") {
            continue;
        }
        let _ = attr.parse_nested_meta(|meta| {
            if let Some(seg) = meta.path.segments.last() {
                out.push(seg.ident.to_string());
            }
            Ok(())
        });
    }
    out
}

fn lifetime_params_of(g: &syn::Generics) -> Vec<String> {
    g.lifetimes()
        .map(|lp| lp.lifetime.ident.to_string())
        .collect()
}

fn type_params_of(g: &syn::Generics) -> Vec<String> {
    g.type_params().map(|tp| tp.ident.to_string()).collect()
}

fn vis_text(v: &syn::Visibility) -> String {
    match v {
        syn::Visibility::Public(_) => "pub".to_string(),
        syn::Visibility::Restricted(r) => {
            let path: String = r
                .path
                .segments
                .iter()
                .map(|s| s.ident.to_string())
                .collect::<Vec<_>>()
                .join("::");
            format!("pub({path})")
        }
        syn::Visibility::Inherited => "priv".to_string(),
    }
}

fn doc_first_line(attrs: &[syn::Attribute]) -> Option<String> {
    for a in attrs {
        if a.path().is_ident("doc") {
            if let syn::Meta::NameValue(nv) = &a.meta {
                if let syn::Expr::Lit(lit) = &nv.value {
                    if let syn::Lit::Str(s) = &lit.lit {
                        let v = s.value();
                        let line = v.trim().lines().next().unwrap_or("").trim().to_string();
                        if !line.is_empty() {
                            return Some(line);
                        }
                    }
                }
            }
        }
    }
    None
}

fn fields_from_struct(fields: &syn::Fields, file: &str) -> Vec<FieldFacts> {
    match fields {
        syn::Fields::Named(named) => named
            .named
            .iter()
            .map(|f| field_from_named(f, file))
            .collect(),
        syn::Fields::Unnamed(unn) => unn
            .unnamed
            .iter()
            .enumerate()
            .map(|(i, f)| {
                let (ownership, refs, lifetimes) = classify(&f.ty);
                let (referenced, cardinality) = split_refs(refs);
                FieldFacts {
                    name: format!(".{i}"),
                    ty_text: type_text(&f.ty),
                    ownership,
                    referenced,
                    cardinality,
                    lifetimes,
                    span: Some(span_of(file, f.span())),
                    prev_span: None,
                    change_kind: None,
                    side: crate::model::Side::default(),
                }
            })
            .collect(),
        syn::Fields::Unit => vec![],
    }
}

fn field_from_named(f: &syn::Field, file: &str) -> FieldFacts {
    let name = f
        .ident
        .as_ref()
        .map(|i| i.to_string())
        .unwrap_or_else(|| "_".into());
    let (ownership, refs, lifetimes) = classify(&f.ty);
    let (referenced, cardinality) = split_refs(refs);
    FieldFacts {
        name,
        ty_text: type_text(&f.ty),
        ownership,
        referenced,
        cardinality,
        lifetimes,
        span: Some(span_of(file, f.span())),
        prev_span: None,
        change_kind: None,
        side: crate::model::Side::default(),
    }
}

/// Helper: split the (name, cardinality) pairs returned by `classify` into
/// the parallel `Vec<String>` and `Vec<Cardinality>` we store on facts.
fn split_refs(
    refs: Vec<(String, crate::model::Cardinality)>,
) -> (Vec<String>, Vec<crate::model::Cardinality>) {
    let mut names = Vec::with_capacity(refs.len());
    let mut cards = Vec::with_capacity(refs.len());
    for (n, c) in refs {
        names.push(n);
        cards.push(c);
    }
    (names, cards)
}

/// Build a [`Span`] from a [`proc_macro2::Span`] and the file path the
/// item was parsed from. proc_macro2's span carries line+column data
/// when the "span-locations" feature is enabled (see Cargo.toml);
/// without that feature this would return (0, 0) for every item.
fn span_of(file: &str, s: proc_macro2::Span) -> Span {
    let start = s.start();
    let end = s.end();
    Span {
        file: file.to_string(),
        start_line: start.line as u32,
        end_line: end.line as u32,
    }
}

/// Tight span for a function — from the `fn` keyword (start of
/// `syn::Signature`) to the body's closing brace. AVOIDS leaking
/// into doc comments and `#[...]` attributes above the function,
/// which `syn::ItemFn::span()` would otherwise include. A modified
/// attribute above an unchanged function would otherwise push the
/// whole function into a Modified state via hunk overlap.
fn fn_span_of(file: &str, sig: &syn::Signature, body: Option<&syn::Block>) -> Span {
    let start = sig.span().start();
    let end = match body {
        Some(b) => b.span().end(),
        None => sig.span().end(),
    };
    Span {
        file: file.to_string(),
        start_line: start.line as u32,
        end_line: end.line as u32,
    }
}

fn build_fn_facts(
    name: &str,
    impl_trait: Option<String>,
    visibility: String,
    sig: &syn::Signature,
    body: Option<&syn::Block>,
    attrs: &[syn::Attribute],
    span: Option<Span>,
) -> FnFacts {
    let mut self_kind = SelfKind::None;
    let mut params = Vec::new();
    let mut input_lifetimes: BTreeSet<String> = BTreeSet::new();
    for input in &sig.inputs {
        match input {
            syn::FnArg::Receiver(r) => {
                if r.reference.is_none() {
                    self_kind = SelfKind::ByValue;
                } else if r.mutability.is_some() {
                    self_kind = SelfKind::RefMut;
                } else {
                    self_kind = SelfKind::Ref;
                }
                if let Some((_, Some(lt))) = &r.reference {
                    input_lifetimes.insert(lt.ident.to_string());
                }
            }
            syn::FnArg::Typed(pt) => {
                let pname = match &*pt.pat {
                    syn::Pat::Ident(pi) => pi.ident.to_string(),
                    _ => "_".into(),
                };
                let (ownership, refs, lifetimes) = classify(&pt.ty);
                let (referenced, cardinality) = split_refs(refs);
                for lt in &lifetimes {
                    input_lifetimes.insert(lt.clone());
                }
                params.push(ParamFacts {
                    name: pname,
                    ty_text: type_text(&pt.ty),
                    ownership,
                    referenced,
                    cardinality,
                    lifetimes,
                });
            }
        }
    }

    let (ret_ownership, ret_referenced, ret_cardinality, ret_lifetimes, ret_text) =
        match &sig.output {
            ReturnType::Default => (
                Ownership::Primitive,
                vec![],
                vec![],
                vec![],
                "()".to_string(),
            ),
            ReturnType::Type(_, ty) => {
                let (ownership, refs, lifetimes) = classify(ty);
                let (referenced, cardinality) = split_refs(refs);
                (ownership, referenced, cardinality, lifetimes, type_text(ty))
            }
        };

    let lifetime_flows_through = ret_lifetimes.iter().any(|lt| input_lifetimes.contains(lt));

    let mut unsafe_blocks: u32 = 0;
    if let Some(b) = body {
        let mut counter = UnsafeCounter { count: 0 };
        counter.visit_block(b);
        unsafe_blocks = counter.count;
    }

    FnFacts {
        name: name.to_string(),
        impl_trait,
        visibility,
        self_kind,
        is_unsafe: sig.unsafety.is_some(),
        is_const: sig.constness.is_some(),
        is_async: sig.asyncness.is_some(),
        lifetime_params: lifetime_params_of(&sig.generics),
        params,
        return_ty_text: ret_text,
        return_ownership: ret_ownership,
        return_referenced: ret_referenced,
        return_cardinality: ret_cardinality,
        lifetime_flows_through,
        unsafe_blocks,
        doc_first_line: doc_first_line(attrs),
        span,
        prev_span: None,
        change_kind: None,
        side: crate::model::Side::default(),
    }
}

struct UnsafeCounter {
    count: u32,
}
impl<'ast> Visit<'ast> for UnsafeCounter {
    fn visit_expr_unsafe(&mut self, _: &'ast syn::ExprUnsafe) {
        self.count += 1;
        // Don't recurse — we're only counting top-level unsafe blocks per body.
    }
}

// ── Edge graph ────────────────────────────────────────────────────────────

/// Map a short type name (e.g. "TypeContext") to the canonical full path of
/// the type definition. If a name is ambiguous across crates, we keep all
/// candidates and emit one edge per candidate so we don't drop information.
type Registry = BTreeMap<String, Vec<String>>;

fn build_type_registry(ws: &WorkspaceFacts) -> Registry {
    let mut r: Registry = BTreeMap::new();
    for cf in ws.crates.values() {
        for m in cf.modules.values() {
            for ty in &m.types {
                r.entry(ty.name.clone())
                    .or_default()
                    .push(ty.full_path.clone());
            }
        }
    }
    r
}

/// Function-name registry. Keyed by short fn name; values are full paths
/// in the form `crate::module::path::fn_name`. Used to resolve `pub use`
/// re-exports of free functions.
fn build_fn_registry(ws: &WorkspaceFacts) -> Registry {
    let mut r: Registry = BTreeMap::new();
    for cf in ws.crates.values() {
        for m in cf.modules.values() {
            for f in &m.functions {
                let full = if m.path.is_empty() {
                    format!("{}::{}", cf.name, f.name)
                } else {
                    format!("{}::{}::{}", cf.name, m.path, f.name)
                };
                r.entry(f.name.clone()).or_default().push(full);
            }
        }
    }
    r
}

/// Map every type's canonical full path to its [`TypeKind`]. The
/// re-export resolver uses this to stamp `target_kind` onto each
/// resolved type re-export so the viewer doesn't have to guess.
fn build_type_kinds(ws: &WorkspaceFacts) -> TypeKindByPath {
    let mut out: TypeKindByPath = BTreeMap::new();
    for cf in ws.crates.values() {
        for m in cf.modules.values() {
            for ty in &m.types {
                out.insert(ty.full_path.clone(), ty.kind.clone());
            }
        }
    }
    out
}

/// Recursively flatten a `UseTree` into one `PendingReExport` per leaf.
///
/// Globs (`use foo::*`) are skipped — without resolver-level knowledge we
/// can't enumerate the items they expose, and we'd rather record nothing
/// than guess wrong. `Group` nodes (`use foo::{a, b}`) and `Path` nodes
/// (`use foo::bar::Baz`) just contribute prefix segments. `Name` and
/// `Rename` are the leaves.
fn walk_use_tree(
    tree: &UseTree,
    prefix: &mut Vec<String>,
    visibility: &str,
    use_span: Option<&Span>,
    out: &mut Vec<PendingReExport>,
) {
    match tree {
        UseTree::Path(p) => {
            prefix.push(p.ident.to_string());
            walk_use_tree(&p.tree, prefix, visibility, use_span, out);
            prefix.pop();
        }
        UseTree::Name(n) => {
            let name = n.ident.to_string();
            let mut segs = prefix.clone();
            segs.push(name.clone());
            out.push(PendingReExport {
                exposed_name: name,
                segments: segs,
                visibility: visibility.to_string(),
                span: use_span.cloned(),
            });
        }
        UseTree::Rename(r) => {
            let target = r.ident.to_string();
            let mut segs = prefix.clone();
            segs.push(target);
            out.push(PendingReExport {
                exposed_name: r.rename.to_string(),
                segments: segs,
                visibility: visibility.to_string(),
                span: use_span.cloned(),
            });
        }
        UseTree::Group(g) => {
            for it in &g.items {
                walk_use_tree(it, prefix, visibility, use_span, out);
            }
        }
        UseTree::Glob(_) => {
            // Skipped on purpose — see fn-doc.
        }
    }
}

/// Resolve a pending re-export against the type and function registries.
/// Tries types first, then functions. Returns `None` if neither registry
/// has the leaf name (external crates, macros, unknown items). The
/// `type_kinds` map provides the canonical's [`TypeKind`] for the
/// resolved target — stamped onto the returned `ReExport.target_kind`
/// for type re-exports; function re-exports leave it as `None`.
fn resolve_re_export(
    p: &PendingReExport,
    type_registry: &Registry,
    fn_registry: &Registry,
    type_kinds: &TypeKindByPath,
    source: &str,
) -> Option<ReExport> {
    let leaf = p.segments.last()?;
    // Drop `crate`, `self`, `super`, `Self` keywords from segments — they
    // don't contribute to the canonical path and would only mislead the
    // prefix-matching scorer below. Keep them around as "hints" for
    // tie-breaking via `source` instead.
    let prefix_hint: Vec<String> = p
        .segments
        .iter()
        .filter(|s| !matches!(s.as_str(), "crate" | "self" | "super" | "Self"))
        .cloned()
        .collect();

    let try_resolve = |reg: &Registry| -> Option<String> {
        let candidates = reg.get(leaf)?;
        if candidates.is_empty() {
            return None;
        }
        if candidates.len() == 1 {
            return Some(candidates[0].clone());
        }
        // Score by matching the *suffix* of each candidate's module path
        // against the hint's module segments (everything except the leaf).
        // `use` paths are typically relative — e.g. `inner::Bar` — so we
        // align right-to-left rather than left-to-right. The candidate
        // whose tail matches the hint's tail wins.
        let pick_by = |hint_segs: &[String]| -> Option<String> {
            if hint_segs.len() < 2 {
                return None; // No module hint to score against.
            }
            let hint_mod_rev: Vec<&str> = hint_segs
                .iter()
                .rev()
                .skip(1) // drop the leaf
                .map(String::as_str)
                .collect();
            let scored: Vec<(usize, &String)> = candidates
                .iter()
                .map(|c| {
                    let cand_segs: Vec<&str> = c.split("::").collect();
                    let module_len = cand_segs.len().saturating_sub(1);
                    let cand_mod_rev: Vec<&str> =
                        cand_segs.iter().take(module_len).rev().copied().collect();
                    let score = hint_mod_rev
                        .iter()
                        .copied()
                        .zip(cand_mod_rev.iter().copied())
                        .take_while(|(a, b)| a == b)
                        .count();
                    (score, c)
                })
                .collect();
            let best = scored.iter().map(|(s, _)| *s).max().unwrap_or(0);
            if best == 0 {
                return None;
            }
            scored
                .into_iter()
                .find(|(s, _)| *s == best)
                .map(|(_, c)| c.clone())
        };
        // Hint first by the use-tree's textual prefix (best signal),
        // falling back to the source module path. If still tied, return
        // the alphabetically first candidate so behavior is deterministic.
        pick_by(&prefix_hint)
            .or_else(|| {
                let src_segs: Vec<String> = source.split("::").map(str::to_string).collect();
                pick_by(&src_segs)
            })
            .or_else(|| candidates.iter().min().cloned())
    };

    if let Some(target_path) = try_resolve(type_registry) {
        let target_kind = type_kinds.get(&target_path).cloned();
        return Some(ReExport {
            exposed_name: p.exposed_name.clone(),
            target_path,
            visibility: p.visibility.clone(),
            kind: ReExportKind::Type,
            target_kind,
            span: p.span.clone(),
        });
    }
    if let Some(target_path) = try_resolve(fn_registry) {
        return Some(ReExport {
            exposed_name: p.exposed_name.clone(),
            target_path,
            visibility: p.visibility.clone(),
            kind: ReExportKind::Function,
            target_kind: None,
            span: p.span.clone(),
        });
    }
    None
}

/// Resolve a simple type name to one or more full paths, preferring the
/// candidate whose module-path shares the longest prefix with `source`
/// (the full path of the type or fn that holds the reference).
///
/// When multiple candidates tie at the best prefix score, all tied paths
/// are returned — we lack `use`-statement information, so we don't try to
/// pick one arbitrarily. When no candidate shares any prefix at all, we
/// fall back to returning every candidate, since that may legitimately
/// be a cross-module reference brought in via `use`.
fn resolve_name(name: &str, reg: &Registry, source: &str) -> Vec<String> {
    let candidates = reg.get(name).cloned().unwrap_or_default();
    if candidates.len() <= 1 {
        return candidates;
    }
    let source_segs: Vec<&str> = source.split("::").collect();
    let scored: Vec<(usize, String)> = candidates
        .into_iter()
        .map(|c| {
            let cand_segs: Vec<&str> = c.split("::").collect();
            // The candidate's *module* prefix is everything except the last
            // segment (which is the type name itself).
            let module_len = cand_segs.len().saturating_sub(1);
            let score = source_segs
                .iter()
                .zip(cand_segs.iter().take(module_len))
                .take_while(|(a, b)| a == b)
                .count();
            (score, c)
        })
        .collect();
    let best = scored.iter().map(|(s, _)| *s).max().unwrap_or(0);
    if best == 0 {
        return scored.into_iter().map(|(_, c)| c).collect();
    }
    scored
        .into_iter()
        .filter(|(s, _)| *s == best)
        .map(|(_, c)| c)
        .collect()
}

/// Emit edges originating in `ty`. The `via` for field-derived edges is
/// determined by the kind of `ty` (struct/union vs enum). Type aliases do
/// not emit edges — an alias is a name, not a containment relation.
fn emit_edges_from_type(ty: &TypeFacts, reg: &Registry, out: &mut Vec<Edge>) {
    let from = ty.full_path.clone();

    let field_via = match ty.kind {
        TypeKind::Struct => Some(ViaKind::StructField),
        TypeKind::Union => Some(ViaKind::UnionField),
        TypeKind::Enum => Some(ViaKind::EnumVariantPayload),
        TypeKind::Trait | TypeKind::TypeAlias => None,
        // TS-only kinds. The Rust extractor never produces these, but
        // the match must stay exhaustive. Each frontend emits its own
        // edges; TS edges flow through the TS-specific path.
        TypeKind::Class | TypeKind::Interface => None,
    };

    if let Some(via) = field_via {
        for f in &ty.fields {
            let kind = match f.ownership {
                Ownership::Owned => EdgeKind::Owns,
                Ownership::BorrowImmut => EdgeKind::BorrowsImmut,
                Ownership::BorrowMut => EdgeKind::BorrowsMut,
                Ownership::Indirection => EdgeKind::Indirection,
                _ => continue,
            };
            for (i, refname) in f.referenced.iter().enumerate() {
                let cardinality = f
                    .cardinality
                    .get(i)
                    .copied()
                    .unwrap_or(crate::model::Cardinality::One);
                for to in resolve_name(refname, reg, &from) {
                    if to == from {
                        continue;
                    }
                    out.push(Edge {
                        from: from.clone(),
                        to,
                        kind,
                        via,
                        cardinality,
                        origin: format!("field {}", f.name),
                        side: crate::model::Side::default(),
                    });
                }
            }
        }
    }

    for tr in &ty.trait_impls {
        for to in resolve_name(tr, reg, &from) {
            out.push(Edge {
                from: from.clone(),
                to,
                kind: EdgeKind::TraitImpl,
                via: ViaKind::TraitImplBlock,
                cardinality: crate::model::Cardinality::One,
                origin: "impl".into(),
                side: crate::model::Side::default(),
            });
        }
    }

    for m in &ty.methods {
        emit_edges_from_fn(&from, m, reg, out);
    }
}

fn emit_edges_from_fn(from: &str, f: &FnFacts, reg: &Registry, out: &mut Vec<Edge>) {
    for p in &f.params {
        let kind = match p.ownership {
            Ownership::Owned => EdgeKind::Owns,
            Ownership::BorrowImmut => EdgeKind::BorrowsImmut,
            Ownership::BorrowMut => EdgeKind::BorrowsMut,
            Ownership::Indirection => EdgeKind::Indirection,
            _ => continue,
        };
        for (i, refname) in p.referenced.iter().enumerate() {
            let cardinality = p
                .cardinality
                .get(i)
                .copied()
                .unwrap_or(crate::model::Cardinality::One);
            for to in resolve_name(refname, reg, from) {
                if to == from {
                    continue;
                }
                out.push(Edge {
                    from: from.to_string(),
                    to,
                    kind,
                    via: ViaKind::FnParam,
                    cardinality,
                    origin: format!("fn {} param {}", f.name, p.name),
                    side: crate::model::Side::default(),
                });
            }
        }
    }
    let ret_kind = match f.return_ownership {
        Ownership::Owned => Some(EdgeKind::Owns),
        Ownership::BorrowImmut => Some(EdgeKind::BorrowsImmut),
        Ownership::BorrowMut => Some(EdgeKind::BorrowsMut),
        Ownership::Indirection => Some(EdgeKind::Indirection),
        _ => None,
    };
    if let Some(kind) = ret_kind {
        for (i, refname) in f.return_referenced.iter().enumerate() {
            let cardinality = f
                .return_cardinality
                .get(i)
                .copied()
                .unwrap_or(crate::model::Cardinality::One);
            for to in resolve_name(refname, reg, from) {
                if to == from {
                    continue;
                }
                out.push(Edge {
                    from: from.to_string(),
                    to,
                    kind,
                    via: ViaKind::FnReturn,
                    cardinality,
                    origin: format!("fn {} -> ret", f.name),
                    side: crate::model::Side::default(),
                });
            }
        }
    }
}

fn build_profiles(edges: &[Edge]) -> BTreeMap<String, EdgeProfile> {
    let mut out: BTreeMap<String, EdgeProfile> = BTreeMap::new();
    let mut inbound_sources: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut outbound_targets: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();

    for e in edges {
        let kind_key = format!("{:?}", e.kind);
        let via_key = format!("{:?}", e.via);
        let entry_from = out.entry(e.from.clone()).or_default();
        *entry_from.outbound.entry(kind_key.clone()).or_insert(0) += 1;
        *entry_from.outbound_via.entry(via_key.clone()).or_insert(0) += 1;
        outbound_targets
            .entry(e.from.clone())
            .or_default()
            .insert(e.to.clone());

        let entry_to = out.entry(e.to.clone()).or_default();
        *entry_to.inbound.entry(kind_key).or_insert(0) += 1;
        *entry_to.inbound_via.entry(via_key).or_insert(0) += 1;
        inbound_sources
            .entry(e.to.clone())
            .or_default()
            .insert(e.from.clone());
    }
    for (name, p) in out.iter_mut() {
        p.inbound_distinct_sources = inbound_sources
            .get(name)
            .map(|s| s.len() as u32)
            .unwrap_or(0);
        p.outbound_distinct_targets = outbound_targets
            .get(name)
            .map(|s| s.len() as u32)
            .unwrap_or(0);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_use(src: &str) -> ItemUse {
        // Wrap in a tiny file so we can ride syn's full parser. Tests
        // intentionally target real Rust syntax rather than hand-built
        // ASTs so we exercise the same code paths the extractor sees in
        // production.
        let file: File = syn::parse_str(src).expect("parse_str failed");
        for item in file.items {
            if let Item::Use(u) = item {
                return u;
            }
        }
        panic!("no `use` item in input: {src}");
    }

    fn collect(src: &str) -> Vec<PendingReExport> {
        let u = parse_use(src);
        if matches!(u.vis, syn::Visibility::Inherited) {
            return Vec::new();
        }
        let visibility = vis_text(&u.vis);
        let mut out = Vec::new();
        walk_use_tree(&u.tree, &mut Vec::new(), &visibility, None, &mut out);
        out
    }

    #[test]
    fn walks_a_simple_pub_use_into_one_pending_entry() {
        let leaves = collect("pub use foo::Bar;");
        assert_eq!(leaves.len(), 1);
        assert_eq!(leaves[0].exposed_name, "Bar");
        assert_eq!(
            leaves[0].segments,
            vec!["foo".to_string(), "Bar".to_string()]
        );
        assert_eq!(leaves[0].visibility, "pub");
    }

    #[test]
    fn rename_uses_the_alias_as_the_exposed_name() {
        let leaves = collect("pub use foo::Bar as Baz;");
        assert_eq!(leaves.len(), 1);
        assert_eq!(leaves[0].exposed_name, "Baz");
        // segments still target the canonical name on the source side —
        // resolution will look up "Bar", not "Baz".
        assert_eq!(leaves[0].segments.last().map(String::as_str), Some("Bar"));
    }

    #[test]
    fn group_expands_to_one_entry_per_member() {
        let leaves = collect("pub use foo::{Bar, Baz, Qux};");
        let names: Vec<&str> = leaves.iter().map(|p| p.exposed_name.as_str()).collect();
        assert_eq!(names, vec!["Bar", "Baz", "Qux"]);
        // All three share the same `foo` prefix.
        for p in &leaves {
            assert_eq!(p.segments.first().map(String::as_str), Some("foo"));
        }
    }

    #[test]
    fn nested_groups_carry_the_full_prefix_chain_per_leaf() {
        let leaves = collect("pub use foo::bar::{Baz, qux::Quux};");
        let by_name: BTreeMap<&str, &PendingReExport> = leaves
            .iter()
            .map(|p| (p.exposed_name.as_str(), p))
            .collect();
        assert_eq!(
            by_name["Baz"].segments,
            vec!["foo".to_string(), "bar".to_string(), "Baz".to_string()],
        );
        assert_eq!(
            by_name["Quux"].segments,
            vec![
                "foo".to_string(),
                "bar".to_string(),
                "qux".to_string(),
                "Quux".to_string(),
            ],
        );
    }

    #[test]
    fn glob_imports_emit_no_pending_entries() {
        // We can't enumerate `*` without modelling the resolver — drop
        // these silently rather than guessing.
        let leaves = collect("pub use foo::*;");
        assert!(leaves.is_empty());
    }

    #[test]
    fn inherited_visibility_use_is_ignored_entirely() {
        // Plain `use` (no `pub`) is an import for in-module use, NOT a
        // re-export. visit_use bails out before walking the tree.
        let leaves = collect("use foo::Bar;");
        assert!(leaves.is_empty());
    }

    #[test]
    fn pub_crate_visibility_is_preserved_on_each_leaf() {
        let leaves = collect("pub(crate) use foo::{Bar, Baz};");
        assert_eq!(leaves.len(), 2);
        for p in &leaves {
            assert_eq!(p.visibility, "pub(crate)");
        }
    }

    #[test]
    fn pub_in_path_visibility_lands_in_the_pub_in_path_bucket() {
        // `pub(in crate::a)` is captured by `vis_text` as `pub(crate::a)`
        // — the literal `in` is dropped because the path alone is enough
        // to disambiguate from `pub(crate)` / `pub(super)` / `pub(self)`.
        // The viewer's classifyVisibility() routes `pub(<anything else>)`
        // into `pub_in_path`, so this format suffices.
        let leaves = collect("pub(in crate::a) use foo::Bar;");
        assert_eq!(leaves.len(), 1);
        let v = &leaves[0].visibility;
        assert!(
            v.starts_with("pub(")
                && !matches!(v.as_str(), "pub(crate)" | "pub(super)" | "pub(self)"),
            "unexpected vis token: {v}",
        );
    }

    fn make_registry(entries: &[(&str, &[&str])]) -> Registry {
        let mut r: Registry = BTreeMap::new();
        for (name, paths) in entries {
            r.insert(
                (*name).to_string(),
                paths.iter().map(|s| (*s).to_string()).collect(),
            );
        }
        r
    }

    fn make_kinds(entries: &[(&str, TypeKind)]) -> TypeKindByPath {
        let mut k: TypeKindByPath = BTreeMap::new();
        for (path, kind) in entries {
            k.insert((*path).to_string(), kind.clone());
        }
        k
    }

    #[test]
    fn resolve_finds_a_unique_type_target() {
        let reg = make_registry(&[("Bar", &["c::inner::Bar"])]);
        let kinds = make_kinds(&[("c::inner::Bar", TypeKind::Struct)]);
        let pending = PendingReExport {
            exposed_name: "Bar".into(),
            segments: vec!["inner".into(), "Bar".into()],
            visibility: "pub".into(),
            span: None,
        };
        let re = resolve_re_export(&pending, &reg, &Registry::new(), &kinds, "c::outer").unwrap();
        assert_eq!(re.target_path, "c::inner::Bar");
        assert_eq!(re.kind, ReExportKind::Type);
        assert_eq!(re.target_kind, Some(TypeKind::Struct));
    }

    #[test]
    fn resolve_stamps_canonical_kind_for_each_type_re_export() {
        // Round-trip the kind for every variant the extractor can emit
        // — catches future drift between the type-kinds builder and the
        // TypeKind enum.
        for kind in [
            TypeKind::Struct,
            TypeKind::Enum,
            TypeKind::Union,
            TypeKind::Trait,
            TypeKind::TypeAlias,
        ] {
            let reg = make_registry(&[("X", &["c::m::X"])]);
            let kinds = make_kinds(&[("c::m::X", kind.clone())]);
            let pending = PendingReExport {
                exposed_name: "X".into(),
                segments: vec!["m".into(), "X".into()],
                visibility: "pub".into(),
                span: None,
            };
            let re = resolve_re_export(&pending, &reg, &Registry::new(), &kinds, "c::outer")
                .expect("should resolve");
            assert_eq!(re.target_kind, Some(kind));
        }
    }

    #[test]
    fn resolve_picks_the_function_registry_when_no_type_matches() {
        let fn_reg = make_registry(&[("do_thing", &["c::inner::do_thing"])]);
        let pending = PendingReExport {
            exposed_name: "do_thing".into(),
            segments: vec!["inner".into(), "do_thing".into()],
            visibility: "pub".into(),
            span: None,
        };
        let re = resolve_re_export(
            &pending,
            &Registry::new(),
            &fn_reg,
            &TypeKindByPath::new(),
            "c::outer",
        )
        .unwrap();
        assert_eq!(re.kind, ReExportKind::Function);
        assert_eq!(re.target_path, "c::inner::do_thing");
        // Function re-exports never carry a target_kind — that field is
        // type-only.
        assert_eq!(re.target_kind, None);
    }

    #[test]
    fn resolve_returns_none_for_external_or_unknown_targets() {
        let pending = PendingReExport {
            exposed_name: "Unknown".into(),
            segments: vec!["external".into(), "crate_x".into(), "Unknown".into()],
            visibility: "pub".into(),
            span: None,
        };
        assert!(resolve_re_export(
            &pending,
            &Registry::new(),
            &Registry::new(),
            &TypeKindByPath::new(),
            "c::outer",
        )
        .is_none());
    }

    #[test]
    fn resolve_disambiguates_by_use_tree_prefix_match() {
        // Two types named `Foo`. The use tree's textual path mentions the
        // `vm::wasm` prefix, so we should pick that candidate over the
        // unrelated `vm::middle::Foo`.
        let reg = make_registry(&[("Foo", &["c::vm::middle::Foo", "c::vm::wasm::Foo"])]);
        let kinds = make_kinds(&[
            ("c::vm::middle::Foo", TypeKind::Struct),
            ("c::vm::wasm::Foo", TypeKind::Enum),
        ]);
        let pending = PendingReExport {
            exposed_name: "Foo".into(),
            segments: vec!["vm".into(), "wasm".into(), "Foo".into()],
            visibility: "pub".into(),
            span: None,
        };
        let re = resolve_re_export(&pending, &reg, &Registry::new(), &kinds, "c::outer").unwrap();
        assert_eq!(re.target_path, "c::vm::wasm::Foo");
        // target_kind reflects the picked candidate's kind — not the
        // sibling's. Catches a regression where the kind lookup
        // accidentally keys on the wrong path.
        assert_eq!(re.target_kind, Some(TypeKind::Enum));
    }

    #[test]
    fn resolve_strips_keyword_prefixes_before_scoring() {
        // `crate::vm::wasm::Foo` and `super::Foo` are common idioms. Those
        // keywords shouldn't prevent the scorer from matching the
        // remaining real path segments.
        let reg = make_registry(&[("Foo", &["c::vm::middle::Foo", "c::vm::wasm::Foo"])]);
        let pending = PendingReExport {
            exposed_name: "Foo".into(),
            segments: vec!["crate".into(), "vm".into(), "wasm".into(), "Foo".into()],
            visibility: "pub".into(),
            span: None,
        };
        let re = resolve_re_export(
            &pending,
            &reg,
            &Registry::new(),
            &TypeKindByPath::new(),
            "c",
        )
        .unwrap();
        assert_eq!(re.target_path, "c::vm::wasm::Foo");
    }

    #[test]
    fn resolve_falls_back_to_alphabetically_first_when_nothing_disambiguates() {
        // No prefix overlap with the use-tree segments OR the source
        // module — the resolver still has to pick *something*
        // deterministically. Alphabetical lower-bound keeps the choice
        // stable across runs.
        let reg = make_registry(&[("Foo", &["c::a::Foo", "c::b::Foo"])]);
        let pending = PendingReExport {
            exposed_name: "Foo".into(),
            segments: vec!["Foo".into()],
            visibility: "pub".into(),
            span: None,
        };
        let re = resolve_re_export(
            &pending,
            &reg,
            &Registry::new(),
            &TypeKindByPath::new(),
            "z",
        )
        .unwrap();
        assert_eq!(re.target_path, "c::a::Foo");
    }

    // Extract methods from a synthetic single-file crate so we can
    // inspect impl_trait tagging on the resulting FnFacts. Keeps the
    // helper local to this test cluster — we only need the methods
    // attached to one named type, not full workspace machinery.
    fn methods_of(src: &str, type_name: &str) -> Vec<FnFacts> {
        let ast: File = syn::parse_str(src).expect("parse_str failed");
        let mut ctx = Ctx {
            crate_name: "test".into(),
            file: "test.rs".into(),
            module_stack: vec![String::new()],
            modules: BTreeMap::new(),
            pending_re_exports: BTreeMap::new(),
        };
        ctx.ensure_module("");
        for item in &ast.items {
            ctx.visit_item(item);
        }
        let module = ctx.modules.get("").expect("root module missing");
        module
            .types
            .iter()
            .find(|t| t.name == type_name)
            .map(|t| t.methods.clone())
            .unwrap_or_default()
    }

    #[test]
    fn same_name_methods_in_two_impl_blocks_get_distinct_impl_trait_tags() {
        // Two `impl From<X> for Wrapper` blocks both define a `from`
        // method. Without impl_trait disambiguation, the viewer's id
        // scheme `${typePath}::${method.name}` would collide; with it,
        // each method carries the trait name of its impl block so the
        // ids stay unique downstream.
        let src = r#"
            pub struct Wrapper(i32);
            impl From<i32> for Wrapper {
                fn from(v: i32) -> Self { Wrapper(v) }
            }
            impl From<u32> for Wrapper {
                fn from(v: u32) -> Self { Wrapper(v as i32) }
            }
            impl Wrapper {
                pub fn inherent(&self) -> i32 { self.0 }
            }
        "#;
        let methods = methods_of(src, "Wrapper");
        let from_methods: Vec<&FnFacts> = methods.iter().filter(|m| m.name == "from").collect();
        assert_eq!(from_methods.len(), 2, "expected two `from` methods");
        // Both `from` methods carry impl_trait="From" — the trait name
        // is the disambiguator; the generic arg distinguishes them at
        // the source level but isn't part of the schema (yet).
        for m in &from_methods {
            assert_eq!(m.impl_trait.as_deref(), Some("From"));
        }
        // Inherent method has no impl_trait — preserves backward-
        // compatible id `${typePath}::inherent`.
        let inherent = methods
            .iter()
            .find(|m| m.name == "inherent")
            .expect("inherent missing");
        assert_eq!(inherent.impl_trait, None);
    }

    #[test]
    fn free_function_has_no_impl_trait_tag() {
        // Sanity check that the visit_item free-function path passes
        // None through to build_fn_facts.
        let src = r#"
            pub fn standalone() -> i32 { 42 }
            pub struct Holder;
        "#;
        let ast: File = syn::parse_str(src).expect("parse_str failed");
        let mut ctx = Ctx {
            crate_name: "test".into(),
            file: "test.rs".into(),
            module_stack: vec![String::new()],
            modules: BTreeMap::new(),
            pending_re_exports: BTreeMap::new(),
        };
        ctx.ensure_module("");
        for item in &ast.items {
            ctx.visit_item(item);
        }
        let module = ctx.modules.get("").expect("root module missing");
        let standalone = module
            .functions
            .iter()
            .find(|f| f.name == "standalone")
            .expect("standalone missing");
        assert_eq!(standalone.impl_trait, None);
    }

    #[test]
    fn resolve_target_kind_falls_back_to_none_when_kinds_table_missing_entry() {
        // Defensive: if the resolver returns a target_path that's
        // somehow absent from the kinds map (shouldn't happen since both
        // are built from the same workspace, but worth pinning), the
        // re-export still resolves with target_kind = None instead of
        // panicking.
        let reg = make_registry(&[("Bar", &["c::inner::Bar"])]);
        let pending = PendingReExport {
            exposed_name: "Bar".into(),
            segments: vec!["inner".into(), "Bar".into()],
            visibility: "pub".into(),
            span: None,
        };
        let re = resolve_re_export(
            &pending,
            &reg,
            &Registry::new(),
            &TypeKindByPath::new(), // empty: no kind info
            "c::outer",
        )
        .unwrap();
        assert_eq!(re.target_kind, None);
    }
}
