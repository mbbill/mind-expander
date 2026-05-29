// @vitest-environment jsdom
//
// Tier-1 DOM-binding regression tests for the ARROW-ROUTING area.
//
// These cover the UI/rendering layer: that `renderTree` faithfully binds
// each computed `Arrow` to one `<g.arrow>` with the correct path `d` and
// endpoint identity attributes, raises a hovered arrow to the top of its
// parent (paint order), and that the hover-highlight CSS contract is the
// vivid distinct color at a modest width.
//
// Harness mirrors tests/render_binding.test.ts: a detached <svg> with three
// stub zoom layers, all `TreeRenderOptions` callbacks as no-ops, a fixed
// measurer. Only attributes set SYNCHRONOUSLY on the d3 enter selection are
// asserted (the opacity tweens never run under jsdom).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Layout } from '../../src/analysis/layout_model.ts';
import { buildLayout } from '../../src/layout/pipeline.ts';
import { type TreeRenderOptions, polylinePath, renderTree } from '../../src/view/tree.ts';
import type { ZoomLayers } from '../../src/view/zoom.ts';
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

let layout: Layout;
let zoom: SVGGElement;
let ownership: TreeRenderOptions['ownership'];

function render(): void {
  document.body.innerHTML = '';
  const inputs = { ...smallFixtureInputs(SMALL_EXPANDED), measureText: measure };
  layout = buildLayout(inputs);
  ownership = inputs.ownership;
  const made = makeLayers();
  zoom = made.zoom;
  renderTree(made.layers, layout, makeOpts(inputs.ownership));
}

beforeEach(render);

// ---------------------------------------------------------------------------
// AR-29 — one <g.arrow> per layout arrow, no dupes/drops; data-arrow-from/to
//         present on every group.
// ---------------------------------------------------------------------------

describe('AR-29 — arrow data-join integrity', () => {
  it('renders exactly one <g.arrow> per layout arrow', () => {
    expect(layout.arrows.length).toBeGreaterThan(0); // non-vacuous
    const arrows = zoom.querySelectorAll('g.arrow');
    expect(arrows.length).toBe(layout.arrows.length);
  });

  it('every <g.arrow> carries non-empty data-arrow-from and data-arrow-to', () => {
    const groups = Array.from(zoom.querySelectorAll('g.arrow'));
    expect(groups.length).toBe(layout.arrows.length);
    for (const g of groups) {
      const from = g.getAttribute('data-arrow-from');
      const to = g.getAttribute('data-arrow-to');
      expect(from !== null && from.length > 0, 'data-arrow-from set').toBe(true);
      expect(to !== null && to.length > 0, 'data-arrow-to set').toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// AR-28 — the DOM path `d` matches the layout arrow's routed polyline
//         exactly (the "arrow at the wrong place" binding bug).
// ---------------------------------------------------------------------------

describe('AR-28 — arrow path d matches the routed polyline exactly', () => {
  it('every rendered visible path d corresponds to a real layout polyline', () => {
    const expected = new Set(layout.arrows.map((a) => polylinePath(a.waypoints)));
    const paths = Array.from(zoom.querySelectorAll('g.arrow path.visible'));
    expect(paths.length).toBe(layout.arrows.length);
    for (const p of paths) {
      const d = p.getAttribute('d') ?? '';
      expect(expected.has(d), `rendered path d="${d}" matches a layout polyline`).toBe(true);
    }
  });

  it('every layout polyline is rendered (no dropped arrow)', () => {
    const rendered = new Set(
      Array.from(zoom.querySelectorAll('g.arrow path.visible')).map(
        (p) => p.getAttribute('d') ?? '',
      ),
    );
    for (const a of layout.arrows) {
      expect(rendered.has(polylinePath(a.waypoints)), `layout polyline for ${a.fromTypeId}`).toBe(
        true,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// AR-25 — hovered arrow <g> is raised to the top of g.arrows (paint order);
//         a fresh renderTree restores the natural order.
// ---------------------------------------------------------------------------

describe('AR-25 — hover raises the arrow to the top of its parent', () => {
  it('mouseenter on a non-last arrow makes it lastElementChild of g.arrows', () => {
    const arrowsGroup = zoom.querySelector('g.arrows');
    expect(arrowsGroup).not.toBeNull();
    if (arrowsGroup === null) return;
    const arrows = Array.from(arrowsGroup.querySelectorAll(':scope > g.arrow'));
    expect(arrows.length).toBeGreaterThanOrEqual(2); // need a non-last sibling

    const first = arrows[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(arrowsGroup.lastElementChild).not.toBe(first); // precondition

    first.dispatchEvent(new Event('mouseenter'));

    expect(arrowsGroup.lastElementChild, 'hovered arrow raised to top').toBe(first);
  });

  it('a fresh renderTree (new DOM) paints arrows in natural data order, un-raised', () => {
    // The raise is attached on enter only and is transient: a genuinely
    // fresh render produces the enter selection in layout-arrow order, so
    // the default stacking (no arrow on top) returns. Render the same
    // layout into a brand-new container and assert order == data order.
    const made = makeLayers();
    renderTree(made.layers, layout, makeOpts(ownership));
    const group = made.zoom.querySelector('g.arrows');
    expect(group).not.toBeNull();
    const order = Array.from(group?.querySelectorAll(':scope > g.arrow') ?? []).map((g) => [
      g.getAttribute('data-arrow-from'),
      g.getAttribute('data-arrow-to'),
    ]);
    const expected = layout.arrows.map((a) => [
      arrowDataFrom(a.fromTypeId, a.fromFieldName, a.fromRowKind),
      arrowDataFrom(a.toTypeId, a.toFieldName, a.toRowKind),
    ]);
    expect(order).toEqual(expected);
  });
});

/** Mirror the `endpointId` helper in tree.ts for the expected DOM
 *  attribute (strip the function-group pseudo segment for function rows). */
function arrowDataFrom(
  typeId: string,
  field: string | undefined,
  rowKind: 'field' | 'method' | 'function' | undefined,
): string {
  const base = rowKind === 'function' ? typeId.replace(/::__fn_[^:]+$/, '') : typeId;
  return field === undefined ? base : `${base}::${field}`;
}

// ---------------------------------------------------------------------------
// AR-26 — hover stroke switches to the vivid distinct purple #a855f7 at 2px
//         (not the idle color, not 3px). The rule lives in index.html CSS,
//         which jsdom does not apply, so assert the authored rule directly.
// ---------------------------------------------------------------------------

describe('AR-26 — hover highlight CSS contract', () => {
  // vitest runs with cwd at the viewer package root; index.html lives there.
  const indexHtml = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

  it('g.arrow:hover path.visible uses #a855f7 at stroke-width 2', () => {
    const ruleBody = extractRuleBody(indexHtml, '#tree g.arrows g.arrow:hover path.visible');
    expect(ruleBody, 'hover rule present in index.html').not.toBeNull();
    if (ruleBody === null) return;
    expect(/stroke:\s*#a855f7/.test(ruleBody), 'vivid purple stroke').toBe(true);
    expect(/stroke-width:\s*2(\D|$)/.test(ruleBody), 'modest 2px width').toBe(true);
    // Guard against the historical "too thick" 3px regression.
    expect(/stroke-width:\s*3/.test(ruleBody)).toBe(false);
  });
});

/** Return the body text of the FIRST CSS rule whose selector text exactly
 *  matches `selector` (ignoring leading whitespace). Null if not found. */
function extractRuleBody(css: string, selector: string): string | null {
  const idx = css.indexOf(selector);
  if (idx === -1) return null;
  const open = css.indexOf('{', idx + selector.length);
  if (open === -1) return null;
  const close = css.indexOf('}', open);
  if (close === -1) return null;
  // Make sure nothing but whitespace sits between the selector and the
  // brace (so we matched the selector head, not a substring of a longer one).
  const between = css.slice(idx + selector.length, open);
  if (between.trim() !== '') return null;
  return css.slice(open + 1, close);
}
