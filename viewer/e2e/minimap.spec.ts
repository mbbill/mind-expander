// Tier-3 real-browser spec: the diagram minimap's click/drag-to-pan
// interaction (GROUP L). Driven against the real `mind-expander view`
// server and real Chromium so the pointer-coordinate translation runs
// against the actual rendered minimap geometry and the live d3.zoom
// transform / native scroll — the parts the jsdom Tier-1 file cannot
// exercise (real getBoundingClientRect, pointer capture, the pan landing
// through the real constrain()).
//
// The oracle for every kept test is the CORRECT observable viewport
// state: the live zoom transform's horizontal pan `x` (read off the zoom
// layer's `transform` attribute) and the native `#canvas-scroll.scrollTop`
// (vertical pan is delivered through native scroll, not the SVG
// transform — see src/view/zoom.ts). Never a screenshot, never "didn't
// throw".
//
// Fixture `e2e/minimap-fixture`: a TALL crate (8 modules × 3 structs).
// Fully expanded, the diagram's content height exceeds the 900px test
// viewport, so a minimap pan produces an OBSERVABLE vertical move. (With
// the small shared fixture the diagram fits the viewport and the pan
// constraint keeps it centred — a click would be a no-op.) This spec
// spawns its OWN server against that fixture rather than the shared
// `viewerURL`, so it does not need to touch the shared harness wiring.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  canvasScrollTop,
  clickMinimapToggle,
  expect,
  isMinimapBodyVisible,
  readZoomTransform,
  test as base,
  waitForLayoutSettled,
} from './_harness.ts';
import type { Page } from '@playwright/test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = process.env.MIND_EXPANDER_BIN ?? path.resolve(HERE, '../../target/debug/mind-expander');
const FIXTURE = path.resolve(HERE, 'minimap-fixture');
const CRATE = 'minimap_fixture';

interface Spawned {
  stdout: NodeJS.ReadableStream;
  on(event: 'error', cb: (e: Error) => void): unknown;
  kill(): boolean;
}

/** Spawn `view <minimap-fixture> --port 0` and resolve its bound URL from
 *  the `ready` JSON line — same contract as the shared harness, kept local
 *  so this spec can point at its own tall fixture without editing
 *  _harness.ts. */
function startServer(): Promise<{ url: string; child: Spawned }> {
  const child = spawn(BIN, ['view', FIXTURE, '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as unknown as Spawned;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('minimap-fixture server never emitted ready'));
    }, 30_000);
    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      try {
        const ev = JSON.parse(line) as { event?: string; url?: string };
        if (ev.event === 'ready' && typeof ev.url === 'string') {
          clearTimeout(timer);
          resolve({ url: ev.url, child });
        }
      } catch {
        // Non-JSON banner line — ignore.
      }
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

const test = base.extend<object, { minimapURL: string }>({
  minimapURL: [
    async ({}, use) => {
      const { url, child } = await startServer();
      await use(url);
      child.kill();
    },
    { scope: 'worker' },
  ],
});

const MODULES = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'] as const;

/** Expand the crate root AND every submodule so all type boxes render
 *  (types render only for expanded modules). The tall fixture then
 *  overflows the viewport vertically, which is what makes the minimap pan
 *  observable. */
async function expandAll(page: Page): Promise<void> {
  await page.locator(`.module-group[data-id="${CRATE}"] > *`).first().click();
  for (const m of MODULES) {
    await page.locator(`.module-group[data-id="${CRATE}::${m}"] > *`).first().click();
  }
  await expect(page.locator('g.type-box').first()).toBeVisible();
  await waitForLayoutSettled(page);
}

/** Bounding box of the minimap SVG in screen coords. */
async function minimapBox(page: Page): Promise<{ x: number; y: number; w: number; h: number }> {
  const box = await page.locator('#minimap-body svg').boundingBox();
  if (box === null) throw new Error('#minimap-body svg has no box');
  return { x: box.x, y: box.y, w: box.width, h: box.height };
}

async function minimapCounts(
  page: Page,
): Promise<{ bands: number; types: number; viewport: number }> {
  return page.evaluate(() => ({
    bands: document.querySelectorAll('#minimap-body g.minimap-bands rect').length,
    types: document.querySelectorAll('#minimap-body g.minimap-types rect').length,
    viewport: document.querySelectorAll('#minimap-body rect.minimap-viewport').length,
  }));
}

/** The viewport indicator rect's current y (minimap-space). */
async function minimapViewportY(page: Page): Promise<number> {
  return page.evaluate(() =>
    Number(
      document.querySelector('#minimap-body rect.minimap-viewport')?.getAttribute('y') ?? 'NaN',
    ),
  );
}

/** Settled viewport state after a pan: horizontal transform x + native
 *  vertical scrollTop. */
async function viewportState(page: Page): Promise<{ x: number; scrollTop: number }> {
  return {
    x: (await readZoomTransform(page)).x,
    scrollTop: await canvasScrollTop(page),
  };
}

let pageErrors: string[];

test.beforeEach(async ({ page, minimapURL }) => {
  pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(minimapURL);
  await expect(page.locator(`.module-group[data-id="${CRATE}"]`)).toBeVisible();
  await expandAll(page);
});

test.afterEach(() => {
  expect(pageErrors, `page errors: ${pageErrors.join('; ')}`).toHaveLength(0);
});

test('minimap renders bands, type rects and a viewport indicator', async ({ page }) => {
  await expect(page.locator('#minimap-body svg')).toBeVisible();
  const c = await minimapCounts(page);
  expect(c.bands, 'module bands rendered').toBeGreaterThan(0);
  expect(c.types, 'type rects rendered').toBeGreaterThan(0);
  expect(c.viewport, 'single viewport indicator').toBe(1);
});

test('the tall fixture overflows the viewport so panning is meaningful', async ({ page }) => {
  // Guard the fixture's premise: scrollHeight > clientHeight, otherwise the
  // pan-clamp would pin scrollTop and the pan tests below would be vacuous.
  const overflow = await page.evaluate(() => {
    const el = document.querySelector('#canvas-scroll') as HTMLElement;
    return el.scrollHeight - el.clientHeight;
  });
  expect(overflow, 'diagram content is taller than the viewport').toBeGreaterThan(50);
});

// ─────────────────────────────────────────────────────────────────────
// Minimap click/drag-to-pan. The pan handlers (pointerdown/move/up →
// panFromPointer → layers.centerOn) are attached to the minimap's `<svg>`
// node. They used to be unreachable: `#top-controls * { pointer-events:
// none }` blocked the svg while only the parent `.minimap-body` div was
// re-enabled, so real pointer gestures never hit the svg and the canvas
// never panned (the jsdom Tier-1 tests, which dispatch directly to the svg,
// always confirmed the translation math). Fixed by `#minimap svg {
// pointer-events: auto }` in index.html, so these now exercise the real
// gesture end to end.
// ─────────────────────────────────────────────────────────────────────

test('clicking the minimap pans the main canvas; top vs bottom land differently', async ({
  page,
}) => {
  const box = await minimapBox(page);

  // Click near the TOP of the minimap → pans toward the top of the diagram
  // (scrollTop small).
  await page.mouse.click(box.x + box.w / 2, box.y + box.h * 0.12);
  await waitForLayoutSettled(page);
  const top = await viewportState(page);

  // Click near the BOTTOM → pans toward the bottom (scrollTop larger).
  await page.mouse.click(box.x + box.w / 2, box.y + box.h * 0.88);
  await waitForLayoutSettled(page);
  const bottom = await viewportState(page);

  // The pointer→data translation is monotonic in y: a lower click lands
  // lower in the document. Vertical pan is native scroll, so assert on
  // scrollTop.
  expect(
    bottom.scrollTop,
    `bottom-click scrollTop (${bottom.scrollTop}) > top-click (${top.scrollTop})`,
  ).toBeGreaterThan(top.scrollTop + 5);
});

test('clicking the minimap moves the viewport and its indicator down', async ({ page }) => {
  // First pan to the TOP via a top-edge minimap click so there is room to
  // move downward (resetAll/`r` would also fit-all and could leave us
  // already centred).
  const box = await minimapBox(page);
  await page.mouse.click(box.x + box.w / 2, box.y + box.h * 0.05);
  await waitForLayoutSettled(page);
  const before = await viewportState(page);
  const vpYBefore = await minimapViewportY(page);

  // Click the far bottom → clear downward move.
  await page.mouse.click(box.x + box.w / 2, box.y + box.h * 0.95);
  await waitForLayoutSettled(page);
  const after = await viewportState(page);
  const vpYAfter = await minimapViewportY(page);

  expect(
    after.scrollTop,
    `viewport scrolled down (${before.scrollTop} → ${after.scrollTop})`,
  ).toBeGreaterThan(before.scrollTop + 5);

  // The minimap's own viewport indicator is recomputed from the live
  // transform on every update, so it tracks downward with the pan.
  expect(vpYAfter, `viewport indicator moved down (${vpYBefore} → ${vpYAfter})`).toBeGreaterThan(
    vpYBefore,
  );
});

test('dragging across the minimap pans continuously', async ({ page }) => {
  // Start panned to the top so the drag has room to scroll down.
  const box = await minimapBox(page);
  await page.mouse.click(box.x + box.w / 2, box.y + box.h * 0.05);
  await waitForLayoutSettled(page);
  const before = await viewportState(page);

  // pointerdown near the top, move to the bottom in steps, pointerup. Each
  // move re-pans (dragging=true). page.mouse drives real pointerdown/move/up
  // with capture against the SVG node.
  const startX = box.x + box.w / 2;
  await page.mouse.move(startX, box.y + box.h * 0.2);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(startX, box.y + box.h * (0.2 + 0.12 * i));
  }
  await page.mouse.up();
  await waitForLayoutSettled(page);

  const after = await viewportState(page);
  expect(
    after.scrollTop,
    `drag scrolled the canvas down (${before.scrollTop} → ${after.scrollTop})`,
  ).toBeGreaterThan(before.scrollTop + 5);
});

test('minimap toggle hides and shows the minimap body', async ({ page }) => {
  expect(await isMinimapBodyVisible(page)).toBe(true);
  await clickMinimapToggle(page);
  expect(await isMinimapBodyVisible(page)).toBe(false);
  await clickMinimapToggle(page);
  expect(await isMinimapBodyVisible(page)).toBe(true);
});
