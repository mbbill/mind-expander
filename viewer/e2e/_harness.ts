// Shared Tier-3 harness: spawns the real `mind-expander view` server
// against the small fixture workspace, exposes its URL as a
// worker-scoped Playwright fixture, and provides reusable helpers for
// the two interactions every geometry spec needs (expand modules,
// expand a type box) plus screen-space geometry readers.
//
// New specs should import { test, expect } from here and reuse the
// helpers rather than re-deriving selectors — the expand flow and the
// element/attribute contract live in ONE place so a renderer change
// updates every spec through this module.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test as base, expect, type Page } from '@playwright/test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Built by the CI job (or locally via `cargo build`). Overridable so CI
// can point at a release binary or a cached path.
const BIN = process.env.MIND_EXPANDER_BIN ?? path.resolve(HERE, '../../target/debug/mind-expander');
const WORKSPACE = path.resolve(HERE, 'fixture-workspace');
const READY_TIMEOUT_MS = 30_000;

/** Spawn `view <fixture> --port 0` and resolve the bound URL from the
 *  `ready` JSON line the server prints to stdout. */
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
        // Non-JSON banner line (e.g. "Extracting facts…") — ignore.
      }
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

export const test = base.extend<object, { viewerURL: string }>({
  viewerURL: [
    async ({}, use) => {
      const { url, child } = await startServer();
      await use(url);
      child.kill();
    },
    { scope: 'worker' },
  ],
});

export { expect };

// ── Interaction helpers ──────────────────────────────────────────────
// All expansion in the viewer is click-driven (the diagram only renders
// type boxes for expanded modules, and field rows / ownership arrows for
// expanded type boxes). These wrap the two clicks every spec needs.

/** Expand a module row in the left HTML tree by its data-id. */
export async function expandModule(page: Page, moduleId: string): Promise<void> {
  // The header (first child of .module-group) carries the toggle handler.
  await page.locator(`.module-group[data-id="${moduleId}"] > *`).first().click();
}

/** Expand a type box (reveal its field/method rows) by clicking its
 *  expand-hit rect. The box must already be visible (its module expanded). */
export async function expandType(page: Page, typeFullPath: string): Promise<void> {
  await page.locator(`g.type-box[data-element-id="${typeFullPath}"] .expand-hit`).click();
}

/** Block until the diagram's geometry stops moving. Expansions tween box
 *  and arrow positions over ~ANIM_MS, so reading getBoundingClientRect
 *  immediately after a click catches mid-transition coordinates (a box
 *  and the arrow pointing at it briefly disagree). This polls the
 *  rendered rects until they are unchanged for `quietMs`, so geometry
 *  assertions read the SETTLED layout — no animation-duration magic
 *  number that would rot if ANIM_MS changes. */
export async function waitForLayoutSettled(
  page: Page,
  { quietMs = 150, timeout = 5000 }: { quietMs?: number; timeout?: number } = {},
): Promise<void> {
  await page.waitForFunction(
    (quiet) => {
      const snap = [...document.querySelectorAll('g.type-box, g.arrow path.visible')]
        .map((e) => {
          const r = (e as SVGGraphicsElement).getBoundingClientRect();
          return `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`;
        })
        .join('|');
      const w = window as unknown as { __meSnap?: string; __meSince?: number };
      if (w.__meSnap === snap) {
        w.__meSince = w.__meSince ?? performance.now();
        return performance.now() - w.__meSince >= quiet;
      }
      w.__meSnap = snap;
      w.__meSince = performance.now();
      return false;
    },
    quietMs,
    { timeout, polling: 50 },
  );
}

// ── Geometry readers (run inside the page) ───────────────────────────

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Screen-space bounding rect of the type box with the given id, or null
 *  if absent. Uses getBoundingClientRect → real rendered geometry. */
export async function typeBoxRect(page: Page, typeFullPath: string): Promise<Rect | null> {
  return page.evaluate((id) => {
    const el = document.querySelector(`g.type-box[data-element-id="${id}"]`);
    if (el === null) return null;
    const r = (el as SVGGraphicsElement).getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, typeFullPath);
}

/** All rendered type-box ids currently in the DOM. */
export async function typeBoxIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('g.type-box')].map((b) => b.getAttribute('data-element-id') ?? ''),
  );
}

export interface ArrowEndpoints {
  from: string | null;
  to: string | null;
  start: { x: number; y: number };
  end: { x: number; y: number };
}

/** Screen-space start/end points of every rendered arrow, derived from
 *  the painted path itself (getPointAtLength + getScreenCTM) so the test
 *  reads the SAME geometry the user sees — never a re-derivation. */
export async function arrowEndpoints(page: Page): Promise<ArrowEndpoints[]> {
  return page.evaluate(() => {
    const toScreen = (path: SVGPathElement, len: number) => {
      const p = path.getPointAtLength(len);
      const m = path.getScreenCTM();
      if (m === null) return { x: p.x, y: p.y };
      return { x: p.x * m.a + p.y * m.c + m.e, y: p.x * m.b + p.y * m.d + m.f };
    };
    return [...document.querySelectorAll('g.arrow')].map((g) => {
      const path = g.querySelector('path.visible') as SVGPathElement;
      const len = path.getTotalLength();
      return {
        from: g.getAttribute('data-arrow-from'),
        to: g.getAttribute('data-arrow-to'),
        start: toScreen(path, 0),
        end: toScreen(path, len),
      };
    });
  });
}

/** True when `pt` lies within `rect` inflated by `margin` on all sides. */
export function pointInRect(pt: { x: number; y: number }, rect: Rect, margin = 0): boolean {
  return (
    pt.x >= rect.x - margin &&
    pt.x <= rect.x + rect.width + margin &&
    pt.y >= rect.y - margin &&
    pt.y <= rect.y + rect.height + margin
  );
}
