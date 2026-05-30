// Tier-3 real-browser spec for GROUP F — Selection / member interactions.
//
// The oracle for every test is a CORRECT observable result the user would
// see — a `.selected` class + painted ring, a `.selected-member` band, or
// the (id, kind) row that lit — never "didn't throw" and never a recorded
// screenshot.
//
// WHY a dedicated fixture (`selection-interactions-fixture`, crate
// `sel_interactions`): GROUP F's decisive case is a single type carrying a
// struct field AND an inherent method that SHARE A NAME (`Vault::store`).
// Both members resolve to the canonical id `sel_interactions::Vault::store`;
// only the `(id, kind)` pair disambiguates them. No other e2e fixture has
// that collision. The existing `selection-fixture` has field+methods but no
// same-name field/method, so it cannot exercise the mis-light bug.
//
// This spec drives the REAL selection path a user triggers with Cmd/Ctrl+
// click (the diagram's d3 handlers branch on `event.metaKey` to open the
// code panel at the element source and push that `(id, kind)` back into the
// diagram selection — the two-way state sync). The shared `_harness.ts`
// server fixture is hard-wired to the geometry fixture, so this spec spawns
// its own server against this fixture (same `ready`-line protocol) while
// reusing the harness DOM helpers.

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import {
  expect,
  hasSelectionRing,
  selectedTypeId,
  test,
  waitForLayoutSettled,
} from './_harness.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = process.env.MIND_EXPANDER_BIN ?? path.resolve(HERE, '../../target/debug/mind-expander');
const WORKSPACE = path.resolve(HERE, 'selection-interactions-fixture');
const READY_TIMEOUT_MS = 30_000;

const CRATE = 'sel_interactions';
const VAULT = `${CRATE}::Vault`;
const BOX = `${CRATE}::core::Box_`;
// The struct field + inherent method share this canonical id; only the
// kind differs.
const STORE_ID = `${VAULT}::store`;
const CAP_ID = `${VAULT}::cap`;
const BOXED_ID = `${VAULT}::boxed`;

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

async function expandModule(page: Page, moduleId: string): Promise<void> {
  await page.locator(`.module-group[data-id="${moduleId}"] > *`).first().click();
}

async function expandType(page: Page, typeFullPath: string): Promise<void> {
  await page.locator(`g.type-box[data-element-id="${typeFullPath}"] .expand-hit`).click();
}

/** Dispatch a real Cmd-modified `click` on `selector`. */
async function cmdClick(page: Page, selector: string): Promise<void> {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) throw new Error(`cmdClick: no element for ${sel}`);
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
  }, selector);
}

/** The `(id, kind)` pairs of every row currently carrying
 *  `.selected-member`. The kind disambiguates the field vs method twin. */
async function selectedMembers(page: Page): Promise<Array<{ id: string; kind: string }>> {
  return page.evaluate(() =>
    [...document.querySelectorAll('g.field-row-g.selected-member')].map((e) => ({
      id: e.getAttribute('data-element-id') ?? '',
      kind: e.getAttribute('data-element-kind') ?? '',
    })),
  );
}

/** Rows inside the Vault box, as `(id, kind)` pairs in render order. Used
 *  to assert the method bucket is expanded (a `method` row materialised)
 *  before clicking it. */
async function vaultRows(page: Page): Promise<Array<{ id: string; kind: string }>> {
  return page.evaluate((id) => {
    const box = document.querySelector(`g.type-box[data-element-id="${id}"]`);
    if (box === null) return [];
    return [...box.querySelectorAll('g.field-row-g')].map((g) => ({
      id: g.getAttribute('data-element-id') ?? '',
      kind: g.getAttribute('data-element-kind') ?? '',
    }));
  }, VAULT);
}

/** Expand the `pub fn` method bucket inside Vault by clicking its header,
 *  so the individual `store()` / `capacity()` method rows materialise. */
async function expandMethodBucket(page: Page): Promise<void> {
  await page
    .locator(
      `g.type-box[data-element-id="${VAULT}"] g.field-row-g[data-element-kind="method_bucket"]`,
    )
    .first()
    .locator('text.field-row')
    .click();
  await waitForLayoutSettled(page);
}

/** Screen-space size of a member row's selection band (`rect.member-bg`).
 *  A row whose `(id, kind)` we name explicitly, since the field and method
 *  twins share `data-element-id`. */
async function memberBandRect(
  page: Page,
  rowId: string,
  rowKind: string,
): Promise<{ width: number; height: number } | null> {
  return page.evaluate(
    ({ id, kind }) => {
      const g = document.querySelector(
        `g.field-row-g[data-element-id="${id}"][data-element-kind="${kind}"]`,
      );
      const bg = g?.querySelector('rect.member-bg') as SVGGraphicsElement | null;
      if (bg === null || bg === undefined) return null;
      const r = bg.getBoundingClientRect();
      return { width: r.width, height: r.height };
    },
    { id: rowId, kind: rowKind },
  );
}

async function expandFixture(page: Page): Promise<void> {
  await expandModule(page, CRATE);
  await expandModule(page, `${CRATE}::core`);
  await expect(page.locator(`g.type-box[data-element-id="${VAULT}"]`)).toBeVisible();
  await expect(page.locator(`g.type-box[data-element-id="${BOX}"]`)).toBeVisible();
  await expandType(page, VAULT);
  // The `boxed` field emits the ownership arrow once Vault is open.
  await expect(page.locator(`g.arrow[data-arrow-to="${BOX}"]`)).toHaveCount(1);
  await waitForLayoutSettled(page);
}

let pageErrors: string[];

test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(server.url);
  await expect(page.locator(`.module-group[data-id="${CRATE}"]`)).toBeVisible();
  await expandFixture(page);
  expect(pageErrors, `page errors during load: ${pageErrors.join('; ')}`).toHaveLength(0);
});

test.afterEach(() => {
  expect(pageErrors, `page errors during test: ${pageErrors.join('; ')}`).toHaveLength(0);
});

test('Cmd+click the type header selects it and paints the purple ring', async ({ page }) => {
  await cmdClick(page, `g.type-box[data-element-id="${VAULT}"] .expand-hit`);
  await expect(page.locator(`g.type-box[data-element-id="${VAULT}"].selected`)).toHaveCount(1);

  // Exactly Vault is selected, and its ring is painted with a positive
  // size + the violet-500 stroke.
  expect(await selectedTypeId(page)).toBe(VAULT);
  expect(await page.locator('g.type-box.selected').count()).toBe(1);
  expect(await hasSelectionRing(page, VAULT)).toBe(true);

  const ringStroke = await page.evaluate((id) => {
    const ring = document.querySelector(`g.type-box[data-element-id="${id}"] rect.selection-ring`);
    return ring === null ? null : getComputedStyle(ring).stroke;
  }, VAULT);
  expect(ringStroke).toMatch(/^rgba?\(168,\s*85,\s*247/);
});

test('Cmd+click a field name selects that field and paints its member band', async ({ page }) => {
  await cmdClick(
    page,
    `g.field-row-g[data-element-id="${CAP_ID}"][data-element-kind="field"] .field-row`,
  );
  await expect(
    page.locator(
      `g.field-row-g[data-element-id="${CAP_ID}"][data-element-kind="field"].selected-member`,
    ),
  ).toHaveCount(1);

  // Exactly the cap field lit; its container box also shows the ring.
  expect(await selectedMembers(page)).toEqual([{ id: CAP_ID, kind: 'field' }]);
  expect(await selectedTypeId(page)).toBe(VAULT);
  expect(await hasSelectionRing(page, VAULT)).toBe(true);

  // The member band is painted with positive size on the cap row.
  const band = await memberBandRect(page, CAP_ID, 'field');
  expect(band).not.toBeNull();
  const b = band as NonNullable<typeof band>;
  expect(b.width).toBeGreaterThan(0);
  expect(b.height).toBeGreaterThan(0);
});

test('Cmd+click a method name selects that method', async ({ page }) => {
  await expandMethodBucket(page);
  // The bucket expanded → a `method` row for `store()` is now present.
  const rows = await vaultRows(page);
  expect(rows).toContainEqual({ id: STORE_ID, kind: 'method' });
  expect(rows).toContainEqual({ id: STORE_ID, kind: 'field' });

  await cmdClick(
    page,
    `g.field-row-g[data-element-id="${STORE_ID}"][data-element-kind="method"] .field-row`,
  );
  await expect(
    page.locator(
      `g.field-row-g[data-element-id="${STORE_ID}"][data-element-kind="method"].selected-member`,
    ),
  ).toHaveCount(1);

  // The METHOD row is selected — and ONLY it, not the same-name field twin.
  expect(await selectedMembers(page)).toEqual([{ id: STORE_ID, kind: 'method' }]);
});

test('a field and method sharing a name disambiguate by (id, kind) — no mis-light', async ({
  page,
}) => {
  await expandMethodBucket(page);
  // Both twins are present and share the canonical id.
  const rows = await vaultRows(page);
  const storeRows = rows.filter((r) => r.id === STORE_ID);
  expect(storeRows.map((r) => r.kind).sort()).toEqual(['field', 'method']);

  // Select the FIELD `store`. Only the field row may light — the method
  // `store()` row must stay unselected even though it shares the id.
  await cmdClick(
    page,
    `g.field-row-g[data-element-id="${STORE_ID}"][data-element-kind="field"] .field-row`,
  );
  await expect(
    page.locator(
      `g.field-row-g[data-element-id="${STORE_ID}"][data-element-kind="field"].selected-member`,
    ),
  ).toHaveCount(1);
  expect(await selectedMembers(page)).toEqual([{ id: STORE_ID, kind: 'field' }]);
  await expect(
    page.locator(
      `g.field-row-g[data-element-id="${STORE_ID}"][data-element-kind="method"].selected-member`,
    ),
  ).toHaveCount(0);

  // Now select the METHOD `store()`. The selection moves to the method
  // row; the field row is no longer lit. Exactly one of the twins is ever
  // lit, keyed by kind.
  await cmdClick(
    page,
    `g.field-row-g[data-element-id="${STORE_ID}"][data-element-kind="method"] .field-row`,
  );
  await expect(
    page.locator(
      `g.field-row-g[data-element-id="${STORE_ID}"][data-element-kind="method"].selected-member`,
    ),
  ).toHaveCount(1);
  expect(await selectedMembers(page)).toEqual([{ id: STORE_ID, kind: 'method' }]);
  await expect(
    page.locator(
      `g.field-row-g[data-element-id="${STORE_ID}"][data-element-kind="field"].selected-member`,
    ),
  ).toHaveCount(0);
});

test('selecting a field lights only that row, not a sibling field on the same type', async ({
  page,
}) => {
  await cmdClick(
    page,
    `g.field-row-g[data-element-id="${BOXED_ID}"][data-element-kind="field"] .field-row`,
  );
  await expect(
    page.locator(
      `g.field-row-g[data-element-id="${BOXED_ID}"][data-element-kind="field"].selected-member`,
    ),
  ).toHaveCount(1);
  expect(await selectedMembers(page)).toEqual([{ id: BOXED_ID, kind: 'field' }]);
  // The sibling `cap` field is NOT lit.
  await expect(
    page.locator(
      `g.field-row-g[data-element-id="${CAP_ID}"][data-element-kind="field"].selected-member`,
    ),
  ).toHaveCount(0);
});

test('closing the code panel clears the diagram selection (two-way state)', async ({ page }) => {
  // Establish a member selection via the code-panel-driving Cmd+click.
  await cmdClick(
    page,
    `g.field-row-g[data-element-id="${CAP_ID}"][data-element-kind="field"] .field-row`,
  );
  await expect(
    page.locator(
      `g.field-row-g[data-element-id="${CAP_ID}"][data-element-kind="field"].selected-member`,
    ),
  ).toHaveCount(1);
  expect(await selectedTypeId(page)).toBe(VAULT);

  // Close the code panel via its close button. The panel's `onClose` calls
  // setDiagramSelection(null, null), so the diagram selection clears —
  // ring + member band both gone. This is the code-panel → diagram half of
  // the two-way sync.
  await page.locator('#code-panel .code-panel-close').click();
  await expect(page.locator('g.type-box.selected')).toHaveCount(0);
  expect(await selectedTypeId(page)).toBeNull();
  expect(await selectedMembers(page)).toEqual([]);
});
