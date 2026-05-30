// Tier-3 real-browser spec for the OWNERSHIP-ARROW DISAMBIGUATION popover
// (GROUP I). Complements e2e/arrow-routing.spec.ts (which already covers the
// single-arrow "navigate, no popup" path and the 2+ overlap "popover opens"
// path) by exercising the popover's OWN interactions, none of which were
// covered at any tier:
//
//   • the header reads "N arrows here — pick one" with the real hit count,
//   • clicking an endpoint row PICKS it → the popover closes and the canvas
//     pans (onPick navigation), and the popover stays gone,
//   • ESC dismisses the open popover,
//   • an outside click dismisses the open popover.
//
// Every oracle is a CORRECT observable result the user would see — DOM text,
// the popover's display flip, or a viewport pan — never "didn't throw" and
// never a screenshot.
//
// Spawns its OWN server against the shared dense fixture (Hub fans out 12
// ownership arrows sharing the owner's exit corridor) using the same
// `ready`-line protocol as _harness.ts, because the shared harness server is
// wired to a different fixture. Reuses every shared arrow/expand helper.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import {
  expandModule,
  expandType,
  expect,
  isArrowDisambigOpen,
  readZoomTransform,
  test,
  waitForLayoutSettled,
} from './_harness.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = process.env.MIND_EXPANDER_BIN ?? path.resolve(HERE, '../../target/debug/mind-expander');
const DENSE_WORKSPACE = path.resolve(HERE, 'dense-fixture');
const READY_TIMEOUT_MS = 30_000;
const DENSE_CRATE = 'dense_fixture';
const HUB = `${DENSE_CRATE}::Hub`;

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

/** Expand the dense fixture so Hub fans out its 12 ownership arrows. */
async function expandDenseFanOut(page: Page): Promise<void> {
  await expandModule(page, DENSE_CRATE);
  await expandModule(page, `${DENSE_CRATE}::parts`);
  await expect(page.locator(`g.type-box[data-element-id="${HUB}"]`)).toBeVisible();
  await expandType(page, HUB);
  await expect(page.locator('g.arrow')).toHaveCount(12);
  await waitForLayoutSettled(page);
}

/** Screen-space point where the most arrow polylines overlap (the owner's
 *  shared exit corridor), with the count of arrows near it — computed from
 *  the SAME painted paths the hit-tester reads, so the click lands on a
 *  genuine ≥2-arrow overlap rather than a guessed coordinate. */
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
    const distToPolyline = (
      p: { x: number; y: number },
      pts: { x: number; y: number }[],
    ): number => {
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

/** Open the disambiguation popover by clicking the densest arrow overlap.
 *  Returns the overlap point + hit count for follow-on assertions. */
async function openDisambig(page: Page): Promise<{ x: number; y: number; count: number }> {
  const overlap = await densestArrowOverlap(page);
  expect(overlap, 'a ≥2-arrow overlap point exists in the dense fan-out').not.toBeNull();
  const pt = overlap as { x: number; y: number; count: number };
  expect(pt.count).toBeGreaterThanOrEqual(2);
  await page.mouse.click(pt.x, pt.y);
  await expect.poll(async () => isArrowDisambigOpen(page)).toBe(true);
  return pt;
}

// ── 1. Header reads "N arrows here — pick one" with the real hit count ──

test('disambig header shows the real arrow-hit count', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(dense.url);
  await expandDenseFanOut(page);

  await openDisambig(page);

  // The header text is "<N> arrows here — pick one"; the leading number is
  // the number of arrows the click hit (arrow_disambig.ts builds it from
  // args.hits.length). It is a genuine ≥2 multi-hit, and the count equals
  // the number of endpoint rows the popover lists for this fan-out (one
  // shared source on top + one `-> target` row per hit), so header N ==
  // (target endpoint rows) since every hit shares the single source.
  const headerText = await page.locator('#arrow-disambig .header .title').textContent();
  expect(headerText).toMatch(/^\d+ arrows here — pick one$/);
  const headerCount = Number(/^(\d+)/.exec(headerText ?? '')?.[1]);
  expect(headerCount).toBeGreaterThanOrEqual(2);
  const targetRows = await page.locator('#arrow-disambig .arrow-endpoint.target').count();
  expect(targetRows).toBe(headerCount);

  expect(errors, `page errors: ${errors.join('; ')}`).toHaveLength(0);
});

// ── 2. Clicking an endpoint row picks it → popover closes + canvas pans ─

test('clicking a disambig endpoint navigates (pans) and closes the popover', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(dense.url);
  await expandDenseFanOut(page);
  await openDisambig(page);

  const before = await readZoomTransform(page);

  // Pick a TARGET endpoint (a `-> parts::X` row). The host resolves it and
  // pans the canvas so that endpoint lands under the click anchor. The
  // popover then closes (onPickHit calls hide()).
  const target = page.locator('#arrow-disambig .arrow-endpoint.target').first();
  await expect(target).toBeVisible();
  await target.click();

  await expect.poll(async () => isArrowDisambigOpen(page)).toBe(false);

  // Navigation moved the viewport (a no-op pick would leave the transform
  // unchanged). Endpoint resolution pans/centers, so x and/or k changes.
  await expect
    .poll(async () => {
      const after = await readZoomTransform(page);
      return Math.abs(after.x - before.x) > 0.5 || Math.abs(after.k - before.k) > 1e-6;
    })
    .toBe(true);

  expect(errors, `page errors: ${errors.join('; ')}`).toHaveLength(0);
});

// ── 3. ESC dismisses the open popover ────────────────────────────────

test('pressing Escape closes the disambig popover', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(dense.url);
  await expandDenseFanOut(page);
  await openDisambig(page);

  await page.keyboard.press('Escape');
  await expect.poll(async () => isArrowDisambigOpen(page)).toBe(false);

  expect(errors, `page errors: ${errors.join('; ')}`).toHaveLength(0);
});

// ── 4. Outside click dismisses the open popover ──────────────────────

test('clicking outside the disambig popover closes it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(dense.url);
  await expandDenseFanOut(page);
  await openDisambig(page);

  // Click a far corner of the viewport that is not over the panel. The
  // document-capture click handler in arrow_disambig.ts dismisses when the
  // click target is outside the panel.
  const vp = page.viewportSize() ?? { width: 1280, height: 720 };
  await page.mouse.click(vp.width - 5, vp.height - 5);

  await expect.poll(async () => isArrowDisambigOpen(page)).toBe(false);

  expect(errors, `page errors: ${errors.join('; ')}`).toHaveLength(0);
});
