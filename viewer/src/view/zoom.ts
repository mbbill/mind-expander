// Pan + zoom on the SVG canvas. d3.zoom drives one shared transform; we
// project it onto two layers:
//
//   • zoomLayer   — full transform (translate(x,y) scale(k)). Holds types,
//                   field rows, and arrows. Pans/zooms freely.
//   • frozenLayer — only vertical translate + scale (translate(0,y) scale(k)).
//                   Holds the module-label overlay. Stays glued to the left
//                   edge horizontally so module ↔ type-band mapping survives
//                   any horizontal pan. Transparent — no backdrop. The labels
//                   float over the diagram and rely on a white text halo for
//                   legibility where they cross type content.
//
// The frozen layer is appended LAST so its labels draw on top of any types
// that pan underneath them and so label clicks beat type-box clicks where
// the two overlap.

import { type ZoomBehavior, type ZoomTransform, select, zoom, zoomIdentity, zoomTransform } from 'd3';

const ZOOM_LAYER_CLASS = 'zoom-layer';
const FROZEN_LAYER_CLASS = 'frozen-layer';
// Permissive bounds at attach time; the real range is set per-draw via
// setScaleExtent based on the layout's content size and the viewport.
const SCALE_MIN = 0.01;
const SCALE_MAX = 1.5;

/** Shared animation duration (ms) for layout tweens and zoom-pan tweens.
 *  Keeping it in one place ensures the renderer in tree.ts and the viewport
 *  pan in main.ts run in lockstep, which is what makes click-anchoring work
 *  smoothly with the layout morph. */
export const ANIM_MS = 250;

export interface ZoomLayers {
  /** Holds types, field rows, arrows. Full pan + zoom. */
  readonly zoomLayer: SVGGElement;
  /** Holds the module-label overlay. Locked horizontally; mirrors only y/scale. */
  readonly frozenLayer: SVGGElement;
  /**
   * Shift the zoom transform by (dx, dy) in data-space units. Used to
   * compensate for layout-induced y movement so the clicked element stays
   * under the cursor after a re-render. When `animated` is true, the
   * transform tweens over ANIM_MS — must match the layout-element tween
   * duration so the element appears to stay still under the cursor.
   */
  readonly translateBy: (dx: number, dy: number, animated?: boolean) => void;
  /** Shift the zoom transform by screen-space pixels. Useful for
   *  pointer-move panning where the raw deltas arrive in viewport pixels,
   *  but d3.zoom's translateBy expects data-space units. */
  readonly translateByScreen: (dxPx: number, dyPx: number, animated?: boolean) => void;
  /** Current viewport's visible y-range, expressed in data-space coords. */
  readonly visibleYRange: () => { readonly min: number; readonly max: number };
  /** Pan vertically so that data-space y `y` lands at the screen vertical
   *  center. Horizontal pan and zoom scale are preserved. */
  readonly centerOnY: (y: number, animated?: boolean) => void;
  /** Pan both axes so that data-space (x, y) lands at the screen center.
   *  Used by arrow-click navigation to bring source/target dots into
   *  view. Zoom scale is preserved. */
  readonly centerOn: (x: number, y: number, animated?: boolean) => void;
  /** Pan so that data-space (dataX, dataY) lands at screen-space
   *  (screenX, screenY). Lets click-driven navigation place an endpoint
   *  exactly under the cursor instead of dragging it to the centre.
   *  Zoom scale is preserved. */
  readonly panTo: (
    dataX: number,
    dataY: number,
    screenX: number,
    screenY: number,
    animated?: boolean,
  ) => void;
  /** Update the allowed scale range. Clamps the current scale into the new
   *  range — d3.zoom doesn't auto-clamp on scaleExtent change. */
  readonly setScaleExtent: (min: number, max: number) => void;
  /** Reset the zoom scale to 1 (normal size), preserving the data-space
   *  point currently under the viewport center. Subject to the active
   *  scaleExtent — if 1 falls outside the range, d3.zoom clamps. */
  readonly resetScale: (animated?: boolean) => void;
  /** Reset the entire zoom transform to identity (translate (0,0), scale 1).
   *  Used by the "reset" action so the viewport returns to the same place
   *  as the initial page-load view. */
  readonly resetTransform: (animated?: boolean) => void;
  /** Set the entire transform to (k, tx, ty) directly. Subject to the same
   *  constrain function as user gestures, so an out-of-bounds target is
   *  clamped. Used by the space-bar overview toggle to swap between fit-all
   *  and a 100%-scale view anchored at the cursor. */
  readonly setTransform: (k: number, tx: number, ty: number, animated?: boolean) => void;
  /** Decide whether a wheel event should be interpreted as zoom by d3.
   *  Main input-mode handling uses this to make trackpad-mode plain
   *  two-finger scroll pan, while Shift+scroll still zooms. */
  readonly setWheelZoomFilter: (filter: (event: WheelEvent) => boolean) => void;
  /** Update the content bounds used by the pan constraint. The constraint
   *  forbids panning the canvas so far that the screen centre falls outside
   *  these bounds — that keeps at least half the viewport over content and
   *  prevents the diagram from disappearing entirely off-screen. Pass null
   *  to disable the constraint (e.g. before any layout has been computed). */
  readonly setContentBounds: (bounds: ContentBounds | null) => void;
}

export interface ContentBounds {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export function attachZoom(
  svgEl: SVGSVGElement,
  onZoom?: (transform: { x: number; y: number; k: number }) => void,
): ZoomLayers {
  const svg = select(svgEl);

  let zoomLayer = svg.select<SVGGElement>(`g.${ZOOM_LAYER_CLASS}`);
  let frozen = svg.select<SVGGElement>(`g.${FROZEN_LAYER_CLASS}`);
  let z: ZoomBehavior<SVGSVGElement, unknown>;
  let wheelZoomFilter =
    (svgEl as { __sfWheelZoomFilter?: (event: WheelEvent) => boolean }).__sfWheelZoomFilter ??
    (() => true);
  // Recover bounds from the SVG element (per-element so multiple
  // attachments use the same source of truth).
  type BoundsHost = { __sfContentBounds?: ContentBounds | null };
  let contentBounds: ContentBounds | null = (svgEl as BoundsHost).__sfContentBounds ?? null;

  // Pan constraint: screen centre (w/2, h/2) must always sit over content.
  // Solving `contentLeft*k + tx <= w/2 <= contentRight*k + tx` gives
  // `w/2 - contentRight*k <= tx <= w/2 - contentLeft*k`, and analogously
  // for ty. Skip the constraint until bounds are set, or when the content
  // is so small (e.g. zoomed-out tiny crate) that the lower bound exceeds
  // the upper one — that's a degenerate case where any pan is fine.
  const constrain = (
    transform: ZoomTransform,
    extent: [[number, number], [number, number]],
  ): ZoomTransform => {
    if (contentBounds === null) return transform;
    const w = extent[1][0] - extent[0][0];
    const h = extent[1][1] - extent[0][1];
    const k = transform.k;
    let tx = transform.x;
    let ty = transform.y;
    const txMin = w / 2 - contentBounds.x1 * k;
    const txMax = w / 2 - contentBounds.x0 * k;
    if (txMin <= txMax) tx = Math.max(txMin, Math.min(txMax, tx));
    const tyMin = h / 2 - contentBounds.y1 * k;
    const tyMax = h / 2 - contentBounds.y0 * k;
    if (tyMin <= tyMax) ty = Math.max(tyMin, Math.min(tyMax, ty));
    if (tx === transform.x && ty === transform.y) return transform;
    return transform.translate((tx - transform.x) / k, (ty - transform.y) / k);
  };

  if (zoomLayer.empty() || frozen.empty()) {
    zoomLayer = svg.append('g').attr('class', ZOOM_LAYER_CLASS);
    frozen = svg.append('g').attr('class', FROZEN_LAYER_CLASS);

    const shouldWheelZoom = (event: WheelEvent): boolean =>
      (
        (svgEl as { __sfWheelZoomFilter?: (event: WheelEvent) => boolean }).__sfWheelZoomFilter ??
        (() => true)
      )(event);

    const shouldHandleZoomEvent = (event: Event): boolean => {
      if (event.type === 'wheel') return shouldWheelZoom(event as WheelEvent);
      if (event instanceof MouseEvent) return event.button === 0;
      return true;
    };

    z = zoom<SVGSVGElement, unknown>()
      .scaleExtent([SCALE_MIN, SCALE_MAX])
      // Let d3 keep the normal left-button "grab the canvas" drag and
      // programmatic transforms. main.ts owns right-button viewport panning
      // and decides which wheel events should zoom in each input mode.
      .filter(shouldHandleZoomEvent)
      .constrain(constrain)
      .on('zoom', (event) => {
        const t = event.transform;
        zoomLayer.attr('transform', t.toString());
        frozen.attr('transform', `translate(0,${t.y}) scale(${t.k})`);
        onZoom?.({ x: t.x, y: t.y, k: t.k });
      });
    svg.call(z);
    // Disable d3.zoom's built-in double-click-to-zoom-in. Double-clicks
    // mid-diagram were tripping users up — the canvas should respond to
    // wheel/pinch and explicit reset only.
    svg.on('dblclick.zoom', null);
  } else {
    // Existing layers — recover the behavior from where we stashed it.
    const stashed = (svgEl as { __sfZoom?: ZoomBehavior<SVGSVGElement, unknown> }).__sfZoom;
    if (!stashed) throw new Error('zoom behavior missing on existing layers');
    z = stashed;
  }
  (svgEl as { __sfZoom?: ZoomBehavior<SVGSVGElement, unknown> }).__sfZoom = z;
  (svgEl as { __sfWheelZoomFilter?: (event: WheelEvent) => boolean }).__sfWheelZoomFilter =
    wheelZoomFilter;

  const zoomNode = zoomLayer.node();
  const frozenNode = frozen.node();
  if (!zoomNode || !frozenNode) {
    throw new Error('zoom layers not initialized');
  }
  return {
    zoomLayer: zoomNode,
    frozenLayer: frozenNode,
    translateBy: (dx, dy, animated = false) => {
      if (animated) {
        svg.transition('zoom').duration(ANIM_MS).call(z.translateBy, dx, dy);
      } else {
        z.translateBy(svg, dx, dy);
      }
    },
    translateByScreen: (dxPx, dyPx, animated = false) => {
      const t = zoomTransform(svgEl);
      const dx = dxPx / t.k;
      const dy = dyPx / t.k;
      if (animated) {
        svg.transition('zoom').duration(ANIM_MS).call(z.translateBy, dx, dy);
      } else {
        z.translateBy(svg, dx, dy);
      }
    },
    visibleYRange: () => {
      const t = zoomTransform(svgEl);
      const h = svgEl.clientHeight;
      return { min: -t.y / t.k, max: (h - t.y) / t.k };
    },
    centerOnY: (y, animated = false) => {
      const t = zoomTransform(svgEl);
      const h = svgEl.clientHeight;
      // We want screen_y_of(y) == h/2; screen_y = y*k + t.y; so we need
      //   t.y' = h/2 - y*k
      // d3.translateBy(0, dy) updates t.y to t.y + dy*k, so:
      //   dy = (t.y' - t.y)/k = (h/2 - t.y)/k - y
      const dy = (h / 2 - t.y) / t.k - y;
      if (animated) {
        svg.transition('zoom').duration(ANIM_MS).call(z.translateBy, 0, dy);
      } else {
        z.translateBy(svg, 0, dy);
      }
    },
    centerOn: (x, y, animated = false) => {
      // Same algebra as centerOnY, applied to both axes.
      const t = zoomTransform(svgEl);
      const w = svgEl.clientWidth;
      const h = svgEl.clientHeight;
      const dx = (w / 2 - t.x) / t.k - x;
      const dy = (h / 2 - t.y) / t.k - y;
      if (animated) {
        svg.transition('zoom').duration(ANIM_MS).call(z.translateBy, dx, dy);
      } else {
        z.translateBy(svg, dx, dy);
      }
    },
    panTo: (dataX, dataY, screenX, screenY, animated = false) => {
      // Convert SVG-relative click coords (we receive event.clientX/Y, so
      // subtract the SVG's bounding rect to get screen-local coords).
      // Then solve: screen = data * k + t, so t' = screen - data * k.
      // d3.translateBy(dx, dy) updates t to t + dx*k → dx = (screen-t)/k - data.
      const rect = svgEl.getBoundingClientRect();
      const localX = screenX - rect.left;
      const localY = screenY - rect.top;
      const t = zoomTransform(svgEl);
      const dx = (localX - t.x) / t.k - dataX;
      const dy = (localY - t.y) / t.k - dataY;
      if (animated) {
        svg.transition('zoom').duration(ANIM_MS).call(z.translateBy, dx, dy);
      } else {
        z.translateBy(svg, dx, dy);
      }
    },
    setScaleExtent: (min, max) => {
      // Guard against degenerate ranges (e.g. tiny content where fit > max).
      const lo = Math.min(min, max);
      const hi = Math.max(min, max);
      z.scaleExtent([lo, hi]);
      const k = zoomTransform(svgEl).k;
      if (k < lo) z.scaleTo(svg, lo);
      else if (k > hi) z.scaleTo(svg, hi);
    },
    resetScale: (animated = false) => {
      if (animated) {
        svg.transition('zoom').duration(ANIM_MS).call(z.scaleTo, 1);
      } else {
        z.scaleTo(svg, 1);
      }
    },
    resetTransform: (animated = false) => {
      if (animated) {
        svg.transition('zoom').duration(ANIM_MS).call(z.transform, zoomIdentity);
      } else {
        z.transform(svg, zoomIdentity);
      }
    },
    setTransform: (k, tx, ty, animated = false) => {
      // ZoomTransform.translate(dx, dy) sets x = x + k*dx, so to land at
      // (k, tx, ty) starting from identity we apply scale(k) then
      // translate(tx/k, ty/k).
      const target = zoomIdentity.scale(k).translate(tx / k, ty / k);
      if (animated) {
        svg.transition('zoom').duration(ANIM_MS).call(z.transform, target);
      } else {
        z.transform(svg, target);
      }
    },
    setWheelZoomFilter: (filter) => {
      wheelZoomFilter = filter;
      (svgEl as { __sfWheelZoomFilter?: (event: WheelEvent) => boolean }).__sfWheelZoomFilter =
        filter;
    },
    setContentBounds: (bounds) => {
      contentBounds = bounds;
      (svgEl as BoundsHost).__sfContentBounds = bounds;
      // Re-apply current transform so the constraint kicks in immediately
      // — without this the diagram could already be panned off-screen and
      // wouldn't snap back until the next user gesture.
      const t = zoomTransform(svgEl);
      z.transform(svg, t);
    },
  };
}
