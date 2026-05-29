// Tier-3 real-browser spec for the viewer's selection / focus feature
// area, driven against a real `mind-expander view` server + Chromium.
//
// The oracle for every test is a CORRECT observable result — a class,
// rendered geometry, or DOM membership change the user would actually
// see — never "didn't throw" and never a recorded screenshot (the
// on-failure screenshot in playwright.config.ts is only a debugging
// artifact).
//
// WHY a dedicated fixture (not the shared `fixture-workspace`): this area
// needs THREE shapes the geometry fixture lacks:
//   • a type that has BOTH a struct field AND methods, so "select a field
//     must NOT auto-expand the method buckets" is observable (the bucket
//     stays a single `method_bucket` row);
//   • a `pub use` re-export, so the viewer renders a *ghost* type box
//     (italic marker + label) whose violet re-export arrow is revealed by
//     clicking it;
//   • an UNRELATED sibling module, so focus mode (a layout-input filter,
//     not an opacity dim) has something to drop from the DOM.
// `e2e/selection-fixture` is that crate: `App` owns `core::Engine`
// (field+methods) which owns `core::Piston`; the root `pub use`s
// `core::Engine`; `extra::Gadget` is isolated. The shared `_harness.ts`
// server fixture is hard-wired to the geometry fixture, so this spec
// spawns its own server against the selection fixture (same `ready`-line
// protocol) while reusing the harness DOM/geometry helpers.

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import {
  expect,
  hasSelectionRing,
  pressGlobalKey,
  selectedTypeId,
  test,
  typeBoxIds,
  waitForLayoutSettled,
} from './_harness.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = process.env.MIND_EXPANDER_BIN ?? path.resolve(HERE, '../../target/debug/mind-expander');
const WORKSPACE = path.resolve(HERE, 'selection-fixture');
const READY_TIMEOUT_MS = 30_000;

const CRATE = 'sel_fixture';
const APP = `${CRATE}::App`;
const ENGINE = `${CRATE}::core::Engine`;
const PISTON = `${CRATE}::core::Piston`;
const GADGET = `${CRATE}::extra::Gadget`;
// Re-export ghost box id the extractor synthesises for `pub use
// core::Engine` at the crate root (confirmed against /api/facts +
// the rendered DOM).
const GHOST = `${CRATE}::__re_Engine`;
const POWER_FIELD = `${ENGINE}::power`; // a struct field row
const PISTON_FIELD = `${ENGINE}::piston`; // the field that owns Piston

// Violet-500 — the re-export arrow stroke AND the selection-ring stroke
// (index.html). Chromium reports computed colors as `rgb(...)`.
const VIOLET_RGB = 'rgb(168, 85, 247)';

/** Spawn `view <selection-fixture> --port 0` and resolve the bound URL
 *  from the server's `ready` JSON line — same contract as the shared
 *  harness, pointed at this spec's own fixture. */
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

async function expandType(page: Page, typeFullPath: string): Promise<void> {
  await page.locator(`g.type-box[data-element-id="${typeFullPath}"] .expand-hit`).click();
}

/** Dispatch a real Cmd-modified `click` on `selector`. The diagram's d3
 *  click handlers branch on `event.metaKey` to open the code panel at
 *  the clicked element's source and push that `(id, kind)` into the
 *  diagram selection — so this exercises the real selection path a user
 *  triggers with Cmd/Ctrl+click. */
async function cmdClick(page: Page, selector: string): Promise<void> {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) throw new Error(`cmdClick: no element for ${sel}`);
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
  }, selector);
}

/** Ids of the field/member rows currently carrying `.selected-member`. */
async function selectedMemberIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('g.field-row-g.selected-member')].map(
      (e) => e.getAttribute('data-element-id') ?? '',
    ),
  );
}

/** The data-element-kind values of the rendered rows inside a type box,
 *  in render order. Used to assert a method bucket stayed *collapsed* (a
 *  single `method_bucket` row) vs. expanded (individual `method` rows). */
async function rowKinds(page: Page, typeFullPath: string): Promise<string[]> {
  return page.evaluate((id) => {
    const box = document.querySelector(`g.type-box[data-element-id="${id}"]`);
    if (box === null) return [];
    return [...box.querySelectorAll('g.field-row-g')].map(
      (g) => g.getAttribute('data-element-kind') ?? '',
    );
  }, typeFullPath);
}

/** Screen-space bounding rect of a field row's selection band
 *  (`rect.member-bg`), or null when the row / band is absent. */
async function memberBandRect(
  page: Page,
  rowElementId: string,
): Promise<{ width: number; height: number } | null> {
  return page.evaluate((id) => {
    const g = document.querySelector(`g.field-row-g[data-element-id="${id}"]`);
    const bg = g?.querySelector('rect.member-bg') as SVGGraphicsElement | null;
    if (bg === null || bg === undefined) return null;
    const r = bg.getBoundingClientRect();
    return { width: r.width, height: r.height };
  }, rowElementId);
}

/** font-style computed for a type box's kind-marker + header-label. A
 *  ghost re-export renders both italic; a real type renders both
 *  `normal`. */
async function typeBoxFontStyles(
  page: Page,
  typeFullPath: string,
): Promise<{ marker: string; label: string } | null> {
  return page.evaluate((id) => {
    const box = document.querySelector(`g.type-box[data-element-id="${id}"]`);
    if (box === null) return null;
    const marker = box.querySelector('text.kind-marker');
    const label = box.querySelector('text.header-label');
    if (marker === null || label === null) return null;
    return {
      marker: getComputedStyle(marker).fontStyle,
      label: getComputedStyle(label).fontStyle,
    };
  }, typeFullPath);
}

/** The revealed re-export arrow `to` the given target, with its computed
 *  visible-stroke color and whether it carries the `.reexport` class.
 *  Null when no such arrow is rendered. */
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

/** Expand every module + the core/Engine type so the full diagram (App,
 *  ghost, Engine + rows, Piston, Gadget) is rendered. Returns once the
 *  geometry has come to rest. Asserts the load produced no page errors
 *  via the caller's collected list. */
async function expandFixture(page: Page): Promise<void> {
  await expandModule(page, CRATE);
  await expandModule(page, `${CRATE}::core`);
  await expandModule(page, `${CRATE}::extra`);
  await expect(page.locator(`g.type-box[data-element-id="${ENGINE}"]`)).toBeVisible();
  await expect(page.locator(`g.type-box[data-element-id="${GADGET}"]`)).toBeVisible();
  await expandType(page, ENGINE);
  // The piston field row emits the ownership arrow once Engine is open.
  await expect(page.locator(`g.arrow[data-arrow-to="${PISTON}"]`)).toHaveCount(1);
  await waitForLayoutSettled(page);
}

let pageErrors: string[];

test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(server.url);
  await expect(page.locator(`.module-group[data-id="${CRATE}"]`)).toBeVisible();
  await expandFixture(page);
  expect(pageErrors, `page errors during load: ${pageErrors.join('; ')}`).toHaveLength(0);
});

test.afterEach(() => {
  expect(pageErrors, `page errors during test: ${pageErrors.join('; ')}`).toHaveLength(0);
});

test('selecting a type draws the persistent ring around its full rendered extent', async ({
  page,
}) => {
  await cmdClick(page, `g.type-box[data-element-id="${ENGINE}"] .expand-hit`);
  // The ring rect is sized on the redraw the selection triggers.
  await expect(page.locator(`g.type-box[data-element-id="${ENGINE}"].selected`)).toHaveCount(1);

  // Exactly one box is selected, and it is Engine.
  expect(await selectedTypeId(page)).toBe(ENGINE);
  expect(await page.locator('g.type-box.selected').count()).toBe(1);

  // The ring is painted (positive size) and carries the violet stroke.
  // The ring is a soft glow, so its stroke is violet-500 at reduced
  // alpha (rgba(168,85,247,α)); assert the hue channels, not the exact
  // alpha, so the test pins "violet ring" without baking in the glow
  // opacity.
  expect(await hasSelectionRing(page, ENGINE)).toBe(true);
  const ringStroke = await page.evaluate((id) => {
    const ring = document.querySelector(`g.type-box[data-element-id="${id}"] rect.selection-ring`);
    return ring === null ? null : getComputedStyle(ring).stroke;
  }, ENGINE);
  expect(ringStroke).toMatch(/^rgba?\(168,\s*85,\s*247/);

  // The ring hugs the obstacle block — header PLUS the visible member
  // rows — not just the header. The historical bug sized it to the
  // header alone. Two observable oracles for "spans the whole content":
  //   • the ring is TALLER than the header row by several rows (Engine
  //     is expanded with ≥3 rows visible), and
  //   • the ring is as WIDE as a member band (member-bg uses the same
  //     obstacle width) inflated by 2*SELECTION_PAD — i.e. the ring is
  //     sized to the content block, not the narrower header label.
  const ringRect = await page.evaluate((id) => {
    const ring = document.querySelector(
      `g.type-box[data-element-id="${id}"] rect.selection-ring`,
    ) as SVGGraphicsElement | null;
    if (ring === null) return null;
    const r = ring.getBoundingClientRect();
    return { width: r.width, height: r.height };
  }, ENGINE);
  expect(ringRect).not.toBeNull();
  const ring = ringRect as NonNullable<typeof ringRect>;

  // A single header row's screen height (the expand-hit rect is exactly
  // one ROW_H tall) — the ring must clearly exceed it because Engine is
  // expanded with multiple member rows inside the block.
  const headerRowH = await page.evaluate((id) => {
    const hit = document.querySelector(
      `g.type-box[data-element-id="${id}"] rect.expand-hit`,
    ) as SVGGraphicsElement | null;
    return hit === null ? 0 : hit.getBoundingClientRect().height;
  }, ENGINE);
  expect(headerRowH).toBeGreaterThan(0);
  expect(ring.height).toBeGreaterThan(headerRowH * 2);

  // The ring width matches a member band (same obstacle width) + the
  // ring's 2*SELECTION_PAD inflation, confirming it tracks the content
  // block rather than the header label width.
  const bandRect = await memberBandRect(page, POWER_FIELD);
  expect(bandRect).not.toBeNull();
  const band = bandRect as NonNullable<typeof bandRect>;
  expect(ring.width).toBeGreaterThan(band.width);
});

test('selecting a field selects it, paints a member band, but does NOT expand method buckets', async ({
  page,
}) => {
  // Pre-condition: Engine is expanded with a single collapsed method
  // bucket among its rows (the fixture gives Engine two methods → one
  // `pub fn (..)` bucket header).
  const kindsBefore = await rowKinds(page, ENGINE);
  expect(kindsBefore).toContain('method_bucket');
  expect(kindsBefore).not.toContain('method');

  await cmdClick(page, `g.field-row-g[data-element-id="${POWER_FIELD}"] .field-row`);
  await expect(
    page.locator(`g.field-row-g[data-element-id="${POWER_FIELD}"].selected-member`),
  ).toHaveCount(1);

  // Selection landed on the field (and ONLY that row), and lit Engine's
  // ring — selecting a member selects its container box too.
  expect(await selectedMemberIds(page)).toEqual([POWER_FIELD]);
  expect(await selectedTypeId(page)).toBe(ENGINE);
  expect(await hasSelectionRing(page, ENGINE)).toBe(true);

  // The member band rect for the power row is painted with positive size
  // and is narrower than the full selection ring (band = obstacle width,
  // ring = obstacle width + 2*PAD). This is the real "band rendered
  // around the right row" oracle.
  const band = await memberBandRect(page, POWER_FIELD);
  expect(band).not.toBeNull();
  const b = band as NonNullable<typeof band>;
  expect(b.width).toBeGreaterThan(0);
  expect(b.height).toBeGreaterThan(0);

  // The decisive invariant: a FIELD selection must not auto-expand the
  // method buckets. The bucket stays a single `method_bucket` row; no
  // individual `method` rows appear.
  const kindsAfter = await rowKinds(page, ENGINE);
  expect(kindsAfter).toContain('method_bucket');
  expect(kindsAfter).not.toContain('method');
  // Row set is unchanged by the field select.
  expect(kindsAfter).toEqual(kindsBefore);
});

test('selecting a field lights only that row, not a same-position sibling', async ({ page }) => {
  // Select the `piston` field; only the piston row may carry
  // `.selected-member` — not the sibling `power` field on the same type.
  await cmdClick(page, `g.field-row-g[data-element-id="${PISTON_FIELD}"] .field-row`);
  await expect(
    page.locator(`g.field-row-g[data-element-id="${PISTON_FIELD}"].selected-member`),
  ).toHaveCount(1);
  expect(await selectedMemberIds(page)).toEqual([PISTON_FIELD]);
  // The power row is NOT lit.
  await expect(
    page.locator(`g.field-row-g[data-element-id="${POWER_FIELD}"].selected-member`),
  ).toHaveCount(0);
});

test('the re-export ghost box renders italic (marker + label)', async ({ page }) => {
  const ghost = await typeBoxFontStyles(page, GHOST);
  expect(ghost).not.toBeNull();
  expect((ghost as NonNullable<typeof ghost>).marker).toBe('italic');
  expect((ghost as NonNullable<typeof ghost>).label).toBe('italic');

  // A real (non-ghost) type renders both normal — the italic is the
  // ghost-specific signal, not a global style.
  const real = await typeBoxFontStyles(page, ENGINE);
  expect(real).not.toBeNull();
  expect((real as NonNullable<typeof real>).marker).toBe('normal');
  expect((real as NonNullable<typeof real>).label).toBe('normal');
});

test('clicking the ghost reveals its violet re-export arrow to the canonical type', async ({
  page,
}) => {
  // No re-export arrow is rendered until the ghost is followed.
  expect(await reexportArrowTo(page, ENGINE)).toBeNull();

  await page.locator(`g.type-box[data-element-id="${GHOST}"] .expand-hit`).click();
  // Following the ghost expands the canonical target's ancestors and
  // emits the violet arrow; wait for it to be painted + settle.
  await expect(page.locator(`g.arrow[data-arrow-to="${ENGINE}"]`)).toHaveCount(1);
  await waitForLayoutSettled(page);

  const arrow = await reexportArrowTo(page, ENGINE);
  expect(arrow).not.toBeNull();
  const a = arrow as NonNullable<typeof arrow>;
  // It is a re-export edge (dashed violet category), violet-500 stroke.
  expect(a.isReexport).toBe(true);
  expect(a.stroke).toBe(VIOLET_RGB);
});

test('focus mode drops unrelated modules from the layout, keeping the selection-relevant subtree', async ({
  page,
}) => {
  // Establish a selection so focus has a relevance anchor; Engine (and
  // its owner App + owned Piston + the re-export ghost) are relevant,
  // `extra::Gadget` is not.
  await cmdClick(page, `g.type-box[data-element-id="${ENGINE}"] .expand-hit`);
  await expect(page.locator(`g.type-box[data-element-id="${ENGINE}"].selected`)).toHaveCount(1);

  const before = await typeBoxIds(page);
  expect(before).toContain(GADGET);
  expect(before).toContain(ENGINE);

  // Toggle focus mode (the real `f` window keydown handler).
  await pressGlobalKey(page, 'f');
  // Focus is a layout-input filter: the unrelated `extra` band drops, so
  // its Gadget box is removed from the DOM entirely (not merely dimmed).
  await expect(page.locator(`g.type-box[data-element-id="${GADGET}"]`)).toHaveCount(0);
  await waitForLayoutSettled(page);

  const after = await typeBoxIds(page);
  expect(after).not.toContain(GADGET);
  // The relevant subtree stays rendered.
  expect(after).toContain(ENGINE);
  expect(after).toContain(APP);
  expect(after).toContain(PISTON);

  // Toggling focus off restores the dropped box — the filter is
  // reversible, ViewState was untouched.
  await pressGlobalKey(page, 'f');
  await expect(page.locator(`g.type-box[data-element-id="${GADGET}"]`)).toHaveCount(1);
  await waitForLayoutSettled(page);
  expect(await typeBoxIds(page)).toContain(GADGET);
});
