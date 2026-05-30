// Tier-3 code-panel specs that need a NON-default server: diff/unified
// mode (panel renders /api/diff hunks with add/del coloring) and a
// live-reload mutable workspace (editing the source on disk refreshes the
// open panel). These can't use code-panel.spec.ts's read-only fixture +
// auto-expanding beforeEach, so they live here with their own servers.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { diffTest, expandModule, expect, test } from './_harness.ts';
import type { Page } from '@playwright/test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN =
  process.env.MIND_EXPANDER_BIN ?? path.resolve(HERE, '../../target/debug/mind-expander');
const READY_TIMEOUT_MS = 30_000;

/** Dispatch a real Cmd-modified click — the diagram's Cmd/Ctrl+click
 *  affordance that opens the code panel at the clicked element's source. */
async function cmdClick(page: Page, selector: string): Promise<void> {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) throw new Error(`cmdClick: no element for ${sel}`);
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
  }, selector);
}

/** Full visible text of the code-panel body (the rendered source rows). */
async function panelBodyText(page: Page): Promise<string> {
  return page.evaluate(() => document.querySelector('.code-panel-body')?.textContent ?? '');
}

// ── (1) Inline diff coloring for a modified entity ───────────────────
// Reuses the shared diff fixture: `Engine` (in `core`) gains a `torque`
// field on the working tree → a Modified type whose code-panel diff view
// renders the added line as `data-kind="add"` (green).
diffTest('the open code panel renders add/del diff coloring for a modified entity', async ({
  page,
  diffURL,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(diffURL);
  await expect(page.locator('.module-group[data-id="diff_fixture"]')).toBeVisible();
  await expandModule(page, 'diff_fixture');
  await expandModule(page, 'diff_fixture::core');
  const engine = 'diff_fixture::core::Engine';
  await expect(page.locator(`g.type-box[data-element-id="${engine}"]`)).toBeVisible();

  // Cmd+click Engine → open its source. In unified mode the panel takes the
  // /api/diff path and interleaves hunk rows.
  await cmdClick(page, `g.type-box[data-element-id="${engine}"] .expand-hit`);
  await expect(page.locator('#code-panel')).toBeVisible();

  // At least one ADD row renders (the inserted `torque` field).
  await expect
    .poll(() => page.locator('.code-panel-line[data-kind="add"]').count())
    .toBeGreaterThan(0);

  // That add row carries the inserted field text…
  const addText = await page.evaluate(() =>
    [...document.querySelectorAll('.code-panel-line[data-kind="add"]')]
      .map((e) => e.textContent ?? '')
      .join('\n'),
  );
  expect(addText).toContain('torque');

  // …and is actually TINTED (the green add background), not a plain row —
  // a CSS regression that dropped the diff coloring would fail here.
  const bg = await page.evaluate(() => {
    const el = document.querySelector('.code-panel-line[data-kind="add"]');
    return el === null ? null : getComputedStyle(el).backgroundColor;
  });
  expect(bg).not.toBeNull();
  expect(bg, 'add row is tinted, not transparent').not.toBe('rgba(0, 0, 0, 0)');

  expect(errors, `page errors: ${errors.join('; ')}`).toHaveLength(0);
});

// ── (2) Live-reload refreshes the open panel ─────────────────────────

interface MutableServer {
  url: string;
  libPath: string;
  rewrite(source: string): void;
  close(): Promise<void>;
}

/** Spawn `view <tmp-crate>` on a MUTABLE temp workspace (head = working
 *  tree, so the watcher runs). The test edits the source on disk and
 *  asserts the open panel updates. Torn down (kill + rm) by close(). */
async function startMutableServer(): Promise<MutableServer> {
  const dir = mkdtempSync(path.join(tmpdir(), 'me-codepanel-live-'));
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(
    path.join(dir, 'Cargo.toml'),
    '[package]\nname = "live_fixture"\nversion = "0.0.0"\nedition = "2021"\n\n[lib]\npath = "src/lib.rs"\n',
  );
  const libPath = path.join(dir, 'src', 'lib.rs');
  writeFileSync(libPath, 'pub struct Widget {\n    pub alpha: u32,\n}\n');

  const child: ChildProcessWithoutNullStreams = spawn(BIN, ['view', dir, '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`mutable server never became ready within ${READY_TIMEOUT_MS}ms`));
    }, READY_TIMEOUT_MS);
    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      try {
        const ev = JSON.parse(line) as { event?: string; url?: string };
        if (ev.event === 'ready' && typeof ev.url === 'string') {
          clearTimeout(timer);
          resolve(ev.url);
        }
      } catch {
        /* non-JSON banner line — ignore */
      }
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });

  return {
    url,
    libPath,
    rewrite: (source: string) => writeFileSync(libPath, source),
    close: async () => {
      child.kill();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('editing the workspace source on disk live-reloads the open code panel', async ({ page }) => {
  const server = await startMutableServer();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  try {
    await page.goto(server.url);
    await expect(page.locator('.module-group[data-id="live_fixture"]')).toBeVisible();
    await expandModule(page, 'live_fixture');
    const widget = 'live_fixture::Widget';
    await expect(page.locator(`g.type-box[data-element-id="${widget}"]`)).toBeVisible();

    // Open the panel on Widget — it shows the struct source incl. `alpha`,
    // and definitely not the field we are about to add.
    await cmdClick(page, `g.type-box[data-element-id="${widget}"] .expand-hit`);
    await expect(page.locator('#code-panel')).toBeVisible();
    await expect.poll(() => panelBodyText(page)).toContain('alpha');
    expect(await panelBodyText(page)).not.toContain('zeta_added');

    // Edit the source on disk: add a field. The server watcher re-extracts
    // and broadcasts facts_updated; the open panel must refresh to the new
    // bytes (this is the "code panel didn't update on reload" regression).
    server.rewrite('pub struct Widget {\n    pub alpha: u32,\n    pub zeta_added: u32,\n}\n');

    await expect
      .poll(() => panelBodyText(page), { timeout: 15_000 })
      .toContain('zeta_added');

    expect(errors, `page errors: ${errors.join('; ')}`).toHaveLength(0);
  } finally {
    await server.close();
  }
});
