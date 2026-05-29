// Tier-3 real-browser spec for the `call-graph-arrows` feature area.
//
// The base fixture-workspace (geometry.spec) has only structs, so it
// produces ZERO call edges. Call arrows need functions that call each
// other, so this spec spawns its OWN `mind-expander view` server against
// a dedicated `e2e/calls-fixture` crate (added alongside this spec) using
// the same spawn/ready-line pattern startServer/startDiffServer use in
// the shared harness — without editing any shared file.
//
// calls-fixture shape (free functions, deterministic):
//   crate root:   dispatch() -> validate()            (same module → LOCAL/grey)
//                 dispatch() -> helpers::format()      (other module → EXTERNAL/blue)
//                 dispatch() -> helpers::log()         (other module → EXTERNAL/blue)
//                 validate() -> helpers::log()
//   module helpers: format(), log()  (log() has 2 distinct callers)
//
// Function rows become a `function_group` pseudo-type per module. The
// renderer's endpoint ids strip the `__fn_*` group suffix and append the
// row name, so a call arrow's data-arrow-from/to are the function full
// paths (e.g. `calls_fixture::dispatch` → `calls_fixture::validate`).
//
// Every oracle below is a real observable DOM / geometry / state change
// (arrow stroke color, picker open + row labels, arrow midpoint landing
// under the click anchor, hover not rebuilding the layout). A screenshot
// is the on-failure artifact only — never the pass/fail signal.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { type Page, test as base } from '@playwright/test';
import {
  arrowMidpoint,
  clickOutgoingCallGlyph,
  edgePickerRowLabels,
  expandModule,
  expandType,
  expect,
  waitForLayoutSettled,
} from './_harness.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = process.env.MIND_EXPANDER_BIN ?? path.resolve(HERE, '../../target/debug/mind-expander');
const CALLS_WORKSPACE = path.resolve(HERE, 'calls-fixture');
const READY_TIMEOUT_MS = 30_000;

interface SpawnedServer {
  readonly stdout: Readable;
  on(event: 'error', listener: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

// Same ready-line contract as the shared harness (a JSON `ready` line on
// stdout carrying the bound url). Re-derived locally so this spec doesn't
// have to export new surface from _harness.ts.
function waitForReady(child: SpawnedServer): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`calls server never emitted ready within ${READY_TIMEOUT_MS}ms`));
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
        // banner line — ignore.
      }
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

// Worker-scoped server fixture pointed at the calls-fixture crate (the
// call-graph analogue of the harness's `viewerURL`).
const test = base.extend<object, { callsURL: string }>({
  callsURL: [
    async ({}, use) => {
      const child = spawn(BIN, ['view', CALLS_WORKSPACE, '--port', '0'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const url = await waitForReady(child);
      await use(url);
      child.kill();
    },
    { scope: 'worker' },
  ],
});

const CRATE = 'calls_fixture';
const HELPERS = 'calls_fixture::helpers';
const PUB_FNS = 'calls_fixture::__fn_pub';
const HELPERS_PUB_FNS = 'calls_fixture::helpers::__fn_pub';
const DISPATCH = 'calls_fixture::dispatch';
const VALIDATE = 'calls_fixture::validate';
const FORMAT = 'calls_fixture::helpers::format';
const LOG = 'calls_fixture::helpers::log';

const BLUE = '#2563eb'; // COLOR_CALL_EXTERNAL — cross-module call arrows.

// Expand both modules and both function-group boxes so every function
// row (and its locality glyph) renders.
async function expandAllFunctions(page: Page): Promise<void> {
  await expandModule(page, CRATE);
  await expandModule(page, HELPERS);
  await expect(page.locator(`g.type-box[data-element-id="${PUB_FNS}"]`)).toBeVisible();
  await expect(page.locator(`g.type-box[data-element-id="${HELPERS_PUB_FNS}"]`)).toBeVisible();
  await expandType(page, PUB_FNS);
  await expandType(page, HELPERS_PUB_FNS);
  // The dispatch row carries the outgoing locality glyph once its
  // function group is expanded.
  await expect(page.locator(`[data-element-id="${DISPATCH}"] text.locality-glyph`)).toBeVisible();
  await waitForLayoutSettled(page);
}

// Read the painted stroke color of the call arrow matching from→to.
async function callArrowStroke(page: Page, from: string, to: string): Promise<string | null> {
  return page.evaluate(
    ({ from, to }) => {
      const g = [...document.querySelectorAll('g.arrow')].find(
        (e) => e.getAttribute('data-arrow-from') === from && e.getAttribute('data-arrow-to') === to,
      );
      if (g === undefined) return null;
      const path = g.querySelector('path.visible');
      return path === null ? null : path.getAttribute('stroke');
    },
    { from, to },
  );
}

// Whether the call-target picker (`#edge-picker`) is open. NOTE: the
// harness's `isEdgePickerOpen` checks `offsetParent !== null`, which is
// always null for the picker's `position:fixed` root — so it reports
// `false` even when the picker is fully shown. The real open-state toggle
// the module flips is `root.style.display` ('block' on show, 'none' on
// hide), so this spec reads that directly.
async function pickerOpen(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('#edge-picker');
    return el !== null && el.style.display !== 'none';
  });
}

// Fill of the outgoing locality glyph on a function row.
async function localityGlyphFill(page: Page, rowElementId: string): Promise<string | null> {
  return page.evaluate((id) => {
    const glyph = document.querySelector(`[data-element-id="${id}"] text.locality-glyph`);
    return glyph === null ? null : glyph.getAttribute('fill');
  }, rowElementId);
}

let pageErrors: string[];

test.beforeEach(async ({ page, callsURL }) => {
  pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(callsURL);
  await expect(page.locator(`.module-group[data-id="${CRATE}"]`)).toBeVisible();
  await expandAllFunctions(page);
});

test.afterEach(() => {
  // No interaction in this area may throw in the page. Asserted after the
  // test body so a failure points at the offending step's leftover errors.
  expect(pageErrors, `page errors: ${pageErrors.join('; ')}`).toHaveLength(0);
});

test('clicking the outgoing locality glyph opens the call-target picker listing every distinct callee', async ({
  page,
}) => {
  // dispatch() calls three distinct functions, so the glyph click opens
  // the picker (>1 callee) rather than auto-toggling a single edge.
  await clickOutgoingCallGlyph(page, DISPATCH);
  await expect.poll(() => pickerOpen(page)).toBe(true);

  // The picker lists one row per DISTINCT callee — validate(), format(),
  // log() — never the raw call-edge count.
  const labels = await edgePickerRowLabels(page);
  expect(labels.sort()).toEqual(['format()', 'log()', 'validate()']);
});

test('picking a callee reveals its call arrow and lands the target endpoint under the click anchor', async ({
  page,
}) => {
  await clickOutgoingCallGlyph(page, DISPATCH);
  await expect.poll(() => pickerOpen(page)).toBe(true);

  // Click the validate() row. The host pans so the arrow's target endpoint
  // lands at the click anchor (the row's screen position), so we capture
  // that anchor and assert the painted arrow end settles near it.
  const row = page.locator('#edge-picker .edge-picker-row', { hasText: 'validate()' });
  const box = await row.boundingBox();
  expect(box, 'validate() picker row box').not.toBeNull();
  const anchor = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
  await row.click();

  // Picker dismisses on pick.
  await expect.poll(() => pickerOpen(page)).toBe(false);

  // The dispatch → validate call arrow now exists in the DOM.
  const arrowLoc = page.locator(
    `g.arrow[data-arrow-from="${DISPATCH}"][data-arrow-to="${VALIDATE}"]`,
  );
  await expect(arrowLoc).toHaveCount(1);
  await waitForLayoutSettled(page);

  // The painted arrow's target endpoint (its midpoint is a stable proxy
  // that travels with the pan) landed near where the user clicked — NOT a
  // viewport-center jump. The whole point of navigateToArrowEndpoint.
  const mid = await arrowMidpoint(page, DISPATCH, VALIDATE);
  expect(mid, 'dispatch→validate arrow midpoint').not.toBeNull();
  // Generous tolerance: the anchor is the click point and the routed
  // endpoint pans there; the midpoint sits within the routed span of a
  // short same-module arrow, comfortably within a few hundred px of the
  // anchor (a center-jump would be a full half-viewport, ~700px, away).
  expect(Math.abs(mid!.x - anchor.x)).toBeLessThan(400);
  expect(Math.abs(mid!.y - anchor.y)).toBeLessThan(400);
});

test('same-module call arrow renders grey, cross-module call arrow renders blue', async ({
  page,
}) => {
  // Reveal dispatch's whole fan via show-all so both a local and an
  // external arrow are painted at once.
  await clickOutgoingCallGlyph(page, DISPATCH);
  await expect.poll(() => pickerOpen(page)).toBe(true);
  await page.locator('#edge-picker .edge-picker-toolbar button', { hasText: 'show all' }).click();
  await expect.poll(() => pickerOpen(page)).toBe(false);

  // All three arrows materialize.
  await expect(
    page.locator(`g.arrow[data-arrow-from="${DISPATCH}"][data-arrow-to="${VALIDATE}"]`),
  ).toHaveCount(1);
  await expect(
    page.locator(`g.arrow[data-arrow-from="${DISPATCH}"][data-arrow-to="${FORMAT}"]`),
  ).toHaveCount(1);
  await waitForLayoutSettled(page);

  // dispatch → validate is SAME module → canonical grey (NOT blue).
  const localStroke = await callArrowStroke(page, DISPATCH, VALIDATE);
  expect(localStroke).not.toBeNull();
  expect(localStroke!.toLowerCase()).not.toBe(BLUE);

  // dispatch → helpers::format is CROSS module → blue. This is the
  // grey-vs-blue locality bug guard: a single hardcoded color would make
  // both arrows identical.
  const externalStroke = await callArrowStroke(page, DISPATCH, FORMAT);
  expect(externalStroke?.toLowerCase()).toBe(BLUE);

  // The two must DISAGREE — locality is observable on the wire.
  expect(localStroke!.toLowerCase()).not.toBe(externalStroke!.toLowerCase());
});

test('the outgoing locality glyph color matches the external (blue) arrow color', async ({
  page,
}) => {
  // dispatch() touches another module (format/log), so its glyph is the
  // same blue as its external call arrows — one source of truth.
  const fill = await localityGlyphFill(page, DISPATCH);
  expect(fill?.toLowerCase()).toBe(BLUE);
});

test('the incoming-call marker on a callee opens a picker fanning its distinct callers', async ({
  page,
}) => {
  // log() is called by dispatch() AND validate() → 2 distinct callers.
  // Its incoming marker (left `→`) opens the caller picker.
  const marker = page.locator(`[data-element-id="${LOG}"] text.incoming-call-marker`);
  await expect(marker).toBeVisible();
  await marker.click();
  await expect.poll(() => pickerOpen(page)).toBe(true);

  const labels = await edgePickerRowLabels(page);
  expect(labels.sort()).toEqual(['dispatch()', 'validate()']);
});

test('hovering a function row does not materialize or rebuild call arrows', async ({ page }) => {
  // Baseline: nothing revealed yet, so no call arrows are painted.
  await expect(page.locator('g.arrow')).toHaveCount(0);

  // Hover the dispatch row and its glyph. The laggy-preview bug was a
  // hover handler that rebuilt the whole layout / drew arrows on mouseover.
  await page.locator(`[data-element-id="${DISPATCH}"] text.locality-glyph`).hover();
  await page.locator(`g.type-box[data-element-id="${PUB_FNS}"]`).hover();
  // Give any (buggy) rebuild a chance to land before asserting.
  await waitForLayoutSettled(page);

  // Hover produced ZERO call arrows — the count badge may appear, but no
  // routed arrow is materialized until an explicit reveal.
  await expect(page.locator('g.arrow')).toHaveCount(0);
});
