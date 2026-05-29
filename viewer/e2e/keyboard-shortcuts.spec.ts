// Tier-3 real-browser spec: the viewer's GLOBAL keyboard shortcuts,
// driven against the actual `mind-expander view` server and real
// Chromium. The single `window` keydown handler (src/main.ts:1311) maps
//   f → focus   m → methods   c → code panel   s → reset scale
//   r → reset all   t → tour panel   ? → legend modal   Space → overview
// and early-returns on any meta/ctrl/alt modifier.
//
// Each test's oracle is the CORRECT observable effect of the shortcut —
// a DOM `hidden`/class toggle or a real zoom-transform change — never
// "didn't throw" and never a recorded screenshot (screenshots are the
// on-failure debug artifact configured in playwright.config.ts). Every
// test also asserts no uncaught page errors fired during the
// interactions.

import {
  areKeyhintsChipsVisible,
  clickKeyhintsToggle,
  expandModule,
  expandType,
  expect,
  isCodePanelOpen,
  isLegendOpen,
  pressGlobalKey,
  readZoomScale,
  test,
  waitForLayoutSettled,
  type GlobalKey,
} from './_harness.ts';
import type { Page } from '@playwright/test';

const CRATE = 'e2e_fixture';
const APP = 'e2e_fixture::App';

// f/m/r and Space all need a live render context (`currentCtx` +
// `lastLayout`) before they do anything — those handlers early-return
// with no layout. Expanding the top crate is the minimal state that
// gives us a settled layout to assert transforms/redraws against, and it
// mirrors the geometry spec's setup. A type box is also expanded so
// focus/methods have rows to act on.
async function bootstrapDiagram(page: Page): Promise<void> {
  await expandModule(page, CRATE);
  await expect(page.locator(`g.type-box[data-element-id="${APP}"]`)).toBeVisible();
  await expandType(page, APP);
  await waitForLayoutSettled(page);
}

// A `hint-*` chip lights up (`.active`) while its toggle is engaged. The
// active class is what the user sees, so it is a faithful oracle for the
// f/m/c/t toggles that have no other top-level DOM marker.
async function isChipActive(page: Page, hintId: string): Promise<boolean> {
  return page.evaluate(
    (id) => document.querySelector(`#${id}`)?.classList.contains('active') ?? false,
    hintId,
  );
}

async function isTourPanelOpen(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.tour-panel');
    return el !== null && el.hidden === false;
  });
}

/** Dispatch a `window` keydown with a modifier held, matching the
 *  handler's modifier guard inputs. Used to prove Cmd/Ctrl/Alt+key does
 *  NOT trigger a shortcut. */
async function pressWithModifier(
  page: Page,
  key: string,
  mod: 'metaKey' | 'ctrlKey' | 'altKey',
): Promise<void> {
  await page.evaluate(
    ({ k, m }) => {
      const init: KeyboardEventInit = { key: k, bubbles: true, cancelable: true };
      (init as Record<string, unknown>)[m] = true;
      window.dispatchEvent(new KeyboardEvent('keydown', init));
    },
    { k: key, m: mod },
  );
}

let pageErrors: string[] = [];

test.beforeEach(async ({ page, viewerURL }) => {
  pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(viewerURL);
  await expect(page.locator(`.module-group[data-id="${CRATE}"]`)).toBeVisible();
});

test.afterEach(() => {
  // No interaction in any test may surface an uncaught page error.
  expect(pageErrors, `page errors: ${pageErrors.join('; ')}`).toHaveLength(0);
});

test('`?` opens the legend modal and leaves the chip list untouched', async ({ page }) => {
  // The historical bug was `?` toggling the chip list. The correct
  // contract: `?` opens the legend MODAL and does NOT touch the chips —
  // asserting the chips are unchanged is the load-bearing half.
  const chipsBefore = await areKeyhintsChipsVisible(page);
  expect(await isLegendOpen(page)).toBe(false);

  await pressGlobalKey(page, '?');
  expect(await isLegendOpen(page)).toBe(true);
  expect(await areKeyhintsChipsVisible(page)).toBe(chipsBefore);

  // `?` is a real toggle: a second press closes the modal again.
  await pressGlobalKey(page, '?');
  expect(await isLegendOpen(page)).toBe(false);
  expect(await areKeyhintsChipsVisible(page)).toBe(chipsBefore);
});

test('the chip list is toggled by the corner button, not by any key', async ({ page }) => {
  // The corner button is mouse-only by design. Prove no key flips the
  // chips (so a mistyped key can't hide the user's reminders), then that
  // the mouse toggle does flip them. (`?` is excluded here because it
  // opens the legend modal whose backdrop would block the toggle click;
  // the "`?` leaves chips untouched" invariant is covered separately.)
  const before = await areKeyhintsChipsVisible(page);
  for (const k of ['k', 'h']) {
    await pressGlobalKey(page, k as GlobalKey);
  }
  expect(await areKeyhintsChipsVisible(page)).toBe(before);

  await clickKeyhintsToggle(page);
  expect(await areKeyhintsChipsVisible(page)).toBe(!before);
});

test('`f` toggles focus mode and its chip indicator', async ({ page }) => {
  await bootstrapDiagram(page);
  expect(await isChipActive(page, 'hint-focus')).toBe(false);

  await pressGlobalKey(page, 'f');
  await waitForLayoutSettled(page);
  expect(await isChipActive(page, 'hint-focus')).toBe(true);

  await pressGlobalKey(page, 'f');
  await waitForLayoutSettled(page);
  expect(await isChipActive(page, 'hint-focus')).toBe(false);
});

test('`m` toggles method visibility and its chip indicator', async ({ page }) => {
  await bootstrapDiagram(page);
  // The methods chip is lit by default (methods shown). Pressing `m`
  // hides them and dims the chip; pressing again restores both.
  expect(await isChipActive(page, 'hint-methods')).toBe(true);

  await pressGlobalKey(page, 'm');
  await waitForLayoutSettled(page);
  expect(await isChipActive(page, 'hint-methods')).toBe(false);

  await pressGlobalKey(page, 'm');
  await waitForLayoutSettled(page);
  expect(await isChipActive(page, 'hint-methods')).toBe(true);
});

test('`c` toggles the code panel and its chip indicator', async ({ page }) => {
  await bootstrapDiagram(page);
  expect(await isCodePanelOpen(page)).toBe(false);

  await pressGlobalKey(page, 'c');
  await expect(page.locator('#code-panel')).toBeVisible();
  expect(await isCodePanelOpen(page)).toBe(true);
  expect(await isChipActive(page, 'hint-code')).toBe(true);

  await pressGlobalKey(page, 'c');
  await expect(page.locator('#code-panel')).toBeHidden();
  expect(await isCodePanelOpen(page)).toBe(false);
  expect(await isChipActive(page, 'hint-code')).toBe(false);
});

test('`t` toggles the tour-steps panel and its chip indicator', async ({ page }) => {
  await bootstrapDiagram(page);
  expect(await isTourPanelOpen(page)).toBe(false);

  await pressGlobalKey(page, 't');
  await expect(page.locator('.tour-panel')).toBeVisible();
  expect(await isTourPanelOpen(page)).toBe(true);
  expect(await isChipActive(page, 'hint-tour')).toBe(true);

  await pressGlobalKey(page, 't');
  await expect(page.locator('.tour-panel')).toBeHidden();
  expect(await isTourPanelOpen(page)).toBe(false);
  expect(await isChipActive(page, 'hint-tour')).toBe(false);
});

test('`s` resets the zoom scale to 100%', async ({ page }) => {
  await bootstrapDiagram(page);

  // Drive the real zoom path to a non-identity scale, then assert `s`
  // animates it back to k=1. A Shift+wheel over the canvas is a real
  // zoom gesture: the viewer's wheel filter treats a wheel with Shift
  // held as a zoom in every input mode (mouse or trackpad), so this is
  // deterministic regardless of the detected default mode.
  const canvas = page.locator('#tree');
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const b = box as NonNullable<typeof box>;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.keyboard.down('Shift');
  // Several ticks so the cumulative zoom clearly leaves k=1 even though
  // a single wheel delta is small.
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -120);
  await page.keyboard.up('Shift');

  await expect.poll(async () => (await readZoomScale(page)) !== 1).toBe(true);

  await pressGlobalKey(page, 's');
  // resetScale animates over ANIM_MS; poll until it lands back at 1.
  await expect.poll(async () => Math.abs((await readZoomScale(page)) - 1) < 1e-3).toBe(true);
});

test('`r` resets focus mode (and other engaged toggles)', async ({ page }) => {
  await bootstrapDiagram(page);

  // Engage focus mode, then prove `r` clears it (resetAll resets
  // selections + expansion + focus + methods + zoom). Focus chip is the
  // observable marker we assert against.
  await pressGlobalKey(page, 'f');
  await waitForLayoutSettled(page);
  expect(await isChipActive(page, 'hint-focus')).toBe(true);

  await pressGlobalKey(page, 'r');
  await waitForLayoutSettled(page);
  expect(await isChipActive(page, 'hint-focus')).toBe(false);
});

test('`Space` toggles fit-all overview and back', async ({ page }) => {
  await bootstrapDiagram(page);
  expect((await readZoomScale(page))).toBeCloseTo(1, 3);

  // Enter overview: the viewport jumps to the scale-to-fit transform
  // (k != 1 — for this small fixture the content is fitted by zooming
  // IN, clamped to the max scale). The overview transition is an
  // animated zoom, NOT a layout reflow, so poll the zoom scale rather
  // than waiting on box geometry.
  await pressGlobalKey(page, 'Space');
  await expect.poll(async () => Math.abs((await readZoomScale(page)) - 1) > 0.01).toBe(true);

  // Exit overview: returns to k=1.
  await pressGlobalKey(page, 'Space');
  await expect.poll(async () => Math.abs((await readZoomScale(page)) - 1) < 1e-3).toBe(true);
});

test('`Space` auto-repeat does not double-toggle the overview', async ({ page }) => {
  await bootstrapDiagram(page);
  expect((await readZoomScale(page))).toBeCloseTo(1, 3);

  // A real key press fires one keydown then auto-repeat keydowns with
  // e.repeat=true. The handler ignores the repeats, so a held Space
  // performs exactly ONE toggle (into overview), not a flapping cycle.
  await pressGlobalKey(page, 'Space');
  await expect.poll(async () => Math.abs((await readZoomScale(page)) - 1) > 0.01).toBe(true);
  await page.evaluate(() => {
    for (let i = 0; i < 3; i++) {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { code: 'Space', key: ' ', repeat: true, bubbles: true, cancelable: true }),
      );
    }
  });
  // Give any (erroneous) repeat-driven toggle time to animate, then
  // confirm we are STILL in overview — the repeats were ignored, not
  // toggled back to k=1.
  await expect.poll(async () => Math.abs((await readZoomScale(page)) - 1) > 0.01).toBe(true);
});

test('modifier+key chords do NOT trigger any global shortcut', async ({ page }) => {
  await bootstrapDiagram(page);

  // The handler early-returns on meta/ctrl/alt so the browser keeps its
  // own Cmd/Ctrl/Alt chords (save, reload, find…). Engaging every
  // single-letter chord must leave all observable state untouched.
  const codeBefore = await isCodePanelOpen(page);
  const legendBefore = await isLegendOpen(page);
  const tourBefore = await isTourPanelOpen(page);
  const focusBefore = await isChipActive(page, 'hint-focus');
  const methodsBefore = await isChipActive(page, 'hint-methods');
  const scaleBefore = await readZoomScale(page);

  for (const mod of ['metaKey', 'ctrlKey', 'altKey'] as const) {
    for (const key of ['f', 'm', 'c', 's', 'r', 't', '?']) {
      await pressWithModifier(page, key, mod);
    }
  }
  await waitForLayoutSettled(page);

  expect(await isCodePanelOpen(page)).toBe(codeBefore);
  expect(await isLegendOpen(page)).toBe(legendBefore);
  expect(await isTourPanelOpen(page)).toBe(tourBefore);
  expect(await isChipActive(page, 'hint-focus')).toBe(focusBefore);
  expect(await isChipActive(page, 'hint-methods')).toBe(methodsBefore);
  expect(await readZoomScale(page)).toBeCloseTo(scaleBefore, 3);
});
