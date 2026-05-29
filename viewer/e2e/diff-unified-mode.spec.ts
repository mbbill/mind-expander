// Tier-3 real-browser e2e for the `diff-unified-mode` feature area.
//
// Diff/unified mode renders ONE union diagram of base + head. Every
// entity is tagged with a Side (base = removed/red, head = added/green,
// both = unchanged, modified = body-changed) and the viewer surfaces
// that in four observable places (see test-plan/diff-unified-mode.md):
//   • SVG type boxes get `.side-head` / `.side-base` classes and a
//     `data-side` rollup attribute ('add' | 'del' | 'split') driving a
//     stacked green/red bar (tree.ts).
//   • Field/method rows get `data-side` (tree.ts:2047).
//   • The left HTML module tree gets `.rollup-badge` (+N / −M) on every
//     ancestor of a changed file (html_tree.ts:362).
//   • Base-side source is fetchable via `/api/source?side=base` (the
//     `git show` blob at the base sha — server.rs:936).
//
// The oracle is ALWAYS a real observable: a class/attribute the renderer
// set, a painted bar's real rendered height (getBoundingClientRect), a
// badge's text content, or the actual base/head byte difference of a
// served file — never a screenshot and never "didn't throw".
//
// Two servers drive the coverage:
//   • The shared `diffTest` / `diffURL` fixture (`startDiffServer` in
//     _harness.ts) builds an ADD-ONLY working-tree edit: `Engine` gains a
//     field (→ Modified, split rollup) and `Gearbox` is new (→ head-only,
//     .side-head). It covers add / modified / both / rollup / base-view.
//   • A local `startDelDiffServer` below adds the one signal the shared
//     fixture cannot produce — a REMOVED entity (→ `.side-base`, red bar,
//     a `−M` rollup chip). It follows the same throwaway-git-repo pattern
//     as `startDiffServer` and lives only in this spec (the shared
//     _harness.ts must not be edited).

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  apiUrl,
  diffTest,
  expandModule,
  expect,
  fetchChangedFiles,
  fetchHealth,
  moduleRollupBadges,
  test as normalTest,
  typeBoxRollupSide,
  typeBoxSideCounts,
  waitForLayoutSettled,
} from './_harness.ts';
import type { Page } from '@playwright/test';

// Entity ids in the shared diff fixture (diff_fixture crate, lib.rs +
// core.rs). Verified against the live server's rendered DOM.
const CRATE = 'diff_fixture';
const CORE = 'diff_fixture::core';
const APP = 'diff_fixture::App';
const ENGINE = 'diff_fixture::core::Engine';
const GEARBOX = 'diff_fixture::core::Gearbox';

/** Attach a pageerror collector; returns a getter the test asserts empty
 *  at the end so an uncaught exception during diff rendering fails the
 *  spec (not just a silent console error). */
function trackPageErrors(page: Page): () => string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  return () => errors;
}

/** Expand the crate and its `core` module so the three changed/unchanged
 *  type boxes (App, Engine, Gearbox) render, then wait for the layout
 *  tween to settle so bar-rect geometry reads the resting layout. */
async function expandToCore(page: Page): Promise<void> {
  await expandModule(page, CRATE);
  await expandModule(page, CORE);
  await expect(page.locator(`g.type-box[data-element-id="${ENGINE}"]`)).toBeVisible();
  await expect(page.locator(`g.type-box[data-element-id="${GEARBOX}"]`)).toBeVisible();
  await waitForLayoutSettled(page);
}

/** Real rendered height of a type box's stacked side-bar rects (the
 *  painted green top / red bottom). Reads getBoundingClientRect so a
 *  CSS/sizing regression that collapses a bar to zero is caught. */
async function typeBoxBarHeights(
  page: Page,
  typeFullPath: string,
): Promise<{ top: number; bot: number }> {
  return page.evaluate((id) => {
    const box = document.querySelector(`g.type-box[data-element-id="${id}"]`);
    const top = box?.querySelector('rect.side-bar-top') as SVGGraphicsElement | null;
    const bot = box?.querySelector('rect.side-bar-bot') as SVGGraphicsElement | null;
    return {
      top: top?.getBoundingClientRect().height ?? -1,
      bot: bot?.getBoundingClientRect().height ?? -1,
    };
  }, typeFullPath);
}

/** The `data-side` of a field/method row inside an expanded type box. */
async function rowDataSide(page: Page, rowElementId: string): Promise<string | null> {
  return page.evaluate((id) => {
    const r = document.querySelector(`g.type-box [data-element-id="${id}"]`);
    return r === null ? null : r.getAttribute('data-side');
  }, rowElementId);
}

// ── diffTest suite: add / modified / both / rollup / base-view ───────
// Drives the shared `diffURL` fixture. Each test re-navigates so the
// page is clean; the worker-scoped server is reused.

diffTest.describe('diff-unified-mode (shared add-only fixture)', () => {
  diffTest('health reports diff + unified mode with a base worktree', async ({ diffURL }) => {
    const health = await fetchHealth(diffURL);
    expect(health.diff_enabled).toBe(true);
    expect(health.unified_mode).toBe(true);
    // `HEAD..` means the head side is the working tree.
    expect(health.head_is_working_tree).toBe(true);
    // A base worktree was materialized so base-side source/facts exist.
    expect(typeof health.base_workspace_root).toBe('string');
    expect(health.base_workspace_root && health.base_workspace_root.length).toBeGreaterThan(0);
  });

  diffTest('added, modified, and unchanged type boxes carry distinct diff decorations', async ({
    page,
    diffURL,
  }) => {
    const errors = trackPageErrors(page);
    await page.goto(diffURL);
    await expect(page.locator(`.module-group[data-id="${CRATE}"]`)).toBeVisible();
    await expandToCore(page);

    // Head-only added type: `.side-head` class + 'add' rollup attr +
    // a solid green bar (top painted, bottom collapsed to zero).
    await expect(page.locator(`g.type-box.side-head[data-element-id="${GEARBOX}"]`)).toHaveCount(1);
    expect(await typeBoxRollupSide(page, GEARBOX)).toBe('add');
    const gearboxBars = await typeBoxBarHeights(page, GEARBOX);
    expect(gearboxBars.top, 'Gearbox green bar painted').toBeGreaterThan(0);
    expect(gearboxBars.bot, 'Gearbox has no red half (add-only)').toBe(0);

    // Modified type: NEITHER side class (Modified is not base/head), but
    // a 'split' rollup attr → both halves of the stacked bar painted.
    await expect(page.locator(`g.type-box[data-element-id="${ENGINE}"]`)).not.toHaveClass(
      /side-(head|base)/,
    );
    expect(await typeBoxRollupSide(page, ENGINE)).toBe('split');
    const engineBars = await typeBoxBarHeights(page, ENGINE);
    expect(engineBars.top, 'Engine split bar top half painted').toBeGreaterThan(0);
    expect(engineBars.bot, 'Engine split bar bottom half painted').toBeGreaterThan(0);

    // Unchanged type: no diff decoration at all (the normal-mode-neutral
    // guard, but proven WITHIN a diff server — App really is `Both`).
    expect(await typeBoxRollupSide(page, APP)).toBeNull();
    await expect(page.locator(`g.type-box[data-element-id="${APP}"]`)).not.toHaveClass(
      /side-(head|base)/,
    );

    expect(errors(), `page errors: ${errors().join('; ')}`).toHaveLength(0);
  });

  diffTest('the added field row inside the modified type is tagged head (green)', async ({
    page,
    diffURL,
  }) => {
    const errors = trackPageErrors(page);
    await page.goto(diffURL);
    await expect(page.locator(`.module-group[data-id="${CRATE}"]`)).toBeVisible();
    await expandToCore(page);

    // Expand Engine to reveal its field rows.
    await page.locator(`g.type-box[data-element-id="${ENGINE}"] .expand-hit`).click();
    await expect(page.locator(`g.type-box [data-element-id="${ENGINE}::torque"]`)).toBeVisible();
    await waitForLayoutSettled(page);

    // The newly-added `torque` field row is `head`; the pre-existing
    // `power` field carries no side (unchanged member of a modified type).
    expect(await rowDataSide(page, `${ENGINE}::torque`)).toBe('head');
    expect(await rowDataSide(page, `${ENGINE}::power`)).toBeNull();

    expect(errors(), `page errors: ${errors().join('; ')}`).toHaveLength(0);
  });

  diffTest('module rollup chip reflects the diff and propagates to the collapsed crate', async ({
    page,
    diffURL,
  }) => {
    const errors = trackPageErrors(page);

    // The numstat the chips render from: src/core.rs, +5 / −0.
    const changed = await fetchChangedFiles(diffURL);
    const core = changed.find((f) => f.path.endsWith('core.rs'));
    expect(core, 'core.rs in changed-files').toBeTruthy();
    expect(core?.adds).toBeGreaterThan(0);
    expect(core?.dels).toBe(0);

    await page.goto(diffURL);
    await expect(page.locator(`.module-group[data-id="${CRATE}"]`)).toBeVisible();

    // On FIRST load (crate collapsed, before expanding), the crate row
    // already shows a `+N` chip — the change is in `core`, so the badge
    // must have propagated up to the ancestor crate. This is the
    // discovery affordance that makes diff mode visibly different from
    // normal on load.
    const collapsed = await moduleRollupBadges(page);
    expect(collapsed[CRATE], 'crate rollup badge before expand').toBeTruthy();
    expect(collapsed[CRATE]?.add).toBe(`+${core?.adds}`);
    // Add-only diff → no red `−M` half on the chip.
    expect(collapsed[CRATE]?.del).toBeNull();

    // After expanding, the changed module itself carries the same chip,
    // and its add count matches the numstat exactly.
    await expandModule(page, CRATE);
    await expect(page.locator(`.module-group[data-id="${CORE}"]`)).toBeVisible();
    const expanded = await moduleRollupBadges(page);
    expect(expanded[CORE], 'core module rollup badge').toBeTruthy();
    expect(expanded[CORE]?.add).toBe(`+${core?.adds}`);
    expect(expanded[CORE]?.del).toBeNull();

    expect(errors(), `page errors: ${errors().join('; ')}`).toHaveLength(0);
  });

  diffTest('base-side source is viewable and differs from head', async ({ diffURL }) => {
    // Base-side code can be viewed: `/api/source?side=base` serves the
    // git blob at the base sha. The base predates the working-tree edit,
    // so the head/default source contains the added `torque` field and
    // the new `Gearbox` struct while the base source contains neither.
    // This is the observable "base-side code is reachable" oracle.
    const headRes = await fetch(apiUrl(diffURL, '/api/source?path=src/core.rs'));
    expect(headRes.status).toBe(200);
    const head = await headRes.text();

    const baseRes = await fetch(apiUrl(diffURL, '/api/source?path=src/core.rs&side=base'));
    expect(baseRes.status).toBe(200);
    const base = await baseRes.text();

    expect(head).toContain('torque');
    expect(head).toContain('Gearbox');
    expect(base).toContain('power'); // the unchanged field survives
    expect(base).not.toContain('torque'); // added after the base commit
    expect(base).not.toContain('Gearbox'); // added after the base commit
    expect(base).not.toBe(head);
  });
});

// ── normal-mode neutrality (no --at) ─────────────────────────────────
// The other half of "diff looks identical to normal" was that NORMAL
// mode painted green. Drive the plain `viewerURL` fixture (spawned with
// no `--at`) and assert NO type box carries any diff decoration.

normalTest('normal mode (no --at): no type box carries a diff decoration', async ({
  page,
  viewerURL,
}) => {
  const errors = trackPageErrors(page);
  await page.goto(viewerURL);
  await expandModule(page, 'e2e_fixture');
  await expandModule(page, 'e2e_fixture::core');
  await expect(page.locator('g.type-box[data-element-id="e2e_fixture::core::Engine"]')).toBeVisible();
  await waitForLayoutSettled(page);

  const counts = await typeBoxSideCounts(page);
  expect(counts.base, 'no .side-base boxes in normal mode').toBe(0);
  expect(counts.head, 'no .side-head boxes in normal mode').toBe(0);

  const withDataSide = await page.locator('g.type-box[data-side]').count();
  expect(withDataSide, 'no type box has a data-side rollup attr in normal mode').toBe(0);

  // No module rollup badge either — normal mode has no churn to report.
  const badges = await moduleRollupBadges(page);
  expect(Object.keys(badges), 'no rollup badges in normal mode').toHaveLength(0);

  expect(errors(), `page errors: ${errors().join('; ')}`).toHaveLength(0);
});

// ── Removed-entity coverage via a local del+mod diff server ──────────
// The shared fixture is add-only, so it can't produce a `.side-base`
// box, a red 'del' bar, or a `−M` rollup chip. This local server follows
// the same throwaway-git-repo pattern as `startDiffServer` but its
// working-tree edit DELETES a struct (Widget) and a field (Engine.gain),
// so the head side is missing entities present in base → those entities
// come out `Side::Base` and paint red. It lives here (not in the shared
// _harness.ts, which must not be edited).

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN =
  process.env.MIND_EXPANDER_BIN ?? path.resolve(HERE, '../../target/debug/mind-expander');

interface LocalDiffServer {
  readonly url: string;
  close(): Promise<void>;
}

/** Resolve the bound URL from the `ready` JSON line `view` prints. Local
 *  copy of the harness's private waitForReady (we can't import it). */
function waitForReady(stdout: NodeJS.ReadableStream, kill: () => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      kill();
      reject(new Error('del-diff server never emitted ready within 30s'));
    }, 30_000);
    const rl = createInterface({ input: stdout });
    rl.on('line', (line) => {
      try {
        const ev = JSON.parse(line) as { event?: string; url?: string };
        if (ev.event === 'ready' && typeof ev.url === 'string') {
          clearTimeout(timer);
          resolve(ev.url);
        }
      } catch {
        // non-JSON banner line — ignore.
      }
    });
  });
}

/** Build a throwaway git repo whose working-tree edit REMOVES a struct
 *  and a field, so `--at HEAD..` yields base-only (removed) entities that
 *  render red. Mirrors `startDiffServer`'s pattern. */
async function startDelDiffServer(): Promise<LocalDiffServer> {
  const repo = mkdtempSync(path.join(tmpdir(), 'me-e2e-del-'));
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  };
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  writeFileSync(
    path.join(repo, 'Cargo.toml'),
    '[package]\nname = "del_fixture"\nversion = "0.0.0"\nedition = "2021"\n\n[lib]\npath = "src/lib.rs"\n',
  );
  writeFileSync(
    path.join(repo, 'src/lib.rs'),
    'pub mod core;\n\npub struct App {\n    pub engine: core::Engine,\n}\n',
  );
  // Baseline: two structs, Engine has two fields.
  writeFileSync(
    path.join(repo, 'src/core.rs'),
    'pub struct Engine {\n    pub power: u32,\n    pub gain: u32,\n}\n\npub struct Widget {\n    pub size: u32,\n}\n',
  );
  git('init', '-q');
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'user.name', 'E2E Del Harness');
  git('add', '-A');
  git('commit', '-q', '-m', 'baseline');
  // Working-tree edit: remove the whole `Widget` struct (→ base-only
  // type) AND remove `Engine.gain` (→ base-only field on a modified
  // type). Both are absent from head → tagged `Side::Base` → red.
  writeFileSync(path.join(repo, 'src/core.rs'), 'pub struct Engine {\n    pub power: u32,\n}\n');

  const child = spawn(BIN, ['view', repo, '--at', 'HEAD..', '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let url: string;
  try {
    url = await waitForReady(child.stdout, () => child.kill());
  } catch (e) {
    child.kill();
    rmSync(repo, { recursive: true, force: true });
    throw e;
  }
  return {
    url,
    close: async () => {
      child.kill();
      rmSync(repo, { recursive: true, force: true });
    },
  };
}

const DEL_CRATE = 'del_fixture';
const DEL_CORE = 'del_fixture::core';
const DEL_ENGINE = 'del_fixture::core::Engine';
const DEL_WIDGET = 'del_fixture::core::Widget';

normalTest.describe('diff-unified-mode (removed entities → red)', () => {
  let server: LocalDiffServer;

  normalTest.beforeAll(async () => {
    server = await startDelDiffServer();
  });
  normalTest.afterAll(async () => {
    if (server) await server.close();
  });

  normalTest('a deleted struct renders as a base-side (red) box', async ({ page }) => {
    const errors = trackPageErrors(page);
    await page.goto(server.url);
    await expect(page.locator(`.module-group[data-id="${DEL_CRATE}"]`)).toBeVisible();
    await expandModule(page, DEL_CRATE);
    await expandModule(page, DEL_CORE);
    await expect(page.locator(`g.type-box[data-element-id="${DEL_WIDGET}"]`)).toBeVisible();
    await waitForLayoutSettled(page);

    // The removed `Widget` struct is retained in the union diagram with
    // the `.side-base` class — deletions ARE visible on the diagram, not
    // dropped (the union-model decision). Its rollup attr is 'del' and it
    // paints a solid red bar (bottom half, top collapsed).
    await expect(page.locator(`g.type-box.side-base[data-element-id="${DEL_WIDGET}"]`)).toHaveCount(
      1,
    );
    expect(await typeBoxRollupSide(page, DEL_WIDGET)).toBe('del');
    const bars = await typeBoxBarHeights(page, DEL_WIDGET);
    expect(bars.bot, 'Widget red bar painted').toBeGreaterThan(0);
    expect(bars.top, 'Widget has no green half (del-only)').toBe(0);

    expect(errors(), `page errors: ${errors().join('; ')}`).toHaveLength(0);
  });

  normalTest('a deleted field row is tagged base and the rollup chip shows −M', async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await page.goto(server.url);
    await expect(page.locator(`.module-group[data-id="${DEL_CRATE}"]`)).toBeVisible();

    // The numstat is del-only here → the rollup chip carries a `−M` half.
    const changed = await fetchChangedFiles(server.url);
    const core = changed.find((f) => f.path.endsWith('core.rs'));
    expect(core?.dels, 'core.rs has deletions').toBeGreaterThan(0);

    const badges = await moduleRollupBadges(page);
    expect(badges[DEL_CRATE], 'crate rollup badge').toBeTruthy();
    expect(badges[DEL_CRATE]?.del).toBe(`−${core?.dels}`); // − U+2212

    await expandModule(page, DEL_CRATE);
    await expandModule(page, DEL_CORE);
    await expect(page.locator(`g.type-box[data-element-id="${DEL_ENGINE}"]`)).toBeVisible();
    // Expand Engine to reveal the removed `gain` field row.
    await page.locator(`g.type-box[data-element-id="${DEL_ENGINE}"] .expand-hit`).click();
    await expect(page.locator(`g.type-box [data-element-id="${DEL_ENGINE}::gain"]`)).toBeVisible();
    await waitForLayoutSettled(page);

    // The removed `gain` field row is `base` (red); the surviving
    // `power` field carries no side.
    expect(await rowDataSide(page, `${DEL_ENGINE}::gain`)).toBe('base');
    expect(await rowDataSide(page, `${DEL_ENGINE}::power`)).toBeNull();

    expect(errors(), `page errors: ${errors().join('; ')}`).toHaveLength(0);
  });
});
