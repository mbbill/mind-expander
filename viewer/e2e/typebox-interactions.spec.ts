// GROUP K — Tier-3 real-browser spec for the diagram type-box's HOVER and
// ANIMATION affordances. These are the behaviors that only a real browser
// (real d3 transitions, real fonts, real pointer events) can exercise, and
// that the Tier-1 binding spec (`tests/areas/typebox-glyph.render.test.ts`)
// cannot assert because jsdom does not run d3 tweens.
//
// Every oracle is a CORRECT observable result — a DOM/state/geometry change
// the user would see — never "didn't throw" and never a screenshot.
//
// Scope (the GROUP K hover/animation gaps):
//   - kind-marker hover → owner-count badge `(N)` fades in, hide on leave.
//   - field-row hover → type-hint pill (`text.field-ty`) fades in / out.
//   - chevron rotate: the type expand-arrow flips ▸→▾ on expand (and the
//     box grows: the expand/collapse TWEEN settles to a taller box).
//   - outgoing locality `→` glyph hover → grows font + reveals a distinct-
//     callee count badge `(2)`.
//   - incoming `→` marker hover → grows font + reveals a distinct-caller
//     count badge `(2)`.
//   - kind-marker pointer-events=all (it owns its own clicks).
//
// WHY a dedicated fixture: the existing `type-box-fixture` has no call
// edges, so it can't drive locality/incoming hover badges; and a clean
// single-owner type is needed for the deterministic owner-count `(1)`.
// `e2e/typebox-interactions-fixture` ships exactly that shape (see its
// lib.rs). The shared `_harness.ts` server fixture is hard-wired to the
// geometry fixture, so this spec spawns its own server (same `ready`-line
// protocol) while reusing the shared interaction helpers.

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { expect, expandModule, expandType, test, waitForLayoutSettled } from './_harness.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN =
  process.env.MIND_EXPANDER_BIN ?? path.resolve(HERE, '../../target/debug/mind-expander');
const WORKSPACE = path.resolve(HERE, 'typebox-interactions-fixture');
const READY_TIMEOUT_MS = 30_000;

const CRATE = 'tbi_fixture';
const ENGINE = `${CRATE}::Engine`;
const POWER_FIELD = `${ENGINE}::power`;
const PUB_FNS = `${CRATE}::__fn_pub`;
const DISPATCH = `${CRATE}::dispatch`;
const LOG = `${CRATE}::helpers::log`;
const HELPERS = `${CRATE}::helpers`;
const HELPERS_PUB_FNS = `${CRATE}::helpers::__fn_pub`;

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
        /* banner line — ignore */
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

// ── helpers ──────────────────────────────────────────────────────────

/** Read the rendered opacity (computed style, honoring in-flight d3 tweens)
 *  of the first element matching `selector`, or null if absent. */
async function opacityOf(page: Page, selector: string): Promise<number | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) return null;
    const o = getComputedStyle(el as Element).opacity;
    return o === '' ? null : Number(o);
  }, selector);
}

/** Font-size (px) of the first element matching `selector`, or null. */
async function fontSizeOf(page: Page, selector: string): Promise<number | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) return null;
    const fs = getComputedStyle(el as Element).fontSize;
    return fs === '' ? null : Number.parseFloat(fs);
  }, selector);
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  (page as unknown as { __errs: string[] }).__errs = errors;
  await page.goto(server.url);
  await expect(page.locator(`.module-group[data-id="${CRATE}"]`)).toBeVisible();
  await expandModule(page, CRATE);
  await expect(page.locator(`g.type-box[data-element-id="${ENGINE}"]`)).toBeVisible();
  await waitForLayoutSettled(page);
});

function assertNoPageErrors(page: Page): void {
  const errors = (page as unknown as { __errs: string[] }).__errs ?? [];
  expect(errors, `page errors: ${errors.join('; ')}`).toHaveLength(0);
}

/** Expand both function groups so every free-function row + its glyphs
 *  render. */
async function expandAllFunctions(page: Page): Promise<void> {
  await expandModule(page, HELPERS);
  await expect(page.locator(`g.type-box[data-element-id="${PUB_FNS}"]`)).toBeVisible();
  await expect(page.locator(`g.type-box[data-element-id="${HELPERS_PUB_FNS}"]`)).toBeVisible();
  await expandType(page, PUB_FNS);
  await expandType(page, HELPERS_PUB_FNS);
  await expect(page.locator(`[data-element-id="${DISPATCH}"] text.locality-glyph`)).toBeVisible();
  await waitForLayoutSettled(page);
}

// ── tests ────────────────────────────────────────────────────────────

test('hovering the kind marker reveals an owner-count badge reading the owner count, hidden on leave', async ({
  page,
}) => {
  // Engine is owned by exactly one type (App.engine), so the badge reads (1).
  const marker = page.locator(`g.type-box[data-element-id="${ENGINE}"] text.kind-marker`);
  const badgeSel = `g.type-box[data-element-id="${ENGINE}"] text.owner-count-badge`;

  // No badge in the DOM before any hover (it is created lazily on enter).
  await expect(page.locator(badgeSel)).toHaveCount(0);

  await marker.hover();
  // The badge appears, reads the real owner count, and fades to opacity 1.
  await expect(page.locator(badgeSel)).toHaveText('(1)');
  await expect.poll(() => opacityOf(page, badgeSel)).toBeGreaterThan(0.9);

  // Move the pointer off the marker → the badge fades back to opacity 0.
  await page.locator(`g.type-box[data-element-id="${CRATE}::App"]`).hover();
  await expect.poll(() => opacityOf(page, badgeSel)).toBeLessThan(0.1);

  assertNoPageErrors(page);
});

test('hovering a field row fades the type-hint pill in, and leaving fades it out', async ({
  page,
}) => {
  // Reveal Engine's fields.
  await expandType(page, ENGINE);
  const powerName = page.locator(
    `g.field-row-g[data-element-id="${POWER_FIELD}"] text.field-row`,
  );
  await expect(powerName).toHaveText('power');
  const tySel = `g.field-row-g[data-element-id="${POWER_FIELD}"] text.field-ty`;

  // The type-hint (`u32`) is hidden by default (opacity 0), not absent.
  await expect(page.locator(tySel)).toHaveText('u32');
  await expect.poll(() => opacityOf(page, tySel)).toBeLessThan(0.1);

  // Hover the field name → the hint pill fades in (120ms tween settles to 1).
  await powerName.hover();
  await expect.poll(() => opacityOf(page, tySel)).toBeGreaterThan(0.9);

  // Leave → it fades back out (TY_HIDE_DELAY=0 then a 200ms fade-out).
  // Move the pointer to an empty corner of the viewport so the power row's
  // mouseleave fires (hovering another header is intercepted by its hit rect).
  await page.mouse.move(2, 2);
  await expect.poll(() => opacityOf(page, tySel)).toBeLessThan(0.1);

  assertNoPageErrors(page);
});

test('expanding a type rotates the chevron ▸→▾ and tweens the box to a taller height', async ({
  page,
}) => {
  const arrow = page.locator(`g.type-box[data-element-id="${ENGINE}"] text.expand-arrow`);
  await expect(arrow).toHaveText('▸');

  const collapsedH = await page.evaluate((id) => {
    const el = document.querySelector(`g.type-box[data-element-id="${id}"]`);
    return el === null ? null : (el as SVGGraphicsElement).getBoundingClientRect().height;
  }, ENGINE);
  expect(collapsedH).not.toBeNull();

  await expandType(page, ENGINE);
  await waitForLayoutSettled(page);

  // Chevron rotated to the open glyph.
  await expect(arrow).toHaveText('▾');

  // The expand/collapse TWEEN settled to a TALLER box (fields + bucket now
  // occupy real vertical space). A box that never grew would mean the tween
  // or the field render silently dropped.
  const expandedH = await page.evaluate((id) => {
    const el = document.querySelector(`g.type-box[data-element-id="${id}"]`);
    return el === null ? null : (el as SVGGraphicsElement).getBoundingClientRect().height;
  }, ENGINE);
  expect(expandedH).not.toBeNull();
  expect(expandedH as number).toBeGreaterThan((collapsedH as number) + 1);

  // Collapse again → chevron flips back and the box shrinks to ~original.
  await expandType(page, ENGINE);
  await waitForLayoutSettled(page);
  await expect(arrow).toHaveText('▸');

  assertNoPageErrors(page);
});

test('hovering the outgoing locality glyph grows it and reveals a distinct-callee count badge', async ({
  page,
}) => {
  await expandAllFunctions(page);
  const glyph = page.locator(`[data-element-id="${DISPATCH}"] text.locality-glyph`);
  const badgeSel = `g.field-row-g[data-element-id="${DISPATCH}"] text.locality-count-badge`;

  const restSize = await fontSizeOf(page, `[data-element-id="${DISPATCH}"] text.locality-glyph`);
  expect(restSize).not.toBeNull();

  await glyph.hover();

  // dispatch() calls 2 DISTINCT callees (validate, helpers::log) — the badge
  // counts distinct callees, not raw call edges.
  await expect(page.locator(badgeSel)).toHaveText('(2)');
  await expect.poll(() => opacityOf(page, badgeSel)).toBeGreaterThan(0.9);

  // The glyph grows on hover (CALL_MARKER_HOVER_FONT_SIZE > rest size).
  await expect
    .poll(() => fontSizeOf(page, `[data-element-id="${DISPATCH}"] text.locality-glyph`))
    .toBeGreaterThan(restSize as number);

  assertNoPageErrors(page);
});

test('hovering the incoming-call marker grows it and reveals a distinct-caller count badge', async ({
  page,
}) => {
  await expandAllFunctions(page);
  // helpers::log() is called by dispatch() AND validate() → 2 distinct callers.
  const marker = page.locator(`[data-element-id="${LOG}"] text.incoming-call-marker`);
  const badgeSel = `g.field-row-g[data-element-id="${LOG}"] text.incoming-count-badge`;
  await expect(marker).toBeVisible();

  const restSize = await fontSizeOf(page, `[data-element-id="${LOG}"] text.incoming-call-marker`);
  expect(restSize).not.toBeNull();

  await marker.hover();

  await expect(page.locator(badgeSel)).toHaveText('(2)');
  await expect.poll(() => opacityOf(page, badgeSel)).toBeGreaterThan(0.9);
  await expect
    .poll(() => fontSizeOf(page, `[data-element-id="${LOG}"] text.incoming-call-marker`))
    .toBeGreaterThan(restSize as number);

  assertNoPageErrors(page);
});

test('the kind marker owns its pointer events (clickable affordance, not covered by the hit rect)', async ({
  page,
}) => {
  const marker = page.locator(`g.type-box[data-element-id="${ENGINE}"] text.kind-marker`);
  await expect(marker).toHaveAttribute('pointer-events', 'all');
  // It is the topmost element at its own center — a real click target, not
  // shadowed by the transparent expand-hit rect.
  const topmostClass = await page.evaluate((id) => {
    const m = document.querySelector(`g.type-box[data-element-id="${id}"] text.kind-marker`);
    if (m === null) return null;
    const r = (m as SVGGraphicsElement).getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return top === null ? null : top.getAttribute('class');
  }, ENGINE);
  expect(topmostClass, 'kind marker is the hit-test winner at its center').toBe('kind-marker');

  assertNoPageErrors(page);
});
