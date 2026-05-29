// Tier-3 real-browser spec: the viewport transform (zoom / pan / scale)
// behaviors, driven against the actual `mind-expander view` server and
// real Chromium.
//
// The oracle for every kept test is the CORRECT observable behavior —
// the viewport transform/scale the renderer projects through (read via
// readZoomTransform / readZoomScale off the zoom layer's live
// `transform` attribute) plus real rendered box geometry — never "didn't
// throw" and never a recorded screenshot (screenshots are only the
// on-failure debug artifact configured in playwright.config.ts).
//
// What we assert (per the area brief):
//   • Space toggles to a fit-all overview (every type box fully on
//     screen, scale ≠ 1) and back to 100% (k = 1).
//   • "s" resets the scale to 100% after a zoom.
//   • shift+wheel zooms about the cursor — the data point under the
//     pointer stays put. (Shift+wheel zooms in BOTH input modes, so the
//     test does not depend on the platform-detected mouse/trackpad
//     default.)
//   • pan cannot fling all content off-screen: the horizontal pan clamp
//     pins a content edge to the opposite viewport edge
//     (tx ∈ [-contentWPx, w]); a harder drag converges to the SAME tx.
//
// Fixture `e2e/fixture-workspace`: App owns Engine (in `core`), Engine
// owns Cylinder.

import {
  type GlobalKey,
  expandModule,
  expandType,
  expect,
  pressGlobalKey,
  readZoomScale,
  readZoomTransform,
  test,
  typeBoxIds,
  typeBoxRect,
  waitForLayoutSettled,
} from './_harness.ts';
import type { Page } from '@playwright/test';

const CRATE = 'e2e_fixture';
const APP = 'e2e_fixture::App';
const ENGINE = 'e2e_fixture::core::Engine';

// Expand the whole fixture so all three type boxes render — enough
// content for zoom/pan to act on. Geometry settles (tween) before any
// transform read.
async function expandAll(page: Page): Promise<void> {
  await expandModule(page, CRATE);
  await expandModule(page, `${CRATE}::core`);
  await expect(page.locator(`g.type-box[data-element-id="${ENGINE}"]`)).toBeVisible();
  await expandType(page, APP);
  await expect(page.locator('g.arrow')).toHaveCount(1);
  await waitForLayoutSettled(page);
}

/** Block until the zoom layer's `transform` attribute stops changing.
 *  Animated zoom/pan tweens (resetScale, the Space overview toggle) drive
 *  the SCALE over ANIM_MS; a pure-scale tween can momentarily leave the
 *  type-box rects quiet, so waitForLayoutSettled (which watches rects) can
 *  return mid-transition. This polls the actual transform attribute the
 *  reader uses, so transform assertions see the settled value — no
 *  animation-duration magic number. */
async function settleZoom(page: Page, { quietMs = 200, timeout = 5000 } = {}): Promise<void> {
  await page.waitForFunction(
    (quiet) => {
      const layer = document.querySelector('#tree g.zoom-layer');
      const attr = layer?.getAttribute('transform') ?? '';
      const w = window as unknown as { __zpSnap?: string; __zpSince?: number };
      if (w.__zpSnap === attr) {
        w.__zpSince = w.__zpSince ?? performance.now();
        return performance.now() - w.__zpSince >= quiet;
      }
      w.__zpSnap = attr;
      w.__zpSince = performance.now();
      return false;
    },
    quietMs,
    { timeout, polling: 50 },
  );
}

/** Viewport (scroll-container) size in CSS px — the dimensions the zoom
 *  math treats as the viewport (the SVG is sized to content, so its size
 *  is not the viewport). */
async function viewportSize(page: Page): Promise<{ w: number; h: number }> {
  return page.evaluate(() => {
    const cs = document.querySelector('#canvas-scroll') as HTMLElement;
    return { w: cs.clientWidth, h: cs.clientHeight };
  });
}

/** Right-button drag across the canvas, distributing (dx, dy) px over
 *  `steps` moves. Right-button drag is main.ts's viewport-pan gesture;
 *  the pan negates the gesture delta, so dragging the mouse RIGHT moves
 *  the content LEFT (tx decreases) and vice-versa. */
async function rightDrag(page: Page, dx: number, dy: number, steps = 30): Promise<void> {
  const box = await page.locator('#canvas-scroll').boundingBox();
  if (box === null) throw new Error('#canvas-scroll has no box');
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down({ button: 'right' });
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(startX + (dx * i) / steps, startY + (dy * i) / steps);
  }
  await page.mouse.up({ button: 'right' });
  await waitForLayoutSettled(page);
}

/** Dispatch `n` shift+wheel steps of `deltaY` at viewport-screen point
 *  (clientX, clientY). Shift+wheel is filtered to ZOOM in both mouse and
 *  trackpad mode, so this exercises cursor-anchored zoom regardless of
 *  the platform-detected default input mode. */
async function shiftWheelZoom(
  page: Page,
  clientX: number,
  clientY: number,
  deltaY: number,
  n: number,
): Promise<void> {
  await page.evaluate(
    ({ clientX, clientY, deltaY, n }) => {
      const cs = document.querySelector('#canvas-scroll') as HTMLElement;
      for (let i = 0; i < n; i++) {
        cs.dispatchEvent(
          new WheelEvent('wheel', {
            deltaY,
            clientX,
            clientY,
            shiftKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      }
    },
    { clientX, clientY, deltaY, n },
  );
  await settleZoom(page);
}

let pageErrors: string[];

test.beforeEach(async ({ page, viewerURL }) => {
  pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(viewerURL);
  await expect(page.locator(`.module-group[data-id="${CRATE}"]`)).toBeVisible();
  await expandAll(page);
});

test.afterEach(() => {
  // No uncaught page errors during load + the interaction under test.
  expect(pageErrors, `page errors: ${pageErrors.join('; ')}`).toHaveLength(0);
});

test('Space toggles to a fit-all overview and back to 100%', async ({ page }) => {
  const { w, h } = await viewportSize(page);
  expect(await readZoomTransform(page), 'load view is identity').toMatchObject({ x: 0, k: 1 });

  // Move the pointer inside the canvas so the second Space press has a
  // cursor anchor (handleSpace reads the live cursor position).
  await page.mouse.move(w / 2, h / 2);

  // First Space → fit-all overview. Scale leaves 100% (handleSpace picks
  // fit = min(w/W, h/H)*0.95).
  await pressGlobalKey(page, 'Space' satisfies GlobalKey);
  await settleZoom(page);
  const kOverview = await readZoomScale(page);
  expect(kOverview, 'overview scale differs from 100%').not.toBeCloseTo(1, 2);

  // The defining property of "fit-all": every type box is fully within
  // the viewport — that is what the overview is FOR, and it's
  // font/OS-independent.
  const ids = await typeBoxIds(page);
  expect(ids.length).toBeGreaterThan(0);
  for (const id of ids) {
    const r = await typeBoxRect(page, id);
    expect(r, `rect for ${id}`).not.toBeNull();
    const rect = r as NonNullable<typeof r>;
    const M = 1; // px slack for sub-pixel rounding
    expect(rect.x, `${id} left in view`).toBeGreaterThanOrEqual(-M);
    expect(rect.y, `${id} top in view`).toBeGreaterThanOrEqual(-M);
    expect(rect.x + rect.width, `${id} right in view`).toBeLessThanOrEqual(w + M);
    expect(rect.y + rect.height, `${id} bottom in view`).toBeLessThanOrEqual(h + M);
  }

  // Second Space → exit overview back to exactly 100%.
  await pressGlobalKey(page, 'Space' satisfies GlobalKey);
  await settleZoom(page);
  expect(await readZoomScale(page), 'second Space restores 100%').toBeCloseTo(1, 2);
});

test('"s" resets the scale to 100% after a zoom', async ({ page }) => {
  // Zoom in first so k ≠ 1; otherwise the reset is a no-op and the test
  // would pass trivially.
  const box = await typeBoxRect(page, APP);
  expect(box).not.toBeNull();
  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;
  await shiftWheelZoom(page, cx, cy, -100, 4);
  expect(await readZoomScale(page), 'scale rose above 100% from the zoom').toBeGreaterThan(1.01);

  // The real `s` global shortcut → resetScale(1), animated.
  await pressGlobalKey(page, 's' satisfies GlobalKey);
  await settleZoom(page);

  // Oracle: scale is back to 100%. `s` is documented to reset scale (the
  // data point under the viewport centre is preserved); we assert the
  // scale, which is its contract.
  expect(await readZoomScale(page)).toBeCloseTo(1, 2);
});

test('shift+wheel zoom keeps the point under the cursor fixed (anchored zoom)', async ({ page }) => {
  const before = await typeBoxRect(page, APP);
  expect(before).not.toBeNull();
  // Anchor the wheel at the App box centre.
  const cx = before!.x + before!.width / 2;
  const cy = before!.y + before!.height / 2;
  const k0 = await readZoomScale(page);

  await shiftWheelZoom(page, cx, cy, -100, 4);

  const k1 = await readZoomScale(page);
  const after = await typeBoxRect(page, APP);
  expect(after).not.toBeNull();

  // The zoom actually changed scale (a real zoom, not a no-op).
  expect(k1, 'zoom-in raised the scale').toBeGreaterThan(k0 + 0.05);

  // Cursor-anchored: the App box centre, which sat under the cursor,
  // is still under the cursor after the scale change. d3.zoom is bound
  // to #canvas-scroll precisely so this anchoring holds on both axes
  // (vertical pan is mirrored to scrollTop). A few px slack for
  // sub-pixel rounding / discrete wheel steps.
  const acx = after!.x + after!.width / 2;
  const acy = after!.y + after!.height / 2;
  expect(Math.abs(acx - cx), `cursor x drift (was ${cx}, now ${acx})`).toBeLessThanOrEqual(3);
  expect(Math.abs(acy - cy), `cursor y drift (was ${cy}, now ${acy})`).toBeLessThanOrEqual(3);
});

test('panning cannot fling all content off-screen — horizontal clamp pins a content edge to the viewport edge', async ({
  page,
}) => {
  const { w } = await viewportSize(page);
  expect(await readZoomTransform(page)).toMatchObject({ x: 0, k: 1 });

  // Drag the mouse RIGHT-TO-LEFT (content moves right). The clamp pins
  // the content's LEFT edge to the RIGHT viewport edge: tx → w. The pan
  // gain makes a 1500px drag overshoot, so the clamp — not the gesture —
  // decides the final tx.
  await rightDrag(page, -1500, 0);
  const txContentRight = (await readZoomTransform(page)).x;
  expect(txContentRight, 'content-right drag clamps tx to the viewport width').toBeCloseTo(w, 0);

  // Idempotence proves it's a CLAMP, not just "moved a long way": an even
  // harder drag from here cannot push tx past w.
  await rightDrag(page, -3000, 0);
  expect((await readZoomTransform(page)).x, 'harder drag stays clamped at w').toBeCloseTo(w, 0);

  // Drag the mouse LEFT-TO-RIGHT (content moves left). The clamp pins the
  // content's RIGHT edge to the LEFT viewport edge: tx → -contentWPx (a
  // FINITE floor, not -∞). We don't hardcode contentWPx (it depends on
  // the real rendered font width); instead we prove the floor exists and
  // is hit — tx is negative and two differently-sized hard drags converge
  // to the SAME tx.
  await rightDrag(page, 1500, 0);
  const txLeftA = (await readZoomTransform(page)).x;
  await rightDrag(page, 3000, 0);
  const txLeftB = (await readZoomTransform(page)).x;
  expect(txLeftA, 'content-left drag moved content left (tx < 0)').toBeLessThan(0);
  expect(txLeftB, 'content-left drag is clamped to a finite floor (idempotent)').toBeCloseTo(
    txLeftA,
    0,
  );

  // User-visible findability at this clamp: at least one type box's RIGHT
  // edge is still at/over the left viewport edge (x ≈ 0), so content
  // stays reachable — it was not flung entirely past the screen.
  const ids = await typeBoxIds(page);
  let maxRight = Number.NEGATIVE_INFINITY;
  for (const id of ids) {
    const r = await typeBoxRect(page, id);
    if (r !== null) maxRight = Math.max(maxRight, r.x + r.width);
  }
  expect(maxRight, 'a type-box edge is still reachable at the left viewport edge').toBeGreaterThan(
    -2,
  );
});
