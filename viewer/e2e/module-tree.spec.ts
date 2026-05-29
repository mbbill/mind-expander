// Tier-3 real-browser spec for the module-tree feature area — the
// left-hand HTML module column (`renderHtmlModuleTree` /
// `html_tree_anim`) driven against a real `mind-expander view` server.
//
// The oracle for every kept test is a CORRECT observable change the user
// would see: a row appears/disappears, a type box renders, a screen-y
// moves, a sticky header stays pinned, an icon's background-image flips,
// a FLIP animation runs. Never "didn't throw", never a screenshot (the
// on-failure screenshot in playwright.config.ts is only a debugging
// artifact). Each test asserts no uncaught page errors.
//
// WHY a dedicated fixture (not the shared `e2e/fixture-workspace`):
//   • Folder-vs-file icons + the `isLeaf` crate-root fix are TypeScript
//     only (Rust shows no icons — module ≠ file). The shared fixture is
//     a flat 2-module Rust crate, so it cannot exercise them.
//   • Scroll-sync, sticky-breadcrumb pinning, and the FLIP enter/exit
//     animation only manifest when the column overflows the 900px
//     viewport. The shared fixture's 3 rows never overflow.
// `e2e/module-tree-ts-fixture` is a TS package (tsconfig + package.json)
// with a real crate-root file (`src/index.ts`), two synthesized
// directory intermediates (`widgets/`, `deep/level2/level3/level4/`), 20
// file-leaf modules under `widgets/`, and a 5-deep nested chain — enough
// to overflow the viewport and to show folder/file icons at every leaf
// kind. The shared `_harness.ts` server fixture is hard-wired to the
// geometry fixture, so this spec spawns its own server against the TS
// fixture (same `ready`-line protocol) while reusing the shared helpers.

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Page } from '@playwright/test';
import {
  canvasScrollTop,
  expect,
  scrollCanvas,
  test,
  typeBoxIds,
  typeBoxRect,
  waitForLayoutSettled,
} from './_harness.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = process.env.MIND_EXPANDER_BIN ?? path.resolve(HERE, '../../target/debug/mind-expander');
const WORKSPACE = path.resolve(HERE, 'module-tree-ts-fixture');
const READY_TIMEOUT_MS = 30_000;

const CRATE = 'mt_ts_fixture';
const WIDGETS = `${CRATE}::widgets`; // synthesized directory module (folder)
const GAUGE_MOD = `${CRATE}::widgets::gauge`; // real .ts file module (file leaf)
const GAUGE_TYPE = `${CRATE}::widgets::gauge::Gauge`; // type box revealed on expand
const DEEP = `${CRATE}::deep`;
const DEEP_L4 = `${CRATE}::deep::level2::level3::level4`;

/** Spawn `view <ts-fixture> --port 0` and resolve the bound URL from the
 *  server's `ready` JSON line — the same contract `_harness.ts` uses,
 *  pointed at this spec's own TS fixture. */
function startServer(): Promise<{ url: string; child: ChildProcess }> {
  const child = spawn(BIN, ['view', WORKSPACE, '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`server never emitted ready within ${READY_TIMEOUT_MS}ms`));
    }, READY_TIMEOUT_MS);
    const rl = createInterface({ input: child.stdout! });
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

let server: { url: string; child: ChildProcess };

test.beforeAll(async () => {
  server = await startServer();
});

test.afterAll(() => {
  server?.child.kill();
});

// ── Fixture-local DOM readers ────────────────────────────────────────

/** Click a module row's header by data-id (the toggle / scroll-to /
 *  show-code target). Re-derived locally so this spec reads against its
 *  own crate ids. */
async function clickModuleHeader(page: Page, moduleId: string): Promise<void> {
  await page.locator(`.module-group[data-id="${moduleId}"] > .module-header`).click();
}

/** data-id of every rendered module-group, in DOM order. */
async function moduleIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('#html-modules .module-group')].map(
      (g) => (g as HTMLElement).dataset.id ?? '',
    ),
  );
}

/** The `data-leaf` attribute of a module-group ('true' | 'false'), or
 *  null when the row isn't rendered. */
async function moduleLeaf(page: Page, moduleId: string): Promise<string | null> {
  return page.evaluate((id) => {
    const g = document.querySelector(`#html-modules .module-group[data-id="${id}"]`);
    return g === null ? null : ((g as HTMLElement).dataset.leaf ?? null);
  }, moduleId);
}

/** The CSS `::before` background-image painted on a module-group's chip —
 *  the folder/file icon. Returns the computed value (a `url(...)` data
 *  URI in TS mode, or 'none'). */
async function chipIconImage(page: Page, moduleId: string): Promise<string> {
  return page.evaluate((id) => {
    const chip = document.querySelector(
      `#html-modules .module-group[data-id="${id}"] > .module-header .module-chip`,
    );
    if (chip === null) return 'none';
    return getComputedStyle(chip, '::before').backgroundImage;
  }, moduleId);
}

/** Screen-space top of a module-group's header (viewport px). */
async function headerTop(page: Page, moduleId: string): Promise<number | null> {
  return page.evaluate((id) => {
    const h = document.querySelector(
      `#html-modules .module-group[data-id="${id}"] > .module-header`,
    );
    return h === null ? null : (h as HTMLElement).getBoundingClientRect().top;
  }, moduleId);
}

/** Running CSS animations on a module-group element (their keyframes'
 *  transform/opacity flavor) — the observable signal that `playTreeFlip`
 *  ran. Returns the count of active animations. */
async function groupAnimationCount(page: Page, moduleId: string): Promise<number> {
  return page.evaluate((id) => {
    const g = document.querySelector(`#html-modules .module-group[data-id="${id}"]`);
    if (g === null) return 0;
    return (g as HTMLElement).getAnimations().length;
  }, moduleId);
}

/** Block until every running FLIP animation on the tree column has
 *  finished. `playTreeFlip` runs ~140ms Web Animations on enter/persist;
 *  reading header geometry before they settle catches mid-transition
 *  positions. The enter animation uses `fill:'both'` so it stays in
 *  `getAnimations()` after completing — we wait on `playState` rather
 *  than count, so the wait can't hang on a still-listed finished anim. */
async function waitTreeAnimationsDone(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    [...document.querySelectorAll('#html-modules .module-group')].every((g) =>
      (g as HTMLElement).getAnimations().every((a) => a.playState !== 'running'),
    ),
  );
}

/** Expand the crate root + a chain of module ids in order, waiting for
 *  each new child to render and the FLIP to settle before the next
 *  click so geometry/state reads are deterministic. */
async function expandChain(page: Page, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    await page.locator(`.module-group[data-id="${id}"] > .module-header`).waitFor();
    await clickModuleHeader(page, id);
    await waitTreeAnimationsDone(page);
  }
}

// Fresh page per test; assert no uncaught page errors after each.
let pageErrors: string[];
test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(server.url);
  await expect(page.locator(`.module-group[data-id="${CRATE}"]`)).toBeVisible();
});
test.afterEach(() => {
  expect(pageErrors, `page errors: ${pageErrors.join('; ')}`).toHaveLength(0);
});

test('crate root is a container (isLeaf fix), not a file leaf', async ({ page }) => {
  // The crate root is backed by a real file (src/index.ts) that is
  // present in crate.modules, but it must NOT be flipped to a leaf — it
  // represents the package as a whole and stays a container so the TS
  // renderer never draws a *file* icon on the crate row. (module_tree.ts
  // keeps `isLeaf=false` for the `m.path===''` root.)
  expect(await moduleLeaf(page, CRATE)).toBe('false');
  // It is the crate-tier row (depth 0) and therefore carries no icon at
  // all — the folder/file ::before rule is `:not(.crate-tier)`.
  const isCrateTier = await page.evaluate(
    (id) =>
      document
        .querySelector(`#html-modules .module-group[data-id="${id}"] > .module-header`)
        ?.classList.contains('crate-tier') ?? false,
    CRATE,
  );
  expect(isCrateTier).toBe(true);
  expect(await chipIconImage(page, CRATE)).toBe('none');
});

test('expanding a module row reveals child rows; collapsing hides them', async ({ page }) => {
  // Collapsed crate root shows only itself.
  expect(await moduleIds(page)).toEqual([CRATE]);

  await clickModuleHeader(page, CRATE);
  await expect(
    page.locator(`#html-modules .module-group[data-id="${WIDGETS}"]`),
  ).toBeVisible();
  const afterExpand = await moduleIds(page);
  expect(afterExpand).toContain(WIDGETS);
  expect(afterExpand).toContain(DEEP);
  expect(afterExpand.length).toBeGreaterThan(1);

  // Collapse again — children disappear from the DOM.
  await clickModuleHeader(page, CRATE);
  await expect(
    page.locator(`#html-modules .module-group[data-id="${WIDGETS}"]`),
  ).toHaveCount(0);
  expect(await moduleIds(page)).toEqual([CRATE]);
});

test('expanding a leaf file module reveals its type box', async ({ page }) => {
  await clickModuleHeader(page, CRATE);
  await expect(page.locator(`.module-group[data-id="${WIDGETS}"]`)).toBeVisible();
  await clickModuleHeader(page, WIDGETS);
  await expect(page.locator(`.module-group[data-id="${GAUGE_MOD}"]`)).toBeVisible();
  await clickModuleHeader(page, GAUGE_MOD);

  // The type box for the leaf's struct renders on the canvas.
  await expect(
    page.locator(`g.type-box[data-element-id="${GAUGE_TYPE}"]`),
  ).toBeVisible();
  await waitForLayoutSettled(page);
  const rect = await typeBoxRect(page, GAUGE_TYPE);
  expect(rect, 'gauge type box rect').not.toBeNull();
  expect(rect?.width).toBeGreaterThan(0);
  expect(rect?.height).toBeGreaterThan(0);
  expect(await typeBoxIds(page)).toContain(GAUGE_TYPE);
});

test('TS folder vs file icons differ; synthesized dir is a folder, real file is a file', async ({
  page,
}) => {
  await clickModuleHeader(page, CRATE);
  await expect(page.locator(`.module-group[data-id="${WIDGETS}"]`)).toBeVisible();
  await clickModuleHeader(page, WIDGETS);
  await expect(page.locator(`.module-group[data-id="${GAUGE_MOD}"]`)).toBeVisible();

  // `widgets` is a synthesized directory intermediate → data-leaf=false →
  // amber FILLED folder icon (#f59e0b).
  expect(await moduleLeaf(page, WIDGETS)).toBe('false');
  const folderImg = await chipIconImage(page, WIDGETS);
  expect(folderImg).toContain('url(');
  expect(folderImg).toContain('f59e0b');

  // `widgets::gauge` is a real .ts file → data-leaf=true → outlined file
  // icon (slate stroke #475569), NOT the amber fill.
  expect(await moduleLeaf(page, GAUGE_MOD)).toBe('true');
  const fileImg = await chipIconImage(page, GAUGE_MOD);
  expect(fileImg).toContain('url(');
  expect(fileImg).toContain('475569');

  // The two icons are genuinely distinct (the "icons too similar" guard).
  expect(folderImg).not.toBe(fileImg);
});

test('scroll syncs the module tree with the canvas content', async ({ page }) => {
  // Expand widgets + gauge so a real SVG type box (Gauge) renders, and the
  // shared #canvas-scroll has content to scroll. We anchor the sync check
  // on the SVG TYPE BOX rather than an HTML header row: headers can become
  // position:sticky and pin at the top (screen-y stops changing), which is
  // a SEPARATE feature with its own test below — an SVG box never pins, so
  // it tracks the native scroll 1:1, which is exactly the tree↔canvas sync.
  await expandChain(page, [CRATE, WIDGETS, GAUGE_MOD]);
  await expect(page.locator(`g.type-box[data-element-id="${GAUGE_TYPE}"]`)).toBeVisible();

  // Scroll by the AVAILABLE overflow (depends on the runner's font metrics),
  // not a hardcoded magnitude (which flaked on CI). Skip if it cannot scroll
  // meaningfully rather than assert vacuously.
  const start = await canvasScrollTop(page);
  const overflow = await page.evaluate(() => {
    const el = document.querySelector('#canvas-scroll') as HTMLElement;
    return el.scrollHeight - el.clientHeight;
  });
  const target = Math.min(180, Math.max(0, overflow - start));
  test.skip(target < 60, `#canvas-scroll cannot scroll enough to test sync (overflow ${overflow}px)`);

  const boxY = async (): Promise<number> => {
    const r = await typeBoxRect(page, GAUGE_TYPE);
    expect(r, 'Gauge box present').not.toBeNull();
    return (r as { y: number }).y;
  };
  const before = await boxY();
  await scrollCanvas(page, target);
  // Vertical pan is native scroll → wait until the box's screen-y settles.
  await page.waitForFunction(
    ({ id, b }) => {
      const el = document.querySelector(`g.type-box[data-element-id="${id}"]`);
      return el !== null && b - (el as SVGGraphicsElement).getBoundingClientRect().y > 30;
    },
    { id: GAUGE_TYPE, b: before },
  );
  const applied = (await canvasScrollTop(page)) - start;
  const after = await boxY();
  // The box moved UP by exactly the applied scroll delta (1:1 sync between
  // the native scroll and the rendered canvas content).
  expect(applied).toBeGreaterThan(40);
  expect(before - after).toBeCloseTo(applied, -1);
});

// Tiny local guard so the assertion above reads `number` not
// `number | null` (the locator existence check already proved non-null).
function headerTopSync(v: number | null): number {
  expect(v).not.toBeNull();
  return v as number;
}

test('ancestor header stays pinned (sticky breadcrumb) while content scrolls under it', async ({
  page,
}) => {
  await expandChain(page, [CRATE, WIDGETS]);
  await expect(page.locator(`.module-group[data-id="${GAUGE_MOD}"]`)).toBeVisible();

  // Pick a deep leaf far down the list and a shallow ancestor (widgets,
  // depth 1) that should pin to the sticky stack as we scroll past it.
  const deepLeaf = `${CRATE}::widgets::w9`;
  const ancestor = WIDGETS;

  // Scroll by the available overflow (font/OS-dependent), not a hardcoded
  // magnitude; skip if the viewport can't scroll meaningfully.
  const start = await canvasScrollTop(page);
  const overflow = await page.evaluate(() => {
    const el = document.querySelector('#canvas-scroll') as HTMLElement;
    return el.scrollHeight - el.clientHeight;
  });
  const target = Math.min(260, Math.max(0, overflow - start));
  test.skip(target < 80, `#canvas-scroll cannot scroll enough to pin the ancestor (overflow ${overflow}px)`);

  const ancestorBefore = headerTopSync(await headerTop(page, ancestor));
  const leafBefore = headerTopSync(await headerTop(page, deepLeaf));

  await scrollCanvas(page, target);
  // Poll until the leaf has actually scrolled up (rAF-throttled handler).
  await page.waitForFunction(
    ({ id, b }) => {
      const h = document.querySelector(
        `#html-modules .module-group[data-id="${id}"] > .module-header`,
      );
      return h !== null && b - (h as HTMLElement).getBoundingClientRect().top > 30;
    },
    { id: deepLeaf, b: leafBefore },
  );

  const ancestorAfter = headerTopSync(await headerTop(page, ancestor));
  const leafAfter = headerTopSync(await headerTop(page, deepLeaf));

  // The leaf scrolled up with the content…
  expect(leafBefore - leafAfter).toBeGreaterThan(20);
  // …but the ancestor (widgets) is pinned near the top of the viewport by
  // CSS sticky: it moves far LESS than the leaf, staying close to its
  // sticky-top instead of scrolling out of view. This is the sticky
  // breadcrumb behavior.
  const ancestorTravel = Math.abs(ancestorAfter - ancestorBefore);
  const leafTravel = Math.abs(leafAfter - leafBefore);
  expect(ancestorTravel).toBeLessThan(leafTravel);
  // And it remains visible within the viewport (not scrolled off-screen).
  const viewportH = page.viewportSize()?.height ?? 900;
  expect(ancestorAfter).toBeGreaterThanOrEqual(-1);
  expect(ancestorAfter).toBeLessThan(viewportH);
});

test('expand runs a FLIP enter animation; collapse cleans up its exit ghost', async ({ page }) => {
  // EXPAND: the crate root toggles open → child rows enter. `playTreeFlip`
  // schedules an opacity 0→1 Web Animation on each entering group (in a
  // rAF after the redraw). Observe a running animation on the entering
  // `widgets` row — the live signal that the FLIP actually ran (not a
  // static re-render).
  await clickModuleHeader(page, CRATE);
  await expect(page.locator(`.module-group[data-id="${WIDGETS}"]`)).toBeVisible();
  await page.waitForFunction(
    (id) => {
      const g = document.querySelector(`#html-modules .module-group[data-id="${id}"]`);
      return g !== null && (g as HTMLElement).getAnimations().some((a) => a.playState === 'running');
    },
    WIDGETS,
    { timeout: 2000 },
  );
  expect(await groupAnimationCount(page, WIDGETS)).toBeGreaterThan(0);

  // The enter animation completes (`fill:'both'` keeps it listed, so the
  // oracle is playState 'finished', not absence) and the row settles at
  // full opacity.
  await page.waitForFunction(
    (id) => {
      const g = document.querySelector(`#html-modules .module-group[data-id="${id}"]`);
      return (
        g !== null && (g as HTMLElement).getAnimations().every((a) => a.playState === 'finished')
      );
    },
    WIDGETS,
    { timeout: 2000 },
  );
  expect(
    await page.evaluate(
      (id) =>
        getComputedStyle(
          document.querySelector(`#html-modules .module-group[data-id="${id}"]`) as HTMLElement,
        ).opacity,
      WIDGETS,
    ),
  ).toBe('1');

  // COLLAPSE: children exit. The exit path mounts a ghost overlay
  // ([data-tree-ghost]) that fades out and is then removed. First confirm
  // the ghost mounts (the exit animation ran), then confirm it is cleaned
  // up — guarding the "ghosts accumulate" regression.
  await clickModuleHeader(page, CRATE);
  await expect(page.locator(`.module-group[data-id="${WIDGETS}"]`)).toHaveCount(0);
  await page.waitForFunction(() => document.querySelectorAll('[data-tree-ghost]').length > 0, undefined, {
    timeout: 2000,
  });
  await page.waitForFunction(
    () => document.querySelectorAll('[data-tree-ghost]').length === 0,
    undefined,
    { timeout: 3000 },
  );
  expect(
    await page.evaluate(() => document.querySelectorAll('[data-tree-ghost]').length),
  ).toBe(0);
});

test('deep nested chain pins ancestors in z-order (shallower paints on top)', async ({ page }) => {
  // Expand the 5-deep chain so depth 0..4 rows coexist. Their headers
  // carry z-index = 1000 - modDepth so a shallower ancestor paints OVER a
  // deeper child when their sticky zones overlap during scroll.
  await expandChain(page, [CRATE, DEEP, `${CRATE}::deep::level2`, `${CRATE}::deep::level2::level3`]);
  await expect(page.locator(`.module-group[data-id="${DEEP_L4}"]`)).toBeVisible();

  const z = await page.evaluate(
    (ids) =>
      ids.map((id) => {
        const h = document.querySelector(
          `#html-modules .module-group[data-id="${id}"] > .module-header`,
        ) as HTMLElement | null;
        return h === null ? null : Number(getComputedStyle(h).zIndex);
      }),
    [CRATE, DEEP, `${CRATE}::deep::level2`, `${CRATE}::deep::level2::level3`, DEEP_L4],
  );
  // Strictly decreasing with depth: 1000, 999, 998, 997, 996.
  for (let i = 1; i < z.length; i++) {
    expect(z[i], `z[${i}] (${z[i]}) < z[${i - 1}] (${z[i - 1]})`).toBeLessThan(z[i - 1] as number);
  }
});
