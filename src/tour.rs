//! Tour ingestion: schema types, resolver, and the in-memory queue
//! consumed by the viewer's eventual SSE channel.
//!
//! Contract (mirror of the docs in the schema spec):
//!   • Each `Reference` is workspace-relative: `{file, line?}`.
//!   • `line == None` → "the module that owns this file".
//!   • `line == Some(n)` → resolve via a fallback ladder:
//!       1. element whose span contains `n` (smallest range wins);
//!       2. nearest element starting at or after `n`;
//!       3. nearest element ending before `n`;
//!       4. the file's module.
//!   • Validation rejects unknown schema versions and unresolvable refs
//!     with one structured error per failing reference.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::model::WorkspaceFacts;

// ─── Wire schema ────────────────────────────────────────────────────────────

/// Schema version emitted by the AI / accepted by the server. Bumped
/// when a backwards-incompatible change lands; the server rejects
/// unknown versions with a clear error rather than silently mis-playing
/// a tour.
pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Deserialize)]
pub struct Tour {
    pub schema_version: u32,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub subject: Option<Reference>,
    pub steps: Vec<Step>,
}

#[derive(Debug, Deserialize)]
pub struct Step {
    pub say: String,
    #[serde(default)]
    pub refs: Vec<Reference>,
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
    /// Bubble points at the arrow midpoint between `refs[0]` and
    /// `refs[1]` — generated automatically when the original step had
    /// 2+ refs and the server detected an edge between them.
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
    /// Adjacency built from `WorkspaceFacts.edges` and `call_edges`.
    /// `connections.get(a)` returns every element id directly connected
    /// to `a`. Membership is symmetric — both endpoints are inserted —
    /// so a single lookup answers "is there an edge between A and B?".
    /// The server uses this to inject an extra "focus the arrow"
    /// stage when a tour step has multiple refs that are known to be
    /// connected.
    connections: BTreeMap<String, std::collections::BTreeSet<String>>,
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
        let mut by_file: BTreeMap<PathBuf, Vec<IndexedEntry>> = BTreeMap::new();
        let mut module_by_file: BTreeMap<PathBuf, String> = BTreeMap::new();
        let push = |by_file: &mut BTreeMap<PathBuf, Vec<IndexedEntry>>,
                    file: &str,
                    entry: IndexedEntry| {
            by_file
                .entry(canonical_or_owned(file))
                .or_default()
                .push(entry);
        };
        for krate in facts.crates.values() {
            for module in krate.modules.values() {
                let module_id = if module.path.is_empty() {
                    krate.name.clone()
                } else {
                    format!("{}::{}", krate.name, module.path)
                };
                // First module that points at a given file wins —
                // inline `mod foo { ... }` modules share their
                // parent's file, and the parent (registered first by
                // BTreeMap iteration on the empty/shorter path) is
                // the right "owner" to fall back to.
                module_by_file
                    .entry(canonical_or_owned(&module.file))
                    .or_insert_with(|| module_id.clone());

                for t in &module.types {
                    if let Some(span) = &t.span {
                        push(
                            &mut by_file,
                            &span.file,
                            IndexedEntry {
                                element_id: t.full_path.clone(),
                                kind: ElementKind::Type,
                                start_line: span.start_line,
                                end_line: span.end_line,
                            },
                        );
                    }
                    for f in &t.fields {
                        if let Some(span) = &f.span {
                            push(
                                &mut by_file,
                                &span.file,
                                IndexedEntry {
                                    element_id: format!("{}::{}", t.full_path, f.name),
                                    kind: ElementKind::Field,
                                    start_line: span.start_line,
                                    end_line: span.end_line,
                                },
                            );
                        }
                    }
                    for m in &t.methods {
                        if let Some(span) = &m.span {
                            push(
                                &mut by_file,
                                &span.file,
                                IndexedEntry {
                                    element_id: format!("{}::{}", t.full_path, m.name),
                                    kind: ElementKind::Method,
                                    start_line: span.start_line,
                                    end_line: span.end_line,
                                },
                            );
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
                        push(
                            &mut by_file,
                            &span.file,
                            IndexedEntry {
                                element_id: id,
                                kind: ElementKind::Function,
                                start_line: span.start_line,
                                end_line: span.end_line,
                            },
                        );
                    }
                }
            }
        }
        for entries in by_file.values_mut() {
            entries.sort_by(|a, b| {
                a.start_line
                    .cmp(&b.start_line)
                    .then_with(|| (a.end_line - a.start_line).cmp(&(b.end_line - b.start_line)))
            });
        }
        let mut connections: BTreeMap<String, std::collections::BTreeSet<String>> = BTreeMap::new();
        let mut record = |a: &str, b: &str| {
            connections
                .entry(a.to_string())
                .or_default()
                .insert(b.to_string());
            connections
                .entry(b.to_string())
                .or_default()
                .insert(a.to_string());
        };
        for edge in &facts.edges {
            record(&edge.from, &edge.to);
        }
        let mut callsites_by_file: BTreeMap<PathBuf, Vec<CallSite>> = BTreeMap::new();
        for call in &facts.call_edges {
            record(&call.caller, &call.callee);
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
                a.start_line.cmp(&b.start_line).then_with(|| {
                    (a.end_line - a.start_line).cmp(&(b.end_line - b.start_line))
                })
            });
        }
        Self {
            by_file,
            module_by_file,
            connections,
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

    /// Are the two element ids directly connected via any edge
    /// (type-level Edge or CallEdge)? Symmetric — direction doesn't
    /// matter for "should we show an arrow stage here?".
    pub fn connected(&self, a: &str, b: &str) -> bool {
        self.connections
            .get(a)
            .map(|set| set.contains(b))
            .unwrap_or(false)
    }

    /// Resolve one reference, prepending `workspace_root` to its file
    /// path. Returns a concise message on failure that the CLI can
    /// surface verbatim.
    pub fn resolve(
        &self,
        r: &Reference,
        workspace_root: &Path,
    ) -> Result<ResolvedRef, String> {
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

    let subject = tour.subject.as_ref().and_then(|r| {
        match index.resolve(r, workspace_root) {
            Ok(rr) => Some(rr),
            Err(msg) => {
                errors.push(ResolveError {
                    step: 0,
                    r#ref: 0,
                    msg: format!("subject: {msg}"),
                });
                None
            }
        }
    });

    let mut resolved_steps: Vec<ResolvedStep> = Vec::with_capacity(tour.steps.len());
    for (si, step) in tour.steps.iter().enumerate() {
        let mut refs: Vec<ResolvedRef> = Vec::with_capacity(step.refs.len());
        for (ri, r) in step.refs.iter().enumerate() {
            match index.resolve(r, workspace_root) {
                Ok(rr) => refs.push(rr),
                Err(msg) => errors.push(ResolveError {
                    step: si + 1,
                    r#ref: ri + 1,
                    msg,
                }),
            }
        }
        let focus = if refs.is_empty() {
            StepFocus::None
        } else {
            StepFocus::Element
        };
        // The author-written stage: bubble points at the first ref (or
        // has no pointer for a text-only step). Multiple refs go in
        // untouched — the viewer can still highlight the rest.
        resolved_steps.push(ResolvedStep {
            say: step.say.clone(),
            refs: refs.clone(),
            focus,
        });
        // Server-injected stage: if 2+ refs and at least one pair is
        // connected via a known edge (call or ownership), append a
        // duplicate-text stage that points at the arrow between the
        // first ref and the first connected partner. Detecting
        // "connected" via the precomputed adjacency keeps this cheap
        // (no facts re-traversal per step).
        if refs.len() >= 2 {
            let head = &refs[0];
            if let Some(partner) = refs.iter().skip(1).find(|r| index.connected(&head.id, &r.id)) {
                resolved_steps.push(ResolvedStep {
                    say: step.say.clone(),
                    refs: vec![head.clone(), partner.clone()],
                    focus: StepFocus::Arrow,
                });
            }
        }
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
