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
use crate::model::{Language, WorkspaceFacts};

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
        let mut facts = extract::extract_workspace(root)?;
        if facts.crates.is_empty() {
            return Ok(None);
        }
        // Stamp the language on every crate this frontend emits.
        // `Language::default()` is already Rust, so this is
        // technically redundant — but keeping the invariant local
        // to the frontend (rather than leaning on a default two
        // files away) is the cheap, explicit option.
        for cf in facts.crates.values_mut() {
            cf.language = Language::Rust;
        }
        Ok(Some(facts))
    }
}
