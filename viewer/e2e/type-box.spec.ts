// Tier-3 real-browser spec for the type-box feature area.
//
// Drives a real Chromium against a real `mind-expander view` server.
// Every oracle is a CORRECT observable result — a DOM / geometry / state
// change the user would see — never "didn't throw" and never a recorded
// screenshot (the on-failure screenshot in playwright.config.ts is only a
// debugging artifact).
//
// Scope (what a type box renders + how it reacts): the box renders with
// positive real-font size and its header label FITS within the box (the
// real-font header-overflow guard); expanding reveals field rows + a
// method-bucket header; expanding the bucket reveals method rows; clicking
// a method name expands its signature into argument rows; the kind marker
// owns pointer events and the chevron toggles expansion; a `pub use`
// ghost type renders its label italic.
//
// WHY a dedicated fixture (not the shared `fixture-workspace`): the shared
// geometry fixture is all plain structs with fields and NO methods, so it
// can't exercise method buckets, the signature toggle, or a ghost. This
// spec ships `e2e/type-box-fixture`: `engine::Engine` has two fields and
// two methods (one with two arguments), and the crate root `pub use`s
// `Engine as Garage` to produce a ghost type. The shared `_harness.ts`
// server fixture is hard-wired to the geometry fixture, so this spec spawns
// its own server against its fixture (same `ready`-line protocol) while
// reusing the shared interaction/geometry helpers.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test, waitForLayoutSettled } from './_harness.ts';
import type { Page } from '@playwright/test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN =
  process.env.MIND_EXPANDER_BIN ?? path.resolve(HERE, '../../target/debug/mind-expander');
const WORKSPACE = path.resolve(HERE, 'type-box-fixture');
const READY_TIMEOUT_MS = 30_000;

const CRATE = 'tb_fixture';
const APP = `${CRATE}::App`;
const ENGINE = `${CRATE}::engine::Engine`;
const GHOST = `${CRATE}::__re_Garage`; // ghost id for `pub use Engine as Garage`
// The two-argument method whose name-click expands the signature.
const SET_POWER = `${ENGINE}::set_power`;
const METHOD_BUCKET = `${ENGINE}::pub fn (2)`; // bucket header row element id

/** Spawn `view <type-box-fixture> --port 0` and resolve the bound URL
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

// ── Fixture-local helpers (re-derived against this crate's ids) ──────

async function expandModule(page: Page, moduleId: string): Promise<void> {
  await page.locator(`.module-group[data-id="${moduleId}"] > *`).first().click();
}

/** Bring every box into the DOM: expand the crate root + the `engine`
 *  module so App, the ghost, and Engine all render. Returns once layout
 *  has settled. */
async function expandAll(page: Page): Promise<void> {
  await expandModule(page, CRATE);
  await expandModule(page, `${CRATE}::engine`);
  await expect(page.locator(`g.type-box[data-element-id="${ENGINE}"]`)).toBeVisible();
  await expect(page.locator(`g.type-box[data-element-id="${GHOST}"]`)).toBeVisible();
  await waitForLayoutSettled(page);
}

/** Screen-space bounding rect of a single element (or null). */
async function rectOf(page: Page, selector: string): Promise<DOMRect | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) return null;
    const r = (el as SVGGraphicsElement).getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom } as DOMRect;
  }, selector);
}

/** Visible (rendered) field-row groups for a type box, by member label. A
 *  collapsed type removes its rows entirely (exit transition + .remove),
 *  so reading after `waitForLayoutSettled` reflects the settled set. */
function rowLocator(page: Page, typeId: string) {
  return page.locator(`g.type-box[data-element-id="${typeId}"] g.field-row-g`);
}

// Every test starts from a freshly loaded diagram and asserts NO uncaught
// page error occurred during its interactions. (SSE reconnect / resource
// console errors are NOT page errors and are intentionally not asserted —
// the oracle is uncaught JS exceptions, matching geometry.spec.ts.)
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  (page as unknown as { __errs: string[] }).__errs = errors;
  await page.goto(server.url);
  await expect(page.locator(`.module-group[data-id="${CRATE}"]`)).toBeVisible();
  await expandAll(page);
});

function assertNoPageErrors(page: Page): void {
  const errors = (page as unknown as { __errs: string[] }).__errs ?? [];
  expect(errors, `page errors: ${errors.join('; ')}`).toHaveLength(0);
}

// ── Tests ────────────────────────────────────────────────────────────

test('type boxes render with positive real-font size and a single kind marker', async ({
  page,
}) => {
  for (const id of [APP, ENGINE, GHOST]) {
    const box = await rectOf(page, `g.type-box[data-element-id="${id}"]`);
    expect(box, `rect for ${id}`).not.toBeNull();
    // A zero-area box IS the "type box not showing" bug, and under a real
    // browser the size reflects the real system font, not a fixed-width
    // test fallback.
    expect(box?.width, `${id} width`).toBeGreaterThan(0);
    expect(box?.height, `${id} height`).toBeGreaterThan(0);

    // Exactly one kind marker per box, and it owns pointer events (the
    // contract that keeps the kind letter clickable — see tree.ts).
    const markers = page.locator(`g.type-box[data-element-id="${id}"] text.kind-marker`);
    await expect(markers).toHaveCount(1);
    await expect(markers).toHaveAttribute('pointer-events', 'all');
  }
  assertNoPageErrors(page);
});

test('the header label fits within the box under the real font (overflow guard)', async ({
  page,
}) => {
  // The historical bug let bold/long header text spill past the box right
  // edge. Real fonts (not the test measurer) decide the advance, so this
  // is the e2e guard: the rendered label must sit inside the rendered box,
  // to the RIGHT of the kind marker (no overlap), with its right edge at or
  // within the box right edge.
  const MARGIN = 2; // px slack for sub-pixel rounding
  for (const id of [APP, ENGINE, GHOST]) {
    const box = await rectOf(page, `g.type-box[data-element-id="${id}"]`);
    const label = await rectOf(page, `g.type-box[data-element-id="${id}"] text.header-label`);
    const marker = await rectOf(page, `g.type-box[data-element-id="${id}"] text.kind-marker`);
    expect(box && label && marker, `rects for ${id}`).toBeTruthy();
    const b = box as DOMRect;
    const l = label as DOMRect;
    const m = marker as DOMRect;

    expect(l.width, `${id} label width`).toBeGreaterThan(0);
    // Label starts past the marker (marker + name read as a unit, no overlap).
    expect(l.x, `${id} label left vs marker right`).toBeGreaterThanOrEqual(m.right - MARGIN);
    // Label right edge fits within the box right edge — the overflow guard.
    expect(l.right, `${id} label right vs box right`).toBeLessThanOrEqual(b.right + MARGIN);
    // Marker fits within the box left edge.
    expect(m.x, `${id} marker left vs box left`).toBeGreaterThanOrEqual(b.x - MARGIN);
  }
  assertNoPageErrors(page);
});

test('expanding a type reveals its field rows and a method-bucket header; collapsing removes them', async ({
  page,
}) => {
  const engineHit = page.locator(`g.type-box[data-element-id="${ENGINE}"] .expand-hit`);
  const arrow = page.locator(`g.type-box[data-element-id="${ENGINE}"] text.expand-arrow`);
  const rows = rowLocator(page, ENGINE);

  // Engine starts collapsed (no member rows; chevron points right).
  await expect(rows).toHaveCount(0);
  await expect(arrow).toHaveText('▸');

  // Expand → two field rows (power, torque) + one method-bucket header.
  await engineHit.click();
  await waitForLayoutSettled(page);
  await expect(arrow).toHaveText('▾');
  await expect(rows).toHaveCount(3);
  await expect(
    page.locator(`g.type-box[data-element-id="${ENGINE}"] g.field-row-g[data-element-id="${ENGINE}::power"]`),
  ).toHaveCount(1);
  await expect(
    page.locator(`g.type-box[data-element-id="${ENGINE}"] g.field-row-g[data-element-id="${METHOD_BUCKET}"]`),
  ).toHaveCount(1);
  // The bucket header carries its own collapsible chevron (closed = ▸).
  const bucketChevron = page.locator(
    `g.field-row-g[data-element-id="${METHOD_BUCKET}"] text.method-bucket-chevron`,
  );
  await expect(bucketChevron).toHaveText('▸');

  // Collapse → rows are removed (exit transition + .remove), chevron flips.
  await engineHit.click();
  await waitForLayoutSettled(page);
  await expect(arrow).toHaveText('▸');
  await expect(rows).toHaveCount(0);

  assertNoPageErrors(page);
});

test('the kind marker and the expand chevron are clickable affordances', async ({ page }) => {
  // The chevron-hit toggles the SAME expansion the expand-hit does; using
  // the marker's sibling expand-arrow chevron as the click target proves
  // the chevron affordance is wired (not just decorative). App starts in a
  // known state; toggle twice and assert the chevron text round-trips and
  // member rows appear/disappear.
  const arrow = page.locator(`g.type-box[data-element-id="${APP}"] text.expand-arrow`);
  const arrowHit = page.locator(`g.type-box[data-element-id="${APP}"] .expand-arrow-hit`);
  const rows = rowLocator(page, APP);

  const initial = (await arrow.textContent())?.trim();
  expect(initial === '▸' || initial === '▾').toBe(true);

  await arrowHit.click();
  await waitForLayoutSettled(page);
  const toggled = (await arrow.textContent())?.trim();
  expect(toggled, 'chevron text flipped on click').not.toBe(initial);

  // After the toggle the row count agrees with the chevron direction:
  // open (▾) → App's two fields render; closed (▸) → none.
  if (toggled === '▾') {
    await expect(rows).toHaveCount(2);
  } else {
    await expect(rows).toHaveCount(0);
  }

  // The kind marker owns pointer events and is a real <text> hit target.
  const marker = page.locator(`g.type-box[data-element-id="${APP}"] text.kind-marker`);
  await expect(marker).toHaveAttribute('pointer-events', 'all');
  const markerBox = await rectOf(page, `g.type-box[data-element-id="${APP}"] text.kind-marker`);
  expect(markerBox?.width, 'marker has paintable width').toBeGreaterThan(0);
  expect(markerBox?.height, 'marker has paintable height').toBeGreaterThan(0);

  assertNoPageErrors(page);
});

test('clicking a method name expands its signature into one argument row per parameter', async ({
  page,
}) => {
  // Expand Engine, then open the method bucket so method rows render.
  await page.locator(`g.type-box[data-element-id="${ENGINE}"] .expand-hit`).click();
  await waitForLayoutSettled(page);
  await page
    .locator(`g.field-row-g[data-element-id="${METHOD_BUCKET}"] text.method-bucket-chevron`)
    .click();
  await waitForLayoutSettled(page);

  // The two methods now have rows. set_power is `&mut self, watts, rpm`.
  const setPowerRow = page
    .locator(`g.type-box[data-element-id="${ENGINE}"] g.field-row-g[data-element-id="${SET_POWER}"]`)
    .filter({ hasText: 'set_power' });
  await expect(setPowerRow).toHaveCount(1);

  // No signature argument rows yet.
  const argRows = page.locator(
    `g.type-box[data-element-id="${ENGINE}"] g.field-row-g[data-element-id="${ENGINE}::watts"], ` +
      `g.type-box[data-element-id="${ENGINE}"] g.field-row-g[data-element-id="${ENGINE}::rpm"], ` +
      `g.type-box[data-element-id="${ENGINE}"] g.field-row-g[data-element-id="${ENGINE}::&mut self"]`,
  );
  await expect(argRows).toHaveCount(0);

  // Click the method NAME → expands the signature into argument rows:
  // the `&mut self` receiver plus one row per parameter (watts, rpm).
  await setPowerRow.locator('text.field-row').click();
  await waitForLayoutSettled(page);

  await expect(
    page.locator(`g.type-box[data-element-id="${ENGINE}"] g.field-row-g[data-element-id="${ENGINE}::watts"]`),
  ).toHaveCount(1);
  await expect(
    page.locator(`g.type-box[data-element-id="${ENGINE}"] g.field-row-g[data-element-id="${ENGINE}::rpm"]`),
  ).toHaveCount(1);
  await expect(
    page.locator(`g.type-box[data-element-id="${ENGINE}"] g.field-row-g[data-element-id="${ENGINE}::&mut self"]`),
  ).toHaveCount(1);

  // The watts/rpm argument rows show their type text (`u32`) inline — the
  // signature_arg rows render the type immediately (not hover-gated).
  await expect(
    page.locator(`g.field-row-g[data-element-id="${ENGINE}::watts"] text.field-ty`),
  ).toHaveText('u32');

  assertNoPageErrors(page);
});

test('a `pub use` ghost type renders its header label italic; real types render normal', async ({
  page,
}) => {
  // The ghost (`pub use engine::Engine as Garage`) is its own type box with
  // label "Garage" rendered italic — the identity affordance for re-exports.
  const ghostLabel = page.locator(`g.type-box[data-element-id="${GHOST}"] text.header-label`);
  await expect(ghostLabel).toHaveText('Garage');
  await expect(ghostLabel).toHaveAttribute('font-style', 'italic');

  // Real types render their label in the normal (non-italic) style.
  await expect(
    page.locator(`g.type-box[data-element-id="${APP}"] text.header-label`),
  ).toHaveAttribute('font-style', 'normal');
  await expect(
    page.locator(`g.type-box[data-element-id="${ENGINE}"] text.header-label`),
  ).toHaveAttribute('font-style', 'normal');

  assertNoPageErrors(page);
});
