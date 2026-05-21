//! Rust frontend — thin wrapper over [`crate::extract::extract_workspace`].
//!
//! Phase 1 intentionally does not reorganize the 1,774-line `extract.rs`.
//! This wrapper just exposes the existing entry point through the
//! [`LanguageFrontend`] trait so the dispatcher can treat Rust as one
//! of several pluggable languages. A follow-up PR can split discovery
//! from per-package extraction once a second language demands it.

use std::path::Path;

use anyhow::Result;

use crate::extract;
use crate::frontend::LanguageFrontend;
use crate::model::WorkspaceFacts;

pub struct RustFrontend;

impl LanguageFrontend for RustFrontend {
    fn name(&self) -> &'static str {
        "rust"
    }

    fn extract(&self, root: &Path) -> Result<Option<WorkspaceFacts>> {
        // `extract_workspace` walks for Cargo.toml files; a tree
        // without any returns an empty `crates` map (rather than
        // erroring). Translate "no crates discovered" into the
        // trait's "this language isn't present" signal so the
        // dispatcher can fall through to other frontends in a
        // polyglot or non-Rust repo.
        let facts = extract::extract_workspace(root)?;
        if facts.crates.is_empty() {
            Ok(None)
        } else {
            Ok(Some(facts))
        }
    }
}
