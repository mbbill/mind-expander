#!/usr/bin/env bash
#
# Release script — handles version bump, commit, tag, and (optionally)
# push. After push, GitHub Actions takes over: builds binaries for all
# five targets on native runners and publishes everything to npm.
#
# Usage:
#   scripts/release.sh
#
# Flow:
#   1. Reads current version from npm/mind-expander/package.json.
#   2. Prompts for bump type (patch / minor / major / custom).
#   3. Bumps every version string across all 6 packages + Cargo.toml.
#   4. Commits "release: vX.Y.Z" and tags it.
#   5. Prompts whether to push to origin (triggers CI).
#
# If you say "no" to the push prompt, the tag and commit are still
# local — you can push later with `git push origin main vX.Y.Z`, or
# back out with `git reset --hard HEAD~1 && git tag -d vX.Y.Z`.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# ────────────────────────────────────────────────────────────────────
# 1. Sanity checks
# ────────────────────────────────────────────────────────────────────

if ! git diff-index --quiet HEAD --; then
  echo "error: uncommitted changes in working tree. Commit or stash first." >&2
  exit 1
fi

BRANCH="$(git branch --show-current)"
if [ "$BRANCH" != "main" ]; then
  echo "warning: you're on branch '$BRANCH', not 'main'."
  read -r -p "continue anyway? (yes/no) " ack
  [ "$ack" = "yes" ] || exit 1
fi

# ────────────────────────────────────────────────────────────────────
# 2. Compute bump options
# ────────────────────────────────────────────────────────────────────

CURRENT="$(node -p "require('./npm/mind-expander/package.json').version")"

# Split on dots; strip any prerelease suffix (-alpha.1 etc.) before
# arithmetic so `1.0.0-rc.1` parses as 1.0.0 for the next-version math.
CORE="${CURRENT%-*}"
IFS=. read -r MAJOR MINOR PATCH <<<"$CORE"
NEXT_PATCH="$MAJOR.$MINOR.$((PATCH + 1))"
NEXT_MINOR="$MAJOR.$((MINOR + 1)).0"
NEXT_MAJOR="$((MAJOR + 1)).0.0"

echo "Current version: $CURRENT"
echo
echo "Choose bump:"
echo "  1) patch  → $NEXT_PATCH   (bug fixes, no API change)"
echo "  2) minor  → $NEXT_MINOR   (new features, backward compatible)"
echo "  3) major  → $NEXT_MAJOR   (breaking changes)"
echo "  4) custom (type your own)"
echo
read -r -p "[1-4]: " choice

case "$choice" in
  1) NEW="$NEXT_PATCH" ;;
  2) NEW="$NEXT_MINOR" ;;
  3) NEW="$NEXT_MAJOR" ;;
  4) read -r -p "Enter version (X.Y.Z or X.Y.Z-prerelease): " NEW ;;
  *) echo "error: invalid choice '$choice'" >&2; exit 1 ;;
esac

if ! [[ "$NEW" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.]+)?$ ]]; then
  echo "error: '$NEW' is not valid semver" >&2
  exit 1
fi

if [ "$NEW" = "$CURRENT" ]; then
  echo "error: new version $NEW is the same as current — nothing to bump" >&2
  exit 1
fi

if [ "$(printf '%s\n%s\n' "$CURRENT" "$NEW" | sort -V | tail -n1)" != "$NEW" ]; then
  echo "error: new version $NEW is not greater than current $CURRENT" >&2
  exit 1
fi

echo
read -r -p "Bump $CURRENT → $NEW? (yes/no) " confirm
[ "$confirm" = "yes" ] || { echo "aborted, no changes made"; exit 1; }

# ────────────────────────────────────────────────────────────────────
# 3. Bump versions
# ────────────────────────────────────────────────────────────────────

bump_version() {
  local file="$1"
  if [[ "$file" == *.json ]]; then
    sed -i.bak -E "0,/\"version\":[[:space:]]*\"[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.]+)?\"/s//\"version\": \"$NEW\"/" "$file"
  else
    sed -i.bak -E "0,/^version[[:space:]]*=[[:space:]]*\"[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.]+)?\"/s//version = \"$NEW\"/" "$file"
  fi
  rm -f "$file.bak"
}

echo "==> bumping versions to $NEW"
bump_version Cargo.toml
bump_version npm/mind-expander/package.json
for pkg in npm/binary-*; do
  bump_version "$pkg/package.json"
done

# Pin the launcher's optionalDependencies to the new version too —
# they must move in lockstep with the platform packages.
sed -i.bak -E "s|(\"@mind-expander/binary-[a-z0-9-]+\":[[:space:]]*)\"[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.]+)?\"|\1\"$NEW\"|g" \
  npm/mind-expander/package.json
rm -f npm/mind-expander/package.json.bak

# Refresh Cargo.lock so the version bump is reflected and the commit
# is reproducible.
cargo build --features typescript >/dev/null

echo
echo "Files changed:"
git diff --stat

# ────────────────────────────────────────────────────────────────────
# 4. Commit + tag
# ────────────────────────────────────────────────────────────────────

echo
read -r -p "Commit and tag v$NEW? (yes/no) " confirm
if [ "$confirm" != "yes" ]; then
  echo "aborted. Revert with: git checkout ."
  exit 1
fi

git add -A
git commit -m "release: v$NEW"
git tag "v$NEW"
echo "  ✓ committed and tagged v$NEW"

# ────────────────────────────────────────────────────────────────────
# 5. Optional push (triggers CI release)
# ────────────────────────────────────────────────────────────────────

echo
echo "Push triggers the GitHub release workflow:"
echo "  - 5 parallel builds (macOS arm/x64, Linux x64/arm, Windows x64)"
echo "  - publishes all 6 npm packages"
echo "  - ~7-10 min total"
echo
read -r -p "Push to origin now? (yes/no) " confirm

if [ "$confirm" = "yes" ]; then
  git push origin "$BRANCH" "v$NEW"
  echo
  echo "  ✓ pushed. CI is running."
  echo
  echo "Watch progress:"
  echo "  https://github.com/mbbill/mind-expander/actions"
  if command -v gh >/dev/null 2>&1; then
    echo "  or: gh run watch"
  fi
else
  echo
  echo "Tag v$NEW created locally but not pushed."
  echo "  Push later:  git push origin $BRANCH v$NEW"
  echo "  Abort:       git reset --hard HEAD~1 && git tag -d v$NEW"
fi
