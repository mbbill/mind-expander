// Tier-3 real-browser spec for the code panel.
//
// Drives a real Chromium against a real `mind-expander view` server.
// The oracle for every test is the CORRECT observable result — a DOM /
// geometry / selection change the user would see — never "didn't throw"
// and never a recorded screenshot (the on-failure screenshot in
// playwright.config.ts is only a debugging artifact).
//
// WHY a dedicated fixture (not the shared `fixture-workspace`): the code
// panel's breadcrumb only renders a clickable FOLDER segment when the
// indexed files span more than one directory (otherwise the common
// prefix collapses to a single file-only crumb), and the cmd+click
// free-function / method cases need a free fn and a method to target.
// `e2e/code-panel-fixture` is a small crate with a nested module
// (`src/widgets/gauge.rs`), a free function (`boot`), and a method
// (`Gauge::read`) — a superset of what the geometry fixture offers. The
// shared `_harness.ts` server fixture is hard-wired to the geometry
// fixture, so this spec spawns its own server against the panel fixture
// (same `ready`-line protocol) while reusing every panel helper.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  codePanelResizeHandle,
  codePanelWidth,
  expect,
  isCodePanelOpen,
  openCodeViaKey,
  test,
  waitForLayoutSettled,
} from './_harness.ts';
import type { Page } from '@playwright/test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN =
  process.env.MIND_EXPANDER_BIN ?? path.resolve(HERE, '../../target/debug/mind-expander');
const WORKSPACE = path.resolve(HERE, 'code-panel-fixture');
const READY_TIMEOUT_MS = 30_000;

const CRATE = 'cp_fixture';
const APP = `${CRATE}::App`;
const GAUGE = `${CRATE}::widgets::gauge::Gauge`;
const BOOT = `${CRATE}::boot`; // free function row id

/** Spawn `view <code-panel-fixture> --port 0` and resolve the bound URL
 *  from the server's `ready` JSON line — same contract as the shared
 *  harness, but pointed at this spec's own fixture. */
function startServer(): Promise<{ url: string; child: ChildProcessWithoutNullStreams }> {
  const child = spawn(BIN, ['view', WORKSPACE, '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`server never emitted ready within ${READY_TIMEOUT_MS}ms`));
    }, READY_TIMEOUT_MS);
    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      try {
        const ev = JSON.parse(line) as { event?: string; url?: string };
        if (ev.event === 'ready' && typeof ev.url === 'string') {
          clearTimeout(timer);
          resolve({ url: ev.url, child });
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
}

let server: { url: string; child: ChildProcessWithoutNullStreams };

test.beforeAll(async () => {
  server = await startServer();
});

test.afterAll(() => {
  server?.child.kill();
});

// ── Fixture-local helpers ────────────────────────────────────────────

/** Expand a module row in the left HTML tree by its data-id. (Same
 *  contract as the shared `expandModule`, re-derived here so this spec
 *  reads against its own crate ids without coupling to the geometry
 *  fixture's `expandAll`.) */
async function expandModule(page: Page, moduleId: string): Promise<void> {
  await page.locator(`.module-group[data-id="${moduleId}"] > *`).first().click();
}

/** Expand a type box (reveal its rows) by clicking its expand-hit. */
async function expandType(page: Page, typeFullPath: string): Promise<void> {
  await page.locator(`g.type-box[data-element-id="${typeFullPath}"] .expand-hit`).click();
}

/** Dispatch a real Cmd-modified `click` on `selector`. The diagram's d3
 *  click handlers branch on `event.metaKey` to open the code panel at
 *  the clicked element's source (the user's Cmd/Ctrl+click affordance),
 *  so the spec exercises that exact branch. */
async function cmdClick(page: Page, selector: string): Promise<void> {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) throw new Error(`cmdClick: no element for ${sel}`);
    el.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }),
    );
  }, selector);
}

/** The 1-based line numbers carried by the panel rows currently tagged
 *  `entity-row` — i.e. the focus frame the panel scrolled to. */
async function entityRowLines(page: Page): Promise<number[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.code-panel-line.entity-row')].map((l) =>
      Number(l.dataset.line ?? l.dataset.lineHead),
    ),
  );
}

/** Breadcrumb chips in the panel title bar: text + whether it is the
 *  terminal file segment. */
async function breadcrumbs(page: Page): Promise<{ text: string; isFile: boolean }[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.code-panel-crumb')].map((b) => ({
      text: b.textContent ?? '',
      isFile: b.classList.contains('is-file'),
    })),
  );
}

/** Ids of the diagram type boxes currently carrying `.selected`. */
async function selectedTypeIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('g.type-box.selected')].map(
      (e) => e.getAttribute('data-element-id') ?? '',
    ),
  );
}

/** Ids of the field/member rows currently selected on the diagram. */
async function selectedMemberIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [
      ...document.querySelectorAll('g.field-row-g.selected-member, g.field-row-g.selected'),
    ].map((e) => e.getAttribute('data-element-id') ?? ''),
  );
}

// Open all modules + the two relevant type boxes so every targeted
// element (App, Gauge, the free fn `boot`) has a diagram row to click.
// Returns once geometry has settled.
async function expandFixture(page: Page): Promise<void> {
  await expandModule(page, CRATE);
  await expandModule(page, `${CRATE}::widgets`);
  await expandModule(page, `${CRATE}::widgets::gauge`);
  await expect(page.locator(`g.type-box[data-element-id="${GAUGE}"]`)).toBeVisible();
  // Reveal the crate-root free-function group's rows so `boot` is clickable.
  await expandType(page, `${CRATE}::__fn_pub`);
  await expect(page.locator(`g.field-row-g[data-element-id="${BOOT}"]`)).toBeVisible();
  await waitForLayoutSettled(page);
}

// Every test starts from a freshly loaded, fully expanded diagram and
// asserts that NO uncaught page error occurred during its interactions.
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // Stash on the test-info-less closure via the page object so each test
  // can assert at the end.
  (page as unknown as { __errs: string[] }).__errs = errors;
  await page.goto(server.url);
  await expect(page.locator(`.module-group[data-id="${CRATE}"]`)).toBeVisible();
  await expandFixture(page);
});

function assertNoPageErrors(page: Page): void {
  const errors = (page as unknown as { __errs: string[] }).__errs ?? [];
  expect(errors, `page errors: ${errors.join('; ')}`).toHaveLength(0);
}

// ── Tests ────────────────────────────────────────────────────────────

test('Cmd+click on a type box opens the panel at that type source', async ({ page }) => {
  expect(await isCodePanelOpen(page)).toBe(false);

  await cmdClick(page, `g.type-box[data-element-id="${APP}"] .expand-hit`);

  // Panel opens, the diagram selects App, and the panel scrolls to App's
  // source span (lines 10..13 of lib.rs in the fixture — `pub struct
  // App { ... }`). The focus frame is the source-of-truth that the panel
  // landed on the RIGHT element, not just that it opened.
  await expect(page.locator('#code-panel')).toBeVisible();
  expect(await isCodePanelOpen(page)).toBe(true);
  expect(await selectedTypeIds(page)).toContain(APP);

  await expect
    .poll(() => page.locator('.code-panel-line.entity-row').count())
    .toBeGreaterThan(0);
  const lines = await entityRowLines(page);
  expect(Math.min(...lines)).toBe(10);
  // The struct body is contiguous; the frame must not be a single stray line.
  expect(lines.length).toBeGreaterThan(1);

  assertNoPageErrors(page);
});

test('Cmd+click on a free-function row opens the panel scrolled to the function', async ({
  page,
}) => {
  await cmdClick(page, `g.field-row-g[data-element-id="${BOOT}"] text.field-row`);

  await expect(page.locator('#code-panel')).toBeVisible();
  // `boot` is `pub fn boot() -> u32 { 42 }` on lines 17..19 of lib.rs.
  // WHY this is a real regression oracle: free functions live under a
  // `__fn_pub` pseudo-type, so the handler must pass the function's
  // fully-qualified path (not `${type}::${name}`) for the span lookup to
  // resolve — a wrong id silently opens nothing / the wrong lines.
  await expect(page.locator('.code-panel-title')).toHaveText(/lib\.rs/);
  await expect
    .poll(() => page.locator('.code-panel-line.entity-row').count())
    .toBeGreaterThan(0);
  const lines = await entityRowLines(page);
  expect(Math.min(...lines)).toBe(17);
  expect(Math.max(...lines)).toBe(19);

  assertNoPageErrors(page);
});

test('the `c` key opens the panel for the current selection and toggles it closed', async ({
  page,
}) => {
  // Establish a selection (and an open panel) via Cmd+click on App.
  await cmdClick(page, `g.type-box[data-element-id="${APP}"] .expand-hit`);
  await expect(page.locator('#code-panel')).toBeVisible();
  expect(await selectedTypeIds(page)).toContain(APP);

  // `c` toggles the OPEN panel closed, and closing clears the diagram
  // selection so the two views stay in sync (panel.onClose → host).
  await openCodeViaKey(page);
  await expect(page.locator('#code-panel')).toBeHidden();
  expect(await isCodePanelOpen(page)).toBe(false);
  await expect.poll(() => selectedTypeIds(page)).toEqual([]);

  // Re-establish a selection without opening the panel: a plain (no
  // modifier) click on the Gauge type box selects it.
  await page.locator(`g.type-box[data-element-id="${GAUGE}"] .expand-hit`).click();
  // The plain click toggled Gauge's expansion; re-collapse is irrelevant —
  // what matters is that `c` now opens the panel for the *selected*
  // element. Select via Cmd+click path again to guarantee a selection,
  // then close, then reopen with `c`.
  await cmdClick(page, `g.type-box[data-element-id="${GAUGE}"] .expand-hit`);
  await expect(page.locator('#code-panel')).toBeVisible();
  await openCodeViaKey(page); // close
  await expect(page.locator('#code-panel')).toBeHidden();

  // `c` with Gauge still the most-recent selection reopens the panel at
  // Gauge's source (gauge.rs).
  await openCodeViaKey(page);
  await expect(page.locator('#code-panel')).toBeVisible();
  await expect(page.locator('.code-panel-title')).toHaveText(/gauge\.rs/);

  assertNoPageErrors(page);
});

test('the close button hides the panel and clears the diagram selection', async ({ page }) => {
  await cmdClick(page, `g.type-box[data-element-id="${APP}"] .expand-hit`);
  await expect(page.locator('#code-panel')).toBeVisible();
  expect(await selectedTypeIds(page)).toContain(APP);

  await page.locator('#code-panel .code-panel-close').click();

  await expect(page.locator('#code-panel')).toBeHidden();
  expect(await isCodePanelOpen(page)).toBe(false);
  // onClose fires → host clears the diagram selection.
  await expect.poll(() => selectedTypeIds(page)).toEqual([]);

  assertNoPageErrors(page);
});

test('clicking a source line inside the panel navigates the diagram selection to that entity', async ({
  page,
}) => {
  // Open at App (struct on lines 10..13). Line 11 is `pub gauge: Gauge,`
  // — the `gauge` field. Clicking it must move the diagram selection to
  // that field AND repaint the panel's focus frame onto line 11.
  await cmdClick(page, `g.type-box[data-element-id="${APP}"] .expand-hit`);
  await expect(page.locator('#code-panel')).toBeVisible();
  await expect
    .poll(() => page.locator('.code-panel-line.entity-row').count())
    .toBeGreaterThan(0);

  await page.locator('.code-panel-line[data-line="11"]').click();

  await expect
    .poll(() => selectedMemberIds(page))
    .toContain(`${APP}::gauge`);
  // The panel's highlight followed the cursor to the clicked entity.
  await expect.poll(() => entityRowLines(page)).toEqual([11]);

  assertNoPageErrors(page);
});

test('dragging the left splitter resizes the panel and the width persists across reload', async ({
  page,
}) => {
  await cmdClick(page, `g.type-box[data-element-id="${APP}"] .expand-hit`);
  await expect(page.locator('#code-panel')).toBeVisible();

  const before = await codePanelWidth(page);
  expect(before).not.toBeNull();

  // The left-edge splitter grows the panel when dragged LEFT (newW =
  // rightEdge - cursorX). Drive a real pointer drag so we exercise the
  // pointerdown/move/up + setPointerCapture path the user hits.
  const handle = codePanelResizeHandle(page);
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  const b = box as NonNullable<typeof box>;
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const DRAG = 140;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - DRAG / 2, cy, { steps: 6 });
  await page.mouse.move(cx - DRAG, cy, { steps: 6 });
  await page.mouse.up();

  const after = await codePanelWidth(page);
  expect(after).not.toBeNull();
  // Width grew by ~DRAG px (a couple px of slack for sub-pixel rounding
  // of the handle centre).
  expect(after as number).toBeGreaterThan((before as number) + DRAG - 6);
  expect(after as number).toBeLessThan((before as number) + DRAG + 6);

  const persisted = after as number;

  // Reload: the persisted width is read from localStorage and applied
  // before the panel is even reopened, so reopening lands at that width.
  await page.reload();
  await expect(page.locator(`.module-group[data-id="${CRATE}"]`)).toBeVisible();
  await expandFixture(page);
  await cmdClick(page, `g.type-box[data-element-id="${APP}"] .expand-hit`);
  await expect(page.locator('#code-panel')).toBeVisible();

  const reopened = await codePanelWidth(page);
  expect(reopened).not.toBeNull();
  // Same width survives the reload (localStorage round-trips an integer,
  // so allow a 2px rounding window).
  expect(Math.abs((reopened as number) - persisted)).toBeLessThanOrEqual(3);

  assertNoPageErrors(page);
});

test('a breadcrumb folder segment opens a popup whose file entry loads that file', async ({
  page,
}) => {
  // Gauge lives in src/widgets/gauge.rs, so its breadcrumb has a FOLDER
  // chip (`widgets`) plus the file chip (`gauge.rs`). The flat geometry
  // fixture can't produce this — it's why this spec ships its own nested
  // fixture.
  await cmdClick(page, `g.type-box[data-element-id="${GAUGE}"] .expand-hit`);
  await expect(page.locator('#code-panel')).toBeVisible();

  const crumbs = await breadcrumbs(page);
  expect(crumbs.map((c) => c.text)).toEqual(['widgets', 'gauge.rs']);
  expect(crumbs[0]?.isFile).toBe(false); // folder chip
  expect(crumbs[1]?.isFile).toBe(true); // terminal file chip

  // Click the FOLDER chip → a popup listing the folder's children opens.
  await page.locator('.code-panel-crumb', { hasText: 'widgets' }).click();
  await expect(page.locator('.code-panel-breadcrumb-popup')).toBeVisible();
  const rows = page.locator('.code-panel-breadcrumb-popup-row');
  await expect(rows).toHaveText([/gauge\.rs/]);

  // Click the file row → popup closes and that file loads in the panel.
  // (Re-load of the same file is fine; the observable contract is "popup
  // dismisses and the file is shown".)
  await rows.filter({ hasText: 'gauge.rs' }).click();
  await expect(page.locator('.code-panel-breadcrumb-popup')).toHaveCount(0);
  await expect(page.locator('#code-panel')).toBeVisible();
  await expect(page.locator('.code-panel-title')).toHaveText(/gauge\.rs/);
  await expect.poll(() => page.locator('.code-panel-line').count()).toBeGreaterThan(0);

  assertNoPageErrors(page);
});

test('the panel renders real Prism syntax-highlight tokens for Rust source', async ({ page }) => {
  await cmdClick(page, `g.type-box[data-element-id="${APP}"] .expand-hit`);
  await expect(page.locator('#code-panel')).toBeVisible();
  await expect
    .poll(() => page.locator('.code-panel-line').count())
    .toBeGreaterThan(0);

  // Real in-browser Prism highlighting emits `.token` spans (e.g. the
  // `pub`/`struct`/`fn` keywords). A body with zero tokens IS the
  // "source shown without syntax highlighting" regression.
  await expect
    .poll(() => page.locator('.code-panel-body .token').count())
    .toBeGreaterThan(0);
  await expect(page.locator('.code-panel-body .token.keyword').first()).toBeAttached();

  assertNoPageErrors(page);
});

test.skip(
  'live-reload of the edited source updates the open panel — needs a mutable workspace copy + watcher, not present in this fixture',
  () => {},
);

test.skip(
  'inline diff coloring (add/del rows) for a modified entity — needs a git base/head delta fixture launched with --at, not present',
  () => {},
);
