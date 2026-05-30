// Tier-3 code-panel specs for GROUP A: a DELETION-bearing unified diff.
//
// The shared diff fixture (_harness.ts startDiffServer) is add-only, so
// it cannot exercise the del-line side of the panel. This spec spins up
// its own throwaway git repo whose working-tree edit REMOVES a struct
// (`Widget`) and a field (`Engine.gain`), so `--at HEAD..` yields a diff
// with `del` (red) rows and base-only (Side::Base) entities.
//
// What it covers (all observable in a real browser, no screenshots):
//   • del rows render with the red `data-kind="del"` tint;
//   • clicking a DEL line fires onLineNavigate with base coords and
//     resolves the BASE-side entity (the click-correctness fix) — the
//     diagram selection lands on the removed `Widget`, NOT on whatever
//     head sibling shares that line number;
//   • a base-only entity (removed `Widget`) resolves via the base path
//     (byFileBase lookup) — the panel hands the host the BASE worktree
//     path for del rows;
//   • clicking an ADD line resolves via the head side;
//   • clicking a CONTEXT line carries both coords (resolves head-first).
//
// We can't edit _harness.ts, so the server helper is local (mirrors the
// startDelDiffServer pattern already used by diff-unified-mode.spec.ts).

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { type Page, expect, test } from '@playwright/test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN =
  process.env.MIND_EXPANDER_BIN ?? path.resolve(HERE, '../../target/debug/mind-expander');
const READY_TIMEOUT_MS = 30_000;

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
      reject(new Error(`del-diff server never emitted ready within ${READY_TIMEOUT_MS}ms`));
    }, READY_TIMEOUT_MS);
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
 *  (`Widget`) and a field (`Engine.gain`), so `--at HEAD..` yields a diff
 *  with del rows and base-only (Side::Base) entities. */
async function startDelDiffServer(): Promise<LocalDiffServer> {
  const repo = mkdtempSync(path.join(tmpdir(), 'me-e2e-cp-del-'));
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  };
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  writeFileSync(
    path.join(repo, 'Cargo.toml'),
    '[package]\nname = "cp_del_fixture"\nversion = "0.0.0"\nedition = "2021"\n\n[lib]\npath = "src/lib.rs"\n',
  );
  writeFileSync(
    path.join(repo, 'src/lib.rs'),
    'pub mod core;\n\npub struct App {\n    pub engine: core::Engine,\n}\n',
  );
  // Baseline: Engine (two fields) + Widget (removed below).
  writeFileSync(
    path.join(repo, 'src/core.rs'),
    'pub struct Engine {\n    pub power: u32,\n    pub gain: u32,\n}\n\npub struct Widget {\n    pub size: u32,\n}\n',
  );
  git('init', '-q');
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'user.name', 'E2E CP Del Harness');
  git('add', '-A');
  git('commit', '-q', '-m', 'baseline');
  // Working-tree edit: drop the whole `Widget` struct (→ base-only type)
  // and `Engine.gain` (→ base-only field on a modified type), and add a
  // brand-new `note` field on Engine (→ a head-only `add` row), so the
  // diff carries del AND add AND context rows.
  writeFileSync(
    path.join(repo, 'src/core.rs'),
    'pub struct Engine {\n    pub power: u32,\n    pub note: u32,\n}\n',
  );

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

const CRATE = 'cp_del_fixture';
const CORE = 'cp_del_fixture::core';
const ENGINE = 'cp_del_fixture::core::Engine';
const WIDGET = 'cp_del_fixture::core::Widget';

/** Dispatch a real Cmd-modified click — the diagram affordance that opens
 *  the code panel at the clicked element's source. */
async function cmdClick(page: Page, selector: string): Promise<void> {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) throw new Error(`cmdClick: no element for ${sel}`);
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
  }, selector);
}

async function expandModule(page: Page, moduleId: string): Promise<void> {
  await page.locator(`.module-group[data-id="${moduleId}"] > *`).first().click();
}

/** The id of the currently selected type box, or null. */
async function selectedTypeId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.querySelector('g.type-box.selected');
    return el === null ? null : el.getAttribute('data-element-id');
  });
}

/** Click a code-panel line by its diff side + coordinate. `side` picks
 *  the gutter attribute (`data-line-head` for add/context, `data-line-base`
 *  for del/context); clicks the row's text span like a real user. Returns
 *  true if a matching row was found and clicked. */
async function clickPanelLine(
  page: Page,
  side: 'head' | 'base',
  line: number,
): Promise<boolean> {
  return page.evaluate(
    ({ side, line }) => {
      const attr = side === 'head' ? 'lineHead' : 'lineBase';
      const row = [...document.querySelectorAll<HTMLElement>('.code-panel-line')].find(
        (r) => r.dataset[attr] === String(line),
      );
      if (row === undefined) return false;
      const target = row.querySelector('.code-panel-text') ?? row;
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return true;
    },
    { side, line },
  );
}

/** The kind (`add`/`del`/`context`) of the panel row carrying the given
 *  coordinate on the given side, or null. */
async function panelRowKind(
  page: Page,
  side: 'head' | 'base',
  line: number,
): Promise<string | null> {
  return page.evaluate(
    ({ side, line }) => {
      const attr = side === 'head' ? 'lineHead' : 'lineBase';
      const row = [...document.querySelectorAll<HTMLElement>('.code-panel-line')].find(
        (r) => r.dataset[attr] === String(line),
      );
      return row?.dataset.kind ?? null;
    },
    { side, line },
  );
}

test.describe('code-panel deletion-bearing diff (GROUP A)', () => {
  let server: LocalDiffServer;

  test.beforeAll(async () => {
    server = await startDelDiffServer();
  });
  test.afterAll(async () => {
    if (server) await server.close();
  });

  test('clicking a DEL line in the panel resolves the BASE entity (click-correctness fix)', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.goto(server.url);
    await expect(page.locator(`.module-group[data-id="${CRATE}"]`)).toBeVisible();
    await expandModule(page, CRATE);
    await expandModule(page, CORE);

    // The removed `Widget` survives in the union diagram as a base-side
    // (red) box. Cmd+click it → the panel loads its BASE snapshot in
    // diff mode (loadFromBase=true), so its rows are `del`.
    await expect(page.locator(`g.type-box.side-base[data-element-id="${WIDGET}"]`)).toHaveCount(1);
    await cmdClick(page, `g.type-box[data-element-id="${WIDGET}"] .expand-hit`);
    await expect(page.locator('#code-panel')).toBeVisible();

    // At least one DEL (red) row renders — the removed Widget body.
    await expect
      .poll(() => page.locator('.code-panel-line[data-kind="del"]').count())
      .toBeGreaterThan(0);

    // That del row is actually TINTED red (not a plain row) — a CSS
    // regression dropping the diff coloring would fail here.
    const bg = await page.evaluate(() => {
      const el = document.querySelector('.code-panel-line[data-kind="del"]');
      return el === null ? null : getComputedStyle(el).backgroundColor;
    });
    expect(bg, 'del row is tinted, not transparent').not.toBe('rgba(0, 0, 0, 0)');

    // Find the base line of the `Widget` struct header and click it. The
    // panel emits baseLine + baseFile; the host resolves the BASE entity
    // via byFileBase. The observable result: the diagram selection lands
    // on the removed `Widget` — proving the red-line click routed to the
    // Base side, not a head sibling.
    const widgetBaseLine = await page.evaluate(() => {
      const row = [...document.querySelectorAll<HTMLElement>('.code-panel-line[data-kind="del"]')]
        .find((r) => (r.textContent ?? '').includes('struct Widget'));
      return row?.dataset.lineBase ? Number(row.dataset.lineBase) : null;
    });
    expect(widgetBaseLine, 'a del row for `struct Widget`').not.toBeNull();

    const clicked = await clickPanelLine(page, 'base', widgetBaseLine!);
    expect(clicked, 'del row was clickable').toBe(true);

    await expect.poll(() => selectedTypeId(page)).toBe(WIDGET);

    expect(errors, `page errors: ${errors.join('; ')}`).toHaveLength(0);
  });

  test('clicking an ADD line resolves via the head side; CONTEXT line carries both coords', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.goto(server.url);
    await expect(page.locator(`.module-group[data-id="${CRATE}"]`)).toBeVisible();
    await expandModule(page, CRATE);
    await expandModule(page, CORE);

    // Open the modified `Engine` (gained `note`, lost `gain`) in diff
    // mode. It's a head-present type, so the panel loads the head
    // snapshot and interleaves the diff hunks.
    await expect(page.locator(`g.type-box[data-element-id="${ENGINE}"]`)).toBeVisible();
    await cmdClick(page, `g.type-box[data-element-id="${ENGINE}"] .expand-hit`);
    await expect(page.locator('#code-panel')).toBeVisible();
    await expect
      .poll(() => page.locator('.code-panel-line[data-kind="add"]').count())
      .toBeGreaterThan(0);

    // The new `note` field is an `add` row (head coord only). Clicking it
    // resolves via the head index → selection lands on Engine.
    const noteHeadLine = await page.evaluate(() => {
      const row = [...document.querySelectorAll<HTMLElement>('.code-panel-line[data-kind="add"]')]
        .find((r) => (r.textContent ?? '').includes('note'));
      return row?.dataset.lineHead ? Number(row.dataset.lineHead) : null;
    });
    expect(noteHeadLine, 'an add row for the new `note` field').not.toBeNull();
    // The add row carries no base coord (head-only).
    expect(await panelRowKind(page, 'head', noteHeadLine!)).toBe('add');

    const addClicked = await clickPanelLine(page, 'head', noteHeadLine!);
    expect(addClicked, 'add row was clickable').toBe(true);
    await expect.poll(() => selectedTypeId(page)).toBe(ENGINE);

    // A CONTEXT row (the struct header, present in both snapshots) carries
    // BOTH head and base coords. Clicking it resolves head-first → still
    // lands on Engine, and the row exposes both gutters.
    const headerHeadLine = await page.evaluate(() => {
      const row = [...document.querySelectorAll<HTMLElement>('.code-panel-line[data-kind="context"]')]
        .find((r) => (r.textContent ?? '').includes('struct Engine'));
      if (row === undefined) return null;
      return {
        head: row.dataset.lineHead ? Number(row.dataset.lineHead) : null,
        base: row.dataset.lineBase ? Number(row.dataset.lineBase) : null,
      };
    });
    expect(headerHeadLine, 'a context row for `struct Engine`').not.toBeNull();
    expect(headerHeadLine?.head, 'context row carries a head coord').not.toBeNull();
    expect(headerHeadLine?.base, 'context row carries a base coord').not.toBeNull();

    const ctxClicked = await clickPanelLine(page, 'head', headerHeadLine!.head!);
    expect(ctxClicked, 'context row was clickable').toBe(true);
    await expect.poll(() => selectedTypeId(page)).toBe(ENGINE);

    expect(errors, `page errors: ${errors.join('; ')}`).toHaveLength(0);
  });
});
