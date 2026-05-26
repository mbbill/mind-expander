//! Git-driven revision plumbing for the `view --at <revspec>` flow.
//!
//! Owns the "which snapshot do we parse" decision and nothing else.
//! The server consumes a `RevSpec` plus the materialized `head_path`
//! and never touches `git` directly — keeps the boundary between
//! "git plumbing" and "axum routes" clean.
//!
//! Revspec grammar (one new flag, mirrors git's range syntax):
//!   - empty            → head = working tree, base = none
//!   - `<ref>`          → head = <ref>,        base = none
//!   - `<base>..<head>` → head = <head>,       base = <base>
//!   - `<base>..`       → head = working tree, base = <base>
//!   - `..<head>`       → head = <head>,       base = working tree
//!
//! `None` in either `base` or `head` always means "the working tree."
//! `Some(refname)` always means "a committed sha to resolve."
//! This keeps the four code paths (no diff / diff vs wt / diff vs sha /
//! browse old sha) collapsible to one mechanism.

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{anyhow, bail, Context, Result};

/// Parsed `--at` value. Either side `None` means "the working tree."
/// `diff_enabled` records whether the user wrote a `..` separator —
/// needed to distinguish "" (no diff at all) from "..ref" (diff vs
/// working-tree base), since both leave `base = None`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevSpec {
    pub base: Option<String>,
    pub head: Option<String>,
    pub diff_enabled: bool,
}

impl RevSpec {
    pub fn working_tree() -> Self {
        Self {
            base: None,
            head: None,
            diff_enabled: false,
        }
    }
}

/// Parse a `--at` value. Splits on the first `..` literal, at most once.
/// Returns a `RevSpec` with empty sides converted to `None`.
pub fn parse_revspec(s: &str) -> Result<RevSpec> {
    if s.is_empty() {
        return Ok(RevSpec::working_tree());
    }
    // Find the literal `..` separator. We split on the first occurrence
    // only: refs themselves never contain `..` (git rejects it in branch
    // names), so a second occurrence would already be invalid input.
    match s.find("..") {
        None => Ok(RevSpec {
            base: None,
            head: Some(s.to_owned()),
            diff_enabled: false,
        }),
        Some(i) => {
            let base = &s[..i];
            let head = &s[i + 2..];
            Ok(RevSpec {
                base: if base.is_empty() {
                    None
                } else {
                    Some(base.to_owned())
                },
                head: if head.is_empty() {
                    None
                } else {
                    Some(head.to_owned())
                },
                diff_enabled: true,
            })
        }
    }
}

/// `git -C <path> rev-parse --show-toplevel` → the repo root that
/// contains `path`. Errors if `path` is not inside a git repo.
pub fn find_repo_root(path: &Path) -> Result<PathBuf> {
    let out = Command::new("git")
        .args(["-C"])
        .arg(path)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .context("invoking `git rev-parse --show-toplevel`")?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        bail!(
            "not a git repository: {} ({})",
            path.display(),
            stderr.trim()
        );
    }
    let raw = String::from_utf8(out.stdout).context("git toplevel path is not utf-8")?;
    Ok(PathBuf::from(raw.trim()))
}

/// Resolve a ref string to a full sha. Returns the git error message
/// verbatim on failure so the user sees what git saw.
pub fn resolve_sha(repo_root: &Path, refname: &str) -> Result<String> {
    let out = Command::new("git")
        .args(["-C"])
        .arg(repo_root)
        .args(["rev-parse", "--verify", "--quiet"])
        // `^{commit}` resolves tags / branches / shas all to the
        // underlying commit sha. Detached worktrees want commits, not
        // tag objects.
        .arg(format!("{refname}^{{commit}}"))
        .output()
        .context("invoking `git rev-parse`")?;
    if !out.status.success() {
        bail!(
            "git could not resolve `{refname}`: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    let raw = String::from_utf8(out.stdout).context("git rev-parse output not utf-8")?;
    let sha = raw.trim();
    if sha.is_empty() {
        bail!("git resolved `{refname}` to an empty sha");
    }
    Ok(sha.to_owned())
}

/// Fetch a file's content as it existed at a given sha. Used by
/// `/api/source?side=base` so the code panel can render base-side
/// content for removed/modified entities without materializing the
/// base worktree on disk. Returns the file bytes verbatim.
pub fn show_blob(repo_root: &Path, sha: &str, repo_rel: &str) -> Result<Vec<u8>> {
    let out = Command::new("git")
        .args(["-C"])
        .arg(repo_root)
        .arg("show")
        .arg(format!("{sha}:{repo_rel}"))
        .output()
        .context("invoking `git show`")?;
    if !out.status.success() {
        bail!(
            "git show {sha}:{repo_rel} failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(out.stdout)
}

/// `git -C <repo_root> worktree prune` to clean up stale worktree
/// entries left behind when a cache dir was deleted out-of-band.
/// Non-fatal: a failure here just means stale entries linger.
pub fn prune_worktrees(repo_root: &Path) -> Result<()> {
    let out = Command::new("git")
        .args(["-C"])
        .arg(repo_root)
        .args(["worktree", "prune"])
        .output()
        .context("invoking `git worktree prune`")?;
    if !out.status.success() {
        // Only warn — pruning is hygiene, not correctness.
        eprintln!(
            "[mind-expander] (warning) git worktree prune failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(())
}

/// Cache dir for the materialized head worktree.
/// `~/.cache/mind-expander/worktrees/<repo-id>/<sha>/`.
/// `repo-id` is a sha1 of the repo root path so two checkouts of the
/// same logical repo don't collide.
pub fn worktree_cache_path(repo_root: &Path, head_sha: &str) -> Result<PathBuf> {
    let base = dirs_cache_dir()?
        .join("mind-expander")
        .join("worktrees")
        .join(repo_hash(repo_root))
        .join(head_sha);
    Ok(base)
}

/// Materialize a head sha as a detached worktree under the cache dir.
/// Returns the path to the worktree (which becomes the parser's input).
///
/// `--detach` bypasses the "branch already checked out elsewhere"
/// constraint: the new worktree carries a detached HEAD pointing at
/// the sha and never tries to occupy a branch slot.
pub fn materialize_head(repo_root: &Path, head_sha: &str) -> Result<PathBuf> {
    let dest = worktree_cache_path(repo_root, head_sha)?;

    // Fast path: the cache dir exists AND git knows about it as a
    // registered worktree → reuse it. We deliberately don't trust the
    // dir's mere existence; a stale dir from a previous crash would
    // not be a valid worktree.
    if dest.exists() && is_registered_worktree(repo_root, &dest)? {
        return Ok(dest);
    }

    // If a leftover dir is here but not registered, get rid of it
    // first so `git worktree add` doesn't refuse on "path exists."
    if dest.exists() {
        std::fs::remove_dir_all(&dest)
            .with_context(|| format!("removing stale cache dir {}", dest.display()))?;
    }

    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating cache parent {}", parent.display()))?;
    }

    let out = Command::new("git")
        .args(["-C"])
        .arg(repo_root)
        .args(["worktree", "add", "--detach"])
        .arg(&dest)
        .arg(head_sha)
        .output()
        .context("invoking `git worktree add`")?;
    if !out.status.success() {
        bail!(
            "git worktree add failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(dest)
}

fn is_registered_worktree(repo_root: &Path, dest: &Path) -> Result<bool> {
    let out = Command::new("git")
        .args(["-C"])
        .arg(repo_root)
        .args(["worktree", "list", "--porcelain"])
        .output()
        .context("invoking `git worktree list`")?;
    if !out.status.success() {
        return Ok(false);
    }
    let text = String::from_utf8_lossy(&out.stdout);
    // Porcelain output starts each entry with `worktree <abs-path>`.
    let canon = std::fs::canonicalize(dest).unwrap_or_else(|_| dest.to_owned());
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("worktree ") {
            let entry = PathBuf::from(rest);
            let entry_canon = std::fs::canonicalize(&entry).unwrap_or(entry);
            if entry_canon == canon {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

fn repo_hash(repo_root: &Path) -> String {
    // A cheap stable digest is enough — collisions just mean a single
    // user reusing two repo paths that hash the same. DJB2-like fold
    // over the path bytes; no extra deps.
    let bytes = repo_root.as_os_str().to_string_lossy();
    let mut h: u64 = 5381;
    for b in bytes.bytes() {
        h = h.wrapping_mul(33).wrapping_add(b as u64);
    }
    format!("{h:016x}")
}

fn dirs_cache_dir() -> Result<PathBuf> {
    if let Ok(xdg) = std::env::var("XDG_CACHE_HOME") {
        if !xdg.is_empty() {
            return Ok(PathBuf::from(xdg));
        }
    }
    let home =
        std::env::var("HOME").map_err(|_| anyhow!("HOME not set; cannot locate cache dir"))?;
    Ok(PathBuf::from(home).join(".cache"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_empty_means_working_tree() {
        let r = parse_revspec("").unwrap();
        assert_eq!(r, RevSpec::working_tree());
        assert!(!r.diff_enabled);
    }

    #[test]
    fn parse_single_ref_is_head_only_no_diff() {
        let r = parse_revspec("HEAD~3").unwrap();
        assert_eq!(r.base, None);
        assert_eq!(r.head.as_deref(), Some("HEAD~3"));
        assert!(!r.diff_enabled);
    }

    #[test]
    fn parse_range_two_refs() {
        let r = parse_revspec("main..pr-42").unwrap();
        assert_eq!(r.base.as_deref(), Some("main"));
        assert_eq!(r.head.as_deref(), Some("pr-42"));
        assert!(r.diff_enabled);
    }

    #[test]
    fn parse_base_only_means_head_is_working_tree() {
        let r = parse_revspec("main..").unwrap();
        assert_eq!(r.base.as_deref(), Some("main"));
        assert_eq!(r.head, None);
        assert!(r.diff_enabled);
    }

    #[test]
    fn parse_head_only_means_base_is_working_tree() {
        let r = parse_revspec("..pr-42").unwrap();
        assert_eq!(r.base, None);
        assert_eq!(r.head.as_deref(), Some("pr-42"));
        // `..pr-42`: diff IS enabled (user wrote `..`); base = None
        // means "use the working tree as the diff base."
        assert!(r.diff_enabled);
    }
}
