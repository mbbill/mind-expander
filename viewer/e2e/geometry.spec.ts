// Tier-3 reference spec: real-browser geometry invariants for the
// diagram, driven against the actual `mind-expander view` server.
//
// The oracle here is INVARIANTS, not a recorded screenshot: each
// assertion is a property that must hold for any correct render, so it
// survives intentional layout changes and is font/OS-independent. A
// screenshot is captured only on failure (playwright.config.ts) as a
// human-reviewed debugging artifact.
//
// Fixture `e2e/fixture-workspace`: App owns Engine (in `core`), Engine
// owns Cylinder.

import {
  arrowEndpoints,
  expandModule,
  expandType,
  expect,
  pointInRect,
  test,
  typeBoxIds,
  typeBoxRect,
  waitForLayoutSettled,
} from './_harness.ts';

const CRATE = 'e2e_fixture';
const APP = 'e2e_fixture::App';
const ENGINE = 'e2e_fixture::core::Engine';
const CYLINDER = 'e2e_fixture::core::Cylinder';

// Expand the whole fixture so all three type boxes render, then expand
// App so its `engine` field row emits the ownership arrow to Engine.
async function expandAll(page: import('@playwright/test').Page): Promise<void> {
  await expandModule(page, CRATE);
  await expandModule(page, `${CRATE}::core`);
  await expect(page.locator(`g.type-box[data-element-id="${ENGINE}"]`)).toBeVisible();
  await expandType(page, APP);
  await expect(page.locator('g.arrow')).toHaveCount(1);
  // Boxes + arrow tween to their new positions after the expand; read
  // geometry only once everything has come to rest.
  await waitForLayoutSettled(page);
}

test.beforeEach(async ({ page, viewerURL }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(viewerURL);
  await expect(page.locator(`.module-group[data-id="${CRATE}"]`)).toBeVisible();
  await expandAll(page);
  // No uncaught page errors during load + interaction.
  expect(errors, `page errors: ${errors.join('; ')}`).toHaveLength(0);
});

test('every type box renders with positive real-font size', async ({ page }) => {
  const ids = await typeBoxIds(page);
  expect(ids.sort()).toEqual([APP, CYLINDER, ENGINE]);
  for (const id of ids) {
    const rect = await typeBoxRect(page, id);
    expect(rect, `rect for ${id}`).not.toBeNull();
    // A zero-area box IS the "type box not showing" bug — and because
    // this is a real browser, the size reflects the real system font,
    // not the test's fixed-width fallback.
    expect(rect?.width, `${id} width`).toBeGreaterThan(0);
    expect(rect?.height, `${id} height`).toBeGreaterThan(0);
  }
});

test('the ownership arrow attaches to both its source and target boxes', async ({ page }) => {
  const arrows = await arrowEndpoints(page);
  expect(arrows).toHaveLength(1);
  const [arrow] = arrows;
  // The arrow is App.engine → Engine.
  expect(arrow.from).toBe(`${APP}::engine`);
  expect(arrow.to).toBe(ENGINE);

  const appRect = await typeBoxRect(page, APP);
  const engineRect = await typeBoxRect(page, ENGINE);
  expect(appRect && engineRect).toBeTruthy();

  // Start anchors within the source (owner) box; end anchors within the
  // target box. A floating endpoint = the "arrow starts/ends in the
  // wrong place" bug, now verified against real rendered geometry.
  const MARGIN = 6; // px of slack for stroke width / port offset
  expect(
    pointInRect(arrow.start, appRect as NonNullable<typeof appRect>, MARGIN),
    `arrow start ${JSON.stringify(arrow.start)} within App box ${JSON.stringify(appRect)}`,
  ).toBe(true);
  expect(
    pointInRect(arrow.end, engineRect as NonNullable<typeof engineRect>, MARGIN),
    `arrow end ${JSON.stringify(arrow.end)} within Engine box ${JSON.stringify(engineRect)}`,
  ).toBe(true);

  // And the end specifically lands on a vertical SIDE of the target box.
  const er = engineRect as NonNullable<typeof engineRect>;
  const onLeft = Math.abs(arrow.end.x - er.x) <= MARGIN;
  const onRight = Math.abs(arrow.end.x - (er.x + er.width)) <= MARGIN;
  expect(onLeft || onRight, `arrow end x=${arrow.end.x} on a side of Engine box`).toBe(true);
});
