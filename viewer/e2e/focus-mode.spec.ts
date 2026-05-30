// Tier-3 real-browser spec for GROUP G — Focus mode (F) + resetAll (R),
// driven against a real `mind-expander view` server + Chromium.
//
// The oracle for every test is a CORRECT observable result — DOM membership,
// the live SVG transform, native scroll offset — the user would actually
// see, never "didn't throw" and never a recorded screenshot.
//
// WHY a dedicated MULTI-LEVEL fixture (`e2e/focus-fixture`): focus mode is a
// layout-input FILTER (analysis/visibility + layout/geometry), and resetAll
// reverses selection + expansion + focus + methods + zoom/pan in one stroke.
// Exercising both needs a tree with (a) real depth on the relevance path
// (`engine::core::Engine` under `engine` under the crate) and (b) real
// OFF-path branches to drop (`engine::aux::Coolant`, the whole `unrelated`
// branch). The crate:
//   App (root) owns engine::core::Engine, which owns engine::core::Piston;
//   engine::aux::Coolant and unrelated::widgets::Widget are isolated.
// The shared `_harness.ts` server fixture is hard-wired to the geometry
// fixture, so this spec spawns its own server against the focus fixture
// (same `ready`-line protocol) while reusing the harness DOM helpers. This
// mirrors `selection-focus.spec.ts` but the focus drop/restore here is over
// a DEEPER tree (it asserts an intermediate `engine::aux` sibling AND a
// separate top-level branch drop, plus resetAll — none covered there).

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import {
  canvasScrollTop,
  expect,
  pressGlobalKey,
  readZoomTransform,
  selectedTypeId,
  test,
  typeBoxIds,
  typeBoxRect,
  waitForLayoutSettled,
} from './_harness.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = process.env.MIND_EXPANDER_BIN ?? path.resolve(HERE, '../../target/debug/mind-expander');
const WORKSPACE = path.resolve(HERE, 'focus-fixture');
const READY_TIMEOUT_MS = 30_000;

const CRATE = 'focus_fixture';
const APP = `${CRATE}::App`;
const ENGINE = `${CRATE}::engine::core::Engine`;
const PISTON = `${CRATE}::engine::core::Piston`;
const COOLANT = `${CRATE}::engine::aux::Coolant`;
const WIDGET = `${CRATE}::unrelated::widgets::Widget`;

// Module band ids.
const ENGINE_MOD = `${CRATE}::engine`;
const ENGINE_CORE = `${CRATE}::engine::core`;
const ENGINE_AUX = `${CRATE}::engine::aux`;
const UNRELATED = `${CRATE}::unrelated`;
const UNRELATED_WIDGETS = `${CRATE}::unrelated::widgets`;

/** Spawn `view <focus-fixture> --port 0` and resolve the bound URL from the
 *  server's `ready` JSON line — same contract as the shared harness. */
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

/** Dispatch a real Cmd-modified `click` — the diagram's d3 handlers branch
 *  on `event.metaKey` to push `(id, kind)` into the diagram selection (and
 *  open the code panel), so this drives the real selection path. */
async function cmdClick(page: Page, selector: string): Promise<void> {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) throw new Error(`cmdClick: no element for ${sel}`);
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
  }, selector);
}

/** Expand every module + the core/Engine type so all four type boxes (App,
 *  Engine + rows, Piston, Coolant, Widget) render across the multi-level
 *  tree. Returns once geometry settles. */
async function expandFixture(page: Page): Promise<void> {
  await expandModule(page, CRATE);
  await expandModule(page, ENGINE_MOD);
  await expandModule(page, ENGINE_CORE);
  await expandModule(page, ENGINE_AUX);
  await expandModule(page, UNRELATED);
  await expandModule(page, UNRELATED_WIDGETS);
  await expect(page.locator(`g.type-box[data-element-id="${ENGINE}"]`)).toBeVisible();
  await expect(page.locator(`g.type-box[data-element-id="${COOLANT}"]`)).toBeVisible();
  await expect(page.locator(`g.type-box[data-element-id="${WIDGET}"]`)).toBeVisible();
  await expandType(page, ENGINE);
  // The piston field row emits the ownership arrow once Engine is open.
  await expect(page.locator(`g.arrow[data-arrow-to="${PISTON}"]`)).toHaveCount(1);
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

test('F engages focus and filters a multi-level tree to the relevance subtree; F again disengages', async ({
  page,
}) => {
  // Select Engine so focus has a relevance anchor. App (owner) + Piston
  // (owned) + the engine::core ancestors are relevant; engine::aux and the
  // whole unrelated branch are OFF-path.
  await cmdClick(page, `g.type-box[data-element-id="${ENGINE}"] .expand-hit`);
  await expect(page.locator(`g.type-box[data-element-id="${ENGINE}"].selected`)).toHaveCount(1);

  const before = await typeBoxIds(page);
  expect(before).toContain(ENGINE);
  expect(before).toContain(COOLANT);
  expect(before).toContain(WIDGET);

  // Engage focus (real `f` window keydown handler).
  await pressGlobalKey(page, 'f');
  // Focus is a layout-input filter: off-path boxes are removed from the DOM
  // entirely (not dimmed). The off-path SIBLING submodule (engine::aux) AND
  // the separate top-level branch (unrelated) both drop.
  await expect(page.locator(`g.type-box[data-element-id="${COOLANT}"]`)).toHaveCount(0);
  await expect(page.locator(`g.type-box[data-element-id="${WIDGET}"]`)).toHaveCount(0);
  await waitForLayoutSettled(page);

  const after = await typeBoxIds(page);
  // Off-path types gone; relevant subtree fully kept.
  expect(after).not.toContain(COOLANT);
  expect(after).not.toContain(WIDGET);
  expect(after).toContain(ENGINE);
  expect(after).toContain(APP);
  expect(after).toContain(PISTON);

  // Disengage: F again restores every dropped box — ViewState was untouched,
  // so the filter is fully reversible.
  await pressGlobalKey(page, 'f');
  await expect(page.locator(`g.type-box[data-element-id="${COOLANT}"]`)).toHaveCount(1);
  await expect(page.locator(`g.type-box[data-element-id="${WIDGET}"]`)).toHaveCount(1);
  await waitForLayoutSettled(page);
  const restored = await typeBoxIds(page);
  expect(restored).toContain(COOLANT);
  expect(restored).toContain(WIDGET);
});

test('focus anchor tier 1: an on-screen selected box keeps its screen position across the focus relayout', async ({
  page,
}) => {
  // toggleFocus tier 1: when the most-recent selection is ON-screen, focus
  // pins it — after the relayout drops the off-path bands above/around it,
  // the viewport is translated so the anchored box stays at the same
  // screen-y the user was looking at. Select Engine (on screen at load).
  await cmdClick(page, `g.type-box[data-element-id="${ENGINE}"] .expand-hit`);
  await expect(page.locator(`g.type-box[data-element-id="${ENGINE}"].selected`)).toHaveCount(1);
  expect(await selectedTypeId(page)).toBe(ENGINE);

  const beforeRect = await typeBoxRect(page, ENGINE);
  expect(beforeRect, 'Engine on screen before focus').not.toBeNull();

  await pressGlobalKey(page, 'f');
  // The unrelated branch drops, which would normally shift everything below
  // it upward; the tier-1 anchor compensates so the selected box's screen-y
  // is preserved (within sub-pixel slack).
  await expect(page.locator(`g.type-box[data-element-id="${WIDGET}"]`)).toHaveCount(0);
  await waitForLayoutSettled(page);

  const afterRect = await typeBoxRect(page, ENGINE);
  expect(afterRect, 'Engine still on screen after focus').not.toBeNull();
  const dy = Math.abs(
    (afterRect as NonNullable<typeof afterRect>).y -
      (beforeRect as NonNullable<typeof beforeRect>).y,
  );
  // Anchored: the selected box did not jump (allow a few px for the
  // band-height rounding the relayout introduces).
  expect(dy, `anchor kept Engine in place (Δy=${dy})`).toBeLessThan(6);
});

test('R (resetAll) clears selection + arrow visibility + expansion + focus and redraws', async ({
  page,
}) => {
  // Build up a rich state: select Engine, reveal its ownership arrow (Engine
  // is expanded so the piston arrow is shown), engage focus.
  await cmdClick(page, `g.type-box[data-element-id="${ENGINE}"] .expand-hit`);
  await expect(page.locator(`g.type-box[data-element-id="${ENGINE}"].selected`)).toHaveCount(1);
  await pressGlobalKey(page, 'f');
  await expect(page.locator(`g.type-box[data-element-id="${WIDGET}"]`)).toHaveCount(0);
  await waitForLayoutSettled(page);
  // Focus mode indicator reflects the engaged mode.
  expect(await selectedTypeId(page)).toBe(ENGINE);

  // R → resetAll: selection cleared, focus off (so dropped boxes return),
  // expansion reset to the crate root only (deep modules collapse, so deep
  // type boxes disappear), every arrow hidden, redraw applied. Type boxes
  // exit via a fade-then-remove tween, so the post-reset DOM is asserted with
  // auto-retrying locators rather than a single snapshot.
  await pressGlobalKey(page, 'r');

  // Focus disengaged AND expansion reset to the root: the deep type boxes
  // (Engine/Piston/Coolant/Widget) are all removed because their modules are
  // no longer expanded — root-only is the boot default resetAll restores.
  await expect(page.locator(`g.type-box[data-element-id="${ENGINE}"]`)).toHaveCount(0);
  await expect(page.locator(`g.type-box[data-element-id="${PISTON}"]`)).toHaveCount(0);
  await expect(page.locator(`g.type-box[data-element-id="${COOLANT}"]`)).toHaveCount(0);
  await expect(page.locator(`g.type-box[data-element-id="${WIDGET}"]`)).toHaveCount(0);

  // Selection cleared: no type box carries `.selected` after the reset
  // relayout (the previously-selected Engine box is gone entirely).
  await expect(page.locator('g.type-box.selected')).toHaveCount(0);
  expect(await selectedTypeId(page)).toBeNull();

  // No arrows remain (all ownership/field arrows hidden on reset).
  await expect(page.locator('g.arrow')).toHaveCount(0);

  // resetAll restores the BOOT default: only the workspace root is
  // expanded, so the crate band renders COLLAPSED (its child modules are not
  // shown) — exactly the state at first load. The crate band being present
  // and collapsed proves the diagram re-rendered, not blanked.
  const crateBand = page.locator(`.module-group[data-id="${CRATE}"]`);
  await expect(crateBand).toBeVisible();
  await expect(page.locator(`.module-group[data-id="${ENGINE_MOD}"]`)).toHaveCount(0);
  await expect(page.locator(`.module-group[data-id="${UNRELATED}"]`)).toHaveCount(0);

  // Re-expanding works after reset — proves draw() ran and state is clean
  // (focus is OFF, so re-expanded off-path modules render their boxes again,
  // not filtered out). Walk back down the tree to a deep off-path type box.
  await expandModule(page, CRATE);
  await expect(page.locator(`.module-group[data-id="${ENGINE_MOD}"]`)).toBeVisible();
  await expandModule(page, ENGINE_MOD);
  await expect(page.locator(`.module-group[data-id="${ENGINE_AUX}"]`)).toBeVisible();
  await expandModule(page, ENGINE_AUX);
  await expect(page.locator(`g.type-box[data-element-id="${COOLANT}"]`)).toBeVisible();
});

test('R (resetAll) resets the zoom/pan transform to identity', async ({ page }) => {
  // Pan the viewport horizontally with a right-button drag so the live SVG
  // transform's translate term is non-zero (vertical pan is native scroll,
  // tested separately below). Right-drag is main.ts's pan gesture.
  const box = await page.locator('#canvas-scroll').boundingBox();
  expect(box).not.toBeNull();
  const b = box as NonNullable<typeof box>;
  const sx = b.x + b.width / 2;
  const sy = b.y + b.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down({ button: 'right' });
  for (let i = 1; i <= 20; i++) await page.mouse.move(sx - (120 * i) / 20, sy);
  await page.mouse.up({ button: 'right' });
  await waitForLayoutSettled(page);

  const panned = await readZoomTransform(page);
  expect(Math.abs(panned.x), `panned tx non-zero (was ${panned.x})`).toBeGreaterThan(5);

  // R → resetAll → layers.resetTransform(true): the transform animates back
  // to identity (x=0, k=1). Poll the live attribute through the tween.
  await pressGlobalKey(page, 'r');
  await expect
    .poll(async () => Math.abs((await readZoomTransform(page)).x) < 1, {
      message: 'resetAll restored tx to 0',
      timeout: 4000,
    })
    .toBe(true);
  expect((await readZoomTransform(page)).k).toBeCloseTo(1, 2);
});

test('R (resetAll) restores the vertical native-scroll pan to its identity rest position', async ({
  page,
}) => {
  // Vertical pan is delivered through native scrollTop (NOT the SVG
  // transform). The zoom layer maps the identity transform (ty=0) to a
  // NON-zero rest scrollTop = TOP_PADDING (see zoom.ts: scrollTop =
  // TOP_PADDING - ty), so the correct oracle is "returns to the boot rest
  // value", not "scrollTop===0". Capture that rest value at load, pan away,
  // then R must bring it back.
  const rest = await canvasScrollTop(page);

  await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('#canvas-scroll');
    if (el !== null) el.scrollTop = el.scrollTop + 200;
  });
  expect(Math.abs((await canvasScrollTop(page)) - rest)).toBeGreaterThan(50);

  // R → resetAll → resetTransform(true): the transform animates to identity,
  // which the scroll mapping projects back to the rest scrollTop.
  await pressGlobalKey(page, 'r');
  await expect
    .poll(async () => Math.abs((await canvasScrollTop(page)) - rest), {
      message: 'resetAll restored scrollTop to its identity rest position',
      timeout: 4000,
    })
    .toBeLessThan(3);
});
