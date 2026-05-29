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

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { type Page, test as base, expect } from '@playwright/test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Built by the CI job (or locally via `cargo build`). Overridable so CI
// can point at a release binary or a cached path.
const BIN = process.env.MIND_EXPANDER_BIN ?? path.resolve(HERE, '../../target/debug/mind-expander');
const WORKSPACE = path.resolve(HERE, 'fixture-workspace');
const READY_TIMEOUT_MS = 30_000;

// The `view` children are spawned with stdio `['ignore','pipe','pipe']`,
// so stdin is null and stdout/stderr are readable pipes. A minimal
// structural type captures exactly what the ready-parse + teardown need
// (a readable stdout, an error event, and kill), without pulling in the
// ChildProcessWithoutNullStreams shape that doesn't match an ignored
// stdin.
interface SpawnedServer {
  readonly stdout: Readable;
  on(event: 'error', listener: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/** Resolve the bound URL from the `ready` JSON line a freshly-spawned
 *  `view` child prints to stdout. Shared by every server-spawn helper
 *  (plain fixture + diff repo) so the ready-line contract lives once. */
function waitForReady(child: SpawnedServer): Promise<string> {
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
          resolve(ev.url);
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

/** Spawn `view <fixture> --port 0` and resolve the bound URL from the
 *  `ready` JSON line the server prints to stdout. */
async function startServer(): Promise<{ url: string; child: SpawnedServer }> {
  const child = spawn(BIN, ['view', WORKSPACE, '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = await waitForReady(child);
  return { url, child };
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
    [...document.querySelectorAll('g.type-box')].map(
      (b) => b.getAttribute('data-element-id') ?? '',
    ),
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

// ── URL join ─────────────────────────────────────────────────────────
// The server's `ready` line reports the base URL WITH a trailing slash
// (`http://127.0.0.1:PORT/`). Naive `url + '/api/...'` produces a double
// slash that the axum router does NOT match — it falls through to the
// SPA static fallback and returns index.html instead of JSON. Resolving
// against the base via the URL constructor collapses the slash, so every
// API helper below routes through this.

/** Join an `/api/...` path onto the server base URL, collapsing the
 *  trailing-slash double-slash that would otherwise miss the route. */
export function apiUrl(base: string, apiPath: string): string {
  return new URL(apiPath.replace(/^\//, ''), base).toString();
}

// ── Tour injection (POST /api/tour + SSE-rendered UI) ────────────────
// The viewer receives tours over SSE (`/api/tour-events`) and replays
// queued tours from `/api/tours` on load; either path surfaces the
// `#tour-bar` pill (tour_bar.ts) and lets the player open the bubble
// (tour_bubble.ts) / panel (tour_panel.ts). A tour step's `ref` is
// resolved server-side against the span index, so `ref.file` MUST be a
// real source file the server indexed — we read one from `/api/facts`
// rather than guessing a path.

/** Wire shape the server accepts at POST /api/tour. NOTE: the live
 *  server requires `schema_version: 2` (see SCHEMA_VERSION in
 *  src/tour.rs) — schema_version 1 is rejected with 422. */
export interface TourStepInput {
  readonly say: string;
  /** Element reference. `line` is 1-based; omit to target the module. */
  readonly ref?: { readonly file: string; readonly line?: number };
}
export interface TourInput {
  readonly schema_version: 2;
  readonly title?: string;
  readonly steps: readonly TourStepInput[];
}

/** A real (file, line) pair pulled from the server's own facts, suitable
 *  as a tour step `ref` — guaranteed to resolve server-side. */
export interface FixtureRef {
  /** Absolute path to a source file the server indexed. */
  readonly file: string;
  /** 1-based line of a known type declaration in that file. */
  readonly line: number;
  /** The type's canonical id (e.g. `e2e_fixture::core::Engine`), handy
   *  for asserting selection / anchor against the resolved element. */
  readonly typeId: string;
}

// Minimal slice of the /api/facts JSON this harness reads. The full
// schema lives in the viewer (src/data/schema.ts); we keep an
// intentionally narrow local shape so the harness doesn't couple to the
// renderer's model.
interface FactsSlice {
  readonly crates: Record<
    string,
    {
      readonly modules: Record<
        string,
        {
          readonly file: string;
          readonly types?: ReadonlyArray<{
            readonly full_path: string;
            readonly span?: { readonly file: string; readonly start_line: number };
          }>;
        }
      >;
    }
  >;
}

/** Fetch `/api/facts` and return the first type declaration with a span
 *  — its `{file, line, typeId}` is a ref the server will resolve. Throws
 *  if the facts contain no spanned type (the fixture always has several,
 *  so a throw means the server/fixture contract broke). */
export async function fixtureTypeRef(url: string): Promise<FixtureRef> {
  const res = await fetch(apiUrl(url, '/api/facts'));
  const facts = (await res.json()) as FactsSlice;
  for (const crate of Object.values(facts.crates)) {
    for (const mod of Object.values(crate.modules)) {
      for (const ty of mod.types ?? []) {
        if (ty.span !== undefined) {
          return { file: ty.span.file, line: ty.span.start_line, typeId: ty.full_path };
        }
      }
    }
  }
  throw new Error('no spanned type in /api/facts — fixture/server contract changed');
}

/** Build a minimal valid 2-step tour over the fixture: a text-only
 *  opener plus one step whose `ref` points at the given real type
 *  (`fixtureTypeRef`). schema_version is pinned to 2 (the value the
 *  live server accepts). */
export function buildFixtureTour(ref: FixtureRef, title = 'E2E fixture tour'): TourInput {
  return {
    schema_version: 2,
    title,
    steps: [
      { say: 'Welcome to the fixture tour.' },
      { say: `This is **${ref.typeId}**.`, ref: { file: ref.file, line: ref.line } },
    ],
  };
}

/** POST a tour to the running server. Resolves to the parsed JSON body
 *  ({status, tour_id} on 200; {status, errors} on 422) plus the HTTP
 *  status, so a spec can assert acceptance AND surface resolver errors. */
export async function postTour(
  url: string,
  tour: TourInput,
): Promise<{ status: number; body: { status?: string; tour_id?: string; errors?: unknown[] } }> {
  const res = await fetch(apiUrl(url, '/api/tour'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(tour),
  });
  const body = (await res.json()) as { status?: string; tour_id?: string; errors?: unknown[] };
  return { status: res.status, body };
}

// ── Tour UI readers (tour_bar / tour_bubble / tour_panel) ────────────
// These inspect the real DOM the tour modules build — `#tour-bar`
// (tour_bar.ts), `.tour-bubble` (tour_bubble.ts), `.tour-panel`
// (tour_panel.ts). They report observable state, never re-derive it.

/** True when the "new tour" pill (`#tour-bar`) is visible — it un-hides
 *  itself the moment the viewer receives its first tour. */
export async function isTourBarVisible(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('#tour-bar');
    return el !== null && el.hidden === false;
  });
}

/** The `#tour-bar` pill's text (e.g. `▶ new tour: <title>`), or null
 *  when the bar isn't present. */
export async function tourBarText(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('#tour-bar');
    return el === null ? null : (el.textContent ?? '');
  });
}

/** Click the `#tour-bar` pill — opens the tour panel and starts the
 *  newest tour (the bubble appears as a result). */
export async function clickTourBar(page: Page): Promise<void> {
  await page.locator('#tour-bar').click();
}

/** True when the tour bubble (`.tour-bubble`) is mounted — the player
 *  builds it on start and removes it on stop, so presence == playing. */
export async function isTourBubbleVisible(page: Page): Promise<boolean> {
  return page.evaluate(() => document.querySelector('.tour-bubble') !== null);
}

/** Rendered body text of the tour bubble (the current step's `say`,
 *  with markdown rendered to text), or null when no bubble is shown. */
export async function tourBubbleText(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const body = document.querySelector<HTMLElement>('.tour-bubble .tour-bubble-body');
    return body === null ? null : (body.textContent ?? '');
  });
}

/** The bubble's step counter text (`"1 / 2"`), or null when no bubble. */
export async function tourBubbleCounter(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const c = document.querySelector<HTMLElement>('.tour-bubble .tour-bubble-counter');
    return c === null ? null : (c.textContent ?? '');
  });
}

/** Advance the tour via the bubble's Next button (same path as the `N`
 *  key). Throws via locator timeout if the bubble isn't shown. */
export async function clickTourNext(page: Page): Promise<void> {
  await page.locator('.tour-bubble .tour-bubble-next').click();
}

/** Step the tour back via the bubble's Prev button. */
export async function clickTourPrev(page: Page): Promise<void> {
  await page.locator('.tour-bubble .tour-bubble-prev').click();
}

/** Stop the tour via the bubble's Stop button (same path as Esc). */
export async function clickTourStop(page: Page): Promise<void> {
  await page.locator('.tour-bubble .tour-bubble-stop').click();
}

/** True when the tour-steps side panel (`.tour-panel`) is open. The
 *  panel toggles via the `t` key (pressGlobalKey) or the tour-bar
 *  click; it hides with the `hidden` attribute. */
export async function isTourPanelOpen(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.tour-panel');
    return el !== null && el.hidden === false;
  });
}

/** Per-row step text shown in the open tour panel body
 *  (`.tour-panel-step-text`), top to bottom. Empty when no panel. */
export async function tourPanelStepTexts(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('.tour-panel .tour-panel-step-text')].map(
      (e) => e.textContent ?? '',
    ),
  );
}

// ── Diff / unified-mode server (mind-expander view --at HEAD..) ──────
// Diff mode needs a real git repo with a committed baseline and a
// working-tree edit so `--at HEAD..` produces a non-empty delta. We
// build a throwaway crate in the OS temp dir, commit it, then mutate a
// source file (add a struct field) so the head facts differ from base.
// The server materializes a base worktree and reports `diff_enabled` /
// `unified_mode` via /api/health; the viewer paints `.side-base` /
// `.side-head` decorations + module rollup chips from /api/diff +
// /api/changed-files.

/** A live diff-mode server: its bound URL plus a `close()` that kills
 *  the child and removes the temp repo. */
export interface DiffServer {
  readonly url: string;
  close(): Promise<void>;
}

/** Build a throwaway git repo with a committed baseline + a working-tree
 *  edit, spawn `view --at HEAD.. <repo> --port 0`, and return its URL.
 *  The edit modifies `Engine` (adds a field → a Modified type with a
 *  `data-side` rollup) AND adds a new `Gearbox` struct (a head-only type
 *  with the `.side-head` class), so both diff decoration signals plus a
 *  non-zero module rollup are observable in the viewer. */
export async function startDiffServer(): Promise<DiffServer> {
  const repo = mkdtempSync(path.join(tmpdir(), 'me-e2e-diff-'));
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  };
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  writeFileSync(
    path.join(repo, 'Cargo.toml'),
    '[package]\nname = "diff_fixture"\nversion = "0.0.0"\nedition = "2021"\n\n[lib]\npath = "src/lib.rs"\n',
  );
  writeFileSync(
    path.join(repo, 'src/lib.rs'),
    'pub mod core;\n\npub struct App {\n    pub engine: core::Engine,\n}\n',
  );
  writeFileSync(path.join(repo, 'src/core.rs'), 'pub struct Engine {\n    pub power: u32,\n}\n');
  // Local identity only — `git commit` refuses without user.name/email
  // and we must not depend on the runner's global config.
  git('init', '-q');
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'user.name', 'E2E Harness');
  git('add', '-A');
  git('commit', '-q', '-m', 'baseline');
  // Working-tree edit produces TWO kinds of delta so both diff signals
  // are observable:
  //   • `Engine` gains a field → a *Modified* type. Modified types carry
  //     a `data-side` rollup attribute (`add` here) but NEITHER
  //     `.side-base`/`.side-head` class (those mark base-only / head-only
  //     types — see tree.ts).
  //   • `Gearbox` is brand new → a *head-only* type that DOES get the
  //     `.side-head` class.
  // Either way the changed modules light up rollup chips.
  writeFileSync(
    path.join(repo, 'src/core.rs'),
    'pub struct Engine {\n    pub power: u32,\n    pub torque: u32,\n}\n\npub struct Gearbox {\n    pub ratio: u32,\n}\n',
  );

  const child = spawn(BIN, ['view', repo, '--at', 'HEAD..', '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let url: string;
  try {
    url = await waitForReady(child);
  } catch (e) {
    child.kill();
    rmSync(repo, { recursive: true, force: true });
    throw e;
  }
  const close = async (): Promise<void> => {
    child.kill();
    rmSync(repo, { recursive: true, force: true });
  };
  return { url, close };
}

/** Worker-scoped diff-mode server fixture — the diff analogue of
 *  `viewerURL`. Specs that need diff/unified mode pull `diffURL` and
 *  `page.goto(diffURL)`; the temp repo is torn down at worker exit. */
export const diffTest = base.extend<object, { diffURL: string }>({
  diffURL: [
    async ({}, use) => {
      const server = await startDiffServer();
      await use(server.url);
      await server.close();
    },
    { scope: 'worker' },
  ],
});

/** Shape of `/api/health` relevant to diff mode. */
export interface HealthBody {
  readonly status: string;
  readonly diff_enabled: boolean;
  readonly unified_mode: boolean;
  readonly head_is_working_tree: boolean;
  readonly base_workspace_root?: string;
  readonly workspace_root: string;
}

/** Fetch and parse `/api/health`. In diff mode `diff_enabled` and
 *  `unified_mode` are both true and `base_workspace_root` is present. */
export async function fetchHealth(url: string): Promise<HealthBody> {
  const res = await fetch(apiUrl(url, '/api/health'));
  return (await res.json()) as HealthBody;
}

/** Fetch `/api/changed-files` — the per-file add/del counts that drive
 *  the module rollup chips. Non-empty in diff mode. */
export async function fetchChangedFiles(
  url: string,
): Promise<Array<{ path: string; adds: number; dels: number }>> {
  const res = await fetch(apiUrl(url, '/api/changed-files'));
  const body = (await res.json()) as { files: Array<{ path: string; adds: number; dels: number }> };
  return body.files;
}

// ── Diff side decorations (DOM readers) ──────────────────────────────
// In unified mode the SVG type boxes get `.side-base` / `.side-head`
// classes and a `data-side` rollup attribute (tree.ts); the left HTML
// tree gives module-groups `.side-{base|head|both}` and a
// `.rollup-badge` with `.rb-add` / `.rb-del` counts (html_tree.ts).

/** Count of rendered type boxes carrying each diff side class. A
 *  non-zero total is the observable signal that diff decorations
 *  rendered (vs. looking identical to normal mode). */
export async function typeBoxSideCounts(page: Page): Promise<{ base: number; head: number }> {
  return page.evaluate(() => ({
    base: document.querySelectorAll('g.type-box.side-base').length,
    head: document.querySelectorAll('g.type-box.side-head').length,
  }));
}

/** The `data-side` rollup attribute of the type box with the given id
 *  (`'add' | 'del' | 'split'`), or null when absent / unset. */
export async function typeBoxRollupSide(page: Page, typeFullPath: string): Promise<string | null> {
  return page.evaluate((id) => {
    const el = document.querySelector(`g.type-box[data-element-id="${id}"]`);
    return el === null ? null : el.getAttribute('data-side');
  }, typeFullPath);
}

/** Module rollup chips in the left HTML tree, keyed by module data-id,
 *  with their `+N` / `−M` badge text. Only modules whose subtree has a
 *  non-zero delta get a `.rollup-badge`, so the returned map is the set
 *  of changed modules the viewer surfaces. */
export async function moduleRollupBadges(
  page: Page,
): Promise<Record<string, { add: string | null; del: string | null }>> {
  return page.evaluate(() => {
    const out: Record<string, { add: string | null; del: string | null }> = {};
    for (const group of document.querySelectorAll<HTMLElement>('.module-group')) {
      const id = group.getAttribute('data-id');
      const badge = group.querySelector('.rollup-badge');
      if (id === null || badge === null) continue;
      out[id] = {
        add: badge.querySelector('.rb-add')?.textContent ?? null,
        del: badge.querySelector('.rb-del')?.textContent ?? null,
      };
    }
    return out;
  });
}

/** Diff side class on a module-group in the left tree
 *  (`'base' | 'head' | 'both'`), or null when none is applied. */
export async function moduleSide(page: Page, moduleId: string): Promise<string | null> {
  return page.evaluate((id) => {
    const g = document.querySelector(`.module-group[data-id="${id}"]`);
    if (g === null) return null;
    for (const s of ['base', 'head', 'both']) {
      if (g.classList.contains(`side-${s}`)) return s;
    }
    return null;
  }, moduleId);
}

// ── Shared interaction helpers (hover / arrow-nav / scroll / picker) ─
// These wrap the real wiring other feature-area specs need. Arrow
// hit-testing is geometric (tree.ts installArrowClickHandler): the
// handler picks arrows under the CLICK POINT on the zoom layer, so we
// drive hover/click at an arrow's painted midpoint rather than against a
// per-arrow DOM hit target. Selection surfaces as `.type-box.selected`
// (+ visible `rect.selection-ring`); the call-target picker is
// `#edge-picker`; arrow-nav disambiguation is `#arrow-disambig`.

/** Screen-space midpoint of the rendered arrow whose
 *  `data-arrow-from` / `data-arrow-to` match, or null if not found.
 *  Derived from the painted path (getPointAtLength + screen CTM) — the
 *  same geometry the user sees, reused for hover/click targeting. */
export async function arrowMidpoint(
  page: Page,
  from: string,
  to: string,
): Promise<{ x: number; y: number } | null> {
  return page.evaluate(
    ({ from, to }) => {
      const g = [...document.querySelectorAll('g.arrow')].find(
        (e) => e.getAttribute('data-arrow-from') === from && e.getAttribute('data-arrow-to') === to,
      );
      if (g === undefined) return null;
      const path = g.querySelector('path.visible') as SVGPathElement | null;
      if (path === null) return null;
      const p = path.getPointAtLength(path.getTotalLength() / 2);
      const m = path.getScreenCTM();
      if (m === null) return { x: p.x, y: p.y };
      return { x: p.x * m.a + p.y * m.c + m.e, y: p.x * m.b + p.y * m.d + m.f };
    },
    { from, to },
  );
}

/** Hover the mouse over an arrow's midpoint (drives the tree's
 *  hover-highlight path). No-op-safe: throws via the explicit null check
 *  if the arrow isn't present so a spec fails loudly rather than
 *  hovering empty canvas. */
export async function hoverArrow(page: Page, from: string, to: string): Promise<void> {
  const pt = await arrowMidpoint(page, from, to);
  if (pt === null) throw new Error(`arrow ${from} → ${to} not found to hover`);
  await page.mouse.move(pt.x, pt.y);
}

/** Click an arrow at its midpoint — exercises the zoom-layer
 *  `click.arrow-nav` hit-test (tree.ts). With a single arrow under the
 *  point the host navigates directly; with 2+ it opens the
 *  `#arrow-disambig` popover (see `isArrowDisambigOpen`). */
export async function clickArrow(page: Page, from: string, to: string): Promise<void> {
  const pt = await arrowMidpoint(page, from, to);
  if (pt === null) throw new Error(`arrow ${from} → ${to} not found to click`);
  await page.mouse.click(pt.x, pt.y);
}

/** Hover a type box by id (drives any box-level hover affordances). */
export async function hoverType(page: Page, typeFullPath: string): Promise<void> {
  await page.locator(`g.type-box[data-element-id="${typeFullPath}"]`).hover();
}

/** Click a callable row's outgoing-call `→` locality glyph
 *  (`text.locality-glyph` inside the field-row group). With 2+ callees
 *  the host opens the call-target picker (`#edge-picker`); with exactly
 *  1 it toggles that edge directly. `rowElementId` is the row's
 *  `data-element-id` (the function's full path). */
export async function clickOutgoingCallGlyph(page: Page, rowElementId: string): Promise<void> {
  await page.locator(`[data-element-id="${rowElementId}"] text.locality-glyph`).click();
}

/** True when the call-target / call-source picker (`#edge-picker`) is
 *  mounted and visible. The picker is appended on open and removed on
 *  dismiss, so presence == open. */
export async function isEdgePickerOpen(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('#edge-picker');
    return el !== null && el.offsetParent !== null;
  });
}

/** The callee/caller labels listed in the open call-target picker
 *  (`.edge-picker-row .edge-picker-main`), top to bottom. */
export async function edgePickerRowLabels(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('#edge-picker .edge-picker-row .edge-picker-main')].map(
      (e) => e.textContent ?? '',
    ),
  );
}

/** True when the arrow-nav disambiguation popover (`#arrow-disambig`) is
 *  showing (its root flips `display` from `none`). Opened when a click
 *  lands on 2+ overlapping arrows. */
export async function isArrowDisambigOpen(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('#arrow-disambig');
    return el !== null && el.style.display !== 'none';
  });
}

/** The id of the currently selected type box (the one carrying
 *  `.selected` with a painted selection ring), or null when nothing is
 *  selected. Multiple `.selected` boxes return the first. */
export async function selectedTypeId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.querySelector('g.type-box.selected');
    return el === null ? null : el.getAttribute('data-element-id');
  });
}

/** True when the type box with this id shows its selection ring — i.e.
 *  it carries `.selected` AND the ring rect has positive size (the ring
 *  is sized only for the selected box). The observable "is this focused"
 *  signal for selection specs. */
export async function hasSelectionRing(page: Page, typeFullPath: string): Promise<boolean> {
  return page.evaluate((id) => {
    const box = document.querySelector(`g.type-box[data-element-id="${id}"]`);
    if (box === null || !box.classList.contains('selected')) return false;
    const ring = box.querySelector('rect.selection-ring') as SVGGraphicsElement | null;
    if (ring === null) return false;
    const r = ring.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }, typeFullPath);
}

/** Scroll the diagram canvas viewport (`#canvas-scroll`) by a vertical
 *  delta in px. Vertical pan is native scroll (see zoom.ts), so this is
 *  how a spec moves the canvas to bring off-screen modules into view.
 *  Returns the resulting scrollTop. */
export async function scrollCanvas(page: Page, deltaY: number): Promise<number> {
  return page.evaluate((dy) => {
    const el = document.querySelector<HTMLElement>('#canvas-scroll');
    if (el === null) return 0;
    el.scrollTop += dy;
    return el.scrollTop;
  }, deltaY);
}

/** Current vertical scroll offset of the canvas viewport
 *  (`#canvas-scroll.scrollTop`). */
export async function canvasScrollTop(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelector('#canvas-scroll')?.scrollTop ?? 0);
}

/** Scroll the left HTML module tree (`#html-modules` lives inside the
 *  same `#canvas-scroll` viewport, so the tree scrolls with the
 *  canvas). Thin alias over `scrollCanvas` named for tree-navigation
 *  specs that think in terms of the module list. */
export async function scrollModuleTree(page: Page, deltaY: number): Promise<number> {
  return scrollCanvas(page, deltaY);
}
