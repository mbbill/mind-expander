//! Pluggable language frontends. Each frontend owns its own parser and
//! package discovery; all of them produce the same language-agnostic
//! [`WorkspaceFacts`] consumed by the rest of the tool.
//!
//! Phase 1 keeps the trait deliberately minimal — a single `extract`
//! method returning `Option<WorkspaceFacts>` so a frontend can opt out
//! cheaply when there are no packages of its language under `root`.
//! The richer `detect_packages` / `extract_package` split from the plan
//! is reserved for a follow-up when a second language forces the issue.

use std::path::Path;

use anyhow::Result;

use crate::model::WorkspaceFacts;

pub mod rust;
pub mod typescript;

/// Pluggable per-language extractor. One implementation per source
/// language. The dispatcher fans out to every registered frontend and
/// merges their results.
pub trait LanguageFrontend {
    /// Short identifier — used in error messages and diagnostics.
    fn name(&self) -> &'static str;

    /// Extract facts for this language under `root`. Returns `Ok(None)`
    /// if no packages of this language exist under `root` (so the
    /// dispatcher can skip a missing-language frontend without raising
    /// an error in polyglot or single-language repos).
    fn extract(&self, root: &Path) -> Result<Option<WorkspaceFacts>>;
}

/// All frontends compiled into this build. Order matters only for
/// diagnostic output; the dispatcher merges results regardless.
fn registered() -> Vec<Box<dyn LanguageFrontend>> {
    vec![
        Box::new(rust::RustFrontend),
        Box::new(typescript::TypeScriptFrontend),
    ]
}

/// Top-level extraction entry point. With `only = None`, runs every
/// registered frontend and merges any non-empty results into a single
/// [`WorkspaceFacts`]; with `only = Some(name)`, restricts extraction
/// to the named frontend (`"rust"` / `"typescript"`). Errors if the
/// requested frontend isn't registered.
pub fn dispatch_with(root: &Path, only: Option<&str>) -> Result<WorkspaceFacts> {
    let frontends = registered();
    if let Some(name) = only {
        if !frontends.iter().any(|f| f.name() == name) {
            anyhow::bail!(
                "language frontend `{}` is not compiled into this build (available: {})",
                name,
                frontends
                    .iter()
                    .map(|f| f.name())
                    .collect::<Vec<_>>()
                    .join(", ")
            );
        }
    }
    let mut merged: Option<WorkspaceFacts> = None;
    let mut tried: Vec<&'static str> = Vec::with_capacity(frontends.len());
    for frontend in &frontends {
        if let Some(name) = only {
            if frontend.name() != name {
                continue;
            }
        }
        tried.push(frontend.name());
        match frontend.extract(root)? {
            None => continue,
            Some(facts) => match merged.as_mut() {
                None => merged = Some(facts),
                Some(acc) => merge_into(acc, facts),
            },
        }
    }
    merged.ok_or_else(|| {
        anyhow::anyhow!(
            "no source packages found under {} (tried: {})",
            root.display(),
            tried.join(", ")
        )
    })
}

/// Merge `incoming` into `acc`. Crate names are unique per language
/// (Rust crates are namespaced by `package.name`, TS packages by
/// `package.json#name`), so collisions across languages are extremely
/// unlikely; on collision the incoming wins and we trust the caller
/// to use distinct names. Edge lists concatenate. Per-type edge
/// profiles concatenate by overwriting on collision — type ids are
/// fully-qualified and language-prefixed, so collisions in practice
/// only happen when the same frontend somehow runs twice, which the
/// caller already avoids by registering each frontend once.
fn merge_into(acc: &mut WorkspaceFacts, incoming: WorkspaceFacts) {
    for (name, crate_facts) in incoming.crates {
        acc.crates.insert(name, crate_facts);
    }
    acc.edges.extend(incoming.edges);
    acc.call_edges.extend(incoming.call_edges);
    for (type_id, profile) in incoming.edge_profiles {
        acc.edge_profiles.insert(type_id, profile);
    }
}
