// Pan + zoom on the SVG canvas. d3.zoom drives one shared transform; we
// project it onto three layers:
//
//   • zoomLayer   — full transform (translate(x,y) scale(k)). Holds types,
//                   field rows, and arrows. Pans/zooms freely.
//   • frozenLayer — only vertical translate + scale (translate(0,y) scale(k)).
//                   Holds the module-label overlay. Stays glued to the left
//                   edge horizontally so module ↔ type-band mapping survives
//                   any horizontal pan.
//   • stickyLayer — no transform (viewport-space). Pinned to the top-left
//                   corner of the SVG. Holds the breadcrumb of ancestor
//                   module rows for whichever band the user is currently
//                   scrolled inside, so the "where am I" chain never
//                   disappears off-screen. Anchored to the viewport (not
//                   the canvas) so it does not move with horizontal pan
//                   and does not grow/shrink with zoom — a fixed-size HUD.
//
// stickyLayer is appended LAST so its rows draw on top of everything that
// scrolls under them.

import {
  type ZoomBehavior,
  type ZoomTransform,
  select,
  zoom,
  zoomIdentity,
  zoomTransform,
} from 'd3';

const ZOOM_LAYER_CLASS = 'zoom-layer';
const FROZEN_LAYER_CLASS = 'frozen-layer';
const STICKY_LAYER_CLASS = 'sticky-layer';
// Permissive bounds at attach time; the real range is set per-draw via
// setScaleExtent based on the layout's content size and the viewport.
const SCALE_MIN = 0.01;
const SCALE_MAX = 1.5;
// Minimum visible content margin (px) on each side of the viewport.
// Pan is constrained so at least this many pixels of content stay
// on-screen along each axis — small enough to feel free, large enough
// to keep the diagram findable.
const PAN_MARGIN_PX = 60;

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
  /** Pinned to the top of the viewport. Mirrors only horizontal pan + scale,
   *  so the rows it holds match the in-canvas rows' x and size but never
   *  scroll vertically. */
  readonly stickyLayer: SVGGElement;
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
  /** Pan vertically so that data-space y `y` lands at screen y = topPx (in
   *  viewport pixels). Used by the sticky-breadcrumb click to put the
   *  clicked module's row at the top of the viewport, just below the
   *  remaining sticky rows above it. */
  readonly panYToTop: (y: number, topPx: number, animated?: boolean) => void;
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
  /** Current d3.zoom transform (k, x, y). External callers that used
   *  to call `zoomTransform(svgEl)` should call this — d3.zoom is now
   *  bound to the scroll container, so reading the transform off the
   *  SVG would always return identity. */
  readonly getTransform: () => { x: number; y: number; k: number };
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
  scrollEl: HTMLElement,
  onZoom?: (transform: { x: number; y: number; k: number }) => void,
): ZoomLayers {
  const svg = select(svgEl);
  // d3.zoom is bound to the scroll container (see comment near
  // `target.call(z)` below). All d3.zoom programmatic APIs and
  // zoomTransform reads must use this element, not svgEl.
  const target = select<Element, unknown>(scrollEl);

  let zoomLayer = svg.select<SVGGElement>(`g.${ZOOM_LAYER_CLASS}`);
  let frozen = svg.select<SVGGElement>(`g.${FROZEN_LAYER_CLASS}`);
  let sticky = svg.select<SVGGElement>(`g.${STICKY_LAYER_CLASS}`);
  let z: ZoomBehavior<Element, unknown>;
  let wheelZoomFilter =
    (svgEl as { __sfWheelZoomFilter?: (event: WheelEvent) => boolean }).__sfWheelZoomFilter ??
    (() => true);
  // Recover bounds from the SVG element (per-element so multiple
  // attachments use the same source of truth).
  type BoundsHost = { __sfContentBounds?: ContentBounds | null };
  let contentBounds: ContentBounds | null = (svgEl as BoundsHost).__sfContentBounds ?? null;

  // Pan constraint chosen per-axis to fit two situations:
  //   1. Content smaller than viewport along this axis (e.g. the launch
  //      view of a few crate rows): allow the user to place content
  //      anywhere, only requiring PAN_MARGIN_PX to stay visible so it
  //      can't be pushed entirely off-screen. This lets ty=0 (content
  //      at top) sit naturally — no snap on first drag.
  //   2. Content bigger than viewport (typical expanded diagram): keep
  //      the screen centre over content. Without this, the user could
  //      pan a large diagram such that only a thin strip of labels stays
  //      visible — the rest of the diagram off-screen is hard to find.
  // Each axis switches between (1) and (2) independently based on its
  // current content size at the current zoom level.
  //
  // Derivation: a content edge sits at screen coord = data*k + t. For
  // (1) we want PAN_MARGIN_PX of content visible at each edge of the
  // viewport. For (2) we want viewport_centre in [data0*k+t, data1*k+t].
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
    const contentWPx = (contentBounds.x1 - contentBounds.x0) * k;
    const contentHPx = (contentBounds.y1 - contentBounds.y0) * k;
    // Horizontal: SVG transform tx is the motion mechanism (no native
    // horizontal scroll — there is no horizontal sticky to support).
    // Symmetric over-scroll: tx ∈ [-contentWPx, w]. tx > 0 = content
    // shifted right with empty space on the left; tx < -contentWPx
    // would put the content fully off the right of viewport.
    const txMin = -contentWPx + contentBounds.x0 * k;
    const txMax = w - contentBounds.x0 * k;
    if (txMin <= txMax) tx = Math.max(txMin, Math.min(txMax, tx));
    // Vertical: native scroll is the single motion mechanism.
    // canvas-content has clientHeight of padding above AND below the
    // content (set in main.ts), so scrollTop in [0, scrollMax] covers
    // the full over-scroll + scroll range. d3.zoom's ty maps to
    // scrollTop = TOP_PADDING - ty (TOP_PADDING = clientHeight = h).
    //
    // Valid ty: [h - scrollMax, h] = [-contentH, h].
    //   ty = h  → scrollTop = 0 (max over-scroll top, h px of empty).
    //   ty = 0  → scrollTop = h (default, content top at viewport top).
    //   ty < 0  → scrollTop > h (scrolled into content).
    //   ty = -contentH → scrollTop = scrollMax (max over-scroll bottom).
    const contentH = contentBounds.y1 * k - contentBounds.y0 * k;
    const tyMin = -contentH;
    const tyMax = h;
    if (tyMin <= tyMax) ty = Math.max(tyMin, Math.min(tyMax, ty));
    if (tx === transform.x && ty === transform.y) return transform;
    return transform.translate((tx - transform.x) / k, (ty - transform.y) / k);
  };

  if (zoomLayer.empty() || frozen.empty() || sticky.empty()) {
    zoomLayer = svg.append('g').attr('class', ZOOM_LAYER_CLASS);
    frozen = svg.append('g').attr('class', FROZEN_LAYER_CLASS);
    sticky = svg.append('g').attr('class', STICKY_LAYER_CLASS);

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

    z = zoom<Element, unknown>()
      .scaleExtent([SCALE_MIN, SCALE_MAX])
      // Let d3 keep the normal left-button "grab the canvas" drag and
      // programmatic transforms. main.ts owns right-button viewport panning
      // and decides which wheel events should zoom in each input mode.
      .filter(shouldHandleZoomEvent)
      .constrain(constrain)
      .on('zoom', (event) => {
        const t = event.transform;
        // d3.zoom's ty is purely a "pan offset from default". The
        // visual is delivered ENTIRELY by native scrollTop —
        // canvas-content is padded by clientHeight above AND below
        // the actual diagram (see main.ts), so the user can
        // over-scroll past either edge symmetrically and
        // `position: sticky` engages naturally throughout.
        //
        //   scrollTop = TOP_PADDING - t.y
        //
        //   ty = 0  → default (content top at viewport top).
        //   ty > 0  → over-scroll top (empty above content).
        //   ty < 0  → scrolled into content (sticky engages).
        const TOP = scrollEl.clientHeight;
        zoomLayer.attr('transform', `translate(${t.x},0) scale(${t.k})`);
        frozen.attr('transform', `scale(${t.k})`);
        scrollEl.scrollTop = Math.max(0, TOP - t.y);
        onZoom?.({ x: t.x, y: t.y, k: t.k });
      });
    // Bind d3.zoom to the scroll container, not the SVG. Two reasons:
    //   1. Wheel events from anywhere inside canvas-scroll (including
    //      the HTML module overlay) reach d3.zoom uniformly. If we
    //      bound to the SVG, wheels over HTML siblings would trigger
    //      native scroll on canvas-scroll and desync from d3.zoom's
    //      transform.
    //   2. d3.zoom's wheel zoom-around-cursor math uses
    //      `event.clientX/Y - rect.top` where rect is the bound
    //      element. canvas-scroll has a stable bounding rect; the SVG
    //      one shifts as we mirror t.y into scrollTop, which would
    //      break cursor-anchored zoom.
    target.call(z);
    // Disable d3.zoom's built-in double-click-to-zoom-in. Double-clicks
    // mid-diagram were tripping users up — the canvas should respond to
    // wheel/pinch and explicit reset only.
    target.on('dblclick.zoom', null);
  } else {
    // Existing layers — recover the behavior from where we stashed it.
    const stashed = (svgEl as { __sfZoom?: ZoomBehavior<Element, unknown> }).__sfZoom;
    if (!stashed) throw new Error('zoom behavior missing on existing layers');
    z = stashed;
  }
  (svgEl as { __sfZoom?: ZoomBehavior<Element, unknown> }).__sfZoom = z;
  (svgEl as { __sfWheelZoomFilter?: (event: WheelEvent) => boolean }).__sfWheelZoomFilter =
    wheelZoomFilter;

  const zoomNode = zoomLayer.node();
  const frozenNode = frozen.node();
  const stickyNode = sticky.node();
  if (!zoomNode || !frozenNode || !stickyNode) {
    throw new Error('zoom layers not initialized');
  }
  return {
    zoomLayer: zoomNode,
    frozenLayer: frozenNode,
    stickyLayer: stickyNode,
    translateBy: (dx, dy, animated = false) => {
      if (animated) {
        target.transition('zoom').duration(ANIM_MS).call(z.translateBy, dx, dy);
      } else {
        z.translateBy(target, dx, dy);
      }
    },
    translateByScreen: (dxPx, dyPx, animated = false) => {
      const t = zoomTransform(scrollEl);
      const dx = dxPx / t.k;
      const dy = dyPx / t.k;
      if (animated) {
        target.transition('zoom').duration(ANIM_MS).call(z.translateBy, dx, dy);
      } else {
        z.translateBy(target, dx, dy);
      }
    },
    visibleYRange: () => {
      const t = zoomTransform(scrollEl);
      const h = scrollEl.clientHeight;
      return { min: -t.y / t.k, max: (h - t.y) / t.k };
    },
    centerOnY: (y, animated = false) => {
      const t = zoomTransform(scrollEl);
      const h = scrollEl.clientHeight;
      // We want screen_y_of(y) == h/2; screen_y = y*k + t.y; so we need
      //   t.y' = h/2 - y*k
      // d3.translateBy(0, dy) updates t.y to t.y + dy*k, so:
      //   dy = (t.y' - t.y)/k = (h/2 - t.y)/k - y
      const dy = (h / 2 - t.y) / t.k - y;
      if (animated) {
        target.transition('zoom').duration(ANIM_MS).call(z.translateBy, 0, dy);
      } else {
        z.translateBy(target, 0, dy);
      }
    },
    panYToTop: (y, topPx, animated = false) => {
      // Same algebra as centerOnY but the target screen-y is `topPx`
      // instead of h/2 — places `y` at the requested viewport pixel.
      const t = zoomTransform(scrollEl);
      const dy = (topPx - t.y) / t.k - y;
      if (animated) {
        target.transition('zoom').duration(ANIM_MS).call(z.translateBy, 0, dy);
      } else {
        z.translateBy(target, 0, dy);
      }
    },
    centerOn: (x, y, animated = false) => {
      // Same algebra as centerOnY, applied to both axes.
      const t = zoomTransform(scrollEl);
      const w = scrollEl.clientWidth;
      const h = scrollEl.clientHeight;
      const dx = (w / 2 - t.x) / t.k - x;
      const dy = (h / 2 - t.y) / t.k - y;
      if (animated) {
        target.transition('zoom').duration(ANIM_MS).call(z.translateBy, dx, dy);
      } else {
        z.translateBy(target, dx, dy);
      }
    },
    panTo: (dataX, dataY, screenX, screenY, animated = false) => {
      // Convert click coords (event.clientX/Y) to the scroll container's
      // local coordinate system. d3.zoom is bound to canvas-scroll, so
      // its transform math expects local-y in [0, scrollEl.clientHeight].
      // The SVG's bounding rect now shifts with scrollTop (the SVG is
      // sized to the full content extent), so using it would
      // double-count the scroll offset and land the click in the wrong
      // place. The scroll container's rect is stable.
      const rect = scrollEl.getBoundingClientRect();
      const localX = screenX - rect.left;
      const localY = screenY - rect.top;
      const t = zoomTransform(scrollEl);
      const dx = (localX - t.x) / t.k - dataX;
      const dy = (localY - t.y) / t.k - dataY;
      if (animated) {
        target.transition('zoom').duration(ANIM_MS).call(z.translateBy, dx, dy);
      } else {
        z.translateBy(target, dx, dy);
      }
    },
    setScaleExtent: (min, max) => {
      // Guard against degenerate ranges (e.g. tiny content where fit > max).
      const lo = Math.min(min, max);
      const hi = Math.max(min, max);
      z.scaleExtent([lo, hi]);
      const k = zoomTransform(scrollEl).k;
      if (k < lo) z.scaleTo(target, lo);
      else if (k > hi) z.scaleTo(target, hi);
    },
    resetScale: (animated = false) => {
      if (animated) {
        target.transition('zoom').duration(ANIM_MS).call(z.scaleTo, 1);
      } else {
        z.scaleTo(target, 1);
      }
    },
    resetTransform: (animated = false) => {
      if (animated) {
        target.transition('zoom').duration(ANIM_MS).call(z.transform, zoomIdentity);
      } else {
        z.transform(target, zoomIdentity);
      }
    },
    setTransform: (k, tx, ty, animated = false) => {
      // ZoomTransform.translate(dx, dy) sets x = x + k*dx, so to land at
      // (k, tx, ty) starting from identity we apply scale(k) then
      // translate(tx/k, ty/k).
      const t = zoomIdentity.scale(k).translate(tx / k, ty / k);
      if (animated) {
        target.transition('zoom').duration(ANIM_MS).call(z.transform, t);
      } else {
        z.transform(target, t);
      }
    },
    getTransform: () => {
      const t = zoomTransform(scrollEl);
      return { x: t.x, y: t.y, k: t.k };
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
      const t = zoomTransform(scrollEl);
      z.transform(target, t);
    },
  };
}
