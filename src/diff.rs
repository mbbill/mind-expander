//! Code-panel diff source.
//!
//! Invokes `git diff` against the workspace's repo and converts the
//! unified output into the structured shape the viewer consumes.
//! Server endpoint contract (mirrored in viewer/src/view/code_panel.ts):
//!
//! ```json
//! {
//!   "file_old": "crates/foo/src/bar.rs" | null,
//!   "file_new": "crates/foo/src/bar.rs" | null,
//!   "hunks": [{
//!     "old_start": 12, "old_count": 5,
//!     "new_start": 12, "new_count": 8,
//!     "lines": [
//!       { "kind": "context"|"add"|"del", "text": "...", "old"?: N, "new"?: N }
//!     ]
//!   }]
//! }
//! ```
//!
//! The base side never needs materialization — `git diff` reads both
//! sides directly from git objects (and the working tree, when head
//! is omitted). So this module owns one shell call + one parser and
//! nothing else.

use std::path::Path;
use std::process::Command;

use anyhow::{Context, Result, bail};
use serde::Serialize;

/// Top-level result returned over `/api/diff`.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct DiffResult {
    pub file_old: Option<String>,
    pub file_new: Option<String>,
    pub hunks: Vec<Hunk>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct Hunk {
    pub old_start: u32,
    pub old_count: u32,
    pub new_start: u32,
    pub new_count: u32,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct DiffLine {
    pub kind: LineKind,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new: Option<u32>,
}

#[derive(Debug, Serialize, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum LineKind {
    Context,
    Add,
    Del,
}

/// Outcome of a diff request. `Empty` is the "file unchanged" case the
/// server maps to HTTP 204 so the panel can fall back to source mode.
pub enum DiffOutcome {
    Changed(DiffResult),
    Empty,
}

/// Shell out to `git diff` and parse the result for one file.
/// `head_sha = None` means "compare base to working tree."
pub fn diff_file(
    repo_root: &Path,
    base_sha: &str,
    head_sha: Option<&str>,
    repo_relative_path: &str,
) -> Result<DiffOutcome> {
    let mut cmd = Command::new("git");
    cmd.args(["-C"])
        .arg(repo_root)
        .args(["diff", "--no-color", "-U3", "--no-ext-diff", base_sha]);
    if let Some(h) = head_sha {
        cmd.arg(h);
    }
    cmd.arg("--").arg(repo_relative_path);
    let out = cmd.output().context("invoking `git diff`")?;
    if !out.status.success() {
        bail!(
            "git diff failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    let text = String::from_utf8(out.stdout)
        .context("git diff output not utf-8")?;
    if text.trim().is_empty() {
        return Ok(DiffOutcome::Empty);
    }
    parse_unified(&text).map(DiffOutcome::Changed)
}

/// Parse a single-file unified diff produced by `git diff`. Caller is
/// responsible for ensuring the input is for one file (we filter
/// `--` to one path so this holds for our endpoint).
pub fn parse_unified(text: &str) -> Result<DiffResult> {
    let mut file_old: Option<String> = None;
    let mut file_new: Option<String> = None;
    let mut hunks: Vec<Hunk> = Vec::new();
    let mut cur: Option<Hunk> = None;
    let mut old_line: u32 = 0;
    let mut new_line: u32 = 0;

    for line in text.split_inclusive('\n') {
        // Strip the trailing newline for stored text — the panel
        // re-introduces line breaks via its per-line DOM.
        let raw = line.strip_suffix('\n').unwrap_or(line);

        // File header lines: `--- a/path` and `+++ b/path`. `/dev/null`
        // means the file was added (no a/) or removed (no b/).
        if let Some(rest) = raw.strip_prefix("--- ") {
            file_old = parse_header_path(rest);
            continue;
        }
        if let Some(rest) = raw.strip_prefix("+++ ") {
            file_new = parse_header_path(rest);
            continue;
        }
        // Hunk header: `@@ -old_start[,old_count] +new_start[,new_count] @@ ...`
        if let Some(rest) = raw.strip_prefix("@@ ") {
            if let Some(h) = cur.take() {
                hunks.push(h);
            }
            let (os, oc, ns, nc) = parse_hunk_header(rest)?;
            old_line = os;
            new_line = ns;
            cur = Some(Hunk {
                old_start: os,
                old_count: oc,
                new_start: ns,
                new_count: nc,
                lines: Vec::new(),
            });
            continue;
        }
        // Skip diff metadata lines we don't render: `diff --git`,
        // `index ...`, `new file mode`, `deleted file mode`, etc.
        // They appear before the first `---`/`+++` and between files.
        if cur.is_none() {
            continue;
        }
        // Line classification by leading char inside a hunk.
        let h = cur.as_mut().unwrap();
        let mut chars = raw.chars();
        let sign = chars.next();
        let body: String = chars.collect();
        match sign {
            Some('+') => {
                h.lines.push(DiffLine {
                    kind: LineKind::Add,
                    text: body,
                    old: None,
                    new: Some(new_line),
                });
                new_line += 1;
            }
            Some('-') => {
                h.lines.push(DiffLine {
                    kind: LineKind::Del,
                    text: body,
                    old: Some(old_line),
                    new: None,
                });
                old_line += 1;
            }
            Some(' ') => {
                h.lines.push(DiffLine {
                    kind: LineKind::Context,
                    text: body,
                    old: Some(old_line),
                    new: Some(new_line),
                });
                old_line += 1;
                new_line += 1;
            }
            Some('\\') => {
                // `\ No newline at end of file` — informational, drop.
                continue;
            }
            _ => {
                // Unknown line inside a hunk; tolerate by skipping.
                continue;
            }
        }
    }
    if let Some(h) = cur.take() {
        hunks.push(h);
    }
    Ok(DiffResult { file_old, file_new, hunks })
}

fn parse_header_path(rest: &str) -> Option<String> {
    // Strip trailing tab + timestamp git sometimes adds. Strip the
    // `a/` or `b/` prefix git uses by default. `/dev/null` → None.
    let path = rest.split('\t').next().unwrap_or(rest).trim();
    if path == "/dev/null" {
        return None;
    }
    let stripped = path
        .strip_prefix("a/")
        .or_else(|| path.strip_prefix("b/"))
        .unwrap_or(path);
    Some(stripped.to_owned())
}

fn parse_hunk_header(rest: &str) -> Result<(u32, u32, u32, u32)> {
    // rest is like: `-12,5 +12,8 @@ ...` (the trailing `@@` and section
    // header may or may not be present; we only care about the spans).
    let end = rest.find(" @@").unwrap_or(rest.len());
    let head = &rest[..end];
    let mut it = head.split_whitespace();
    let old = it.next().ok_or_else(|| anyhow::anyhow!("hunk header missing old span"))?;
    let new = it.next().ok_or_else(|| anyhow::anyhow!("hunk header missing new span"))?;
    let (os, oc) = parse_span(old.strip_prefix('-').unwrap_or(old))?;
    let (ns, nc) = parse_span(new.strip_prefix('+').unwrap_or(new))?;
    Ok((os, oc, ns, nc))
}

fn parse_span(s: &str) -> Result<(u32, u32)> {
    let mut parts = s.split(',');
    let start: u32 = parts
        .next()
        .ok_or_else(|| anyhow::anyhow!("missing span start"))?
        .parse()
        .context("parsing span start")?;
    let count: u32 = match parts.next() {
        Some(c) => c.parse().context("parsing span count")?,
        // Unified diff convention: omitted count = 1.
        None => 1,
    };
    Ok((start, count))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_simple_modify() {
        let diff = "\
--- a/foo.rs
+++ b/foo.rs
@@ -1,3 +1,3 @@
 fn a() {
-    old();
+    new();
 }
";
        let r = parse_unified(diff).unwrap();
        assert_eq!(r.file_old.as_deref(), Some("foo.rs"));
        assert_eq!(r.file_new.as_deref(), Some("foo.rs"));
        assert_eq!(r.hunks.len(), 1);
        let h = &r.hunks[0];
        assert_eq!(h.old_start, 1);
        assert_eq!(h.old_count, 3);
        assert_eq!(h.new_start, 1);
        assert_eq!(h.new_count, 3);
        assert_eq!(h.lines.len(), 4);
        assert_eq!(h.lines[0].kind, LineKind::Context);
        assert_eq!(h.lines[0].text, "fn a() {");
        assert_eq!(h.lines[0].old, Some(1));
        assert_eq!(h.lines[0].new, Some(1));
        assert_eq!(h.lines[1].kind, LineKind::Del);
        assert_eq!(h.lines[1].text, "    old();");
        assert_eq!(h.lines[1].old, Some(2));
        assert_eq!(h.lines[1].new, None);
        assert_eq!(h.lines[2].kind, LineKind::Add);
        assert_eq!(h.lines[2].text, "    new();");
        assert_eq!(h.lines[2].old, None);
        assert_eq!(h.lines[2].new, Some(2));
    }

    #[test]
    fn parse_added_file() {
        let diff = "\
diff --git a/new.rs b/new.rs
new file mode 100644
--- /dev/null
+++ b/new.rs
@@ -0,0 +1,2 @@
+fn x() {}
+fn y() {}
";
        let r = parse_unified(diff).unwrap();
        assert_eq!(r.file_old, None);
        assert_eq!(r.file_new.as_deref(), Some("new.rs"));
        assert_eq!(r.hunks.len(), 1);
        assert_eq!(r.hunks[0].lines.len(), 2);
        assert!(r.hunks[0].lines.iter().all(|l| l.kind == LineKind::Add));
    }

    #[test]
    fn parse_removed_file() {
        let diff = "\
diff --git a/gone.rs b/gone.rs
deleted file mode 100644
--- a/gone.rs
+++ /dev/null
@@ -1,2 +0,0 @@
-fn x() {}
-fn y() {}
";
        let r = parse_unified(diff).unwrap();
        assert_eq!(r.file_old.as_deref(), Some("gone.rs"));
        assert_eq!(r.file_new, None);
        assert_eq!(r.hunks[0].lines.len(), 2);
        assert!(r.hunks[0].lines.iter().all(|l| l.kind == LineKind::Del));
    }

    #[test]
    fn parse_hunk_header_with_default_count() {
        // git emits `@@ -5 +5 @@` (no count) when count is 1.
        let (os, oc, ns, nc) = parse_hunk_header("-5 +5 @@ context").unwrap();
        assert_eq!((os, oc, ns, nc), (5, 1, 5, 1));
    }
}
