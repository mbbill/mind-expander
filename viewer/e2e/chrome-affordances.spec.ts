// Tier-3 real-browser spec: the viewer's non-diagram "chrome" affordances —
// the legend/shortcuts modal, the keyhints chip row + its toggle, and the
// minimap collapse/expand toggle. Driven against the real `mind-expander
// view` server (via the shared harness) and real Chromium.
//
// These are small affordances, so each test's oracle is the CORRECT
// observable state change the shipped handler produces — the real `hidden`
// attribute the handler toggles, the sessionStorage key it persists, and the
// computed visibility after a click or key. Never a screenshot (that is only
// the on-failure debug artifact from playwright.config.ts), never
// "didn't throw".
//
// Verified against index.html + src/main.ts:
//   • `?` key  → toggles #legend-modal (main.ts: keydown '?' → toggleKeyhints,
//      which is bound to the legend modal's setOpen(!isOpen)).
//   • #hint-legend chip row click → also toggles the legend modal.
//   • .legend-modal-close / .legend-modal-backdrop click / Esc → close it.
//   • .keyhints-toggle click → flips #keyhints-chips hidden; persists
//      'mind-expander.keyhints.chips' ('1'/'0'); default (no stored pref) open.
//   • .minimap-toggle click → flips #minimap-body hidden; persists
//      'mind-expander.minimap.expanded'.

import {
  areKeyhintsChipsVisible,
  clickKeyhintsToggle,
  clickMinimapToggle,
  expect,
  isLegendOpen,
  isMinimapBodyVisible,
  pressGlobalKey,
  test,
} from './_harness.ts';

const CRATE = 'e2e_fixture';

// Collect uncaught page errors per test; asserted at the end of each so a
// thrown handler (not just a wrong state) also fails the spec.
test.beforeEach(async ({ page, viewerURL }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  (page as unknown as { __errors: string[] }).__errors = errors;
  await page.goto(viewerURL);
  // Wait for the app to mount: the left module tree and the chrome handlers
  // (which run in the same init pass) are present once the root crate row is.
  await expect(page.locator(`.module-group[data-id="${CRATE}"]`)).toBeVisible();
});

function pageErrors(page: import('@playwright/test').Page): string[] {
  return (page as unknown as { __errors: string[] }).__errors;
}

// ── Legend modal ─────────────────────────────────────────────────────

test('legend modal opens on `?` and closes on a second `?`', async ({ page }) => {
  // Reference-only modal: lives in the DOM hidden, no sessionStorage. Starts closed.
  expect(await isLegendOpen(page)).toBe(false);

  await pressGlobalKey(page, '?');
  await expect.poll(() => isLegendOpen(page)).toBe(true);

  // The `?` key is a true toggle, so a second press closes it again.
  await pressGlobalKey(page, '?');
  await expect.poll(() => isLegendOpen(page)).toBe(false);

  expect(pageErrors(page), pageErrors(page).join('; ')).toHaveLength(0);
});

test('legend modal opens when the `?` chip row is clicked', async ({ page }) => {
  // The #hint-legend chip lives inside the keyhints chip row, which is open by
  // default, so the row is a real mouse affordance mirroring the `?` key.
  expect(await isLegendOpen(page)).toBe(false);

  await page.locator('#hint-legend').click();
  await expect.poll(() => isLegendOpen(page)).toBe(true);

  expect(pageErrors(page), pageErrors(page).join('; ')).toHaveLength(0);
});

test('legend modal closes via its close button', async ({ page }) => {
  await pressGlobalKey(page, '?');
  await expect.poll(() => isLegendOpen(page)).toBe(true);

  await page.locator('.legend-modal-close').click();
  await expect.poll(() => isLegendOpen(page)).toBe(false);

  expect(pageErrors(page), pageErrors(page).join('; ')).toHaveLength(0);
});

test('legend modal closes when its backdrop is clicked', async ({ page }) => {
  await pressGlobalKey(page, '?');
  await expect.poll(() => isLegendOpen(page)).toBe(true);

  // The backdrop sits behind the card; click it directly (force past the
  // card's pointer region) — clicking the backdrop is the documented dismiss.
  await page.locator('.legend-modal-backdrop').click({ position: { x: 2, y: 2 } });
  await expect.poll(() => isLegendOpen(page)).toBe(false);

  expect(pageErrors(page), pageErrors(page).join('; ')).toHaveLength(0);
});

test('legend modal closes on Esc', async ({ page }) => {
  await pressGlobalKey(page, '?');
  await expect.poll(() => isLegendOpen(page)).toBe(true);

  // Capture-phase Escape handler closes the modal only when it is open.
  await page.keyboard.press('Escape');
  await expect.poll(() => isLegendOpen(page)).toBe(false);

  expect(pageErrors(page), pageErrors(page).join('; ')).toHaveLength(0);
});

// ── Keyhints chips toggle + persistence ──────────────────────────────

test('keyhints chips are shown by default and the toggle hides/shows them', async ({ page }) => {
  // First visit with no stored preference: chips start visible (the handler
  // defaults `chipsOpen` to true when sessionStorage is empty).
  expect(await areKeyhintsChipsVisible(page)).toBe(true);
  // Computed display, not just the attribute: the [hidden] CSS override must
  // actually win over `.chips { display: flex }` so visible == laid out.
  expect(await page.locator('#keyhints-chips').isVisible()).toBe(true);

  await clickKeyhintsToggle(page);
  await expect.poll(() => areKeyhintsChipsVisible(page)).toBe(false);
  await expect(page.locator('#keyhints-chips')).toBeHidden();

  // Toggle is symmetric: a second click shows them again.
  await clickKeyhintsToggle(page);
  await expect.poll(() => areKeyhintsChipsVisible(page)).toBe(true);
  await expect(page.locator('#keyhints-chips')).toBeVisible();

  expect(pageErrors(page), pageErrors(page).join('; ')).toHaveLength(0);
});

test('keyhints chip visibility persists across a reload', async ({ page }) => {
  // Collapse, then reload the SAME tab: sessionStorage('mind-expander.keyhints.chips')
  // should be '0' and the chips should come back collapsed (stored pref honored).
  await clickKeyhintsToggle(page);
  await expect.poll(() => areKeyhintsChipsVisible(page)).toBe(false);
  expect(await page.evaluate(() => sessionStorage.getItem('mind-expander.keyhints.chips'))).toBe(
    '0',
  );

  await page.reload();
  await expect(page.locator(`.module-group[data-id="${CRATE}"]`)).toBeVisible();
  expect(await areKeyhintsChipsVisible(page)).toBe(false);
  expect(await page.evaluate(() => sessionStorage.getItem('mind-expander.keyhints.chips'))).toBe(
    '0',
  );

  // Re-expand and confirm the '1' preference also survives a reload.
  await clickKeyhintsToggle(page);
  await expect.poll(() => areKeyhintsChipsVisible(page)).toBe(true);
  await page.reload();
  await expect(page.locator(`.module-group[data-id="${CRATE}"]`)).toBeVisible();
  expect(await areKeyhintsChipsVisible(page)).toBe(true);

  expect(pageErrors(page), pageErrors(page).join('; ')).toHaveLength(0);
});

// ── Minimap collapse/expand ──────────────────────────────────────────

test('minimap toggle hides and shows the minimap body', async ({ page }) => {
  // Default expanded (no stored pref ⇒ `!== '0'` is true). The body carries
  // the `hidden` attribute; the toggle flips it.
  expect(await isMinimapBodyVisible(page)).toBe(true);

  await clickMinimapToggle(page);
  await expect.poll(() => isMinimapBodyVisible(page)).toBe(false);
  await expect(page.locator('#minimap-body')).toBeHidden();

  await clickMinimapToggle(page);
  await expect.poll(() => isMinimapBodyVisible(page)).toBe(true);
  await expect(page.locator('#minimap-body')).toBeVisible();

  expect(pageErrors(page), pageErrors(page).join('; ')).toHaveLength(0);
});

test('minimap toggle flips its caret and aria-expanded, and persists', async ({ page }) => {
  const toggle = page.locator('.minimap-toggle');
  const caret = page.locator('.minimap-caret');

  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(caret).toHaveText('▾');

  await clickMinimapToggle(page);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(caret).toHaveText('▸');
  expect(await page.evaluate(() => sessionStorage.getItem('mind-expander.minimap.expanded'))).toBe(
    '0',
  );

  // Collapsed state survives a reload within the same tab.
  await page.reload();
  await expect(page.locator(`.module-group[data-id="${CRATE}"]`)).toBeVisible();
  expect(await isMinimapBodyVisible(page)).toBe(false);
  await expect(page.locator('.minimap-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.minimap-caret')).toHaveText('▸');

  expect(pageErrors(page), pageErrors(page).join('; ')).toHaveLength(0);
});
