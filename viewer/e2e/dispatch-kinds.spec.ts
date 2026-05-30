// Tier-3 real-browser spec for GROUP M — diagram Cmd/Ctrl+click DISPATCH.
//
// What this covers: the `onShowCode(id, kind)` wiring in
// src/view/tree.ts and its routing through `openCodeFor(id, kind)` in
// src/main.ts. Cmd/Ctrl+click on EVERY diagram row kind must open the
// code panel scrolled to THAT element's source span:
//   • a struct field row        → kind 'field'
//   • a method row              → kind 'method'
//   • a method-bucket header     → NO-OP (buckets have no own span)
//   • a free-function row        → kind 'function'   (complements existing)
//   • a module label (left tree) → kind 'module'
//   • a ghost / re-export row    → routed via ghostTarget to the canonical type
//
// The type-box and free-function cases already have happy-path coverage
// in code-panel.spec.ts against its own fixture; this spec fills the row
// kinds that the catalog (GROUP M) flags as partial/none — field, method,
// module, bucket-no-op — plus the ghost case the routing does not handle.
//
// The oracle for each test is the CORRECT observable result: the panel
// opens at the targeted element's exact source lines (the focus frame's
// `entity-row` line numbers), verified against the real spans the server
// reports for `e2e/dispatch-kinds-fixture` — never "didn't throw" and
// never a screenshot.
//
// WHY a dedicated fixture: GROUP M needs a single crate exercising every
// row kind at once, including a `pub use` re-export (a ghost row) that
// the shared geometry fixture lacks. `e2e/dispatch-kinds-fixture` is that
// crate — `App` (fields), `Gauge` (field + method + a method bucket),
// `boot` (free fn), and `pub use ... as Dial` (a ghost in the crate
// root). The shared `_harness.ts` server is hard-wired to the geometry
// fixture, so this spec spawns its own server against the dispatch
// fixture (same `ready`-line protocol) and reuses the panel helpers.

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { expect, isCodePanelOpen, test, waitForLayoutSettled } from './_harness.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = process.env.MIND_EXPANDER_BIN ?? path.resolve(HERE, '../../target/debug/mind-expander');
const WORKSPACE = path.resolve(HERE, 'dispatch-kinds-fixture');
const READY_TIMEOUT_MS = 30_000;

const CRATE = 'dk_fixture';
const APP = `${CRATE}::App`; // struct in lib.rs (17..20)
const GAUGE = `${CRATE}::widgets::gauge::Gauge`; // struct in gauge.rs (1..3)
const APP_GAUGE = `${APP}::gauge`; // field row, lib.rs line 18
const GAUGE_READING = `${GAUGE}::reading`; // field row, gauge.rs line 2
const GAUGE_READ = `${GAUGE}::read`; // method row, gauge.rs (8..10)
const BOOT = `${CRATE}::boot`; // free fn row, lib.rs (24..26)
const GAUGE_MODULE = `${CRATE}::widgets::gauge`; // module label, gauge.rs
const GHOST = `${CRATE}::__re_Dial`; // ghost row for `pub use ... as Dial`

/** Spawn `view <dispatch-kinds-fixture> --port 0` and resolve the bound
 *  URL from the server's `ready` JSON line — same contract as the shared
 *  harness, pointed at this spec's own fixture. */
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

/** Expand a module row in the left HTML tree by its data-id. */
async function expandModule(page: Page, moduleId: string): Promise<void> {
  await page.locator(`.module-group[data-id="${moduleId}"] > *`).first().click();
}

/** Expand a type box via its CHEVRON (`expand-arrow-hit`), which routes
 *  through `onToggleTypeMembers` and auto-expands the type's method
 *  buckets — so method rows (and their bucket header) render without a
 *  second click. (Plain `.expand-hit` toggles expansion but leaves
 *  buckets collapsed, hiding method rows.) */
async function expandType(page: Page, typeFullPath: string): Promise<void> {
  await page.locator(`g.type-box[data-element-id="${typeFullPath}"] .expand-arrow-hit`).click();
}

/** Dispatch a real Cmd-modified `click` on `selector`. The diagram's d3
 *  click handlers branch on `event.metaKey` to call
 *  `onShowCode(id, kind)` → `openCodeFor`, the affordance under test. */
async function cmdClick(page: Page, selector: string): Promise<void> {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) throw new Error(`cmdClick: no element for ${sel}`);
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
  }, selector);
}

/** The 1-based line numbers carried by the panel rows currently tagged
 *  `entity-row` — the focus frame the panel scrolled to. Source-mode
 *  rows use `data-line`. */
async function entityRowLines(page: Page): Promise<number[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.code-panel-line.entity-row')].map((l) =>
      Number(l.dataset.line ?? l.dataset.lineHead),
    ),
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
    [...document.querySelectorAll('g.field-row-g.selected-member, g.field-row-g.selected')].map(
      (e) => e.getAttribute('data-element-id') ?? '',
    ),
  );
}

// Open every module + both type boxes so all targeted rows (App + its
// fields, Gauge + its field/method/bucket, boot, the ghost) have a
// rendered diagram element to click. Returns once geometry has settled.
async function expandFixture(page: Page): Promise<void> {
  await expandModule(page, CRATE);
  await expandModule(page, `${CRATE}::widgets`);
  await expandModule(page, GAUGE_MODULE);
  await expect(page.locator(`g.type-box[data-element-id="${GAUGE}"]`)).toBeVisible();
  await expandType(page, APP);
  await expandType(page, GAUGE);
  // Reveal the crate-root free-function group's rows so `boot` renders.
  await expandType(page, `${CRATE}::__fn_pub`);
  await expect(page.locator(`g.field-row-g[data-element-id="${APP_GAUGE}"]`)).toBeVisible();
  await expect(page.locator(`g.field-row-g[data-element-id="${GAUGE_READ}"]`)).toBeVisible();
  await expect(page.locator(`g.field-row-g[data-element-id="${BOOT}"]`)).toBeVisible();
  await waitForLayoutSettled(page);
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
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

test('Cmd+click a struct FIELD row opens the panel at that field source', async ({ page }) => {
  expect(await isCodePanelOpen(page)).toBe(false);

  // `App::gauge` is `pub gauge: Gauge,` on lib.rs line 18. The handler
  // routes `onShowCode(`${type}::${name}`, 'field')`; a wrong id/kind
  // would resolve the wrong span (or none).
  await cmdClick(page, `g.field-row-g[data-element-id="${APP_GAUGE}"] text.field-row`);

  await expect(page.locator('#code-panel')).toBeVisible();
  expect(await isCodePanelOpen(page)).toBe(true);
  await expect(page.locator('.code-panel-title')).toHaveText(/lib\.rs/);
  // The diagram selection follows the dispatch to the same member.
  await expect.poll(() => selectedMemberIds(page)).toContain(APP_GAUGE);

  await expect.poll(() => page.locator('.code-panel-line.entity-row').count()).toBeGreaterThan(0);
  // Single-line field span: exactly line 18, no stray rows.
  expect(await entityRowLines(page)).toEqual([18]);

  assertNoPageErrors(page);
});

test('Cmd+click a FIELD on a nested type opens the panel at the nested file + line', async ({
  page,
}) => {
  // `Gauge::reading` is `pub reading: u32,` on gauge.rs line 2 — a
  // DIFFERENT file than the crate root, so this also proves the dispatch
  // carries the field's own span file, not the last-opened file.
  await cmdClick(page, `g.field-row-g[data-element-id="${GAUGE_READING}"] text.field-row`);

  await expect(page.locator('#code-panel')).toBeVisible();
  await expect(page.locator('.code-panel-title')).toHaveText(/gauge\.rs/);
  await expect.poll(() => selectedMemberIds(page)).toContain(GAUGE_READING);
  await expect.poll(() => page.locator('.code-panel-line.entity-row').count()).toBeGreaterThan(0);
  expect(await entityRowLines(page)).toEqual([2]);

  assertNoPageErrors(page);
});

test('Cmd+click a METHOD row opens the panel scrolled to the method body', async ({ page }) => {
  // `Gauge::read` is `pub fn read(&self) -> u32 { ... }` on gauge.rs
  // lines 8..10. Methods route through `f.functionFullPath` with kind
  // 'method' (NOT `${type}::${name}` blindly) so the (id,kind) span
  // lookup is unambiguous even when a field shares the name.
  await cmdClick(page, `g.field-row-g[data-element-id="${GAUGE_READ}"] text.field-row`);

  await expect(page.locator('#code-panel')).toBeVisible();
  await expect(page.locator('.code-panel-title')).toHaveText(/gauge\.rs/);
  await expect.poll(() => selectedMemberIds(page)).toContain(GAUGE_READ);

  await expect.poll(() => page.locator('.code-panel-line.entity-row').count()).toBeGreaterThan(0);
  const lines = await entityRowLines(page);
  expect(Math.min(...lines)).toBe(8);
  expect(Math.max(...lines)).toBe(10);

  assertNoPageErrors(page);
});

test('Cmd+click a free-FUNCTION row opens the panel scrolled to the function', async ({ page }) => {
  // Complements code-panel.spec.ts's free-fn case on a different fixture.
  // `boot` is `pub fn boot() -> u32 { 42 }` on lib.rs lines 24..26; free
  // functions live under a `__fn_pub` pseudo-type, so the handler must
  // pass the function's fully-qualified path with kind 'function'.
  await cmdClick(page, `g.field-row-g[data-element-id="${BOOT}"] text.field-row`);

  await expect(page.locator('#code-panel')).toBeVisible();
  await expect(page.locator('.code-panel-title')).toHaveText(/lib\.rs/);
  await expect.poll(() => page.locator('.code-panel-line.entity-row').count()).toBeGreaterThan(0);
  const lines = await entityRowLines(page);
  expect(Math.min(...lines)).toBe(24);
  expect(Math.max(...lines)).toBe(26);

  assertNoPageErrors(page);
});

test('Cmd+click a TYPE box opens the panel at the type source', async ({ page }) => {
  // The type case for THIS fixture: `Gauge` struct on gauge.rs 1..3. The
  // expand-hit rect carries the type's Cmd+click handler
  // (`onShowCode(d.fullPath, 'type')`).
  await cmdClick(page, `g.type-box[data-element-id="${GAUGE}"] .expand-hit`);

  await expect(page.locator('#code-panel')).toBeVisible();
  expect(await selectedTypeIds(page)).toContain(GAUGE);
  await expect(page.locator('.code-panel-title')).toHaveText(/gauge\.rs/);

  await expect.poll(() => page.locator('.code-panel-line.entity-row').count()).toBeGreaterThan(0);
  const lines = await entityRowLines(page);
  expect(Math.min(...lines)).toBe(1);
  expect(Math.max(...lines)).toBe(3);

  assertNoPageErrors(page);
});

test('Cmd+click a MODULE label (left tree) opens the panel at the module file', async ({
  page,
}) => {
  // The left-tree `.module-header` click branches on metaKey →
  // `onShowCode(m.id)` → `openCodeFor(moduleId, 'module')`. A module has
  // no tight span, so the index anchors it at line 1 of the module's
  // source file (gauge.rs here).
  await cmdClick(page, `.module-group[data-id="${GAUGE_MODULE}"] .module-header`);

  await expect(page.locator('#code-panel')).toBeVisible();
  expect(await isCodePanelOpen(page)).toBe(true);
  await expect(page.locator('.code-panel-title')).toHaveText(/gauge\.rs/);
  // Module anchor frame is line 1 (the "scroll to top" span).
  await expect.poll(() => page.locator('.code-panel-line.entity-row').count()).toBeGreaterThan(0);
  expect(await entityRowLines(page)).toEqual([1]);

  assertNoPageErrors(page);
});

test('Cmd+click a method-BUCKET header is a no-op (buckets have no own span)', async ({ page }) => {
  expect(await isCodePanelOpen(page)).toBe(false);

  // The "pub fn (1)" bucket header under Gauge has `kind === 'method_bucket'`.
  // The Cmd+click branch explicitly skips bucket headers (`if
  // (!isBucketHeader)`), so the panel must stay CLOSED — the correct
  // observable behavior, not an accidental open at the wrong span.
  const bucket = page.locator(`g.field-row-g[data-element-kind="method_bucket"]`);
  await expect(bucket.first()).toBeVisible();
  await bucket.first().evaluate((g) => {
    const text = g.querySelector('text.field-row');
    if (text === null) throw new Error('bucket header has no field-row text');
    text.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
  });

  // Give any (incorrect) open a chance to surface, then assert it did not.
  await page.waitForTimeout(200);
  expect(await isCodePanelOpen(page)).toBe(false);

  assertNoPageErrors(page);
});

test('Cmd+click a GHOST re-export row opens the canonical type source', async ({
  page,
}) => {
  // tree.ts (line ~1738) fires `onShowCode(d.fullPath, 'type')` for a
  // ghost on Cmd+click — but a ghost's `fullPath` is the SYNTHETIC id
  // `dk_fixture::__re_Dial` (module_tree.ts synthesiseTypeReExportGhosts),
  // which is NOT a key in the span index (buildSpanIndex only inserts
  // real `full_path`s). So `lookupSpan` returns null and
  // `openCodeFor` early-returns: the panel never opens.
  //
  // The CORRECT behavior is to open the canonical type the ghost
  // re-exports (`ghostTarget` = `dk_fixture::widgets::gauge::Gauge`,
  // gauge.rs 1..3), since the ghost row otherwise has no source of its
  // own to show. The dispatch should route the ghost through its target
  // path, not its synthetic id. Skipped until the routing is fixed.
  expect(await isCodePanelOpen(page)).toBe(false);

  await expect(page.locator(`g.type-box[data-element-id="${GHOST}"]`)).toBeVisible();
  await cmdClick(page, `g.type-box[data-element-id="${GHOST}"] .expand-hit`);

  await expect(page.locator('#code-panel')).toBeVisible();
  await expect(page.locator('.code-panel-title')).toHaveText(/gauge\.rs/);
  const lines = await entityRowLines(page);
  expect(Math.min(...lines)).toBe(1);
  expect(Math.max(...lines)).toBe(3);

  assertNoPageErrors(page);
});
