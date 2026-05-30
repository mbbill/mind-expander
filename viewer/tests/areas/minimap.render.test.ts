// @vitest-environment jsdom
//
// Tier-1 DOM-binding tests for the diagram minimap (`createMinimap`).
//
// GROUP L (dg-module-tree-minimap): the minimap had ZERO tests. The minimap
// is a pure render-binding component: given a Layout it paints module bands +
// type boxes (colored by visibility OR diff state), a viewport indicator rect
// derived from the live zoom transform + scroll-container size, and wires
// click/drag-pan that translates pointer coords back into data space and calls
// layers.centerOn. This file covers the binding half — that the computed
// Layout + transform faithfully maps to the SVG elements/attrs synchronously
// in jsdom. The real-browser pointer drag is in e2e/minimap.spec.ts (Tier-3).
//
// `createMinimap` reads only a documented subset of the Layout contract
// (modules[].{id,y,bandHeight}, types[].{id,x,y,width,height,fullPath,
// visibility,typeKind}, totalWidth/totalHeight — see minimap.ts), and a
// minimal ZoomLayers (getTransform/centerOn). We construct those subsets
// directly so each test isolates ONE binding behavior; building the full
// buildLayout pipeline would couple the colour/opacity/viewport oracles to
// unrelated layout math. The oracle for each test is the exact attribute the
// renderer in minimap.ts writes, verified against that source.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Layout, ModuleRow, TypeBox } from '../../src/analysis/layout_model.ts';
import { colorForVisibility } from '../../src/view/encoding.ts';
import { createMinimap } from '../../src/view/minimap.ts';
import type { ZoomLayers } from '../../src/view/zoom.ts';

// Layout geometry constants mirrored from minimap.ts (its private W/H/PAD).
// Tests assert against these so a renderer change to the frame surfaces here.
const W = 180;
const H = 132;
const PAD = 8;
const DIFF_ADD = '#56C271';
const DIFF_DEL = '#FF6B6B';

// ── fixture builders (NEW; do not edit shared fixtures) ─────────────────────
function band(id: string, y: number, bandHeight: number): ModuleRow {
  // Only the fields the minimap reads are meaningful; the rest satisfy the
  // ModuleRow contract so we exercise the real createMinimap signature.
  return {
    id,
    label: id,
    modDepth: 0,
    labelX: 0,
    hitWidth: 0,
    y,
    bandHeight,
    expanded: true,
    hasChildren: false,
    prefixSegments: [],
    leafBg: { name: id, xStart: 0, width: 0, isParent: false },
    isLeaf: true,
    fileRole: 'leaf-file',
    language: 'rust',
  } as ModuleRow;
}

function box(
  id: string,
  opts: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    fullPath?: string;
    visibility?: string;
    typeKind?: TypeBox['typeKind'];
  } = {},
): TypeBox {
  const x = opts.x ?? 10;
  const y = opts.y ?? 20;
  const width = opts.width ?? 40;
  const height = opts.height ?? 30;
  return {
    id,
    label: id,
    typeKind: opts.typeKind ?? 'struct',
    visibility: opts.visibility ?? 'pub',
    fullPath: opts.fullPath ?? id,
    modulePath: 'm',
    col: 0,
    x,
    y,
    width,
    boxX: x,
    boxY: y - height / 2,
    boxWidth: width,
    boxHeight: height,
    headerArrowX: null,
    headerHitWidth: width,
    height,
    hasFields: false,
    expanded: false,
    fields: [],
    totalFieldCount: 0,
    isGhost: false,
    ghostTarget: null,
  } as TypeBox;
}

function layout(opts: {
  modules?: ModuleRow[];
  types?: TypeBox[];
  totalWidth?: number;
  totalHeight?: number;
}): Layout {
  return {
    modules: opts.modules ?? [],
    types: opts.types ?? [],
    arrowLayers: [],
    arrows: [],
    totalWidth: opts.totalWidth ?? 100,
    totalHeight: opts.totalHeight ?? 100,
  };
}

interface Harness {
  root: HTMLElement;
  scrollEl: HTMLElement;
  layers: ZoomLayers;
  setTransform: (t: { x: number; y: number; k: number }) => void;
  centerOn: ReturnType<typeof vi.fn>;
}

function makeHarness(opts: { viewW?: number; viewH?: number } = {}): Harness {
  // @vitest-environment jsdom provides the global `document`. d3's
  // select(root).select('svg') is a DESCENDANT search, so the SVG lives
  // nested inside the root element — exactly like #minimap > .minimap-body >
  // svg in index.html.
  const root = document.createElement('div');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  root.appendChild(svg);
  document.body.appendChild(root);

  const scrollEl = document.createElement('div');
  // jsdom does not lay out, so clientWidth/Height are 0 by default. The
  // viewport-rect math reads these as the on-screen viewport size; define
  // them so the visible-range computation has a real window.
  Object.defineProperty(scrollEl, 'clientWidth', { value: opts.viewW ?? 400, configurable: true });
  Object.defineProperty(scrollEl, 'clientHeight', { value: opts.viewH ?? 300, configurable: true });
  document.body.appendChild(scrollEl);

  let transform = { x: 0, y: 0, k: 1 };
  const centerOn = vi.fn();
  const layers = {
    getTransform: () => transform,
    centerOn,
  } as unknown as ZoomLayers;

  return {
    root,
    scrollEl,
    layers,
    centerOn,
    setTransform: (t) => {
      transform = t;
    },
  };
}

function svgOf(root: HTMLElement): SVGSVGElement {
  const el = root.querySelector('svg');
  if (el === null) throw new Error('no svg');
  return el as unknown as SVGSVGElement;
}

/** Indexed access under noUncheckedIndexedAccess — throws on a missing
 *  element so a wrong-count bug surfaces as a clear failure, not undefined. */
function at<T>(arr: readonly T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`expected element at index ${i} (len ${arr.length})`);
  return v;
}

/** All rects inside the named minimap group. */
function rectsIn(root: HTMLElement, cls: string): SVGRectElement[] {
  return [...svgOf(root).querySelectorAll<SVGRectElement>(`g.${cls} rect`)];
}

/** The single viewport-indicator rect (throws if absent). */
function viewportRect(root: HTMLElement): SVGRectElement {
  const el = svgOf(root).querySelector<SVGRectElement>('rect.minimap-viewport');
  if (el === null) throw new Error('no viewport rect');
  return el;
}

/** The i-th call's arg tuple of a vi mock (throws if that call didn't
 *  happen) — `layers.centerOn(dataX, dataY, animated)`. */
function centerOnCall(
  fn: ReturnType<typeof vi.fn>,
  i: number,
): { dataX: number; dataY: number; animated: boolean } {
  const call = fn.mock.calls[i] as [number, number, boolean] | undefined;
  if (call === undefined) throw new Error(`centerOn was not called ${i + 1} time(s)`);
  return { dataX: call[0], dataY: call[1], animated: call[2] };
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe('minimap render: bands + type boxes', () => {
  it('renders one band rect per module and one type rect per type', () => {
    const h = makeHarness();
    const mm = createMinimap(h.root, h.scrollEl, h.layers);
    mm.update(
      layout({
        modules: [band('m0', 0, 50), band('m1', 50, 50)],
        types: [box('A'), box('B'), box('C')],
        totalWidth: 100,
        totalHeight: 100,
      }),
    );

    const svg = svgOf(h.root);
    expect(svg.querySelectorAll('g.minimap-bands rect')).toHaveLength(2);
    expect(svg.querySelectorAll('g.minimap-types rect')).toHaveLength(3);
    // Root is shown (not hidden) once a non-empty layout arrives.
    expect(h.root.hidden).toBe(false);
  });

  it('band rects span the full content width and alternate fill by index', () => {
    const h = makeHarness();
    const mm = createMinimap(h.root, h.scrollEl, h.layers);
    // Fit scale = min((W-2PAD)/100, (H-2PAD)/100). W=180,H=132 so the
    // HEIGHT axis is the tighter fit: scale = (H-2PAD)/100 = 1.16.
    mm.update({
      ...layout({
        modules: [band('m0', 0, 50), band('m1', 50, 50), band('m2', 100, 50)],
        totalWidth: 100,
        totalHeight: 100,
      }),
    });
    const svg = svgOf(h.root);
    const rects = [...svg.querySelectorAll('g.minimap-bands rect')];
    const scale = Math.min((W - 2 * PAD) / 100, (H - 2 * PAD) / 100);
    const contentW = 100 * scale;
    const ox = (W - contentW) / 2;
    for (const r of rects) {
      expect(Number(r.getAttribute('x'))).toBeCloseTo(ox, 5);
      expect(Number(r.getAttribute('width'))).toBeCloseTo(contentW, 5);
    }
    // Alternating stripe colours by data index: even=#f8fafc, odd=#eef2f7.
    expect(at(rects, 0).getAttribute('fill')).toBe('#f8fafc');
    expect(at(rects, 1).getAttribute('fill')).toBe('#eef2f7');
    expect(at(rects, 2).getAttribute('fill')).toBe('#f8fafc');
  });

  it('band rect y/height project through the fit scale', () => {
    const h = makeHarness();
    const mm = createMinimap(h.root, h.scrollEl, h.layers);
    mm.update(
      layout({
        modules: [band('m0', 0, 40), band('m1', 40, 60)],
        totalWidth: 100,
        totalHeight: 100,
      }),
    );
    const svg = svgOf(h.root);
    const rects = [...svg.querySelectorAll('g.minimap-bands rect')];
    const scale = Math.min((W - 2 * PAD) / 100, (H - 2 * PAD) / 100);
    const oy = (H - 100 * scale) / 2;
    expect(Number(at(rects, 1).getAttribute('y'))).toBeCloseTo(oy + 40 * scale, 4);
    expect(Number(at(rects, 1).getAttribute('height'))).toBeCloseTo(60 * scale, 4);
  });

  it('hides the root when layout is null or empty', () => {
    const h = makeHarness();
    const mm = createMinimap(h.root, h.scrollEl, h.layers);
    mm.update(layout({ totalWidth: 100, totalHeight: 100, types: [box('A')] }));
    expect(h.root.hidden).toBe(false);

    mm.update(null);
    expect(h.root.hidden).toBe(true);

    mm.update(layout({ totalWidth: 0, totalHeight: 100 }));
    expect(h.root.hidden).toBe(true);

    mm.update(layout({ totalWidth: 100, totalHeight: 0 }));
    expect(h.root.hidden).toBe(true);
  });
});

describe('minimap render: type-box colours + opacity (normal mode)', () => {
  it('colours type boxes by visibility when not in diff mode', () => {
    const h = makeHarness();
    const mm = createMinimap(h.root, h.scrollEl, h.layers);
    mm.update(
      layout({
        types: [
          box('pub', { visibility: 'pub' }),
          box('crate', { visibility: 'pub(crate)' }),
          box('priv', { visibility: 'priv' }),
        ],
      }),
    );
    const rects = rectsIn(h.root, 'minimap-types');
    const byId = (id: string): SVGRectElement => {
      // type rects carry no id attr; assert positionally via data join order.
      return at(rects, ['pub', 'crate', 'priv'].indexOf(id));
    };
    expect(byId('pub').getAttribute('fill')).toBe(colorForVisibility('pub'));
    expect(byId('crate').getAttribute('fill')).toBe(colorForVisibility('pub(crate)'));
    expect(byId('priv').getAttribute('fill')).toBe(colorForVisibility('priv'));
    // pub != private colour — the encoding actually discriminates.
    expect(colorForVisibility('pub')).not.toBe(colorForVisibility('priv'));
  });

  it('opacity is 0.4 for normal types and 0.25 for function_group', () => {
    const h = makeHarness();
    const mm = createMinimap(h.root, h.scrollEl, h.layers);
    mm.update(
      layout({
        types: [box('S', { typeKind: 'struct' }), box('F', { typeKind: 'function_group' })],
      }),
    );
    const rects = rectsIn(h.root, 'minimap-types');
    expect(Number(at(rects, 0).getAttribute('opacity'))).toBeCloseTo(0.4, 6);
    expect(Number(at(rects, 1).getAttribute('opacity'))).toBeCloseTo(0.25, 6);
  });

  it('type rect width/height clamp to the 2px minimum when content is tiny', () => {
    const h = makeHarness();
    const mm = createMinimap(h.root, h.scrollEl, h.layers);
    // Huge content so a small box scales below the MIN_TYPE_W/H=2 floor.
    mm.update(
      layout({
        types: [box('tiny', { x: 0, y: 0, width: 0.0001, height: 0.0001 })],
        totalWidth: 100000,
        totalHeight: 100000,
      }),
    );
    const r = at(rectsIn(h.root, 'minimap-types'), 0);
    expect(Number(r.getAttribute('width'))).toBeGreaterThanOrEqual(2);
    expect(Number(r.getAttribute('height'))).toBeGreaterThanOrEqual(2);
  });
});

describe('minimap render: diff-mode colours (typeBarStateById)', () => {
  it('colours add=green, del=red, split=gradient and unchanged=slate', () => {
    const h = makeHarness();
    const stateById = new Map<string, 'add' | 'del' | 'split'>([
      ['m::Added', 'add'],
      ['m::Removed', 'del'],
      ['m::Changed', 'split'],
    ]);
    const mm = createMinimap(h.root, h.scrollEl, h.layers, { typeBarStateById: stateById });
    mm.update(
      layout({
        types: [
          box('Added', { fullPath: 'm::Added' }),
          box('Removed', { fullPath: 'm::Removed' }),
          box('Changed', { fullPath: 'm::Changed' }),
          box('Untouched', { fullPath: 'm::Untouched', visibility: 'pub' }),
        ],
      }),
    );
    const rects = rectsIn(h.root, 'minimap-types');
    expect(at(rects, 0).getAttribute('fill')).toBe(DIFF_ADD);
    expect(at(rects, 1).getAttribute('fill')).toBe(DIFF_DEL);
    expect(at(rects, 2).getAttribute('fill')).toBe('url(#minimap-split)');
    // Unchanged entity in diff mode is quiet slate-300, NOT its visibility
    // colour — the minimap surfaces WHERE the diff is.
    expect(at(rects, 3).getAttribute('fill')).toBe('#cbd5e1');
  });

  it('side-tagged entities are full-opacity (0.95); unchanged stays soft', () => {
    const h = makeHarness();
    const stateById = new Map<string, 'add' | 'del' | 'split'>([['m::Added', 'add']]);
    const mm = createMinimap(h.root, h.scrollEl, h.layers, { typeBarStateById: stateById });
    mm.update(
      layout({
        types: [
          box('Added', { fullPath: 'm::Added', typeKind: 'struct' }),
          box('Untouched', { fullPath: 'm::Untouched', typeKind: 'struct' }),
        ],
      }),
    );
    const rects = rectsIn(h.root, 'minimap-types');
    expect(Number(at(rects, 0).getAttribute('opacity'))).toBeCloseTo(0.95, 6);
    expect(Number(at(rects, 1).getAttribute('opacity'))).toBeCloseTo(0.4, 6);
  });

  it('an EMPTY typeBarStateById map is treated as normal mode (visibility colours)', () => {
    const h = makeHarness();
    // Always-passed-but-empty map: the renderer must test for non-empty
    // content, not just "is it defined" (see minimap.ts comment).
    const mm = createMinimap(h.root, h.scrollEl, h.layers, {
      typeBarStateById: new Map(),
    });
    mm.update(layout({ types: [box('A', { visibility: 'pub' })] }));
    const r = at(rectsIn(h.root, 'minimap-types'), 0);
    expect(r.getAttribute('fill')).toBe(colorForVisibility('pub'));
  });

  it('in diff mode a box absent from the diff map paints quiet slate-300 (not its visibility colour)', () => {
    const h = makeHarness();
    // Non-empty map => diff mode ON. A box not in the map is "unchanged",
    // rendered slate-300 — the minimap surfaces ONLY where the diff is.
    const stateById = new Map<string, 'add' | 'del' | 'split'>([['m::Other', 'add']]);
    const mm = createMinimap(h.root, h.scrollEl, h.layers, { typeBarStateById: stateById });
    mm.update(layout({ types: [box('Mine', { fullPath: 'm::Mine', visibility: 'pub' })] }));
    const r = at(rectsIn(h.root, 'minimap-types'), 0);
    // Diff mode is ON (map non-empty) so an absent box is slate-300, NOT
    // its visibility colour — this is the documented diff-mode behavior.
    expect(r.getAttribute('fill')).toBe('#cbd5e1');
  });

  it('defines a single green-top/red-bottom split gradient with a hard 50% stop', () => {
    const h = makeHarness();
    const mm = createMinimap(h.root, h.scrollEl, h.layers, {
      typeBarStateById: new Map([['m::C', 'split']]),
    });
    mm.update(layout({ types: [box('C', { fullPath: 'm::C' })] }));
    const svg = svgOf(h.root);
    const grad = svg.querySelector('defs.minimap-defs linearGradient#minimap-split');
    if (grad === null) throw new Error('no split gradient');
    // Vertical gradient.
    expect(grad.getAttribute('x1')).toBe('0');
    expect(grad.getAttribute('y1')).toBe('0');
    expect(grad.getAttribute('x2')).toBe('0');
    expect(grad.getAttribute('y2')).toBe('1');
    const stops = [...grad.querySelectorAll('stop')];
    expect(stops).toHaveLength(2);
    // Hard stop at 50%: green offset 50% then red offset 50%.
    expect(at(stops, 0).getAttribute('offset')).toBe('50%');
    expect(at(stops, 0).getAttribute('stop-color')).toBe(DIFF_ADD);
    expect(at(stops, 1).getAttribute('offset')).toBe('50%');
    expect(at(stops, 1).getAttribute('stop-color')).toBe(DIFF_DEL);
  });

  it('defs/gradient is created once, not duplicated across updates', () => {
    const h = makeHarness();
    const mm = createMinimap(h.root, h.scrollEl, h.layers, {
      typeBarStateById: new Map([['m::C', 'split']]),
    });
    mm.update(layout({ types: [box('C', { fullPath: 'm::C' })] }));
    mm.update(layout({ types: [box('C', { fullPath: 'm::C' })] }));
    const svg = svgOf(h.root);
    expect(svg.querySelectorAll('defs.minimap-defs')).toHaveLength(1);
    expect(svg.querySelectorAll('linearGradient#minimap-split')).toHaveLength(1);
  });
});

describe('minimap render: viewBox + frame', () => {
  it('sets a fixed viewBox and xMidYMid meet preserveAspectRatio', () => {
    const h = makeHarness();
    createMinimap(h.root, h.scrollEl, h.layers);
    const svg = svgOf(h.root);
    expect(svg.getAttribute('viewBox')).toBe(`0 0 ${W} ${H}`);
    expect(svg.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet');
  });
});

describe('minimap render: viewport indicator rect', () => {
  it('renders a single viewport rect reflecting the visible data range', () => {
    const h = makeHarness({ viewW: 200, viewH: 150 });
    const mm = createMinimap(h.root, h.scrollEl, h.layers);
    // Identity transform, content 400x300, viewport 200x150 → the visible
    // band is the top-left quarter of the content in data space:
    // vx0=0, vy0=0, vx1=200, vy1=150.
    mm.update(layout({ totalWidth: 400, totalHeight: 300 }));
    const svg = svgOf(h.root);
    const vps = svg.querySelectorAll('rect.minimap-viewport');
    expect(vps).toHaveLength(1);

    const scale = Math.min((W - 2 * PAD) / 400, (H - 2 * PAD) / 300);
    const ox = (W - 400 * scale) / 2;
    const oy = (H - 300 * scale) / 2;
    const vp = viewportRect(h.root);
    expect(Number(vp.getAttribute('x'))).toBeCloseTo(ox + 0 * scale, 4);
    expect(Number(vp.getAttribute('y'))).toBeCloseTo(oy + 0 * scale, 4);
    expect(Number(vp.getAttribute('width'))).toBeCloseTo(200 * scale, 4);
    expect(Number(vp.getAttribute('height'))).toBeCloseTo(150 * scale, 4);
  });

  it('viewport rect updates when the zoom transform changes (scroll/pan)', () => {
    const h = makeHarness({ viewW: 200, viewH: 150 });
    const mm = createMinimap(h.root, h.scrollEl, h.layers);
    const lay = layout({ totalWidth: 400, totalHeight: 300 });
    mm.update(lay);
    const yBefore = Number(viewportRect(h.root).getAttribute('y'));

    // Scroll down: native scroll mirrors -scrollTop into t.y, so t.y<0
    // moves the visible band DOWN the content. vy0 = -t.y/k = 100.
    h.setTransform({ x: 0, y: -100, k: 1 });
    mm.update(lay);
    const yAfter = Number(viewportRect(h.root).getAttribute('y'));
    expect(yAfter).toBeGreaterThan(yBefore);

    const scale = Math.min((W - 2 * PAD) / 400, (H - 2 * PAD) / 300);
    const oy = (H - 300 * scale) / 2;
    expect(yAfter).toBeCloseTo(oy + 100 * scale, 4);
  });

  it('viewport width/height clamp to a 2px minimum for a near-zero window', () => {
    // Tiny viewport vs huge content → the visible-range box would be
    // sub-pixel; the renderer floors it at 2px so the indicator never
    // collapses to an invisible line.
    const h = makeHarness({ viewW: 1, viewH: 1 });
    const mm = createMinimap(h.root, h.scrollEl, h.layers);
    mm.update(layout({ totalWidth: 100000, totalHeight: 100000 }));
    const vp = viewportRect(h.root);
    expect(Number(vp.getAttribute('width'))).toBeGreaterThanOrEqual(2);
    expect(Number(vp.getAttribute('height'))).toBeGreaterThanOrEqual(2);
  });

  it('viewport rect is clamped to content bounds when scrolled past the edge', () => {
    const h = makeHarness({ viewW: 200, viewH: 150 });
    const mm = createMinimap(h.root, h.scrollEl, h.layers);
    const lay = layout({ totalWidth: 400, totalHeight: 300 });
    // Pan FAR past the bottom edge: vy0 would be 1000 but clamps to
    // totalHeight=300; vy1 also clamps to 300 → height collapses to the
    // 2px floor and y pins at the bottom of the minimap content.
    h.setTransform({ x: 0, y: -1000, k: 1 });
    mm.update(lay);
    const scale = Math.min((W - 2 * PAD) / 400, (H - 2 * PAD) / 300);
    const oy = (H - 300 * scale) / 2;
    const vp = viewportRect(h.root);
    // Clamped to data y=300.
    expect(Number(vp.getAttribute('y'))).toBeCloseTo(oy + 300 * scale, 4);
    expect(Number(vp.getAttribute('height'))).toBeCloseTo(2, 6);
  });
});

describe('minimap interaction: pointer→data translation (jsdom)', () => {
  // The pointer-coordinate math (panFromPointer) is pure given a
  // getBoundingClientRect; we can drive it in jsdom by stubbing the rect and
  // dispatching a real PointerEvent, asserting the data-space point passed to
  // layers.centerOn. The real-browser drag (capture, default-prevent,
  // stopPropagation against d3.zoom) lives in e2e/minimap.spec.ts.
  function dispatchPointer(
    h: Harness,
    type: 'pointerdown' | 'pointermove' | 'pointerup',
    clientX: number,
    clientY: number,
  ): void {
    const svg = svgOf(h.root);
    // jsdom lacks PointerEvent; synthesize a minimal Event carrying the
    // fields panFromPointer + the drag handlers read (clientX/Y, pointerId).
    const ev = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent & {
      clientX: number;
      clientY: number;
      pointerId: number;
    };
    Object.defineProperties(ev, {
      clientX: { value: clientX },
      clientY: { value: clientY },
      pointerId: { value: 1 },
    });
    svg.dispatchEvent(ev);
  }

  function stubRect(h: Harness): void {
    const svg = svgOf(h.root);
    // SVG is laid out at (0,0) sized 180x132 (the viewBox CSS box). The
    // pointer math reads getBoundingClientRect().{left,top} only.
    (svg as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: W, height: H, right: W, bottom: H, x: 0, y: 0 }) as DOMRect;
    // jsdom has no pointer-capture; stub so the handlers don't throw.
    const node = svg as unknown as {
      setPointerCapture: (id: number) => void;
      releasePointerCapture: (id: number) => void;
      hasPointerCapture: (id: number) => boolean;
    };
    node.setPointerCapture = () => {};
    node.releasePointerCapture = () => {};
    node.hasPointerCapture = () => false;
  }

  it('pointerdown centers the canvas on the data point under the cursor', () => {
    const h = makeHarness();
    const mm = createMinimap(h.root, h.scrollEl, h.layers);
    mm.update(layout({ totalWidth: 100, totalHeight: 100 }));
    stubRect(h);

    // Fit scale is height-limited: min((180-16)/100,(132-16)/100)=1.16.
    // contentW=contentH=116, ox=(180-116)/2=32, oy=(132-116)/2=8.
    // Click the minimap centre (90, 66): dataX=(90-32)/1.16, dataY=(66-8)/1.16.
    dispatchPointer(h, 'pointerdown', 90, 66);
    expect(h.centerOn).toHaveBeenCalledTimes(1);
    const { dataX, dataY, animated } = centerOnCall(h.centerOn, 0);
    const scale = Math.min((W - 2 * PAD) / 100, (H - 2 * PAD) / 100);
    const ox = (W - 100 * scale) / 2;
    const oy = (H - 100 * scale) / 2;
    expect(dataX).toBeCloseTo((90 - ox) / scale, 4);
    expect(dataY).toBeCloseTo((66 - oy) / scale, 4);
    // Pan is immediate (not animated) so dragging tracks the pointer.
    expect(animated).toBe(false);
  });

  it('dragging (down then move) pans continuously; move before down is ignored', () => {
    const h = makeHarness();
    const mm = createMinimap(h.root, h.scrollEl, h.layers);
    mm.update(layout({ totalWidth: 100, totalHeight: 100 }));
    stubRect(h);

    // A move with no prior pointerdown must NOT pan (dragging=false).
    dispatchPointer(h, 'pointermove', 40, 40);
    expect(h.centerOn).not.toHaveBeenCalled();

    dispatchPointer(h, 'pointerdown', 40, 40);
    dispatchPointer(h, 'pointermove', 120, 100);
    expect(h.centerOn).toHaveBeenCalledTimes(2);

    // After pointerup the drag stops: a later move is ignored.
    dispatchPointer(h, 'pointerup', 120, 100);
    dispatchPointer(h, 'pointermove', 60, 60);
    expect(h.centerOn).toHaveBeenCalledTimes(2);
  });

  it('pointer outside the content rect clamps the data point to [0,total]', () => {
    const h = makeHarness();
    const mm = createMinimap(h.root, h.scrollEl, h.layers);
    mm.update(layout({ totalWidth: 100, totalHeight: 100 }));
    stubRect(h);

    // Click the far top-left corner (0,0): raw dataX=(0-8)/scale<0, clamps
    // to 0. Far bottom-right (180,132): raw > total, clamps to 100.
    dispatchPointer(h, 'pointerdown', 0, 0);
    const topLeft = centerOnCall(h.centerOn, 0);
    expect(topLeft.dataX).toBe(0);
    expect(topLeft.dataY).toBe(0);

    dispatchPointer(h, 'pointerdown', W, H);
    const botRight = centerOnCall(h.centerOn, 1);
    expect(botRight.dataX).toBe(100);
    expect(botRight.dataY).toBe(100);
  });
});
