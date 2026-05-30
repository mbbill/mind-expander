// Tier-3 real-browser spec for GROUP H — call-arrow picker INTERACTIONS
// not covered by call-graph-arrows.spec.ts:
//   - 1-callee glyph click AUTO-TOGGLES the single arrow (no picker).
//   - 1-caller incoming-marker click AUTO-TOGGLES (no picker).
//   - Hovering the glyph / incoming marker reveals a DISTINCT-count badge
//     and grows the marker font (real hover + real-font geometry — only a
//     browser can drive these).
//   - The picker bolds active edges (per specificCallArrowsShown) and the
//     "hide all" toolbar button clears a revealed fan.
//
// Reuses the existing `e2e/calls-fixture` crate (no new fixture needed):
//   dispatch() -> validate(), helpers::format(), helpers::log()  (3 callees)
//   validate() -> helpers::log()                                 (1 callee)
//   helpers::format()  called only by dispatch()                 (1 caller)
//   helpers::log()     called by dispatch() AND validate()       (2 callers)
//
// So validate() is the 1-callee auto-toggle case, format() the 1-caller
// auto-toggle case, and dispatch()/log() the multi (picker) cases.
//
// Every oracle is an observable DOM / geometry / state change. A
// screenshot is the on-failure artifact only — never the pass/fail signal.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { type Page, test as base } from '@playwright/test';
import {
  clickOutgoingCallGlyph,
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

async function expandAllFunctions(page: Page): Promise<void> {
  await expandModule(page, CRATE);
  await expandModule(page, HELPERS);
  await expect(page.locator(`g.type-box[data-element-id="${PUB_FNS}"]`)).toBeVisible();
  await expect(page.locator(`g.type-box[data-element-id="${HELPERS_PUB_FNS}"]`)).toBeVisible();
  await expandType(page, PUB_FNS);
  await expandType(page, HELPERS_PUB_FNS);
  await expect(page.locator(`[data-element-id="${DISPATCH}"] text.locality-glyph`)).toBeVisible();
  await waitForLayoutSettled(page);
}

async function pickerOpen(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('#edge-picker');
    return el !== null && el.style.display !== 'none';
  });
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
  expect(pageErrors, `page errors: ${pageErrors.join('; ')}`).toHaveLength(0);
});

test('1-callee glyph click auto-toggles the single arrow without opening the picker', async ({
  page,
}) => {
  // validate() calls exactly ONE function (helpers::log). Clicking its
  // locality glyph must NOT open the picker — it toggles that one arrow
  // directly (the 1-edge auto-toggle short-circuit).
  await expect(
    page.locator(`g.arrow[data-arrow-from="${VALIDATE}"][data-arrow-to="${LOG}"]`),
  ).toHaveCount(0);

  await clickOutgoingCallGlyph(page, VALIDATE);
  // Give the picker a chance to (wrongly) open before asserting it didn't.
  await waitForLayoutSettled(page);
  expect(await pickerOpen(page)).toBe(false);

  // The single validate → log arrow materialized directly.
  await expect(
    page.locator(`g.arrow[data-arrow-from="${VALIDATE}"][data-arrow-to="${LOG}"]`),
  ).toHaveCount(1);

  // Clicking again toggles it back OFF (still no picker).
  await clickOutgoingCallGlyph(page, VALIDATE);
  await waitForLayoutSettled(page);
  expect(await pickerOpen(page)).toBe(false);
  await expect(
    page.locator(`g.arrow[data-arrow-from="${VALIDATE}"][data-arrow-to="${LOG}"]`),
  ).toHaveCount(0);
});

test('1-caller incoming marker click auto-toggles the single arrow without opening the picker', async ({
  page,
}) => {
  // helpers::format() is called by exactly ONE function (dispatch).
  // Clicking its incoming marker toggles the dispatch → format arrow
  // directly without a caller picker.
  const marker = page.locator(`[data-element-id="${FORMAT}"] text.incoming-call-marker`);
  await expect(marker).toBeVisible();
  await expect(
    page.locator(`g.arrow[data-arrow-from="${DISPATCH}"][data-arrow-to="${FORMAT}"]`),
  ).toHaveCount(0);

  await marker.click();
  await waitForLayoutSettled(page);
  expect(await pickerOpen(page)).toBe(false);

  await expect(
    page.locator(`g.arrow[data-arrow-from="${DISPATCH}"][data-arrow-to="${FORMAT}"]`),
  ).toHaveCount(1);
});

test('hovering the outgoing glyph shows a distinct-callee count badge and grows the marker', async ({
  page,
}) => {
  // dispatch() has 3 distinct callees → badge reads (3). The marker grows
  // from font-size 11 to 14 on hover (real hover transition).
  const glyph = page.locator(`[data-element-id="${DISPATCH}"] text.locality-glyph`);
  const baseSize = await glyph.getAttribute('font-size');
  expect(baseSize).toBe('11');

  await glyph.hover();

  const badge = page.locator(`[data-element-id="${DISPATCH}"] text.locality-count-badge`);
  await expect(badge).toHaveText('(3)');
  // The marker font grows on hover (transition lands at 14).
  await expect.poll(() => glyph.getAttribute('font-size')).toBe('14');
});

test('hovering the incoming marker shows a distinct-caller count badge (deduped)', async ({
  page,
}) => {
  // log() is called by dispatch() AND validate() → 2 DISTINCT callers, so
  // the incoming badge reads (2). (Even though there are 2 separate call
  // edges, the count is distinct-callers.)
  const marker = page.locator(`[data-element-id="${LOG}"] text.incoming-call-marker`);
  await expect(marker).toBeVisible();
  await marker.hover();

  const badge = page.locator(`[data-element-id="${LOG}"] text.incoming-count-badge`);
  await expect(badge).toHaveText('(2)');
  await expect.poll(() => marker.getAttribute('font-size')).toBe('14');
});

test('the picker bolds already-active edges and hide-all clears a revealed fan', async ({
  page,
}) => {
  // Reveal dispatch's whole fan via show-all first.
  await clickOutgoingCallGlyph(page, DISPATCH);
  await expect.poll(() => pickerOpen(page)).toBe(true);
  await page.locator('#edge-picker .edge-picker-toolbar button', { hasText: 'show all' }).click();
  await expect.poll(() => pickerOpen(page)).toBe(false);
  await expect(
    page.locator(`g.arrow[data-arrow-from="${DISPATCH}"][data-arrow-to="${VALIDATE}"]`),
  ).toHaveCount(1);

  // Re-open the picker: every entry is now active → bold (.active class).
  await clickOutgoingCallGlyph(page, DISPATCH);
  await expect.poll(() => pickerOpen(page)).toBe(true);
  const rows = page.locator('#edge-picker .edge-picker-row');
  const total = await rows.count();
  const active = await page.locator('#edge-picker .edge-picker-row.active').count();
  // All three resolved callee rows are active (validate/format/log are all
  // workspace rows, so none are unresolved).
  expect(total).toBe(3);
  expect(active).toBe(3);

  // hide-all clears the whole fan.
  await page.locator('#edge-picker .edge-picker-toolbar button', { hasText: 'hide all' }).click();
  await expect.poll(() => pickerOpen(page)).toBe(false);
  await waitForLayoutSettled(page);
  await expect(
    page.locator(`g.arrow[data-arrow-from="${DISPATCH}"][data-arrow-to="${VALIDATE}"]`),
  ).toHaveCount(0);
  await expect(
    page.locator(`g.arrow[data-arrow-from="${DISPATCH}"][data-arrow-to="${FORMAT}"]`),
  ).toHaveCount(0);
  await expect(
    page.locator(`g.arrow[data-arrow-from="${DISPATCH}"][data-arrow-to="${LOG}"]`),
  ).toHaveCount(0);
});
