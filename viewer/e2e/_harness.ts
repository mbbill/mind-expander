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

// ── Global keyboard shortcuts ────────────────────────────────────────
// The viewer registers ONE keydown listener on `window` (see
// src/main.ts): it early-returns when any of meta/ctrl/alt is held, uses
// `e.code === 'Space'` for the overview toggle (ignoring auto-repeat),
// and `e.key` for the single-letter shortcuts f/m/c/s/r/t/?. These
// helpers dispatch a faithful KeyboardEvent so specs exercise the real
// handler instead of clicking the chips — the keydown path is the
// behavior under test.

/** The single-character global shortcuts the viewer's window keydown
 *  handler recognises. `Space` is dispatched via `code`, the rest via
 *  `key` (see `pressGlobalKey`). */
export type GlobalKey = 'f' | 'm' | 'c' | 's' | 'r' | 't' | '?' | 'Space';

/** Dispatch a `window` keydown for one of the viewer's global
 *  shortcuts, matching the handler's dispatch contract exactly:
 *    • `Space` → `{ code: 'Space' }` (the handler keys off `e.code`).
 *    • everything else → `{ key }` (the handler keys off `e.key`).
 *  No modifier keys are set, so the handler's `metaKey/ctrlKey/altKey`
 *  guard never trips — the shortcut always fires. Bubbles + cancelable
 *  so `preventDefault()` (used by the Space branch) behaves as in a real
 *  press. Returns once the synchronous handler has run. */
export async function pressGlobalKey(page: Page, key: GlobalKey): Promise<void> {
  await page.evaluate((k) => {
    const init: KeyboardEventInit =
      k === 'Space'
        ? { code: 'Space', key: ' ', bubbles: true, cancelable: true }
        : { key: k, bubbles: true, cancelable: true };
    window.dispatchEvent(new KeyboardEvent('keydown', init));
  }, key);
}

// ── Viewport transform / zoom reader ─────────────────────────────────
// The viewer does NOT expose the d3.zoom transform on `window`; the
// authoritative copy lives on the zoom layer's SVG `transform`
// attribute, written on every zoom event as `translate(x,0) scale(k)`
// (vertical pan is delivered through native scrollTop, NOT the SVG
// transform — see src/view/zoom.ts). Reading the attribute therefore
// gives the true horizontal pan `x` and scale `k`; `y` is intentionally
// always 0 in the SVG transform and is not recoverable here.

export interface ZoomTransform {
  /** Horizontal pan in screen px (the `translate(x, …)` term). */
  x: number;
  /** Current zoom scale `k` (the `scale(k)` term). 1 = 100%. */
  k: number;
}

/** Read the live viewport transform off the zoom layer's `transform`
 *  attribute — the same value the renderer projects the canvas through,
 *  so a spec asserts against what the user actually sees rather than a
 *  re-derivation. Returns `{ x: 0, k: 1 }` (identity) when the layer has
 *  no transform yet. Note `y` is not represented here: vertical pan is
 *  native scroll, not part of the SVG transform. */
export async function readZoomTransform(page: Page): Promise<ZoomTransform> {
  return page.evaluate(() => {
    const layer = document.querySelector('#tree g.zoom-layer');
    const attr = layer?.getAttribute('transform') ?? '';
    const t = /translate\(\s*([-\d.eE]+)/.exec(attr);
    const s = /scale\(\s*([-\d.eE]+)/.exec(attr);
    return {
      x: t !== null ? Number(t[1]) : 0,
      k: s !== null ? Number(s[1]) : 1,
    };
  });
}

/** Convenience reader for just the current zoom scale `k`
 *  (1 = 100%). Thin wrapper over `readZoomTransform`. */
export async function readZoomScale(page: Page): Promise<number> {
  return (await readZoomTransform(page)).k;
}

// ── Chrome affordances (legend / keyhints / minimap) ─────────────────
// Each affordance hides itself with the `hidden` attribute (see
// index.html + src/main.ts). These readers report open state by
// inspecting that attribute on the real elements the handlers toggle, so
// they track the shipped wiring rather than duplicating it.

/** True when the legend / shortcuts modal (`#legend-modal`, toggled by
 *  the `?` key) is open. */
export async function isLegendOpen(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('#legend-modal');
    return el !== null && el.hidden === false;
  });
}

/** True when the keyboard-shortcut chip list (`#keyhints-chips`, toggled
 *  by the corner keyboard-emoji button — mouse only, no key binding) is
 *  visible. */
export async function areKeyhintsChipsVisible(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('#keyhints-chips');
    return el !== null && el.hidden === false;
  });
}

/** Click the mouse-only keyhints toggle button (`.keyhints-toggle`) —
 *  there is deliberately no keyboard shortcut for the chip list. */
export async function clickKeyhintsToggle(page: Page): Promise<void> {
  await page.locator('.keyhints-toggle').click();
}

/** True when the minimap body (`#minimap-body`) is expanded. The minimap
 *  collapses to just its toggle header; the body carries the `hidden`
 *  attribute. */
export async function isMinimapBodyVisible(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('#minimap-body');
    return el !== null && el.hidden === false;
  });
}

/** Click the minimap collapse/expand toggle (`.minimap-toggle`). */
export async function clickMinimapToggle(page: Page): Promise<void> {
  await page.locator('.minimap-toggle').click();
}

// ── Code panel ───────────────────────────────────────────────────────
// The code panel (`#code-panel`) is a flex sibling docked on the right;
// `hidden` toggles it and `style.width` carries its current width (the
// left-edge splitter `.code-panel-resize-l` drives resize). The `C`
// global key opens/closes it.

/** True when the right-docked source code panel (`#code-panel`) is open. */
export async function isCodePanelOpen(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('#code-panel');
    return el !== null && el.hidden === false;
  });
}

/** Toggle the code panel via the real `C` global shortcut (open if
 *  closed, close if open) — exercises the same keydown path a user
 *  hits, including the selection-aware open logic in main.ts. */
export async function openCodeViaKey(page: Page): Promise<void> {
  await pressGlobalKey(page, 'c');
}

/** Current rendered width of the code panel in px (its
 *  getBoundingClientRect width), or null when the panel is closed. Use
 *  for resize assertions — read before and after a splitter drag. */
export async function codePanelWidth(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('#code-panel');
    if (el === null || el.hidden) return null;
    return el.getBoundingClientRect().width;
  });
}

/** The code panel's left-edge resize splitter locator
 *  (`.code-panel-resize-l`). Drag it to change the panel width;
 *  dragging left grows the panel. Exposed so resize specs can drive a
 *  real pointer drag against the actual splitter element. */
export function codePanelResizeHandle(page: Page): ReturnType<Page['locator']> {
  return page.locator('#code-panel .code-panel-resize-l');
}
