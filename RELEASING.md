# Releasing

One script, three confirms, walk away.

## The recipe

```sh
scripts/release.sh
```

That's it. The script handles version bump, commit, tag, and
(optionally) push. After push, GitHub Actions builds binaries for
all five targets on native runners and publishes everything to npm
— you don't touch the build pipeline.

## What the script asks you

### Prompt 1 — bump type

```
Current version: 0.1.0

Choose bump:
  1) patch  → 0.1.1   (bug fixes, no API change)
  2) minor  → 0.2.0   (new features, backward compatible)
  3) major  → 1.0.0   (breaking changes)
  4) custom (type your own)
```

Pick the appropriate bump. Custom lets you type any valid semver
(including prereleases like `0.2.0-rc.1`).

### Prompt 2 — commit + tag

After it bumps versions in `Cargo.toml` and all 6 `package.json`
files, it shows you `git diff --stat` and asks:

```
Commit and tag v0.2.0? (yes/no)
```

If no, your worktree has the bumps but no commit — revert with
`git checkout .`.

### Prompt 3 — push to origin

```
Push to origin now? (yes/no)
```

- **Yes:** `git push origin main v0.2.0`. GitHub sees the tag,
  triggers `release.yml`, builds all five binaries in parallel,
  publishes all six npm packages. ~7-10 min total. Nothing for you
  to do.
- **No:** the tag is local-only. Push later with
  `git push origin main v0.2.0`, or back out with
  `git reset --hard HEAD~1 && git tag -d v0.2.0`.

## Watching the release

```sh
gh run watch                # if you have the gh CLI
```

Or open https://github.com/mbbill/mind-expander/actions in a browser.

Each of the 5 build jobs takes ~3-5 min; the final publish job
takes ~1-2 min. First-ever Windows build downloads the MSVC SDK
headers (~700 MB on GitHub's cache, not yours), which adds a few
minutes the first time only.

## Verify the release

After CI finishes:

```sh
for p in mind-expander @mind-expander/binary-darwin-arm64 \
         @mind-expander/binary-darwin-x64 @mind-expander/binary-linux-x64-gnu \
         @mind-expander/binary-linux-arm64-gnu @mind-expander/binary-win32-x64-msvc; do
  npm view "$p" version
done
```

All six should print the new version. Then smoke-test:

```sh
npx mind-expander@latest view /path/to/any/repo
```

## npm auth

CI uses the `NPM_TOKEN` repo secret on GitHub. You set this up once
in: repo Settings → Secrets and variables → Actions → `NPM_TOKEN`.
The token is an npm Automation token with publish rights on
`mind-expander` and `@mind-expander/*`.

Local `npm publish` would use `~/.npmrc` instead, but with the
CI-based flow there's no reason to publish locally — the script
just pushes and CI does the rest.

## When CI is broken

If the workflow fails mid-release (build error, network issue),
the recovery path:

1. **Bad version on npm:** within 72 hours, `npm unpublish mind-expander@0.2.0`
   then fix and re-release. After 72 hours, `npm deprecate` instead:
   ```sh
   npm deprecate mind-expander@0.2.0 "Broken release, use 0.2.1"
   ```
2. **Bad commit on main:** revert it with `git revert HEAD` and push.
   Delete the tag locally and remotely:
   ```sh
   git tag -d v0.2.0
   git push --delete origin v0.2.0
   ```
3. **Need to publish manually:** the workflow at
   `.github/workflows/release.yml` documents the exact build
   commands per target. You can reproduce them locally with
   `cargo-zigbuild` + `cargo-xwin` if you really need to ship from
   your machine — but that's a last resort, not the standard path.

## Unpublishing

Within 72 hours of publishing you can `npm unpublish <pkg>@<version>`.
After 72 hours, only npm support can remove a version. Prefer
`npm deprecate` for any version that's been live more than a day —
unpublishing breaks anyone who already installed it.
