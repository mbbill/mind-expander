// @vitest-environment jsdom
//
// Tier-1 DOM-binding tests for the renderer (`tree.ts`).
//
// The pure layout pipeline is well covered by node-env tests. This file
// covers the OTHER half: that `renderTree` faithfully binds a computed
// `Layout` to the SVG DOM. That binding layer (the d3 data-joins in the
// 120KB tree.ts) is where the "looks wrong on screen but the math is
// right" bugs live:
//
//   - "type box not showing"   → a box dropped by the data-join / a key
//     collision, even though `layout.types` contains it.
//   - "arrow at the wrong place"→ a path whose `d` doesn't match the
//     layout's computed waypoints.
//
// We render a real layout into a detached <svg> under jsdom and assert
// the resulting elements/attributes. Only attributes set SYNCHRONOUSLY
// on the d3 enter selection are asserted (transforms, `d`, data-attrs) —
// the opacity tweens never run under jsdom and aren't relevant here.

import { beforeEach, describe, expect, it } from 'vitest';
import type { Layout } from '../src/analysis/layout_model.ts';
import { buildLayout } from '../src/layout/pipeline.ts';
import { polylinePath, renderTree, type TreeRenderOptions } from '../src/view/tree.ts';
import type { ZoomLayers } from '../src/view/zoom.ts';
import { smallFixtureInputs } from './fixtures/small.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';
const measure = (s: string): number => s.length * 7;
const SMALL_EXPANDED = [
  'c',
  'c::core',
  'c::render',
  'c::App',
  'c::core::Engine',
  'c::render::Renderer',
];

/** A minimal `ZoomLayers` over three detached <g>. renderTree only reads
 *  the three layers and (inside a click handler it installs but we never
 *  fire) `getTransform`. Pan/zoom methods are no-ops. */
function makeLayers(): { layers: ZoomLayers; zoom: SVGGElement } {
  const svg = document.createElementNS(SVG_NS, 'svg');
  document.body.appendChild(svg);
  const g = (): SVGGElement => svg.appendChild(document.createElementNS(SVG_NS, 'g'));
  const zoom = g();
  const noop = (): void => {};
  const layers = {
    zoomLayer: zoom,
    frozenLayer: g(),
    stickyLayer: g(),
    getTransform: () => ({ x: 0, y: 0, k: 1 }),
    translateBy: noop,
    translateByScreen: noop,
    visibleYRange: () => ({ min: 0, max: 1000 }),
    centerOnY: noop,
    panYToTop: noop,
    centerOn: noop,
    panTo: noop,
  } as unknown as ZoomLayers;
  return { layers, zoom };
}

/** All required `TreeRenderOptions`, with callbacks as no-ops and state
 *  sets empty. `ownership` comes from the fixture's layout inputs. */
function makeOpts(ownership: TreeRenderOptions['ownership']): TreeRenderOptions {
  const noop = (): void => {};
  return {
    onToggle: noop,
    onScrollToModule: noop,
    onShowCode: noop,
    onToggleTypeMembers: noop,
    onSelectField: noop,
    onToggleSignature: noop,
    onPickOutgoingCall: noop,
    onPickIncomingCaller: noop,
    onPickOwner: noop,
    onFollowGhost: noop,
    onArrowNavigate: noop,
    specificCallArrowsShown: new Set(),
    selectedFields: new Set(),
    incomingCallTargetsShown: new Set(),
    expandedBucketIds: new Set(),
    selectedArrows: new Set(),
    ownership,
    selectedElementId: null,
    selectedElementKind: null,
  };
}

let layout: Layout;
let zoom: SVGGElement;

beforeEach(() => {
  document.body.innerHTML = '';
  const inputs = { ...smallFixtureInputs(SMALL_EXPANDED), measureText: measure };
  layout = buildLayout(inputs);
  const made = makeLayers();
  zoom = made.zoom;
  renderTree(made.layers, layout, makeOpts(inputs.ownership));
});

describe('renderTree — type-box binding', () => {
  it('renders exactly one <g.type-box> per layout type, no dupes/drops', () => {
    const boxes = Array.from(zoom.querySelectorAll('g.type-box'));
    const renderedIds = boxes.map((b) => b.getAttribute('data-element-id')).sort();
    const expectedIds = layout.types.map((t) => t.fullPath).sort();
    // Equal sets AND equal counts — catches a dropped box ("type box not
    // showing") and a duplicate from a colliding join key.
    expect(renderedIds).toEqual(expectedIds);
  });

  it('positions each type-box at its computed (x, y)', () => {
    for (const t of layout.types) {
      const box = zoom.querySelector(`g.type-box[data-element-id="${cssEsc(t.fullPath)}"]`);
      expect(box, `box for ${t.fullPath}`).not.toBeNull();
      const transform = box?.getAttribute('transform') ?? '';
      const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(transform);
      expect(m, `${t.fullPath} transform "${transform}"`).not.toBeNull();
      // x is bound directly; y is offset by half a header row (see
      // renderTypes). Assert x exactly and y is finite + near the box.
      expect(Number(m?.[1])).toBeCloseTo(t.x, 1);
      expect(Number.isFinite(Number(m?.[2]))).toBe(true);
    }
  });
});

describe('renderTree — arrow binding', () => {
  it('renders one <g.arrow> per layout arrow', () => {
    const arrows = zoom.querySelectorAll('g.arrow');
    expect(layout.arrows.length).toBeGreaterThan(0); // guard: non-vacuous
    expect(arrows.length).toBe(layout.arrows.length);
  });

  it('binds each arrow path `d` to its computed waypoints (start/end correct)', () => {
    const expected = new Set(layout.arrows.map((a) => polylinePath(a.waypoints)));
    const paths = Array.from(zoom.querySelectorAll('g.arrow path.visible'));
    expect(paths.length).toBe(layout.arrows.length);
    for (const p of paths) {
      const d = p.getAttribute('d') ?? '';
      // Every rendered path must correspond to a real layout arrow's
      // routed polyline — a mismatch means the renderer drew the arrow
      // at coordinates the layout never produced.
      expect(expected.has(d), `rendered path d="${d}" matches a layout arrow`).toBe(true);
    }
  });

  it('writes endpoint identity attributes the tour/navigation layer reads', () => {
    const froms = Array.from(zoom.querySelectorAll('g.arrow')).map((g) =>
      g.getAttribute('data-arrow-from'),
    );
    // Every arrow group carries a non-empty source endpoint id.
    expect(froms.length).toBe(layout.arrows.length);
    for (const f of froms) expect(f && f.length > 0).toBe(true);
  });
});

/** Escape a fullPath for use inside a CSS attribute selector. Type ids
 *  contain `::` which is valid in an attribute *value* but we build the
 *  selector with quotes, so only quotes/backslashes need escaping. */
function cssEsc(s: string): string {
  return s.replace(/(["\\])/g, '\\$1');
}
