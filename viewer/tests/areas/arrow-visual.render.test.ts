// @vitest-environment jsdom
//
// Tier-1 DOM-binding regression tests for OWNERSHIP-ARROW VISUALS (GROUP I):
// stroke colour by driftClass, stroke-dasharray by kind, the arrowhead
// marker bound by driftClass, the drift DOT on drifted field rows, and the
// click→onArrowNavigate hit handler (tolerance = ARROW_HIT_PX / zoom).
//
// Harness mirrors tests/areas/arrow-routing.render.test.ts: a detached <svg>
// with three stub zoom layers, all `TreeRenderOptions` callbacks as no-ops
// (overridable), a fixed measurer. Only attributes set SYNCHRONOUSLY on the
// d3 enter selection are asserted — the renderer sets stroke / dasharray /
// marker-end / class / fill / r / pointer-events synchronously, while POSITION
// attributes (`cx`/`cy`/`x`/`y`) flow through a `.transition('move')` that
// never ticks under jsdom, so those are intentionally not asserted here (they
// are owned by the Tier-2 geometry layer instead).

import { beforeEach, describe, expect, it } from 'vitest';
import type { DriftClass } from '../../src/analysis/drift.ts';
import type { Arrow, ArrowWaypoint, Layout, LayoutInputs } from '../../src/analysis/layout_model.ts';
import { rowArrowKey } from '../../src/analysis/layout_model.ts';
import { buildLayout } from '../../src/layout/pipeline.ts';
import { type TreeRenderOptions, renderTree } from '../../src/view/tree.ts';
import type { ZoomLayers } from '../../src/view/zoom.ts';
import { buildInputs, crateFacts, edge, mod, ty } from '../fixtures/builders.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';
const measure = (s: string): number => s.length * 7;

// Observable colours the renderer paints (the literal hex values that land
// in the DOM `stroke` / `fill` attribute). Authored in tree.ts; asserted
// here as the user-visible contract.
const COLOR_CANONICAL = '#94a3b8'; // slate-400 — at_lca / within_budget
const COLOR_SOFT = '#f59e0b'; // amber — drift_below
const COLOR_HARD = '#ef4444'; // red — drift_above / drift_sideways
const COLOR_REEXPORT = '#a855f7'; // violet-500
const COLOR_CALL_EXTERNAL = '#2563eb'; // blue — cross-module call
const COLOR_DRIFT_DOT_BELOW = '#d97706'; // amber-600 — drift_below dot
const COLOR_DRIFT_DOT_HARD = '#ef4444'; // red — drift_above / sideways dot

// kind-specific dash patterns (tree.ts).
const REEXPORT_DASH = '2 2';
const METHOD_DASH = '4 3';
const CROSS_CRATE_DASH = '6 2 1 2 1 2';

// Drift dot geometry (analysis/layout_metrics.ts).
const DRIFT_DOT_RADIUS = 2.5;

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
    visibleYRange: () => ({ min: 0, max: 100000 }),
    centerOnY: noop,
    panYToTop: noop,
    centerOn: noop,
    panTo: noop,
  } as unknown as ZoomLayers;
  return { layers, zoom };
}

function makeOpts(
  ownership: TreeRenderOptions['ownership'],
  over: Partial<TreeRenderOptions> = {},
): TreeRenderOptions {
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
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Drift-class fixture (same hierarchy as arrow-drift.test.ts, Tier-2): four
// targets at at_lca / drift_below / drift_above / drift_sideways relative to
// their owners. Used to assert the REAL stroke colours and the drift dots.
// ---------------------------------------------------------------------------

const HUB = 'c::Hub';
const SIDE_OWNER = 'c::left::SideOwner';
const ABOVE_OWNER = 'c::deep::sub::AboveOwner';

function driftInputs(): LayoutInputs {
  const c = crateFacts('c', [
    mod('', [
      ty('c', '', 'Hub', [
        { name: 'canon', ty_text: 'Canon' },
        { name: 'below', ty_text: 'a::b::c::Below' },
      ]),
      ty('c', '', 'Canon'),
      ty('c', '', 'Above'),
    ]),
    mod('a::b::c', [ty('c', 'a::b::c', 'Below')]),
    mod('deep::sub', [ty('c', 'deep::sub', 'AboveOwner', [{ name: 'up', ty_text: 'deep::Above' }])]),
    mod('left', [ty('c', 'left', 'SideOwner', [{ name: 'sw', ty_text: 'right::Sideways' }])]),
    mod('right', [ty('c', 'right', 'Sideways')]),
  ]);
  const edges = [
    edge(HUB, 'c::Canon', 'field canon'),
    edge(HUB, 'c::a::b::c::Below', 'field below'),
    edge(ABOVE_OWNER, 'c::Above', 'field up'),
    edge(SIDE_OWNER, 'c::right::Sideways', 'field sw'),
  ];
  const expanded = [
    'c',
    'c::a',
    'c::a::b',
    'c::a::b::c',
    'c::deep',
    'c::deep::sub',
    'c::left',
    'c::right',
    HUB,
    ABOVE_OWNER,
    SIDE_OWNER,
  ];
  return buildInputs(c, edges, expanded);
}

function allDriftedShown(): ReadonlySet<string> {
  return new Set([
    rowArrowKey(HUB, 'below'),
    rowArrowKey(ABOVE_OWNER, 'up'),
    rowArrowKey(SIDE_OWNER, 'sw'),
  ]);
}

/** Render the drift fixture into a fresh container and return the painted
 *  visible arrow path for the ownership arrow that targets `toTypeId`. */
function renderDriftAndFindArrow(zoom: SVGGElement, layout: Layout, toTypeId: string): SVGPathElement {
  const groups = Array.from(zoom.querySelectorAll('g.arrow'));
  for (const g of groups) {
    if (g.getAttribute('data-arrow-to') === toTypeId) {
      const p = g.querySelector<SVGPathElement>('path.visible');
      if (p !== null) return p;
    }
  }
  throw new Error(`no rendered arrow to ${toTypeId}`);
}

// ===========================================================================
// GI-VIS-1 — arrow stroke colour follows the TARGET's driftClass.
// ===========================================================================

describe('GI-VIS-1 — arrow stroke colour by driftClass', () => {
  let zoom: SVGGElement;
  let layout: Layout;

  beforeEach(() => {
    document.body.innerHTML = '';
    const inputs = driftInputs();
    layout = buildLayout({ ...inputs, fieldArrowsShown: allDriftedShown(), measureText: measure });
    const made = makeLayers();
    zoom = made.zoom;
    renderTree(made.layers, layout, makeOpts(inputs.ownership));
  });

  it('canonical (at_lca) target → slate stroke', () => {
    expect(renderDriftAndFindArrow(zoom, layout, 'c::Canon').getAttribute('stroke')).toBe(
      COLOR_CANONICAL,
    );
  });

  it('drift_below target → amber stroke', () => {
    expect(
      renderDriftAndFindArrow(zoom, layout, 'c::a::b::c::Below').getAttribute('stroke'),
    ).toBe(COLOR_SOFT);
  });

  it('drift_above target → red stroke', () => {
    expect(renderDriftAndFindArrow(zoom, layout, 'c::Above').getAttribute('stroke')).toBe(
      COLOR_HARD,
    );
  });

  it('drift_sideways target → red stroke', () => {
    expect(
      renderDriftAndFindArrow(zoom, layout, 'c::right::Sideways').getAttribute('stroke'),
    ).toBe(COLOR_HARD);
  });
});

// ===========================================================================
// GI-VIS-2 — stroke-dasharray and marker-end by arrow KIND + cross-crate.
// Built by substituting crafted Arrow objects into a real layout's
// `arrowLayers` (the renderer's data source), so the binding under test is
// the renderer's exact stroke-dasharray / marker-end / class logic.
// ===========================================================================

const WP: readonly ArrowWaypoint[] = [
  { x: 0, y: 0 },
  { x: 40, y: 0 },
  { x: 40, y: 30 },
];

function arrowOf(over: Partial<Arrow>): Arrow {
  return {
    waypoints: WP,
    fromTypeId: 'c::A',
    fromFieldName: 'f',
    fromRowKind: 'field',
    toTypeId: 'c::B',
    kind: 'ownership',
    driftClass: 'at_lca',
    ...over,
  };
}

function layoutWithArrows(arrows: readonly Arrow[]): Layout {
  // A real (small) layout, but with its ownership arrow layer swapped for the
  // crafted set so the renderer paints exactly these. The other layers stay
  // empty; renderArrows flattens arrowLayers as its data join source.
  const base = buildLayout({ ...driftInputs(), fieldArrowsShown: new Set(), measureText: measure });
  return {
    ...base,
    arrows,
    arrowLayers: [
      { id: 'ownership', arrows, hitTestable: true },
      { id: 'reexport', arrows: [], hitTestable: true },
      { id: 'call', arrows: [], hitTestable: true },
    ],
  };
}

function renderArrowsOf(arrows: readonly Arrow[]): { zoom: SVGGElement; layout: Layout } {
  document.body.innerHTML = '';
  const layout = layoutWithArrows(arrows);
  const made = makeLayers();
  renderTree(made.layers, layout, makeOpts(driftInputs().ownership));
  return { zoom: made.zoom, layout };
}

function visiblePathFor(zoom: SVGGElement, from: string): SVGPathElement {
  for (const g of Array.from(zoom.querySelectorAll('g.arrow'))) {
    if (g.getAttribute('data-arrow-from') === from) {
      const p = g.querySelector<SVGPathElement>('path.visible');
      if (p !== null) return p;
    }
  }
  throw new Error(`no rendered arrow from ${from}`);
}

describe('GI-VIS-2 — stroke-dasharray by arrow kind', () => {
  it('plain ownership arrow has NO dasharray (solid line)', () => {
    const { zoom } = renderArrowsOf([arrowOf({ fromFieldName: 'own' })]);
    expect(visiblePathFor(zoom, 'c::A::own').getAttribute('stroke-dasharray')).toBeNull();
  });

  it('reexport arrow uses the short symmetric dash', () => {
    const { zoom } = renderArrowsOf([arrowOf({ fromFieldName: 're', kind: 'reexport' })]);
    expect(visiblePathFor(zoom, 'c::A::re').getAttribute('stroke-dasharray')).toBe(REEXPORT_DASH);
  });

  it('call arrow uses the asymmetric method dash', () => {
    const { zoom } = renderArrowsOf([
      arrowOf({ fromFieldName: 'cl', kind: 'call', fromRowKind: 'method', locality: 'external' }),
    ]);
    expect(visiblePathFor(zoom, 'c::A::cl').getAttribute('stroke-dasharray')).toBe(METHOD_DASH);
  });

  it('cross-crate ownership arrow uses the morse dash regardless of kind', () => {
    const { zoom } = renderArrowsOf([
      arrowOf({ fromFieldName: 'xc', isCrossCrate: true }),
    ]);
    expect(visiblePathFor(zoom, 'c::A::xc').getAttribute('stroke-dasharray')).toBe(CROSS_CRATE_DASH);
  });

  it('cross-crate wins over a reexport kind dash', () => {
    const { zoom } = renderArrowsOf([
      arrowOf({ fromFieldName: 'xr', kind: 'reexport', isCrossCrate: true }),
    ]);
    expect(visiblePathFor(zoom, 'c::A::xr').getAttribute('stroke-dasharray')).toBe(CROSS_CRATE_DASH);
  });
});

describe('GI-VIS-3 — arrowhead marker-end bound by driftClass; call stroke by locality', () => {
  const markerCases: ReadonlyArray<readonly [DriftClass, string]> = [
    ['at_lca', 'sf-arrow-canonical'],
    ['within_budget', 'sf-arrow-canonical'],
    ['drift_below', 'sf-arrow-soft'],
    ['drift_above', 'sf-arrow-hard'],
    ['drift_sideways', 'sf-arrow-hard'],
  ];

  it('marker-end references the per-driftClass marker id', () => {
    for (const [driftClass, markerId] of markerCases) {
      const { zoom } = renderArrowsOf([arrowOf({ fromFieldName: driftClass, driftClass })]);
      expect(
        visiblePathFor(zoom, `c::A::${driftClass}`).getAttribute('marker-end'),
        `marker for ${driftClass}`,
      ).toBe(`url(#${markerId})`);
    }
  });

  it('the canonical arrowhead marker defines fill=context-stroke so it inherits the stroke', () => {
    // Rendered once so the <defs> markers are injected. context-stroke lets a
    // highlighted/drift arrow's head pick up the path stroke without per-state JS.
    const { zoom } = renderArrowsOf([arrowOf({})]);
    const svg = zoom.ownerSVGElement ?? zoom.closest('svg');
    const markerPath = svg?.querySelector('marker#sf-arrow-canonical path');
    expect(markerPath, 'canonical arrow marker present').not.toBeNull();
    expect(markerPath?.getAttribute('fill')).toBe('context-stroke');
  });

  it('external call arrow strokes blue; local call arrow strokes canonical grey', () => {
    const ext = renderArrowsOf([
      arrowOf({ fromFieldName: 'ext', kind: 'call', fromRowKind: 'method', locality: 'external' }),
    ]);
    expect(visiblePathFor(ext.zoom, 'c::A::ext').getAttribute('stroke')).toBe(COLOR_CALL_EXTERNAL);
    const loc = renderArrowsOf([
      arrowOf({ fromFieldName: 'loc', kind: 'call', fromRowKind: 'method', locality: 'local' }),
    ]);
    expect(visiblePathFor(loc.zoom, 'c::A::loc').getAttribute('stroke')).toBe(COLOR_CANONICAL);
  });

  it('reexport arrow strokes violet', () => {
    const { zoom } = renderArrowsOf([arrowOf({ fromFieldName: 'rx', kind: 'reexport' })]);
    expect(visiblePathFor(zoom, 'c::A::rx').getAttribute('stroke')).toBe(COLOR_REEXPORT);
  });
});

// ===========================================================================
// GI-VIS-4 — the drift DOT renders on drifted field rows with the right
// colour; absent on canonical rows, absent on non-field (callable) rows.
// Synchronous attributes only (fill / r / pointer-events / class); the
// dot's cx/cy flow through a transition and are owned by the geometry layer.
// ===========================================================================

describe('GI-VIS-4 — drift dot on field rows', () => {
  let zoom: SVGGElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    const inputs = driftInputs();
    const layout = buildLayout({
      ...inputs,
      fieldArrowsShown: allDriftedShown(),
      measureText: measure,
    });
    const made = makeLayers();
    zoom = made.zoom;
    renderTree(made.layers, layout, makeOpts(inputs.ownership));
  });

  /** The drift dot circle inside the field-row group for (typeId, fieldName),
   *  or null if absent. */
  function driftDot(typeId: string, fieldName: string): SVGCircleElement | null {
    const fg = zoom.querySelector(
      `g.field-row-g[data-element-id="${typeId}::${fieldName}"]`,
    );
    return fg?.querySelector<SVGCircleElement>('circle.drift-dot') ?? null;
  }

  it('drift_below field shows an amber dot (radius 2.5, pointer-events:none)', () => {
    const dot = driftDot(HUB, 'below');
    expect(dot, 'drift_below row has a dot').not.toBeNull();
    expect(dot?.getAttribute('fill')).toBe(COLOR_DRIFT_DOT_BELOW);
    expect(Number(dot?.getAttribute('r'))).toBe(DRIFT_DOT_RADIUS);
    expect(dot?.style.pointerEvents).toBe('none');
  });

  it('drift_above field shows a red dot', () => {
    const dot = driftDot(ABOVE_OWNER, 'up');
    expect(dot, 'drift_above row has a dot').not.toBeNull();
    expect(dot?.getAttribute('fill')).toBe(COLOR_DRIFT_DOT_HARD);
  });

  it('drift_sideways field shows a red dot', () => {
    const dot = driftDot(SIDE_OWNER, 'sw');
    expect(dot, 'drift_sideways row has a dot').not.toBeNull();
    expect(dot?.getAttribute('fill')).toBe(COLOR_DRIFT_DOT_HARD);
  });

  it('canonical (at_lca) field shows NO drift dot', () => {
    expect(driftDot(HUB, 'canon'), 'canonical row has no dot').toBeNull();
  });

  it('every rendered drift dot lives inside a field-row group, never a non-field row', () => {
    const dots = Array.from(zoom.querySelectorAll('circle.drift-dot'));
    expect(dots.length).toBeGreaterThan(0); // non-vacuous
    for (const dot of dots) {
      const group = dot.closest('g.field-row-g');
      expect(group, 'drift dot parented by a field-row group').not.toBeNull();
      expect(group?.getAttribute('data-element-kind')).toBe('field');
    }
  });
});

// ===========================================================================
// GI-VIS-5 — arrow click within tolerance fires onArrowNavigate; tolerance
// is ARROW_HIT_PX / zoom (so the on-screen hit area is zoom-invariant).
// Driven through the installed `click.arrow-nav` handler on the zoom layer.
// ===========================================================================

describe('GI-VIS-5 — arrow click → onArrowNavigate (tolerance scales with zoom)', () => {
  const ARROW_HIT_PX = 8; // tree.ts ARROW_HIT_PX

  /** Render one straight horizontal arrow and dispatch a click at data-space
   *  (cx, cy). The stub layers report transform.k = `k` so the handler's
   *  tolerance is ARROW_HIT_PX / k. d3.pointer reads offsetX/offsetY from the
   *  event against the zoom layer (identity transform on the element), so we
   *  pass them directly. */
  function clickArrowAt(
    k: number,
    clickData: { x: number; y: number },
  ): { calls: number; hits: number } {
    document.body.innerHTML = '';
    const arrow = arrowOf({
      fromFieldName: 'h',
      waypoints: [
        { x: 0, y: 50 },
        { x: 100, y: 50 },
      ],
    });
    const layout = layoutWithArrows([arrow]);
    const made = makeLayers();
    (made.layers as { getTransform: () => { x: number; y: number; k: number } }).getTransform =
      () => ({ x: 0, y: 0, k });
    let calls = 0;
    let hits = 0;
    renderTree(
      made.layers,
      layout,
      makeOpts(driftInputs().ownership, {
        onArrowNavigate: (h) => {
          calls += 1;
          hits = h.length;
        },
      }),
    );
    // jsdom doesn't lay out the SVG and getScreenCTM() is null, so d3.pointer
    // returns clientX/clientY directly (rect origin is 0,0). Pass our intended
    // data-space coordinates as clientX/Y; the zoom layer carries the identity
    // transform, so pointer(event, zoomLayer) == (clientX, clientY).
    const ev = new MouseEvent('click', {
      bubbles: true,
      clientX: clickData.x,
      clientY: clickData.y,
    });
    made.zoom.dispatchEvent(ev);
    return { calls, hits };
  }

  it('a click within tolerance of the arrow fires onArrowNavigate with the hit', () => {
    const r = clickArrowAt(1, { x: 50, y: 50 + 4 }); // 4px off, tol = 8
    expect(r.calls).toBe(1);
    expect(r.hits).toBe(1);
  });

  it('a click beyond tolerance does NOT fire onArrowNavigate', () => {
    const r = clickArrowAt(1, { x: 50, y: 50 + 40 }); // 40px off, tol = 8
    expect(r.calls).toBe(0);
  });

  it('zooming in shrinks the data-space tolerance: a 4px-off click misses at k=4', () => {
    // At k=4 the tolerance is 8/4 = 2 data units; a 4-unit miss is outside it.
    const r = clickArrowAt(4, { x: 50, y: 50 + 4 });
    expect(r.calls).toBe(0);
  });

  it('zooming out grows the data-space tolerance: a 12px-off click hits at k=0.5', () => {
    // At k=0.5 the tolerance is 8/0.5 = 16 data units; a 12-unit miss is inside it.
    const r = clickArrowAt(0.5, { x: 50, y: 50 + 12 });
    expect(r.calls).toBe(1);
  });
});
