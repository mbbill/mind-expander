#!/usr/bin/env python3
"""
Claude Code PreToolUse permission hook.
Single source of truth for all permissions — never falls through to allow/deny list.

Rules:
  1. ALLOW read-only git commands (status, log, diff, show, branch --list, etc.)
  2. DENY  mutating git commands (commit, push, rebase, reset, etc.) unless targeting /tmp
  3. ASK   for gh (GitHub CLI) invocations
  4. DENY  file operations outside workspace and /tmp
  5. ALLOW everything else
"""

import json
import os
import re
import sys

# ── Configuration ──────────────────────────────────────────────────────────────

# Derive workspace from script location: <workspace>/.claude/hooks/pre-tool-use.py
WORKSPACE = os.path.realpath(os.path.join(os.path.dirname(__file__), "..", ".."))

ALLOWED_PATH_PREFIXES = [
    WORKSPACE,
    "/tmp",
    "/private/tmp",                     # macOS: /tmp → /private/tmp
    os.path.expanduser("~/.claude"),    # Claude Code config/memory/skills
]

# Tools that take an explicit file path
FILE_PATH_TOOLS = {
    "Write":        "file_path",
    "Edit":         "file_path",
    "Read":         "file_path",
    "NotebookEdit": "notebook_path",
}

# Tools with an optional search path (defaults to cwd when absent)
SEARCH_PATH_TOOLS = {
    "Glob": "path",
    "Grep": "path",
}

# Command prefixes that appear before the real command
_CMD_PREFIXES = frozenset({
    "sudo", "env", "time", "timeout", "nice", "nohup",
    "command", "builtin", "exec", "caffeinate",
})

# ── Helpers ────────────────────────────────────────────────────────────────────

def emit(decision, reason=""):
    json.dump({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": decision,
            "permissionDecisionReason": reason,
        }
    }, sys.stdout)
    sys.exit(0)


def allow(reason="approved"):
    emit("allow", reason)


def deny(reason="blocked"):
    emit("deny", reason)


def is_path_allowed(path):
    """Check if a resolved path falls under any allowed prefix."""
    if not path:
        return True
    try:
        resolved = os.path.realpath(os.path.expanduser(path))
    except (ValueError, OSError):
        return False
    for prefix in ALLOWED_PATH_PREFIXES:
        if resolved == prefix or resolved.startswith(prefix + os.sep):
            return True
    return False


_TMP_PREFIXES = ["/tmp", "/private/tmp"]

def _is_tmp_path(path):
    """Check if a resolved path falls under /tmp."""
    if not path:
        return False
    try:
        resolved = os.path.realpath(os.path.expanduser(path))
    except (ValueError, OSError):
        return False
    return any(resolved == p or resolved.startswith(p + os.sep) for p in _TMP_PREFIXES)


def _extract_git_target_dir(tokens, start_idx):
    """Extract the target directory from git -C or --git-dir flags."""
    _GIT_DIR_FLAGS = {"-C", "--git-dir", "--work-tree"}
    i = start_idx
    while i < len(tokens):
        tok = tokens[i]
        if tok in _GIT_DIR_FLAGS and i + 1 < len(tokens):
            return tokens[i + 1]
        i += 1
    return None


def _extract_git_subcommand(tokens, start_idx):
    """Given tokens starting after 'git', find the subcommand (skipping flags like -C, --no-pager)."""
    # git flags that consume the next argument
    _GIT_FLAGS_WITH_ARG = {"-C", "-c", "--git-dir", "--work-tree", "--namespace"}
    i = start_idx
    while i < len(tokens):
        tok = tokens[i]
        if tok in _GIT_FLAGS_WITH_ARG:
            i += 2  # skip flag + its argument
            continue
        if tok.startswith("-"):
            i += 1  # skip standalone flags like --no-pager, --bare
            continue
        return tok  # first non-flag token is the subcommand
    return None


# Read-only git subcommands that are safe to allow
_GIT_SAFE_SUBCMDS = frozenset({
    "status", "log", "diff", "show", "branch", "tag",
    "shortlog", "describe", "rev-parse", "rev-list",
    "ls-files", "ls-tree", "ls-remote",
    "cat-file", "name-rev", "blame", "annotate",
    "grep", "reflog", "count-objects", "fsck",
    "config",  # reading config is safe
    "remote",  # 'git remote' (list) is safe; 'git remote add' etc. are low-risk
    "stash",   # 'git stash list/show' — further checked below
    "help", "version", "whatchanged", "cherry",
})


def _check_git_command(tokens, start_idx):
    """Classify a git invocation as allow/deny.

    tokens:     the full token list for this sub-command
    start_idx:  index right after 'git' (or after prefix tokens)

    Returns:
        ("allow", reason) or ("deny", reason)
    """
    # All git operations are allowed when targeting /tmp
    target_dir = _extract_git_target_dir(tokens, start_idx)
    if target_dir and _is_tmp_path(target_dir):
        return ("allow", f"git in /tmp: {' '.join(tokens)[:80]}")

    subcmd = _extract_git_subcommand(tokens, start_idx)

    if subcmd is None:
        # bare 'git' with no subcommand — harmless (prints usage)
        return ("allow", "git (no subcommand)")

    if subcmd in _GIT_SAFE_SUBCMDS:
        # Extra guard: 'git stash' without list/show is mutating
        if subcmd == "stash":
            rest = tokens[tokens.index(subcmd) + 1:]
            rest = [t for t in rest if not t.startswith("-")]
            sub_sub = rest[0] if rest else None
            if sub_sub is None or sub_sub not in {"list", "show"}:
                return ("deny", f"git stash (mutating) blocked: {' '.join(tokens)[:80]}")
        return ("allow", f"git {subcmd} (read-only)")

    # Allow any git command if a positional argument is an absolute /tmp path
    for tok in tokens[start_idx:]:
        if tok.startswith("/") and _is_tmp_path(tok):
            return ("allow", f"git {subcmd} targeting /tmp")

    return ("deny", f"git {subcmd} blocked: {' '.join(tokens)[:80]}")


def _command_is_tmp_scoped(command):
    """Check if a command is entirely scoped to /tmp (cd /tmp/... && ...)."""
    # Fast check: starts with 'cd /tmp' or 'cd /private/tmp'
    stripped = command.lstrip()
    for prefix in _TMP_PREFIXES:
        if stripped.startswith(f"cd {prefix}"):
            return True
    return False


def find_blocked_command(command):
    """Check if any sub-command in a (possibly compound) shell string is blocked.

    Returns:
        ("deny",  reason) — for hard-blocked commands
        ("ask",   reason) — for commands needing user approval (gh)
        ("allow", reason) — explicitly allowed (e.g. read-only git)
        None              — command is clean
    """
    # Fast path: commands scoped to /tmp are always allowed
    if _command_is_tmp_scoped(command):
        return ("allow", "command scoped to /tmp")

    ASK_CMDS = {"gh"}

    # ── Command substitutions: $(cmd ...) or `cmd ...` ────────────────────
    # Parse git commands inside substitutions and apply the same safe-subcmd rules
    for m in re.finditer(r'\$\(([^)]*?\bgit\b[^)]*)', command):
        inner_tokens = m.group(1).split()
        try:
            git_idx = next(i for i, t in enumerate(inner_tokens) if t.rsplit("/", 1)[-1] == "git")
            result = _check_git_command(inner_tokens, git_idx + 1)
            if result[0] != "allow":
                return result
        except StopIteration:
            pass
    for m in re.finditer(r'`([^`]*?\bgit\b[^`]*)`', command):
        inner_tokens = m.group(1).split()
        try:
            git_idx = next(i for i, t in enumerate(inner_tokens) if t.rsplit("/", 1)[-1] == "git")
            result = _check_git_command(inner_tokens, git_idx + 1)
            if result[0] != "allow":
                return result
        except StopIteration:
            pass
    for name in ASK_CMDS:
        if re.search(rf'\$\([^)]*\b{name}\b', command):
            return ("ask", f"{name} requires approval: {command[:80]}")
        if re.search(rf'`[^`]*\b{name}\b', command):
            return ("ask", f"{name} requires approval: {command[:80]}")

    # ── Split on shell operators: ;  &&  ||  |  (  ) ─────────────────────
    worst = None  # track the most restrictive result across sub-commands
    for part in re.split(r'[;&|()]+', command):
        tokens = part.split()
        cmd_idx = 0
        for i, tok in enumerate(tokens):
            if '=' in tok and not tok.startswith('-'):
                continue
            if tok in _CMD_PREFIXES:
                continue
            base = tok.rsplit("/", 1)[-1]

            if base == "git":
                result = _check_git_command(tokens, i + 1)
                if result[0] == "deny":
                    return result
                # allow → continue checking remaining sub-commands
                break

            if base in ASK_CMDS:
                worst = ("ask", f"{base} requires approval: {command[:80]}")
                break

            break  # not a special command → this sub-command is fine

    return worst  # None if everything was clean, or ("ask", ...) if gh was found


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        emit("ask", "hook: failed to parse input")
        return

    tool = data.get("tool_name", "")
    inp  = data.get("tool_input", {})

    # ── Rule 1+2: blocked/ask commands in Bash ─────────────────────────────
    if tool == "Bash":
        cmd = inp.get("command", "")
        result = find_blocked_command(cmd)
        if result:
            emit(result[0], result[1])
        allow()

    # ── Rule 3: file tools — path must be in workspace or /tmp ─────────────
    if tool in FILE_PATH_TOOLS:
        key  = FILE_PATH_TOOLS[tool]
        path = inp.get(key, "")
        if not is_path_allowed(path):
            deny(f"path outside workspace: {path}")
        allow()

    if tool in SEARCH_PATH_TOOLS:
        key  = SEARCH_PATH_TOOLS[tool]
        path = inp.get(key)  # often None → defaults to cwd
        if path and not is_path_allowed(path):
            deny(f"path outside workspace: {path}")
        allow()

    # ── Rule 4: everything else → allow ────────────────────────────────────
    allow(f"{tool} approved")


if __name__ == "__main__":
    main()
