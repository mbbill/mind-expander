// Tier-3 real-browser spec for the diagram's layout PLACEMENT, driven
// against a real `mind-expander view` server and a real Chromium.
//
// The oracle for every test is a CORRECT, observable geometry/DOM fact —
// real getBoundingClientRect rects under the real system font — never
// "didn't throw" and never a recorded screenshot (the on-failure
// screenshot in playwright.config.ts is only a debugging artifact).
//
// WHY a dedicated fixture (not the shared `fixture-workspace`): the
// behavior under test is the PREDECESSOR-RELATIVE placement fix
// (src/layout/grid_placement.ts) — an owned target is floored only by
// its OWN owner's right edge, so it packs in the column immediately
// right of its owner and is NOT pushed past UNRELATED types that merely
// sit at the same depth (a "layer wall"). Reproducing that needs one
// owner with several children PLUS unrelated owners whose children share
// the same depth, PLUS enough density that the depth-0 band spreads into
// multiple sub-columns. The 3-box shared fixture cannot express this, so
// this spec ships `e2e/layout-placement-fixture` (lp_fixture):
//   * Hub (root) owns C0..C5 (depth 1)        → must render next to Hub.
//   * O0..O2 (roots) each own OL0..OL2 (depth 1, UNRELATED to Hub)
//                                              → must stay right of C*.
//   * Pad00..Pad15 (roots, no children)        → density for non-overlap.
// The shared `_harness.ts` server fixture is hard-wired to the geometry
// fixture, so this spec spawns its own server (same `ready`-line
// protocol) while reusing the harness geometry readers.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import {
  type Rect,
  arrowEndpoints,
  expect,
  pointInRect,
  test,
  typeBoxIds,
  typeBoxRect,
  waitForLayoutSettled,
} from './_harness.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN =
  process.env.MIND_EXPANDER_BIN ?? path.resolve(HERE, '../../target/debug/mind-expander');
const WORKSPACE = path.resolve(HERE, 'layout-placement-fixture');
const READY_TIMEOUT_MS = 30_000;

const CRATE = 'lp_fixture';
const HUB = `${CRATE}::Hub`;
const CHILDREN = ['C0', 'C1', 'C2', 'C3', 'C4', 'C5'].map((c) => `${CRATE}::${c}`);
const UNRELATED_CHILDREN = ['OL0', 'OL1', 'OL2'].map((o) => `${CRATE}::${o}`);

interface Server {
  readonly url: string;
  kill(): void;
}

/** Spawn `view <layout-placement-fixture> --port 0` and resolve the
 *  bound URL from the server's `ready` JSON line — same contract as the
 *  shared harness, pointed at this spec's own fixture. */
function startServer(): Promise<Server> {
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
          resolve({ url: ev.url, kill: () => child.kill() });
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

let server: Server;

test.beforeAll(async () => {
  server = await startServer();
});

test.afterAll(() => {
  server?.kill();
});

// ── Fixture-local helpers ────────────────────────────────────────────

async function expandModule(page: Page, moduleId: string): Promise<void> {
  await page.locator(`.module-group[data-id="${moduleId}"] > *`).first().click();
}

async function expandType(page: Page, typeFullPath: string): Promise<void> {
  await page.locator(`g.type-box[data-element-id="${typeFullPath}"] .expand-hit`).click();
}

/** Two rects overlap when their intersection has positive area on BOTH
 *  axes beyond a small slack (stroke width / antialias). */
function rectsOverlap(a: Rect, b: Rect, slack: number): boolean {
  const ox = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const oy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return ox > slack && oy > slack;
}

/** Read the settled rects of every requested id (must all be present). */
async function rectsOf(page: Page, ids: readonly string[]): Promise<Map<string, Rect>> {
  const out = new Map<string, Rect>();
  for (const id of ids) {
    const r = await typeBoxRect(page, id);
    expect(r, `rect for ${id}`).not.toBeNull();
    out.set(id, r as Rect);
  }
  return out;
}

// Bring the whole crate on screen, then expand Hub so it emits its six
// ownership arrows (Hub.* → C*) and the placement plan treats C0..C5 as
// Hub's predecessors-anchored children. Settle before reading geometry.
async function expandAll(page: Page): Promise<void> {
  await expandModule(page, CRATE);
  await expect(page.locator(`g.type-box[data-element-id="${HUB}"]`)).toBeVisible();
  await expandType(page, HUB);
  await expect(page.locator('g.arrow')).toHaveCount(CHILDREN.length);
  await waitForLayoutSettled(page);
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(server.url);
  await expect(page.locator(`.module-group[data-id="${CRATE}"]`)).toBeVisible();
  await expandAll(page);
  // No uncaught page errors during load + interaction.
  expect(errors, `page errors: ${errors.join('; ')}`).toHaveLength(0);
});

test('every type box renders with positive real-font size and no dupes', async ({ page }) => {
  const ids = await typeBoxIds(page);
  // All 29 fixture types render exactly once (Hub + 6 C + 3 O + 3 OL + 16 Pad).
  expect(ids).toHaveLength(29);
  expect(new Set(ids).size, 'no duplicate type boxes').toBe(29);
  for (const id of [HUB, ...CHILDREN, ...UNRELATED_CHILDREN]) {
    const r = await typeBoxRect(page, id);
    expect(r, `rect for ${id}`).not.toBeNull();
    expect((r as Rect).width, `${id} width`).toBeGreaterThan(0);
    expect((r as Rect).height, `${id} height`).toBeGreaterThan(0);
  }
});

test('owned children render NEXT TO their owner, not past the unrelated same-depth block', async ({
  page,
}) => {
  const ids = [HUB, ...CHILDREN, ...UNRELATED_CHILDREN];
  const rects = await rectsOf(page, ids);
  const hub = rects.get(HUB) as Rect;

  const childLefts = CHILDREN.map((c) => (rects.get(c) as Rect).x);
  const unrelatedLefts = UNRELATED_CHILDREN.map((o) => (rects.get(o) as Rect).x);

  const leftmostChild = Math.min(...childLefts);
  const leftmostUnrelated = Math.min(...unrelatedLefts);

  // (1) Depth order: every owned child is to the RIGHT of its owner
  // (owned type at depth+1). A child overlapping/left of Hub would be
  // the depth-ordering bug.
  const MARGIN = 6;
  for (const c of CHILDREN) {
    const r = rects.get(c) as Rect;
    expect(r.x, `${c}.x >= Hub.right`).toBeGreaterThanOrEqual(hub.x + hub.width - MARGIN);
  }

  // (2) NEXT TO the owner: Hub's leftmost child sits in the column
  // immediately right of Hub — within roughly one box-width of Hub's
  // right edge — NOT shoved out near the unrelated block. This is the
  // predecessor-relative floor (grid_placement.ts): the child is floored
  // by Hub's right edge ALONE, so it does not inherit a global layer
  // wall. A buggy layer-wall placement would push the leftmost child out
  // past every depth-1 type instead.
  // One sub-column step right of Hub. Columns step by ~120px (real
  // font); the leftmost child sits in the FIRST column past Hub, so its
  // gap to Hub's right edge is well under one step. A layer-wall push out
  // to the unrelated block would exceed one step and trip this.
  const COLUMN_STEP = 120;
  const NEAR_OWNER_MAX = COLUMN_STEP;
  expect(
    leftmostChild - (hub.x + hub.width),
    `leftmost child gap past Hub right edge (Hub.right=${hub.x + hub.width}, leftmostChild=${leftmostChild})`,
  ).toBeLessThanOrEqual(NEAR_OWNER_MAX);

  // (3) THE predecessor invariant: Hub's children are NOT pushed past the
  // UNRELATED same-depth children. The leftmost owned child column is
  // strictly LEFT of the leftmost unrelated-child column. Under the
  // rejected "layer wall" placement the owned children would clear every
  // depth-1 type and land at or right of the unrelated block, so this is
  // the discriminating oracle for the fix.
  expect(
    leftmostChild,
    `leftmost owned child x=${leftmostChild} must be left of leftmost unrelated child x=${leftmostUnrelated}`,
  ).toBeLessThan(leftmostUnrelated);
});

test('no two type boxes overlap on the dense fixture (real font)', async ({ page }) => {
  const ids = await typeBoxIds(page);
  const rects: Array<{ id: string; rect: Rect }> = [];
  for (const id of ids) {
    const r = await typeBoxRect(page, id);
    expect(r, `rect for ${id}`).not.toBeNull();
    rects.push({ id, rect: r as Rect });
  }
  // Boxes are drawn with a stroke; allow a few px of mutual touching but
  // flag any real area overlap. With 29 real-font boxes packed across
  // multiple sub-columns this is the scaled non-overlap invariant the
  // tiny shared fixture cannot exercise.
  const SLACK = 2;
  const collisions: string[] = [];
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      if (rectsOverlap(rects[i].rect, rects[j].rect, SLACK)) {
        collisions.push(`${rects[i].id} <> ${rects[j].id}`);
      }
    }
  }
  expect(collisions, `overlapping boxes: ${collisions.join(', ')}`).toHaveLength(0);
});

test('each ownership arrow attaches to its owner row and its owned target box', async ({
  page,
}) => {
  const arrows = await arrowEndpoints(page);
  // Six Hub.* → C* ownership arrows, one per expanded field row.
  expect(arrows).toHaveLength(CHILDREN.length);

  const MARGIN = 6;
  for (const arrow of arrows) {
    expect(arrow.from, 'arrow source is a Hub field row').toMatch(
      new RegExp(`^${CRATE}::Hub::`),
    );
    expect(arrow.to, 'arrow target is one of Hub\'s children').not.toBeNull();
    expect(CHILDREN, `arrow target ${arrow.to}`).toContain(arrow.to as string);

    const hubRect = await typeBoxRect(page, HUB);
    const targetRect = await typeBoxRect(page, arrow.to as string);
    expect(hubRect && targetRect).toBeTruthy();

    // Start anchors within the owner box; end anchors within the owned
    // target box — a floating endpoint is the "arrow ends in the wrong
    // place" bug, verified against real rendered geometry.
    expect(
      pointInRect(arrow.start, hubRect as Rect, MARGIN),
      `arrow start ${JSON.stringify(arrow.start)} within Hub box`,
    ).toBe(true);
    expect(
      pointInRect(arrow.end, targetRect as Rect, MARGIN),
      `arrow end ${JSON.stringify(arrow.end)} within ${arrow.to} box`,
    ).toBe(true);
  }
});
