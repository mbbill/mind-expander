// Tier-3 real-browser spec for GROUP J — ghost / re-export FOLLOW
// interactions that only a real server + Chromium can exercise: the
// explicit kind-marker click path, the forward-routed module expansion a
// followed ghost triggers, and the "follow does NOT pan the viewport"
// guarantee.
//
// WHY a dedicated fixture (`e2e/ghost-fixture`): the shared selection
// fixture's ghost target (`core::Engine`) forward-owns `core::Piston` in
// the SAME module, so "follow forward-routes a DEEPER module" is not
// observable there. This crate puts the forward-owned `Piston` one module
// deeper (`core::parts`), and adds an isolated `extra::Gadget` as the
// control that must stay collapsed:
//
//   root  `pub use core::Engine`            → ghost `__re_Engine`
//   core::Engine owns core::parts::Piston   (field `piston`)
//   extra::Gadget                           isolated control
//
// Coverage NOT duplicated: selection-focus.spec.ts already covers the
// ghost ITALIC render and the expand-hit click→reveal-arrow path on its
// own fixture; this spec covers the explicit MARKER click + forward-route
// + no-pan gaps the catalog still lists open.
//
// Every oracle is a CORRECT observable result (a rendered arrow, a box
// appearing/staying absent, an unchanged transform) — never a screenshot.

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import {
  canvasScrollTop,
  expect,
  readZoomTransform,
  test,
  typeBoxIds,
  waitForLayoutSettled,
} from './_harness.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = process.env.MIND_EXPANDER_BIN ?? path.resolve(HERE, '../../target/debug/mind-expander');
const WORKSPACE = path.resolve(HERE, 'ghost-fixture');
const READY_TIMEOUT_MS = 30_000;

const CRATE = 'ghost_fixture';
const ENGINE = `${CRATE}::core::Engine`;
const PISTON = `${CRATE}::core::parts::Piston`;
const GADGET = `${CRATE}::extra::Gadget`;
const GHOST = `${CRATE}::__re_Engine`;

// Violet-500 — the re-export arrow stroke (index.html). Chromium reports
// computed colors as `rgb(...)`.
const VIOLET_RGB = 'rgb(168, 85, 247)';

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

/** The revealed re-export arrow `to` the given target, with its computed
 *  visible-stroke color and `.reexport` class membership; null when no
 *  such arrow is rendered. */
async function reexportArrowTo(
  page: Page,
  to: string,
): Promise<{ isReexport: boolean; stroke: string } | null> {
  return page.evaluate((target) => {
    const g = [...document.querySelectorAll('g.arrow')].find(
      (a) => a.getAttribute('data-arrow-to') === target,
    );
    if (g === undefined) return null;
    const vis = g.querySelector('path.visible');
    if (vis === null) return null;
    return {
      isReexport: vis.classList.contains('reexport'),
      stroke: getComputedStyle(vis).stroke,
    };
  }, to);
}

let pageErrors: string[];

test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(server.url);
  await expect(page.locator(`.module-group[data-id="${CRATE}"]`)).toBeVisible();
  // Expand ONLY the crate root so the App box and the ghost row render,
  // but core / core::parts / extra stay COLLAPSED — that's the precondition
  // that makes "follow expands the right modules, leaves the rest" visible.
  await expandModule(page, CRATE);
  await expect(page.locator(`g.type-box[data-element-id="${GHOST}"]`)).toBeVisible();
  // Canonical Engine, deep Piston, and unrelated Gadget are all hidden
  // until something expands their modules.
  await expect(page.locator(`g.type-box[data-element-id="${ENGINE}"]`)).toHaveCount(0);
  await expect(page.locator(`g.type-box[data-element-id="${PISTON}"]`)).toHaveCount(0);
  await expect(page.locator(`g.type-box[data-element-id="${GADGET}"]`)).toHaveCount(0);
  expect(pageErrors, `page errors during load: ${pageErrors.join('; ')}`).toHaveLength(0);
});

test.afterEach(() => {
  expect(pageErrors, `page errors during test: ${pageErrors.join('; ')}`).toHaveLength(0);
});

test('clicking the ghost KIND-MARKER follows the ghost and reveals its violet re-export arrow', async ({
  page,
}) => {
  // No re-export arrow exists until the ghost is followed.
  expect(await reexportArrowTo(page, ENGINE)).toBeNull();

  // Explicit marker click (distinct from the expand-hit path covered in
  // selection-focus.spec.ts): the kind-marker carries its own click handler
  // that routes to onFollowGhost for ghost rows.
  await page.locator(`g.type-box[data-element-id="${GHOST}"] text.kind-marker`).click();

  await expect(page.locator(`g.arrow[data-arrow-to="${ENGINE}"]`)).toHaveCount(1);
  await waitForLayoutSettled(page);

  const arrow = await reexportArrowTo(page, ENGINE);
  expect(arrow).not.toBeNull();
  const a = arrow as NonNullable<typeof arrow>;
  expect(a.isReexport).toBe(true);
  expect(a.stroke).toBe(VIOLET_RGB);
});

test('following the ghost forward-routes module expansion: canonical + deeper-owned boxes appear, unrelated stays collapsed', async ({
  page,
}) => {
  await page.locator(`g.type-box[data-element-id="${GHOST}"] text.kind-marker`).click();
  await waitForLayoutSettled(page);

  // (a) ancestor expansion → the canonical Engine box appears.
  await expect(page.locator(`g.type-box[data-element-id="${ENGINE}"]`)).toHaveCount(1);
  // (b) forward-routed expansion → the deeper `core::parts` module opens, so
  //     Piston (Engine's canonical forward-owned target) becomes visible.
  await expect(page.locator(`g.type-box[data-element-id="${PISTON}"]`)).toHaveCount(1);

  // (c) the unrelated `extra` module is NOT in the forward-routed set, so
  //     Gadget stays absent — forward-routing is targeted, not "expand all".
  const ids = await typeBoxIds(page);
  expect(ids).toContain(ENGINE);
  expect(ids).toContain(PISTON);
  expect(ids).not.toContain(GADGET);
});

test('following the ghost does NOT pan the viewport (no horizontal transform shift, no vertical scroll)', async ({
  page,
}) => {
  const before = await readZoomTransform(page);
  const scrollBefore = await canvasScrollTop(page);

  await page.locator(`g.type-box[data-element-id="${GHOST}"] text.kind-marker`).click();
  // Wait for the follow to take effect (arrow painted) before sampling.
  await expect(page.locator(`g.arrow[data-arrow-to="${ENGINE}"]`)).toHaveCount(1);
  await waitForLayoutSettled(page);

  const after = await readZoomTransform(page);
  const scrollAfter = await canvasScrollTop(page);

  // Follow toggles visibility + expands target modules but explicitly does
  // NOT move the canvas (main.ts onFollowGhost comment: "we do NOT pan the
  // viewport"). The SVG pan/zoom transform is byte-stable...
  expect(after.x).toBeCloseTo(before.x, 5);
  expect(after.k).toBeCloseTo(before.k, 5);
  // ...and vertical native scroll is untouched.
  expect(scrollAfter).toBeCloseTo(scrollBefore, 1);
});

test('clicking the followed ghost again un-follows it (arrow removed), still no collapse of the ghost row', async ({
  page,
}) => {
  const marker = page.locator(`g.type-box[data-element-id="${GHOST}"] text.kind-marker`);
  await marker.click();
  await expect(page.locator(`g.arrow[data-arrow-to="${ENGINE}"]`)).toHaveCount(1);
  await waitForLayoutSettled(page);

  // Second click toggles ghostArrowsShown OFF → the violet arrow is removed.
  await marker.click();
  await expect(page.locator(`g.arrow[data-arrow-to="${ENGINE}"]`)).toHaveCount(0);
  await waitForLayoutSettled(page);

  // The ghost row itself is never collapsed/removed by a follow toggle — it
  // is a leaf re-export row, present throughout.
  await expect(page.locator(`g.type-box[data-element-id="${GHOST}"]`)).toHaveCount(1);
});
