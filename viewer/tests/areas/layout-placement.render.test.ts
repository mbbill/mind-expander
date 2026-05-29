// @vitest-environment jsdom
//
// Tier-1 DOM-binding tests for the LAYOUT-PLACEMENT area.
//
// The pure placement math is covered in the node-env Tier-2 suite. This file
// covers the renderer seam: that `renderTree` faithfully binds the computed
// placement (`layout.types`) to the SVG DOM — the "looks wrong on screen but
// the math is right" class:
//   - LP-18: a box dropped or duplicated by the d3 data-join ("type box not
//     showing" / "v2 boxes overlap"), or a box drawn at an x the layout never
//     produced.
//   - LP-19: an empty container module emitting a dead type stripe — no
//     type-box should bind to a 0-own-type container, while the container's
//     own module row still exists.
//
// Mirrors the harness in tests/render_binding.test.ts (shared, not edited):
// a real layout is rendered into a detached <svg> under jsdom and only the
// attributes set SYNCHRONOUSLY on the d3 enter selection are asserted.

import { beforeEach, describe, expect, it } from 'vitest';
import type { Layout, LayoutInputs } from '../../src/analysis/layout_model.ts';
import { buildLayout } from '../../src/layout/pipeline.ts';
import { type TreeRenderOptions, renderTree } from '../../src/view/tree.ts';
import type { ZoomLayers } from '../../src/view/zoom.ts';
import { buildInputs, crateFacts, mod, ty } from '../fixtures/builders.ts';
import { smallFixtureInputs } from '../fixtures/small.ts';

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

/** A minimal `ZoomLayers` over three detached <g> — same shape as the shared
 *  render_binding harness. renderTree only reads the three layers and (inside
 *  a click handler it installs but we never fire) `getTransform`. */
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

function renderInto(inputs: LayoutInputs): { layout: Layout; zoom: SVGGElement } {
  document.body.innerHTML = '';
  const withMeasure = { ...inputs, measureText: measure };
  const layout = buildLayout(withMeasure);
  const made = makeLayers();
  renderTree(made.layers, layout, makeOpts(inputs.ownership));
  return { layout, zoom: made.zoom };
}

/** Escape a fullPath for use inside a CSS attribute selector. */
function cssEsc(s: string): string {
  return s.replace(/(["\\])/g, '\\$1');
}

// ===========================================================================
// LP-18 — DOM box binding: exactly one g.type-box per placed type, at its x
// ===========================================================================
describe('LP-18 type-box binding (no drop/dupe, correct x)', () => {
  let layout: Layout;
  let zoom: SVGGElement;

  beforeEach(() => {
    const r = renderInto(smallFixtureInputs(SMALL_EXPANDED));
    layout = r.layout;
    zoom = r.zoom;
  });

  it('renders exactly one g.type-box per layout type — equal sets and counts', () => {
    const boxes = Array.from(zoom.querySelectorAll('g.type-box'));
    const renderedIds = boxes.map((b) => b.getAttribute('data-element-id')).sort();
    const expectedIds = layout.types.map((t) => t.fullPath).sort();
    // Equal sets AND equal counts — a dropped box ("type box not showing") or
    // a duplicate from a colliding join key both fail here.
    expect(renderedIds).toEqual(expectedIds);
    expect(boxes.length).toBe(layout.types.length);
  });

  it('positions each type-box at its computed placement x', () => {
    for (const t of layout.types) {
      const box = zoom.querySelector(`g.type-box[data-element-id="${cssEsc(t.fullPath)}"]`);
      expect(box, `box for ${t.fullPath}`).not.toBeNull();
      const transform = box?.getAttribute('transform') ?? '';
      const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(transform);
      expect(m, `${t.fullPath} transform "${transform}"`).not.toBeNull();
      // x is bound directly from placement; y is offset by half a header row.
      expect(Number(m?.[1])).toBeCloseTo(t.x, 1);
      expect(Number.isFinite(Number(m?.[2]))).toBe(true);
    }
  });
});

// ===========================================================================
// LP-19 — DOM: empty container band emits NO type-box for that module id
// ===========================================================================
describe('LP-19 empty container band emits no type-box', () => {
  it('no g.type-box binds to a 0-own-type container, but the container module still renders', () => {
    const c = crateFacts('c', [
      mod(''),
      mod('outer'), // container, no own types
      mod('outer::inner', [ty('c', 'outer::inner', 'Leaf')]),
    ]);
    const inputs = buildInputs(c, [], ['c', 'c::outer', 'c::outer::inner']);
    const { layout, zoom } = renderInto(inputs);

    // The leaf type is rendered.
    const leafBox = zoom.querySelector('g.type-box[data-element-id="c::outer::inner::Leaf"]');
    expect(leafBox, 'leaf type-box present').not.toBeNull();

    // No type-box is bound to the empty container module id, and none of the
    // rendered type boxes belongs to a type in the container's own module.
    const boxIds = Array.from(zoom.querySelectorAll('g.type-box')).map((b) =>
      b.getAttribute('data-element-id'),
    );
    expect(boxIds).not.toContain('c::outer');
    for (const id of boxIds) {
      // A type owned directly by `c::outer` would have the form `c::outer::X`
      // but NOT `c::outer::inner::...`. There are none.
      expect(id ?? '').not.toMatch(/^c::outer::[^:]+$/);
    }
    // Sanity: the only placed type in the layout is the deep leaf.
    expect(layout.types.map((t) => t.fullPath)).toEqual(['c::outer::inner::Leaf']);

    // The container is a real MODULE, just one with no own types (this
    // distinguishes "module hidden" — wrong — from "module shown but no dead
    // type stripe" — correct). The module column itself is rendered as HTML in
    // html_tree.ts, outside this SVG renderTree harness, so we assert the
    // container's presence in the Layout model that renderTree is handed: the
    // container has a module row while contributing zero type boxes.
    expect(layout.modules.map((m) => m.id)).toContain('c::outer');
  });
});
