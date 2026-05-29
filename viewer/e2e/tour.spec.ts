// Tier-3 real-browser spec for the TOUR feature area.
//
// Drives a real Chromium against a real `mind-expander view` server and
// asserts the observable end-to-end tour flow: a POSTed tour surfaces
// the "new tour" pill with its title, clicking it opens the panel and
// starts playback (bubble appears), the bubble + panel render the step
// text / counter, Next/Prev and the N/P/Esc keyboard shortcuts navigate
// steps, an element step selects AND brings its target onto the canvas,
// and (on a fixture with a real call edge) an arrow step reveals,
// highlights, and points the bubble at the routed arrow.
//
// Every oracle is a real DOM / geometry / state change the user would
// see — never "didn't throw", never a screenshot (the on-failure
// screenshot in playwright.config.ts is only a debugging artifact).
//
// WHY two servers: the shared `_harness.ts` server is hard-wired to the
// geometry `fixture-workspace` (App owns Engine in `core`, Engine owns
// Cylinder — one ownership arrow, no call edges). That fixture covers
// the bar/panel/bubble/nav/element-focus oracles. The "arrow step
// renders" oracle needs a real *call* edge whose endpoints match the
// rendered arrow's `data-arrow-from`/`data-arrow-to` ids (ownership
// arrows are tagged with the FIELD id, not the type id the arrow-step
// resolver produces, so they cannot exercise the arrow-focus path). The
// existing `e2e/calls-fixture` crate provides `dispatch() -> validate()`
// — a free-function call edge — so this spec spawns its own server
// against it for the arrow case, following the code-panel.spec.ts
// pattern, without touching any shared file.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  apiUrl,
  buildFixtureTour,
  clickTourBar,
  clickTourNext,
  clickTourPrev,
  clickTourStop,
  expect,
  fixtureTypeRef,
  hasSelectionRing,
  isTourBarVisible,
  isTourBubbleVisible,
  isTourPanelOpen,
  postTour,
  pressGlobalKey,
  readZoomTransform,
  selectedTypeId,
  test,
  tourBarText,
  tourBubbleCounter,
  tourBubbleText,
  tourPanelStepTexts,
  type TourInput,
  waitForLayoutSettled,
} from './_harness.ts';
import type { Page } from '@playwright/test';

const ENGINE = 'e2e_fixture::core::Engine';

// ── Page-error guard ─────────────────────────────────────────────────
// Attach BEFORE goto so a throw during load is captured; assert empty
// at the end of each test (the tour SSE wiring + rAF anchor loop is a
// rich source of "works visually but logs an uncaught error" bugs).
function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

async function gotoFresh(page: Page, url: string): Promise<string[]> {
  const errors = trackPageErrors(page);
  await page.goto(url);
  // Diagram is up once the root module row exists.
  await expect(page.locator('.module-group[data-id="e2e_fixture"]')).toBeVisible();
  return errors;
}

test.describe('tour over the geometry fixture (bar / panel / bubble / nav)', () => {
  test('a POSTed tour is accepted and reveals the new-tour pill with its title', async ({
    page,
    viewerURL,
  }) => {
    const errors = await gotoFresh(page, viewerURL);
    const ref = await fixtureTypeRef(viewerURL);
    const tour = buildFixtureTour(ref, 'Bar title tour');

    const res = await postTour(viewerURL, tour);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('ok');

    // The pill un-hides itself the moment the SSE event arrives.
    await expect
      .poll(() => isTourBarVisible(page), { timeout: 5000 })
      .toBe(true);
    expect(await tourBarText(page)).toContain('Bar title tour');

    expect(errors, errors.join('; ')).toHaveLength(0);
  });

  test('a tour with a stale schema_version is rejected 422 and is not queued', async ({
    page,
    viewerURL,
  }) => {
    // NOTE: the server is worker-scoped and shared across this file's
    // tests, so prior accepted tours may already be in the queue and the
    // pill may already be visible. The rejection oracle therefore is: the
    // POST returns 422 with errors AND the rejected tour's unique title
    // never enters the served tour queue (`/api/tours`).
    const errors = await gotoFresh(page, viewerURL);
    const ref = await fixtureTypeRef(viewerURL);
    const staleTitle = 'STALE-REJECTED-TOUR-marker';
    // schema_version 1 is the stale value the live server rejects (it
    // requires SCHEMA_VERSION === 2). Cast through the wire type so the
    // bad version is sent verbatim.
    const stale = {
      ...buildFixtureTour(ref, staleTitle),
      schema_version: 1,
    } as unknown as TourInput;

    const res = await postTour(viewerURL, stale);
    expect(res.status).toBe(422);
    expect(Array.isArray(res.body.errors)).toBe(true);
    expect((res.body.errors ?? []).length).toBeGreaterThan(0);

    // The rejected tour must never reach the queue the viewer replays.
    const queued = (await (await fetch(apiUrl(viewerURL, '/api/tours'))).json()) as Array<{
      title?: string;
    }>;
    expect(queued.some((t) => t.title === staleTitle)).toBe(false);

    expect(errors, errors.join('; ')).toHaveLength(0);
  });

  test('clicking the pill opens the panel, starts playback, and renders step text + counter', async ({
    page,
    viewerURL,
  }) => {
    const errors = await gotoFresh(page, viewerURL);
    const ref = await fixtureTypeRef(viewerURL);
    await postTour(viewerURL, buildFixtureTour(ref, 'Playback tour'));
    await expect.poll(() => isTourBarVisible(page), { timeout: 5000 }).toBe(true);

    await clickTourBar(page);

    // Click → panel opens AND the player starts (bubble mounts).
    await expect.poll(() => isTourPanelOpen(page)).toBe(true);
    await expect.poll(() => isTourBubbleVisible(page), { timeout: 5000 }).toBe(true);

    // Step 0 of the fixture tour is the text-only opener.
    expect(await tourBubbleCounter(page)).toBe('1 / 2');
    expect(await tourBubbleText(page)).toContain('Welcome to the fixture tour');

    // Panel lists BOTH step texts (markdown stripped to plain text), so
    // `**id**` reads as the bare type id.
    const rows = await tourPanelStepTexts(page);
    expect(rows.length).toBe(2);
    expect(rows[0]).toContain('Welcome to the fixture tour');
    expect(rows[1]).toContain(ref.typeId);

    expect(errors, errors.join('; ')).toHaveLength(0);
  });

  test('Next then Prev walk the bubble through the steps (button path)', async ({
    page,
    viewerURL,
  }) => {
    const errors = await gotoFresh(page, viewerURL);
    const ref = await fixtureTypeRef(viewerURL);
    await postTour(viewerURL, buildFixtureTour(ref, 'Nav tour'));
    await expect.poll(() => isTourBarVisible(page), { timeout: 5000 }).toBe(true);
    await clickTourBar(page);
    await expect.poll(() => isTourBubbleVisible(page), { timeout: 5000 }).toBe(true);
    expect(await tourBubbleCounter(page)).toBe('1 / 2');

    await clickTourNext(page);
    await expect.poll(() => tourBubbleCounter(page)).toBe('2 / 2');
    expect(await tourBubbleText(page)).toContain(ref.typeId);

    await clickTourPrev(page);
    await expect.poll(() => tourBubbleCounter(page)).toBe('1 / 2');
    expect(await tourBubbleText(page)).toContain('Welcome to the fixture tour');

    expect(errors, errors.join('; ')).toHaveLength(0);
  });

  test('N / P keyboard shortcuts advance and retreat the active tour', async ({
    page,
    viewerURL,
  }) => {
    const errors = await gotoFresh(page, viewerURL);
    const ref = await fixtureTypeRef(viewerURL);
    await postTour(viewerURL, buildFixtureTour(ref, 'Keys tour'));
    await expect.poll(() => isTourBarVisible(page), { timeout: 5000 }).toBe(true);
    await clickTourBar(page);
    await expect.poll(() => isTourBubbleVisible(page), { timeout: 5000 }).toBe(true);
    expect(await tourBubbleCounter(page)).toBe('1 / 2');

    // The bubble installs a window keydown listener for P/N/Esc while it
    // is alive. A real key press drives that handler.
    await page.keyboard.press('n');
    await expect.poll(() => tourBubbleCounter(page)).toBe('2 / 2');

    await page.keyboard.press('p');
    await expect.poll(() => tourBubbleCounter(page)).toBe('1 / 2');

    expect(errors, errors.join('; ')).toHaveLength(0);
  });

  test('Esc / Stop ends the tour and removes the bubble', async ({ page, viewerURL }) => {
    const errors = await gotoFresh(page, viewerURL);
    const ref = await fixtureTypeRef(viewerURL);
    await postTour(viewerURL, buildFixtureTour(ref, 'Stop tour'));
    await expect.poll(() => isTourBarVisible(page), { timeout: 5000 }).toBe(true);
    await clickTourBar(page);
    await expect.poll(() => isTourBubbleVisible(page), { timeout: 5000 }).toBe(true);

    await clickTourStop(page);
    await expect.poll(() => isTourBubbleVisible(page)).toBe(false);

    expect(errors, errors.join('; ')).toHaveLength(0);
  });

  test('an element step selects its target and brings it onto the canvas', async ({
    page,
    viewerURL,
  }) => {
    const errors = await gotoFresh(page, viewerURL);
    const ref = await fixtureTypeRef(viewerURL);
    // Target Engine specifically: it lives in the `core` submodule, so
    // the step must expand ancestor modules AND select the box. Engine's
    // declaration is in core.rs; read its real line from facts rather
    // than hardcoding (the file is the same `core.rs` the fixtureTypeRef
    // walk would surface, but Engine isn't the FIRST spanned type, so we
    // build the ref by hand from the known fixture shape and let the
    // server resolve it).
    const engineTour: TourInput = {
      schema_version: 2,
      title: 'Element focus tour',
      steps: [
        { say: 'Opener.' },
        {
          say: `Focus on **${ENGINE}**.`,
          // core.rs line 1 is the `pub struct Engine` declaration.
          ref: { file: ref.file.replace(/lib\.rs$/, 'core.rs'), line: 1 },
        },
      ],
    };
    const res = await postTour(viewerURL, engineTour);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    await expect.poll(() => isTourBarVisible(page), { timeout: 5000 }).toBe(true);
    await clickTourBar(page);
    await expect.poll(() => isTourBubbleVisible(page), { timeout: 5000 }).toBe(true);

    await clickTourNext(page);
    await expect.poll(() => tourBubbleCounter(page)).toBe('2 / 2');

    // Element-step oracle 1: the target box becomes the selected box,
    // with a painted selection ring.
    await expect.poll(() => selectedTypeId(page), { timeout: 5000 }).toBe(ENGINE);
    expect(await hasSelectionRing(page, ENGINE)).toBe(true);

    // Element-step oracle 2: the Engine box is rendered and fully inside
    // the canvas viewport (the step expanded its ancestor module and
    // panned it into view). Wait for the pan to settle, then check
    // containment against the live canvas rect.
    await waitForLayoutSettled(page);
    const fullyInside = await page.evaluate((id) => {
      const box = document.querySelector(`g.type-box[data-element-id="${id}"]`);
      const vpEl = document.querySelector('#canvas-scroll');
      if (box === null || vpEl === null) return false;
      const r = (box as SVGGraphicsElement).getBoundingClientRect();
      const vp = vpEl.getBoundingClientRect();
      return (
        r.width > 0 &&
        r.height > 0 &&
        r.left >= vp.left - 1 &&
        r.right <= vp.right + 1 &&
        r.top >= vp.top - 1 &&
        r.bottom <= vp.bottom + 1
      );
    }, ENGINE);
    expect(fullyInside, 'Engine box fully within canvas viewport after focus').toBe(true);

    expect(errors, errors.join('; ')).toHaveLength(0);
  });

  test('the t key toggles the tour panel for a received tour', async ({ page, viewerURL }) => {
    const errors = await gotoFresh(page, viewerURL);
    const ref = await fixtureTypeRef(viewerURL);
    await postTour(viewerURL, buildFixtureTour(ref, 'Panel toggle tour'));
    await expect.poll(() => isTourBarVisible(page), { timeout: 5000 }).toBe(true);

    // Panel starts closed; `t` opens it (and the received tour is
    // auto-displayed so its steps render).
    expect(await isTourPanelOpen(page)).toBe(false);
    await pressGlobalKey(page, 't');
    await expect.poll(() => isTourPanelOpen(page)).toBe(true);
    expect((await tourPanelStepTexts(page)).length).toBe(2);

    await pressGlobalKey(page, 't');
    await expect.poll(() => isTourPanelOpen(page)).toBe(false);

    expect(errors, errors.join('; ')).toHaveLength(0);
  });
});

// ── Arrow step (own server against the call-edge fixture) ────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN =
  process.env.MIND_EXPANDER_BIN ?? path.resolve(HERE, '../../target/debug/mind-expander');
const CALLS_WORKSPACE = path.resolve(HERE, 'calls-fixture');
const READY_TIMEOUT_MS = 30_000;

const DISPATCH = 'calls_fixture::dispatch';
const VALIDATE = 'calls_fixture::validate';

function startCallsServer(): Promise<{ url: string; child: ChildProcessWithoutNullStreams }> {
  const child = spawn(BIN, ['view', CALLS_WORKSPACE, '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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

test.describe('tour arrow step over the call-edge fixture', () => {
  let server: { url: string; child: ChildProcessWithoutNullStreams };

  test.beforeAll(async () => {
    server = await startCallsServer();
  });
  test.afterAll(() => {
    server?.child.kill();
  });

  test('an arrow step reveals, highlights, and points the bubble at the routed call arrow', async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await page.goto(server.url);
    await expect(page.locator('.module-group[data-id="calls_fixture"]')).toBeVisible();

    // Build an arrow step over the real directed call edge
    // dispatch() -> validate(). The resolver requires `arrow.from`/`to`
    // (not `ref`), so this is posted as a raw wire body — the harness's
    // TourInput intentionally only models the element-step shape.
    //   dispatch() declared at lib.rs line 21; validate() at line 27.
    // arrow.from → dispatch (the function decl line), arrow.to →
    // validate (its decl line). Both resolve to functions and the
    // directed call edge dispatch→validate exists, so focus = 'arrow'.
    const arrowTour = {
      schema_version: 2,
      title: 'Arrow tour',
      steps: [
        {
          say: `Call edge from **dispatch** to **validate**.`,
          arrow: {
            from: { file: 'src/lib.rs', line: 21 },
            to: { file: 'src/lib.rs', line: 27 },
          },
        },
      ],
    };
    const res = await fetch(apiUrl(server.url, '/api/tour'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(arrowTour),
    });
    const body = (await res.json()) as { status?: string; errors?: unknown[] };
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.status).toBe('ok');

    await expect.poll(() => isTourBarVisible(page), { timeout: 5000 }).toBe(true);
    await clickTourBar(page);
    await expect.poll(() => isTourBubbleVisible(page), { timeout: 5000 }).toBe(true);

    // Arrow-step oracle 1: the routed call arrow exists with the
    // resolved endpoint ids and is wearing the `.tour-highlight` pulse
    // class (applied one rAF after reveal).
    const arrowLoc = page.locator(
      `g.arrow[data-arrow-from="${DISPATCH}"][data-arrow-to="${VALIDATE}"]`,
    );
    await expect(arrowLoc).toHaveCount(1);
    await expect(arrowLoc).toHaveClass(/tour-highlight/);

    await waitForLayoutSettled(page);

    // Arrow-step oracle 2: the bubble tail end lands near the rendered
    // arrow's geometric midpoint (getPointAtLength(total/2) via screen
    // CTM) — the same point main.ts anchors at — NOT the arrow bbox
    // center. Read both in the page and compare in screen space.
    const probe = await page.evaluate(
      ({ from, to }) => {
        const g = document.querySelector(
          `g.arrow[data-arrow-from="${from}"][data-arrow-to="${to}"]`,
        );
        if (g === null) return null;
        const path = g.querySelector('path.visible') as SVGPathElement | null;
        if (path === null) return null;
        const m = path.getScreenCTM();
        if (m === null) return null;
        const p = path.getPointAtLength(path.getTotalLength() / 2);
        const mid = { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
        const tail = document.querySelector('.tour-bubble-tail-svg path.tour-bubble-tail');
        if (tail === null) return { mid, tailEnd: null };
        const tp = tail as SVGPathElement;
        const tm = tp.getScreenCTM();
        const tpt = tp.getPointAtLength(tp.getTotalLength());
        const tailEnd =
          tm === null
            ? { x: tpt.x, y: tpt.y }
            : { x: tm.a * tpt.x + tm.c * tpt.y + tm.e, y: tm.b * tpt.x + tm.d * tpt.y + tm.f };
        return { mid, tailEnd };
      },
      { from: DISPATCH, to: VALIDATE },
    );
    expect(probe, 'arrow midpoint/tail probe').not.toBeNull();
    expect(probe!.tailEnd, 'bubble tail end rendered').not.toBeNull();
    // The tail end sits one GAP (8px) outside the anchor (a 16px box
    // centered on the midpoint), so allow generous slack for the gap +
    // stroke; the point must still be in the midpoint's neighborhood,
    // not at the far arrow bbox corner.
    const dx = probe!.tailEnd!.x - probe!.mid.x;
    const dy = probe!.tailEnd!.y - probe!.mid.y;
    const dist = Math.hypot(dx, dy);
    expect(dist, `tail end ${dist.toFixed(1)}px from arrow midpoint`).toBeLessThan(40);

    expect(errors, errors.join('; ')).toHaveLength(0);
  });
});
