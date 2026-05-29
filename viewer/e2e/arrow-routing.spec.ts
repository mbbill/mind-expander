// Tier-3 real-browser spec for the **arrow-routing** feature area.
//
// Drives a real Chromium against a real `mind-expander view` server.
// Every oracle is a CORRECT observable result the user would see — a CSS
// stroke switch, a paint-order change, a viewport pan, the disambiguation
// popover opening, or real painted arrow geometry attaching to boxes —
// never "didn't throw" and never a recorded screenshot (the on-failure
// screenshot in playwright.config.ts is only a debugging artifact).
//
// Two fixtures are exercised:
//   • the shared `fixture-workspace` (App owns Engine in `core`) via the
//     harness `viewerURL` — a SINGLE ownership arrow, the clean vehicle
//     for hover + single-arrow-click navigation (no popup).
//   • a dedicated dense `e2e/dense-fixture` (Hub owns 12 `parts::*`
//     structs) spawned by this spec — a fan-out of 12 arrows sharing the
//     owner's exit corridor, so a click on the corridor lands on 2+
//     arrows (the disambiguation case) and the whole set exercises the
//     at-scale "every arrow renders and attaches" invariant. The shared
//     `_harness.ts` server fixture is hard-wired to the geometry fixture,
//     so this spec spawns its own server against the dense fixture (same
//     `ready`-line protocol) while reusing every shared arrow helper.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Page } from '@playwright/test';
import {
  arrowEndpoints,
  arrowMidpoint,
  canvasScrollTop,
  expandModule,
  expandType,
  expect,
  isArrowDisambigOpen,
  pointInRect,
  readZoomTransform,
  test,
  typeBoxRect,
  waitForLayoutSettled,
} from './_harness.ts';

// ── Shared (single-arrow) fixture ids ────────────────────────────────
const CRATE = 'e2e_fixture';
const APP = `${CRATE}::App`;
const ENGINE = `${CRATE}::core::Engine`;
const APP_ENGINE_FIELD = `${APP}::engine`;

// ── Dense fan-out fixture (spawned by this spec) ─────────────────────
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = process.env.MIND_EXPANDER_BIN ?? path.resolve(HERE, '../../target/debug/mind-expander');
const DENSE_WORKSPACE = path.resolve(HERE, 'dense-fixture');
const READY_TIMEOUT_MS = 30_000;
const DENSE_CRATE = 'dense_fixture';
const HUB = `${DENSE_CRATE}::Hub`;

/** Spawn `view <dense-fixture> --port 0` and resolve the bound URL from
 *  the server's `ready` JSON line — same contract as the shared harness,
 *  pointed at this spec's own dense fixture. */
function startDenseServer(): Promise<{ url: string; child: ChildProcessWithoutNullStreams }> {
  const child = spawn(BIN, ['view', DENSE_WORKSPACE, '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`dense server never emitted ready within ${READY_TIMEOUT_MS}ms`));
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

let dense: { url: string; child: ChildProcessWithoutNullStreams };

test.beforeAll(async () => {
  dense = await startDenseServer();
});

test.afterAll(() => {
  dense?.child.kill();
});

// ── Helpers ──────────────────────────────────────────────────────────

/** Expand the shared fixture so App's `engine` field row emits its single
 *  ownership arrow to Engine, then let the layout settle. */
async function expandSharedArrow(page: Page): Promise<void> {
  await expandModule(page, CRATE);
  await expandModule(page, `${CRATE}::core`);
  await expect(page.locator(`g.type-box[data-element-id="${ENGINE}"]`)).toBeVisible();
  await expandType(page, APP);
  await expect(page.locator('g.arrow')).toHaveCount(1);
  await waitForLayoutSettled(page);
}

/** Expand the dense fixture so Hub fans out 12 ownership arrows. */
async function expandDenseFanOut(page: Page): Promise<void> {
  await expandModule(page, DENSE_CRATE);
  await expandModule(page, `${DENSE_CRATE}::parts`);
  await expect(page.locator(`g.type-box[data-element-id="${HUB}"]`)).toBeVisible();
  await expandType(page, HUB);
  await expect(page.locator('g.arrow')).toHaveCount(12);
  await waitForLayoutSettled(page);
}

/** Computed stroke color + width of the one arrow `from → to`, read from
 *  its painted `path.visible` (getComputedStyle resolves the CSS hover
 *  rule when the mouse is over it). */
async function arrowStroke(
  page: Page,
  from: string,
  to: string,
): Promise<{ stroke: string; width: string } | null> {
  return page.evaluate(
    ({ from, to }) => {
      const g = [...document.querySelectorAll('g.arrow')].find(
        (e) => e.getAttribute('data-arrow-from') === from && e.getAttribute('data-arrow-to') === to,
      );
      if (g === undefined) return null;
      const path = g.querySelector('path.visible');
      if (path === null) return null;
      const cs = getComputedStyle(path);
      return { stroke: cs.stroke, width: cs.strokeWidth };
    },
    { from, to },
  );
}

/** True when the arrow `from → to`'s `<g>` is the LAST child of the
 *  `g.arrows` layer — i.e. `.raise()` moved it on top so its hover stroke
 *  paints above sibling arrows. */
async function arrowIsRaised(page: Page, from: string, to: string): Promise<boolean> {
  return page.evaluate(
    ({ from, to }) => {
      const g = [...document.querySelectorAll('g.arrow')].find(
        (e) => e.getAttribute('data-arrow-from') === from && e.getAttribute('data-arrow-to') === to,
      );
      if (g === undefined || g.parentElement === null) return false;
      return g.parentElement.lastElementChild === g;
    },
    { from, to },
  );
}

/** Find the densest screen-space point where ≥2 arrow polylines pass
 *  within `tol` px of each other, computed from the SAME painted paths
 *  the hit-tester reads. Returns the point plus the count of arrows near
 *  it (so the spec asserts a true multi-arrow overlap, never a guessed
 *  coordinate). The arrow hit-tolerance is ARROW_HIT_PX (8) / zoom; at
 *  k=1 that is 8px, so `tol=6` is comfortably inside a real hit. */
async function densestArrowOverlap(
  page: Page,
  tol = 6,
): Promise<{ x: number; y: number; count: number } | null> {
  return page.evaluate((tol) => {
    const toScreen = (path: SVGPathElement, len: number): { x: number; y: number } => {
      const p = path.getPointAtLength(len);
      const m = path.getScreenCTM();
      if (m === null) return { x: p.x, y: p.y };
      return { x: p.x * m.a + p.y * m.c + m.e, y: p.x * m.b + p.y * m.d + m.f };
    };
    const dump = [...document.querySelectorAll('g.arrow')].map((g) => {
      const path = g.querySelector('path.visible') as SVGPathElement;
      const L = path.getTotalLength();
      const pts: { x: number; y: number }[] = [];
      for (let i = 0; i <= 24; i++) pts.push(toScreen(path, (L * i) / 24));
      return pts;
    });
    const distToPolyline = (p: { x: number; y: number }, pts: { x: number; y: number }[]): number => {
      let best = Infinity;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1] as { x: number; y: number };
        const b = pts[i] as { x: number; y: number };
        const vx = b.x - a.x;
        const vy = b.y - a.y;
        const l2 = vx * vx + vy * vy;
        let t = l2 === 0 ? 0 : ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2;
        t = Math.max(0, Math.min(1, t));
        const cx = a.x + vx * t;
        const cy = a.y + vy * t;
        best = Math.min(best, Math.hypot(p.x - cx, p.y - cy));
      }
      return best;
    };
    let best: { x: number; y: number; count: number } | null = null;
    for (const arr of dump) {
      for (const p of arr) {
        let count = 0;
        for (const d of dump) if (distToPolyline(p, d) <= tol) count++;
        if (count >= 2 && (best === null || count > best.count)) {
          best = { x: Math.round(p.x), y: Math.round(p.y), count };
        }
      }
    }
    return best;
  }, tol);
}

/** Number of endpoint rows the disambiguation popover is showing. */
async function arrowDisambigRowCount(page: Page): Promise<number> {
  return page.evaluate(
    () => document.querySelectorAll('#arrow-disambig .arrow-endpoint').length,
  );
}

// ── 1. Hover: raise + switch to the hover stroke ─────────────────────

test('hovering an arrow raises it and switches to the vivid purple hover stroke', async ({
  page,
  viewerURL,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(viewerURL);
  await expandSharedArrow(page);

  // Idle: canonical ownership arrows paint slate-400 (#94a3b8). Reading
  // this first makes the hover switch a real before/after, not an
  // assertion that could pass on the idle color too.
  await page.mouse.move(5, 5);
  const idle = await arrowStroke(page, APP_ENGINE_FIELD, ENGINE);
  expect(idle?.stroke).toBe('rgb(148, 163, 184)'); // #94a3b8 slate-400

  // Hover the arrow at its painted midpoint (the wide transparent
  // path.hit catches the pointer; the CSS :hover rule then repaints
  // path.visible).
  const mid = await arrowMidpoint(page, APP_ENGINE_FIELD, ENGINE);
  expect(mid).not.toBeNull();
  await page.mouse.move((mid as { x: number; y: number }).x, (mid as { x: number; y: number }).y);

  // Stroke switches to the vivid purple #a855f7 at a modest 2px — the
  // distinct-color hover contract (AR-26). Color is the load-bearing
  // signal: a same-color thickening was too subtle. (Opacity is NOT
  // asserted — for canonical arrows a more-specific idle opacity rule
  // intentionally out-ranks the hover rule; color+width are the contract.)
  await expect
    .poll(async () => (await arrowStroke(page, APP_ENGINE_FIELD, ENGINE))?.stroke)
    .toBe('rgb(168, 85, 247)'); // #a855f7 purple-500
  // Width transitions over ~80ms (stroke-width transition in index.html);
  // poll until it settles at the 2px hover target so the assertion reads
  // the final state, not a mid-transition value.
  await expect
    .poll(async () => (await arrowStroke(page, APP_ENGINE_FIELD, ENGINE))?.width)
    .toBe('2px');

  // And the hovered <g> is raised to the top of its layer so the bright
  // stroke is never covered by a sibling (AR-25).
  expect(await arrowIsRaised(page, APP_ENGINE_FIELD, ENGINE)).toBe(true);

  expect(errors, `page errors: ${errors.join('; ')}`).toHaveLength(0);
});

// ── 2. Single-arrow click → navigate / center an endpoint ────────────

test('clicking a single arrow pans the canvas to bring its target endpoint to the click anchor', async ({
  page,
  viewerURL,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(viewerURL);
  await expandSharedArrow(page);

  const anchor = await arrowMidpoint(page, APP_ENGINE_FIELD, ENGINE);
  expect(anchor).not.toBeNull();
  const click = anchor as { x: number; y: number };

  const beforeTransform = await readZoomTransform(page);
  const beforeScroll = await canvasScrollTop(page);

  // Click the arrow midpoint. A single arrow always navigates directly
  // (the hit zone picks which endpoint to travel to) with NO popup — the
  // navigation pans/centers an endpoint into view.
  await page.mouse.click(click.x, click.y);
  await waitForLayoutSettled(page);

  // A single arrow never opens the disambiguation popover.
  expect(await isArrowDisambigOpen(page)).toBe(false);

  // The viewport actually moved: horizontal pan (SVG transform x) and/or
  // native vertical scroll changed — `panTo` writes both to bring the
  // navigated endpoint to the click anchor. A no-op click would leave
  // both unchanged, so this is the observable "navigated" signal.
  const afterTransform = await readZoomTransform(page);
  const afterScroll = await canvasScrollTop(page);
  const moved =
    Math.abs(afterTransform.x - beforeTransform.x) > 1 || Math.abs(afterScroll - beforeScroll) > 1;
  expect(
    moved,
    `canvas panned after arrow click (dx=${afterTransform.x - beforeTransform.x}, dScroll=${afterScroll - beforeScroll})`,
  ).toBe(true);

  // The pan moved the viewport, not broke the route: the original
  // App→Engine arrow still connects the same endpoints after the
  // navigation re-draw, and both its boxes are still rendered.
  const all = await arrowEndpoints(page);
  const original = all.find((a) => a.from === APP_ENGINE_FIELD && a.to === ENGINE);
  expect(original, `App→Engine arrow still present (have: ${all.map((a) => `${a.from}->${a.to}`).join(', ')})`).toBeTruthy();
  expect(await typeBoxRect(page, APP)).not.toBeNull();
  expect(await typeBoxRect(page, ENGINE)).not.toBeNull();

  expect(errors, `page errors: ${errors.join('; ')}`).toHaveLength(0);
});

// ── 3. Click on 2+ overlapping arrows → disambiguation popover ───────

test('clicking where multiple arrows overlap opens the disambiguation popover', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(dense.url);
  await expandDenseFanOut(page);

  // (The single-arrow "navigate, no popup" path is covered by the
  // single-arrow click test above; here we isolate the OVERLAP contract
  // without a prior navigating click that would pan the corridor away.)

  // Find the screen point where the most arrow polylines overlap (the
  // owner's shared exit corridor) and confirm it's a genuine ≥2 overlap.
  const overlap = await densestArrowOverlap(page);
  expect(overlap, 'a ≥2-arrow overlap point exists in the dense fan-out').not.toBeNull();
  expect((overlap as { count: number }).count).toBeGreaterThanOrEqual(2);

  const pt = overlap as { x: number; y: number; count: number };
  await page.mouse.click(pt.x, pt.y);

  // The disambiguation popover opens (≥2 arrows under the cursor) and
  // lists endpoint rows for the user to pick from.
  await expect.poll(async () => isArrowDisambigOpen(page)).toBe(true);
  expect(await arrowDisambigRowCount(page)).toBeGreaterThanOrEqual(2);

  expect(errors, `page errors: ${errors.join('; ')}`).toHaveLength(0);
});

// ── 4. At scale: dense fan-out renders all arrows attached to boxes ──

test('dense fan-out renders every arrow without errors, each attached to its source and target box', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(dense.url);
  await expandDenseFanOut(page);

  const arrows = await arrowEndpoints(page);
  // All 12 ownership arrows present (no silent hide at scale — AR-05/32).
  expect(arrows).toHaveLength(12);

  const hubRect = await typeBoxRect(page, HUB);
  expect(hubRect).not.toBeNull();
  const hub = hubRect as NonNullable<typeof hubRect>;

  const MARGIN = 8; // px slack for stroke width / field-row port offset
  for (const arrow of arrows) {
    // Every arrow is a real route with finite painted endpoints.
    expect(Number.isFinite(arrow.start.x) && Number.isFinite(arrow.start.y)).toBe(true);
    expect(Number.isFinite(arrow.end.x) && Number.isFinite(arrow.end.y)).toBe(true);

    // Start anchors inside the owner (Hub) box — a field-row source port.
    expect(arrow.from?.startsWith(`${HUB}::`)).toBe(true);
    expect(
      pointInRect(arrow.start, hub, MARGIN),
      `arrow ${arrow.from} start ${JSON.stringify(arrow.start)} within Hub ${JSON.stringify(hub)}`,
    ).toBe(true);

    // End attaches to a vertical SIDE of its specific target box.
    const targetRect = await typeBoxRect(page, arrow.to as string);
    expect(targetRect, `target box ${arrow.to}`).not.toBeNull();
    const tr = targetRect as NonNullable<typeof targetRect>;
    expect(
      pointInRect(arrow.end, tr, MARGIN),
      `arrow ${arrow.from}→${arrow.to} end ${JSON.stringify(arrow.end)} within target ${JSON.stringify(tr)}`,
    ).toBe(true);
    const onLeft = Math.abs(arrow.end.x - tr.x) <= MARGIN;
    const onRight = Math.abs(arrow.end.x - (tr.x + tr.width)) <= MARGIN;
    expect(onLeft || onRight, `arrow ${arrow.to} end x=${arrow.end.x} on a vertical side`).toBe(
      true,
    );
  }

  expect(errors, `page errors: ${errors.join('; ')}`).toHaveLength(0);
});
