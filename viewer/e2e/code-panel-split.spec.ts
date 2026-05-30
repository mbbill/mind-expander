// GROUP B — Modified-entity (split-on-change) diff fixture, Tier-3.
//
// The shared diff fixture (_harness.ts startDiffServer) edits `Engine` so
// it gains a `torque` field → a *Modified* type. Opening it in the code
// panel takes the /api/diff path and renders the dual del/add block.
//
// code-panel-modes.spec.ts already asserts the ADD row renders + is
// tinted green. This spec covers the GROUP B gaps that file does NOT:
//   • the purple `#a855f7` focus-frame left border actually paints on the
//     entity-row (the real CSS, not just the class) — cp-diff "entity-row
//     purple left border in diff";
//   • the hunk lines are Prism-tokenized in the real browser (token spans
//     present on a change row) — cp-diff "Diff hunk lines Prism
//     highlighted".

import { diffTest, expandModule, expect } from './_harness.ts';
import type { Page } from '@playwright/test';

/** Dispatch a real Cmd-modified click — the diagram's Cmd/Ctrl+click
 *  affordance that opens the code panel at the clicked element's source. */
async function cmdClick(page: Page, selector: string): Promise<void> {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) throw new Error(`cmdClick: no element for ${sel}`);
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
  }, selector);
}

/** Parse a CSS color string ("rgb(168, 85, 247)" / "#a855f7") into
 *  {r,g,b}. Browsers normalize computed colors to rgb()/rgba(); we accept
 *  both so the oracle isn't tied to one serialization. */
function parseColor(c: string): { r: number; g: number; b: number } | null {
  const rgb = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(c);
  if (rgb !== null) return { r: +rgb[1]!, g: +rgb[2]!, b: +rgb[3]! };
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c.trim());
  if (hex !== null) {
    return { r: parseInt(hex[1]!, 16), g: parseInt(hex[2]!, 16), b: parseInt(hex[3]!, 16) };
  }
  return null;
}

const PURPLE = { r: 0xa8, g: 0x55, b: 0xf7 }; // #a855f7, the focus-frame color

/** Open the code panel on the Modified `Engine` type via Cmd+click and
 *  wait for the diff render (an add row appears). */
async function openModifiedEngine(page: Page, diffURL: string): Promise<void> {
  await page.goto(diffURL);
  await expect(page.locator('.module-group[data-id="diff_fixture"]')).toBeVisible();
  await expandModule(page, 'diff_fixture');
  await expandModule(page, 'diff_fixture::core');
  const engine = 'diff_fixture::core::Engine';
  await expect(page.locator(`g.type-box[data-element-id="${engine}"]`)).toBeVisible();
  await cmdClick(page, `g.type-box[data-element-id="${engine}"] .expand-hit`);
  await expect(page.locator('#code-panel')).toBeVisible();
  await expect
    .poll(() => page.locator('.code-panel-line[data-kind="add"]').count())
    .toBeGreaterThan(0);
}

diffTest('modified entity: focus-frame entity-row paints the purple #a855f7 left border', async ({
  page,
  diffURL,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await openModifiedEngine(page, diffURL);

  // The render tags rows inside the entity span with `.entity-row`; the
  // CSS `.code-panel-line.entity-row { border-left-color: #a855f7 }` is
  // what makes the focus frame visible. Assert at least one entity-row
  // exists AND its computed left border is the purple, not transparent.
  await expect
    .poll(() => page.locator('.code-panel-line.entity-row').count())
    .toBeGreaterThan(0);

  const borderColor = await page.evaluate(() => {
    const el = document.querySelector('.code-panel-line.entity-row');
    return el === null ? null : getComputedStyle(el).borderLeftColor;
  });
  expect(borderColor, 'entity-row has a computed left border color').not.toBeNull();
  const parsed = parseColor(borderColor as string);
  expect(parsed, `border color "${borderColor}" parses`).not.toBeNull();
  expect(parsed).toEqual(PURPLE);

  // A non-entity context row must NOT carry the purple frame — the
  // transparent base border collapses to the row background / black, so
  // it is definitely not #a855f7. Guards against a CSS rule that paints
  // every row purple.
  const nonEntityBorder = await page.evaluate(() => {
    const el = document.querySelector('.code-panel-line:not(.entity-row)');
    return el === null ? null : getComputedStyle(el).borderLeftColor;
  });
  if (nonEntityBorder !== null) {
    const np = parseColor(nonEntityBorder);
    // Either unparseable (transparent keyword) or simply not the purple.
    expect(np === null || !(np.r === PURPLE.r && np.g === PURPLE.g && np.b === PURPLE.b)).toBe(true);
  }

  expect(errors, `page errors: ${errors.join('; ')}`).toHaveLength(0);
});

diffTest('modified entity: diff hunk add/del lines are Prism-tokenized in the browser', async ({
  page,
  diffURL,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await openModifiedEngine(page, diffURL);

  // Each hunk line gets its own Prism pass. The inserted `pub torque:
  // u32,` field row must render Prism token spans (e.g. the `pub`
  // keyword), not bare text — a per-line highlight regression would drop
  // the `.token` spans and the row would be plain text.
  const addHasTokens = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.code-panel-line[data-kind="add"]')];
    return rows.some((r) => r.querySelector('.code-panel-text .token') !== null);
  });
  expect(addHasTokens, 'an add row carries Prism .token spans').toBe(true);

  // The `pub` keyword specifically renders as a keyword token.
  const hasPubKeyword = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.code-panel-line[data-kind="add"]')];
    return rows.some((r) =>
      [...r.querySelectorAll('.code-panel-text .token.keyword')].some(
        (t) => (t.textContent ?? '').trim() === 'pub',
      ),
    );
  });
  expect(hasPubKeyword, 'the inserted field row tokenizes `pub` as a keyword').toBe(true);

  expect(errors, `page errors: ${errors.join('; ')}`).toHaveLength(0);
});
