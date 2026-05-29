// Screen-space viewport anchoring for live-reload relayout.
//
// When the facts swap and the diagram relayouts, content above the user's
// focus can grow or shrink, shoving everything below it. Preserving the raw
// zoom transform is NOT enough: draw() recomputes the fit-scale floor, so the
// post-draw scale `k` can differ from the pre-draw one and a data-space
// translation no longer maps to the same screen point. The robust fix is to
// pin a chosen anchor node to the same ON-SCREEN PIXEL across the reload:
//   1. before reload, record the anchor's data point + its current screen px,
//   2. after relayout, look the anchor up in the NEW layout and pan via the
//      live transform so it lands back at that pixel.
//
// This module owns only the pure pixel<->data mapping. The capture/restore
// orchestration (which DOM elements, which fallback ladder) lives in main.ts
// where the layout + zoom handles are in scope.

/** Map a data-space point to its current on-screen pixel within the canvas
 *  scroll viewport, mirroring the viewer's real rendering math (see
 *  `isContentVisible` / `panTo` in main.ts / zoom.ts):
 *    screenX = dataX * k + t.x
 *    screenY = (TOP - scrollTop) + dataY * k
 *  where TOP = viewport clientHeight (the symmetric over-scroll pad) and t is
 *  the live zoom transform. The Y axis uses scrollTop rather than t.y because
 *  the vertical pan is delivered through native scroll, not the SVG transform. */
export function anchorScreenPoint(
  data: { readonly x: number; readonly y: number },
  transform: { readonly x: number; readonly k: number },
  top: number,
  scrollTop: number,
): { readonly x: number; readonly y: number } {
  return {
    x: data.x * transform.k + transform.x,
    y: top - scrollTop + data.y * transform.k,
  };
}

/** Pick the data-space y closest to the centre of the visible y-range. Returns
 *  null when nothing falls inside the range (content scrolled fully off), so
 *  the caller can skip anchoring rather than pin to an off-screen node. */
export function nearestToCenter(
  candidates: ReadonlyArray<{ readonly id: string; readonly y: number }>,
  range: { readonly min: number; readonly max: number },
): { readonly id: string; readonly y: number } | null {
  const center = (range.min + range.max) / 2;
  let best: { readonly id: string; readonly y: number } | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    if (c.y < range.min || c.y > range.max) continue;
    const d = Math.abs(c.y - center);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}
