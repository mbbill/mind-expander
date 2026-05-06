// Pan + zoom on the SVG canvas, with a frozen left column for the module
// tree. d3.zoom drives one shared transform; we project it onto two layers:
//
//   • zoomLayer   — full transform (translate(x,y) scale(k)). Holds types,
//                   field rows, and arrows. Pans/zooms freely.
//   • frozenLayer — only vertical translate + scale (translate(0,y) scale(k)).
//                   Holds the module tree. Stays glued to the left edge
//                   horizontally so module ↔ type-band mapping survives any
//                   horizontal pan.
//
// The frozen layer is appended LAST so it draws on top of any types that pan
// underneath it. A backdrop rect fills the column area opaque white so panned
// types don't bleed through.

import { type ZoomBehavior, select, zoom, zoomIdentity, zoomTransform } from 'd3';

const ZOOM_LAYER_CLASS = 'zoom-layer';
const FROZEN_LAYER_CLASS = 'frozen-layer';
const BACKDROP_CLASS = 'frozen-backdrop';
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
  /** Holds the module tree. Locked horizontally; mirrors only y/scale. */
  readonly frozenLayer: SVGGElement;
  /** White backdrop inside the frozen layer; size it to cover the column. */
  readonly backdrop: SVGRectElement;
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
  /** Decide whether a wheel event should be interpreted as zoom by d3.
   *  Main input-mode handling uses this to make trackpad-mode plain
   *  two-finger scroll pan, while Shift+scroll still zooms. */
  readonly setWheelZoomFilter: (filter: (event: WheelEvent) => boolean) => void;
}

export function attachZoom(
  svgEl: SVGSVGElement,
  onZoom?: (transform: { x: number; y: number; k: number }) => void,
): ZoomLayers {
  const svg = select(svgEl);

  let zoomLayer = svg.select<SVGGElement>(`g.${ZOOM_LAYER_CLASS}`);
  let frozen = svg.select<SVGGElement>(`g.${FROZEN_LAYER_CLASS}`);
  let backdrop = frozen.select<SVGRectElement>(`rect.${BACKDROP_CLASS}`);
  let z: ZoomBehavior<SVGSVGElement, unknown>;
  let wheelZoomFilter =
    (svgEl as { __sfWheelZoomFilter?: (event: WheelEvent) => boolean }).__sfWheelZoomFilter ??
    (() => true);

  if (zoomLayer.empty() || frozen.empty()) {
    zoomLayer = svg.append('g').attr('class', ZOOM_LAYER_CLASS);
    frozen = svg.append('g').attr('class', FROZEN_LAYER_CLASS);
    backdrop = frozen
      .append('rect')
      .attr('class', BACKDROP_CLASS)
      .attr('x', -10000)
      .attr('y', -10000)
      .attr('width', 0)
      .attr('height', 20000)
      .attr('fill', 'white');

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
  const backdropNode = backdrop.node();
  if (!zoomNode || !frozenNode || !backdropNode) {
    throw new Error('zoom layers not initialized');
  }
  return {
    zoomLayer: zoomNode,
    frozenLayer: frozenNode,
    backdrop: backdropNode,
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
      // Same algebra as centerOnY, applied to both axes. Note: the frozen
      // pane's right edge eats some screen width, but we don't compensate
      // here — pinning the navigated point to the visual centre tends to
      // land it nicely in the type pane regardless. If a node ends up
      // hidden behind the frozen column, the user can pan back; that's
      // the same trade-off already accepted by centerOnY for vertical.
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
    setWheelZoomFilter: (filter) => {
      wheelZoomFilter = filter;
      (svgEl as { __sfWheelZoomFilter?: (event: WheelEvent) => boolean }).__sfWheelZoomFilter =
        filter;
    },
  };
}
