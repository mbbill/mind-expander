//! Tour ingestion: schema types, resolver, and the in-memory queue
//! consumed by the viewer's eventual SSE channel.
//!
//! Contract (mirror of the docs in the schema spec):
//!   • A step is one of three shapes; the author picks intent explicitly:
//!       1. `{ say }`                        — narration only
//!       2. `{ say, ref: Reference }`        — focus one element
//!       3. `{ say, arrow: { from, to } }`   — focus a directed arrow
//!     The resolver rejects any step that sets both `ref` and `arrow`.
//!   • Each `Reference` is workspace-relative: `{file, line?}`.
//!   • `line == None` → "the module that owns this file".
//!   • `line == Some(n)` → resolve via a fallback ladder:
//!       1. element whose span contains `n` (smallest range wins);
//!       2. nearest element starting at or after `n`;
//!       3. nearest element ending before `n`;
//!       4. the file's module.
//!   • Arrow steps additionally require a directed edge `from → to`
//!     to exist in the workspace facts (call or type-level edge).
//!     A wrong-way edge is rejected so the bubble's text and the
//!     diagram arrow always agree on direction.
//!   • Validation rejects unknown schema versions and unresolvable refs
//!     with one structured error per failing reference.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::model::WorkspaceFacts;

// ─── Wire schema ────────────────────────────────────────────────────────────

/// Schema version emitted by the AI / accepted by the server. Bumped
/// when a backwards-incompatible change lands; the server rejects
/// unknown versions with a clear error rather than silently mis-playing
/// a tour. v2 replaced `refs: [...]` with the explicit three-shape
/// step (`say` / `say + ref` / `say + arrow`) so direction and intent
/// are never inferred.
pub const SCHEMA_VERSION: u32 = 2;

#[derive(Debug, Deserialize)]
pub struct Tour {
    pub schema_version: u32,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub subject: Option<Reference>,
    pub steps: Vec<Step>,
}

/// A step is one of three explicit shapes, distinguished by which of
/// `ref` / `arrow` is set. The resolver rejects steps that set both —
/// there is no implicit "ref wins" or "arrow wins" rule because the
/// whole point of v2 is to eliminate ambiguity.
#[derive(Debug, Deserialize)]
pub struct Step {
    pub say: String,
    #[serde(default, rename = "ref")]
    pub r#ref: Option<Reference>,
    #[serde(default)]
    pub arrow: Option<ArrowSpec>,
}

/// A directed arrow the author wants the bubble to focus on. `from`
/// and `to` are ordered: `from` is the caller / source, `to` is the
/// callee / target. The resolver verifies a matching directed edge
/// exists; a backwards-only edge is rejected, not silently flipped.
#[derive(Debug, Deserialize)]
pub struct ArrowSpec {
    pub from: Reference,
    pub to: Reference,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Reference {
    pub file: String,
    #[serde(default)]
    pub line: Option<u32>,
}

// ─── Resolved form ──────────────────────────────────────────────────────────

/// Element kind in the diagram's vocabulary. Mirrors `ElementKind` in
/// `viewer/src/data/spans.ts`; serializes as a lowercase tag so the
/// JSON the viewer eventually receives is consistent across the two
/// implementations.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ElementKind {
    Module,
    Type,
    Field,
    Method,
    Function,
}

/// A resolved reference: server has canonicalised `{file, line}` into
/// `(id, kind)`. The viewer can apply this verbatim — no further
/// lookup needed.
#[derive(Debug, Clone, Serialize)]
pub struct ResolvedRef {
    pub id: String,
    pub kind: ElementKind,
}

/// What the viewer's tour bubble should point at on this stage.
/// Set by the server during ingestion — the AI never specifies it.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StepFocus {
    /// Text-only step (0 refs). Bubble has no pointer.
    None,
    /// Bubble points at `refs[0]`.
    Element,
    /// Bubble points at the arrow midpoint between `refs[0]` (from /
    /// caller) and `refs[1]` (to / callee). Order matches the
    /// author's `arrow.from` and `arrow.to` exactly, so the viewer
    /// can reveal the call edge in the correct direction without
    /// guessing.
    Arrow,
}

#[derive(Debug, Clone, Serialize)]
pub struct ResolvedStep {
    pub say: String,
    pub refs: Vec<ResolvedRef>,
    pub focus: StepFocus,
}

#[derive(Debug, Clone, Serialize)]
pub struct ResolvedTour {
    pub tour_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<ResolvedRef>,
    pub steps: Vec<ResolvedStep>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ResolveError {
    /// 1-indexed step number (0 reserved for the top-level `subject`).
    pub step: usize,
    /// 1-indexed ref position within the step (0 reserved for the step
    /// itself, in case we add step-level errors later).
    pub r#ref: usize,
    pub msg: String,
}

// ─── Resolver ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct CallSite {
    start_line: u32,
    end_line: u32,
    callee_id: String,
}

struct IndexedEntry {
    element_id: String,
    kind: ElementKind,
    start_line: u32,
    end_line: u32,
}

/// Per-file index used by the resolver. Entries within a file are
/// sorted by start_line ascending, then by range size ascending so a
/// containment query returns the deepest (smallest) hit first.
pub struct SpanIndex {
    by_file: BTreeMap<PathBuf, Vec<IndexedEntry>>,
    module_by_file: BTreeMap<PathBuf, String>,
    /// Directed adjacency built from `WorkspaceFacts.edges` and
    /// `call_edges`. `directed_edges` contains every `(from, to)`
    /// pair exactly as it appears in the facts — no symmetric
    /// mirroring. The arrow-step validator uses this so an author
    /// who writes the wrong direction is rejected, not silently
    /// flipped.
    directed_edges: std::collections::BTreeSet<(String, String)>,
    /// Per-file list of call expressions, each with its inclusive
    /// line range and resolved callee id. The resolver uses this to
    /// answer "the line the AI cited falls inside a call expression
    /// — what is being called?". Pick the smallest interval that
    /// contains the line so that `f(g())` resolves to `g` (the
    /// inner call), not `f`.
    callsites_by_file: BTreeMap<PathBuf, Vec<CallSite>>,
}

impl SpanIndex {
    pub fn build(facts: &WorkspaceFacts) -> Self {
        // Per-crate partial maps built in parallel. Each crate's
        // entry/module assignments are independent of every other
        // crate's because IDs are namespaced by crate name and span
        // files don't overlap across crates. We merge into the
        // canonical maps sequentially below — the merge step is O(N)
        // BTreeMap pushes, cheap next to the per-entity sweep.
        let crates: Vec<_> = facts.crates.values().collect();
        let partials: Vec<(
            BTreeMap<PathBuf, Vec<IndexedEntry>>,
            BTreeMap<PathBuf, String>,
        )> = crates
            .par_iter()
            .map(|krate| build_crate_partial(krate))
            .collect();

        let mut by_file: BTreeMap<PathBuf, Vec<IndexedEntry>> = BTreeMap::new();
        let mut module_by_file: BTreeMap<PathBuf, String> = BTreeMap::new();
        for (part_by_file, part_module_by_file) in partials {
            for (file, entries) in part_by_file {
                by_file.entry(file).or_default().extend(entries);
            }
            for (file, module_id) in part_module_by_file {
                // First module that points at a given file wins —
                // inline `mod foo { ... }` modules share their
                // parent's file, and the parent (registered first by
                // BTreeMap iteration on the empty/shorter path) is
                // the right "owner" to fall back to.
                module_by_file.entry(file).or_insert(module_id);
            }
        }

        // Per-file entry sort runs in parallel — each file is
        // independent, so the rayon overhead pays back on workspaces
        // with thousands of files.
        by_file.par_iter_mut().for_each(|(_, entries)| {
            entries.sort_by(|a, b| {
                a.start_line
                    .cmp(&b.start_line)
                    .then_with(|| (a.end_line - a.start_line).cmp(&(b.end_line - b.start_line)))
            });
        });
        let mut directed_edges: std::collections::BTreeSet<(String, String)> =
            std::collections::BTreeSet::new();
        for edge in &facts.edges {
            directed_edges.insert((edge.from.clone(), edge.to.clone()));
        }
        let mut callsites_by_file: BTreeMap<PathBuf, Vec<CallSite>> = BTreeMap::new();
        for call in &facts.call_edges {
            directed_edges.insert((call.caller.clone(), call.callee.clone()));
            if call.callsite_start_line == 0 || call.callsite_end_line == 0 {
                continue;
            }
            if let Some(file) = find_caller_file(&by_file, &call.caller) {
                callsites_by_file.entry(file).or_default().push(CallSite {
                    start_line: call.callsite_start_line,
                    end_line: call.callsite_end_line,
                    callee_id: call.callee.clone(),
                });
            }
        }
        // Sort each file's callsites by start_line, then ascending
        // span size — same ordering trick we use for IndexedEntry, so
        // the smallest containing interval wins on a linear scan.
        for sites in callsites_by_file.values_mut() {
            sites.sort_by(|a, b| {
                a.start_line
                    .cmp(&b.start_line)
                    .then_with(|| (a.end_line - a.start_line).cmp(&(b.end_line - b.start_line)))
            });
        }
        Self {
            by_file,
            module_by_file,
            directed_edges,
            callsites_by_file,
        }
    }

    /// Find what `ElementKind` `id` belongs to by scanning every
    /// indexed entry. Used by the callsite-aware resolver when the
    /// callee lives in a different file than the call site. O(N)
    /// scan, but only fires per ref the user clicks, so the cost is
    /// negligible compared with the d3 redraw that follows.
    fn lookup_kind_anywhere(&self, id: &str) -> Option<ElementKind> {
        for entries in self.by_file.values() {
            if let Some(e) = entries.iter().find(|e| e.element_id == id) {
                return Some(e.kind.clone());
            }
        }
        None
    }

    /// Does a directed edge `from → to` exist in the facts? Used by
    /// the arrow-step validator: an author who writes the wrong
    /// direction gets rejected, not silently flipped. Checks both
    /// type-level edges and call edges (calls are stored as
    /// `caller → callee`).
    pub fn has_directed_edge(&self, from: &str, to: &str) -> bool {
        self.directed_edges
            .contains(&(from.to_string(), to.to_string()))
    }

    /// Resolve one reference, prepending `workspace_root` to its file
    /// path. Returns a concise message on failure that the CLI can
    /// surface verbatim.
    pub fn resolve(&self, r: &Reference, workspace_root: &Path) -> Result<ResolvedRef, String> {
        let abs = workspace_root.join(&r.file);
        // canonicalize so the path matches what `mod.file` recorded
        // (the extractor canonicalizes too). Missing files fall through
        // to the indexed-lookup path; the `not in index` message is
        // friendlier than a stat error.
        let abs = std::fs::canonicalize(&abs).unwrap_or(abs);

        let module_id = self.module_by_file.get(&abs);

        // No line → module reference (whole file).
        let line = match r.line {
            None => {
                return module_id
                    .map(|id| ResolvedRef {
                        id: id.clone(),
                        kind: ElementKind::Module,
                    })
                    .ok_or_else(|| format!("file not in index: {}", r.file));
            }
            Some(l) => l,
        };

        let entries = match self.by_file.get(&abs) {
            Some(e) => e,
            None => {
                return module_id
                    .map(|id| ResolvedRef {
                        id: id.clone(),
                        kind: ElementKind::Module,
                    })
                    .ok_or_else(|| format!("file not in index: {}", r.file));
            }
        };

        // 0. Callsite-aware shortcut: if the cited line falls
        //    inside a known call expression, resolve to the CALLEE.
        //    Smallest containing interval wins, so `f(g())` lines
        //    resolve to `g`. Falls through to the containing rule if
        //    no callsite matches.
        if let Some(sites) = self.callsites_by_file.get(&abs) {
            if let Some(hit) = sites
                .iter()
                .filter(|s| s.start_line <= line && s.end_line >= line)
                .min_by_key(|s| s.end_line.saturating_sub(s.start_line))
            {
                if let Some(kind) = entries
                    .iter()
                    .find(|e| e.element_id == hit.callee_id)
                    .map(|e| e.kind.clone())
                    .or_else(|| self.lookup_kind_anywhere(&hit.callee_id))
                {
                    return Ok(ResolvedRef {
                        id: hit.callee_id.clone(),
                        kind,
                    });
                }
            }
        }

        // 1. Element whose span contains `line`. The list is already
        //    sorted deepest-first within a start_line; min_by_key on
        //    the range size produces the tightest fit.
        if let Some(hit) = entries
            .iter()
            .filter(|e| e.start_line <= line && e.end_line >= line)
            .min_by_key(|e| e.end_line.saturating_sub(e.start_line))
        {
            return Ok(into_resolved(hit));
        }
        // 2. Nearest element starting at or after `line`.
        if let Some(hit) = entries
            .iter()
            .filter(|e| e.start_line >= line)
            .min_by_key(|e| e.start_line - line)
        {
            return Ok(into_resolved(hit));
        }
        // 3. Nearest element ending before `line`.
        if let Some(hit) = entries
            .iter()
            .filter(|e| e.end_line < line)
            .max_by_key(|e| e.end_line)
        {
            return Ok(into_resolved(hit));
        }
        // 4. File's module.
        module_id
            .map(|id| ResolvedRef {
                id: id.clone(),
                kind: ElementKind::Module,
            })
            .ok_or_else(|| format!("no resolvable element near {}:{}", r.file, line))
    }
}

/// Build one crate's contribution to `SpanIndex.by_file` and
/// `SpanIndex.module_by_file`. Pure function — no cross-crate state —
/// so the caller can run this in parallel across crates.
fn build_crate_partial(
    krate: &crate::model::CrateFacts,
) -> (
    BTreeMap<PathBuf, Vec<IndexedEntry>>,
    BTreeMap<PathBuf, String>,
) {
    let mut by_file: BTreeMap<PathBuf, Vec<IndexedEntry>> = BTreeMap::new();
    let mut module_by_file: BTreeMap<PathBuf, String> = BTreeMap::new();
    for module in krate.modules.values() {
        let module_id = if module.path.is_empty() {
            krate.name.clone()
        } else {
            format!("{}::{}", krate.name, module.path)
        };
        module_by_file
            .entry(canonical_or_owned(&module.file))
            .or_insert_with(|| module_id.clone());

        for t in &module.types {
            if let Some(span) = &t.span {
                by_file
                    .entry(canonical_or_owned(&span.file))
                    .or_default()
                    .push(IndexedEntry {
                        element_id: t.full_path.clone(),
                        kind: ElementKind::Type,
                        start_line: span.start_line,
                        end_line: span.end_line,
                    });
            }
            for f in &t.fields {
                if let Some(span) = &f.span {
                    by_file
                        .entry(canonical_or_owned(&span.file))
                        .or_default()
                        .push(IndexedEntry {
                            element_id: format!("{}::{}", t.full_path, f.name),
                            kind: ElementKind::Field,
                            start_line: span.start_line,
                            end_line: span.end_line,
                        });
                }
            }
            for m in &t.methods {
                if let Some(span) = &m.span {
                    by_file
                        .entry(canonical_or_owned(&span.file))
                        .or_default()
                        .push(IndexedEntry {
                            element_id: format!("{}::{}", t.full_path, m.name),
                            kind: ElementKind::Method,
                            start_line: span.start_line,
                            end_line: span.end_line,
                        });
                }
            }
        }
        for fn_facts in &module.functions {
            if let Some(span) = &fn_facts.span {
                let id = if module.path.is_empty() {
                    format!("{}::{}", krate.name, fn_facts.name)
                } else {
                    format!("{}::{}::{}", krate.name, module.path, fn_facts.name)
                };
                by_file
                    .entry(canonical_or_owned(&span.file))
                    .or_default()
                    .push(IndexedEntry {
                        element_id: id,
                        kind: ElementKind::Function,
                        start_line: span.start_line,
                        end_line: span.end_line,
                    });
            }
        }
    }
    (by_file, module_by_file)
}

fn find_caller_file(
    by_file: &BTreeMap<PathBuf, Vec<IndexedEntry>>,
    caller_id: &str,
) -> Option<PathBuf> {
    for (file, entries) in by_file {
        if entries.iter().any(|e| e.element_id == caller_id) {
            return Some(file.clone());
        }
    }
    None
}

fn into_resolved(e: &IndexedEntry) -> ResolvedRef {
    ResolvedRef {
        id: e.element_id.clone(),
        kind: e.kind.clone(),
    }
}

fn canonical_or_owned(path: &str) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path))
}

// ─── Validation + resolution entry point ────────────────────────────────────

pub struct IngestOk {
    pub resolved: ResolvedTour,
}

pub struct IngestErr {
    pub errors: Vec<ResolveError>,
}

/// Validate the schema version, then resolve every reference. Failures
/// from any step are collected so the AI sees all issues at once
/// rather than fix-one-rerun-fix-one.
pub fn ingest(
    tour: Tour,
    index: &SpanIndex,
    workspace_root: &Path,
    tour_id: String,
) -> Result<IngestOk, IngestErr> {
    let mut errors: Vec<ResolveError> = Vec::new();

    if tour.schema_version != SCHEMA_VERSION {
        errors.push(ResolveError {
            step: 0,
            r#ref: 0,
            msg: format!(
                "schema_version {} not supported; expected {SCHEMA_VERSION}",
                tour.schema_version
            ),
        });
        return Err(IngestErr { errors });
    }
    if tour.steps.is_empty() {
        errors.push(ResolveError {
            step: 0,
            r#ref: 0,
            msg: "tour has no steps".into(),
        });
        return Err(IngestErr { errors });
    }

    let subject = tour
        .subject
        .as_ref()
        .and_then(|r| match index.resolve(r, workspace_root) {
            Ok(rr) => Some(rr),
            Err(msg) => {
                errors.push(ResolveError {
                    step: 0,
                    r#ref: 0,
                    msg: format!("subject: {msg}"),
                });
                None
            }
        });

    // Resolve each step into its explicit shape. The three step
    // shapes are mutually exclusive — `ref` XOR `arrow` XOR neither —
    // and the resolver rejects any mix or any wrong-direction arrow
    // up front so the wire form (refs + focus) is unambiguous.
    let mut resolved_steps: Vec<ResolvedStep> = Vec::with_capacity(tour.steps.len());
    for (si, step) in tour.steps.iter().enumerate() {
        let resolved = match (&step.r#ref, &step.arrow) {
            (Some(_), Some(_)) => {
                errors.push(ResolveError {
                    step: si + 1,
                    r#ref: 0,
                    msg: "step sets both `ref` and `arrow`; pick exactly one shape".into(),
                });
                continue;
            }
            (None, None) => ResolvedStep {
                say: step.say.clone(),
                refs: Vec::new(),
                focus: StepFocus::None,
            },
            (Some(r), None) => match index.resolve(r, workspace_root) {
                Ok(rr) => ResolvedStep {
                    say: step.say.clone(),
                    refs: vec![rr],
                    focus: StepFocus::Element,
                },
                Err(msg) => {
                    errors.push(ResolveError {
                        step: si + 1,
                        r#ref: 1,
                        msg,
                    });
                    continue;
                }
            },
            (None, Some(arrow)) => {
                // Resolve both endpoints first so the author sees every
                // bad reference in one pass rather than fix-one-rerun.
                let from = index.resolve(&arrow.from, workspace_root);
                let to = index.resolve(&arrow.to, workspace_root);
                let from = match from {
                    Ok(r) => r,
                    Err(msg) => {
                        errors.push(ResolveError {
                            step: si + 1,
                            r#ref: 1,
                            msg: format!("arrow.from: {msg}"),
                        });
                        continue;
                    }
                };
                let to = match to {
                    Ok(r) => r,
                    Err(msg) => {
                        errors.push(ResolveError {
                            step: si + 1,
                            r#ref: 2,
                            msg: format!("arrow.to: {msg}"),
                        });
                        continue;
                    }
                };
                if from.id == to.id {
                    errors.push(ResolveError {
                        step: si + 1,
                        r#ref: 0,
                        msg: "arrow.from and arrow.to resolve to the same element".into(),
                    });
                    continue;
                }
                // Direction matters: facts contain `caller → callee`
                // for calls and `owner → owned` for type-level edges.
                // A wrong-direction arrow is rejected with a hint so
                // the author can swap, rather than have the bubble
                // show one direction while the diagram shows another.
                if !index.has_directed_edge(&from.id, &to.id) {
                    let hint = if index.has_directed_edge(&to.id, &from.id) {
                        " (the reverse direction does exist — did you swap `from` and `to`?)"
                    } else {
                        ""
                    };
                    errors.push(ResolveError {
                        step: si + 1,
                        r#ref: 0,
                        msg: format!("no directed edge from `{}` to `{}`{hint}", from.id, to.id),
                    });
                    continue;
                }
                ResolvedStep {
                    say: step.say.clone(),
                    refs: vec![from, to],
                    focus: StepFocus::Arrow,
                }
            }
        };
        resolved_steps.push(resolved);
    }

    if !errors.is_empty() {
        return Err(IngestErr { errors });
    }

    Ok(IngestOk {
        resolved: ResolvedTour {
            tour_id,
            title: tour.title,
            subject,
            steps: resolved_steps,
        },
    })
}

// ─── In-memory queue ────────────────────────────────────────────────────────

/// Successfully ingested tours, in arrival order. The eventual SSE
/// channel drains/observes this; for now it's just a record so
/// `/api/tour` can be exercised end-to-end before the viewer side
/// ships. `Mutex` is fine here — push and read are infrequent.
#[derive(Default)]
pub struct TourQueue {
    inner: Mutex<Vec<ResolvedTour>>,
}

impl TourQueue {
    pub fn push(&self, tour: ResolvedTour) {
        self.inner.lock().expect("tour queue poisoned").push(tour);
    }

    /// Snapshot the current queue. Primarily for tests / health
    /// diagnostics; the viewer's eventual SSE consumer will use a
    /// channel-based notify instead.
    pub fn snapshot(&self) -> Vec<ResolvedTour> {
        self.inner.lock().expect("tour queue poisoned").clone()
    }
}
