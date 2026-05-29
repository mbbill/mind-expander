// @vitest-environment jsdom
//
// Tier-1 DOM-binding tests for the `call-graph-arrows` area.
//
// Covers the renderer half (`tree.ts` data-joins) and the standalone
// edge-picker DOM (`view/edge_picker.ts`). The pure layout/data layer is
// covered in call-graph-arrows.layout.test.ts; this file asserts that a
// computed call Arrow and its callable row bind faithfully to the SVG DOM,
// and that the picker's resolved/unresolved affordances and click-anchor
// contract hold.
//
// Only attributes set SYNCHRONOUSLY on the d3 enter selection are asserted
// (stroke, fill, `d`, data-attrs) — opacity tweens don't run under jsdom.
//
// `calls_fixture` is built inline: builders.ts/small/medium emit ownership
// edges only and never carry call_edges, so a renderable call arrow has to
// be assembled here (Facts with call_edges → buildFunctionCallIndex →
// buildLayout with the pair in specificCallArrowsShown).

import { beforeEach, describe, expect, it } from 'vitest';
import { buildFunctionCallIndex } from '../../src/analysis/calls.ts';
import { computeDrift } from '../../src/analysis/drift.ts';
import { specificCallArrowKey } from '../../src/analysis/layout_model.ts';
import type { Layout, LayoutInputs } from '../../src/analysis/layout_model.ts';
import { type TreeNode, buildModuleTree } from '../../src/analysis/module_tree.ts';
import { buildOwnershipIndex, computeOwnershipDepth } from '../../src/analysis/ownership.ts';
import type { CallEdge, CrateFacts, Facts, FnFacts, ModuleFacts } from '../../src/data/schema.ts';
import { buildLayout } from '../../src/layout/pipeline.ts';
import { ViewState } from '../../src/state/view_state.ts';
import {
  type EdgeEntry,
  type EdgePickerShowArgs,
  createEdgePicker,
} from '../../src/view/edge_picker.ts';
import { type TreeRenderOptions, polylinePath, renderTree } from '../../src/view/tree.ts';
import type { ZoomLayers } from '../../src/view/zoom.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';
const measure = (s: string): number => s.length * 7;
// Color contract shared between the call-arrow stroke (arrowColor) and the
// row's locality `→` glyph (localityGlyphColor) — they MUST agree.
const BLUE_EXTERNAL = '#2563eb';
const GREY_LOCAL = '#94a3b8';
// The locality `→` glyph's neutral (local-only) fill. Note this is the
// field-ty grey (#64748b), NOT the call-arrow's local stroke (#94a3b8):
// the two channels agree only on the external/blue case. The local glyph
// reuses the neutral field color, so a local-only caller's glyph is just
// "not the external blue".
const NEUTRAL_LOCAL_GLYPH = '#64748b';

/** A minimal `ZoomLayers` over three detached <g> — renderTree only reads
 *  the three layers; pan/zoom methods are no-ops. */
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

function makeOpts(
  ownership: TreeRenderOptions['ownership'],
  selectedArrows: TreeRenderOptions['selectedArrows'] = new Set(),
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
    selectedArrows,
    ownership,
    selectedElementId: null,
    selectedElementKind: null,
  };
}

function fn(name: string): FnFacts {
  return { name, visibility: 'pub' };
}

type CallLocalityMode = 'local' | 'external' | 'unresolved';

/** One caller in the root module that calls one callee.
 *  - 'local': callee in the SAME module (grey arrow / neutral glyph)
 *  - 'external': callee in another module (blue arrow / blue glyph)
 *  - 'unresolved': callee name not in the workspace (no arrow; orange
 *    glyph). The single (caller,callee) pair is revealed. */
function callInputs(mode: CallLocalityMode | boolean): LayoutInputs {
  const m: CallLocalityMode =
    mode === true ? 'external' : mode === false ? 'local' : mode;
  const modules: ModuleFacts[] =
    m === 'external'
      ? [
          { path: '', file: 'src/lib.rs', functions: [fn('caller')], types: [] },
          { path: 'other', file: 'src/other.rs', functions: [fn('far')], types: [] },
        ]
      : [{ path: '', file: 'src/lib.rs', functions: [fn('caller'), fn('callee')], types: [] }];
  // 'unresolved': name that resolves to no workspace row.
  const calleeId =
    m === 'external' ? 'c::other::far' : m === 'unresolved' ? 'c::no_such_fn' : 'c::callee';
  const crate: CrateFacts = {
    name: 'c',
    modules: Object.fromEntries(modules.map((m) => [m.path, m])),
  };
  const edges: CallEdge[] = [
    {
      caller: 'c::caller',
      callee: calleeId,
      kind: 'function',
      resolution: m === 'unresolved' ? 'heuristic' : 'exact',
      origin: calleeId,
    },
  ];
  const facts: Facts = { crates: { c: crate }, edges: [], call_edges: edges };
  const root = buildModuleTree(crate);
  const calls = buildFunctionCallIndex(facts, root);
  const ownership = buildOwnershipIndex(facts);
  const typeModule = new Map<string, string>();
  const ids: string[] = [];
  const walk = (n: TreeNode): void => {
    if (n.kind === 'type') {
      typeModule.set(n.fullPath, n.modulePath);
      ids.push(n.fullPath);
    } else for (const c of n.children) walk(c);
  };
  walk(root);
  const drift = computeDrift(ownership, typeModule);
  const depth = computeOwnershipDepth(ownership, ids, drift);
  const state = new ViewState(['c', 'c::other', ...ids]);
  return {
    staticRoot: root,
    ownership,
    depth,
    state,
    drift,
    calls,
    specificCallArrowsShown: new Set([specificCallArrowKey('c::caller', calleeId)]),
    measureText: measure,
  };
}

function render(
  inputs: LayoutInputs,
  selectExternal = false,
): { layout: Layout; zoom: SVGGElement } {
  document.body.innerHTML = '';
  const layout = buildLayout(inputs);
  const made = makeLayers();
  const selected = selectExternal
    ? new Set(layout.arrows.filter((a) => a.kind === 'call'))
    : new Set<Layout['arrows'][number]>();
  renderTree(made.layers, layout, makeOpts(inputs.ownership, selected));
  return { layout, zoom: made.zoom };
}

describe('call-graph-arrows — call arrow DOM binding', () => {
  // CGA-RENDER-07: the rendered call path's `d` equals polylinePath of the
  // layout arrow's waypoints, and the endpoint identity attrs the tour layer
  // reads carry the NATURAL ids (function-group `__fn_*` stripped).
  it('CGA-RENDER-07 binds call path d to layout waypoints and endpoint ids', () => {
    const { layout, zoom } = render(callInputs(true));
    const callArrows = layout.arrows.filter((a) => a.kind === 'call');
    expect(callArrows.length).toBe(1);
    const expectedD = polylinePath(callArrows[0]?.waypoints ?? []);

    const callPaths = Array.from(zoom.querySelectorAll('g.arrow path.visible.call'));
    expect(callPaths.length).toBe(1);
    expect(callPaths[0]?.getAttribute('d')).toBe(expectedD);

    const g = zoom.querySelector('g.arrow');
    // Free functions live in a `__fn_*` group; the attribute strips that so
    // the tour resolver's natural-id string match succeeds (CGA-DIS-03 form).
    expect(g?.getAttribute('data-arrow-from')).toBe('c::caller');
    expect(g?.getAttribute('data-arrow-to')).toBe('c::other::far');
  });

  // CGA-RENDER-01: arrow stroke is by locality — external=blue, local=grey.
  // Pins BOTH branches (the bug was a hardcoded grey for all calls).
  it('CGA-RENDER-01 external call stroke is blue, local is grey', () => {
    const ext = render(callInputs(true));
    const extPath = ext.zoom.querySelector('g.arrow path.visible.call');
    expect(extPath?.getAttribute('stroke')).toBe(BLUE_EXTERNAL);

    const loc = render(callInputs(false));
    const locPath = loc.zoom.querySelector('g.arrow path.visible.call');
    expect(locPath?.getAttribute('stroke')).toBe(GREY_LOCAL);
  });

  // CGA-RENDER-02: selecting/highlighting an external call arrow must NOT
  // override the locality color — the stroke channel stays blue; selection
  // only adds the `.highlighted` class (width/opacity may change in CSS).
  it('CGA-RENDER-02 selection keeps the external locality color', () => {
    const { zoom } = render(callInputs(true), /* selectExternal */ true);
    const path = zoom.querySelector('g.arrow path.visible.call');
    expect(path?.classList.contains('highlighted')).toBe(true);
    // Color channel unchanged by selection — asserting only "looks different"
    // would accept a grey override.
    expect(path?.getAttribute('stroke')).toBe(BLUE_EXTERNAL);
  });

  // CGA-RENDER-06: the row's locality `→` glyph color. An external caller
  // row's glyph is blue (#2563eb) — the SAME blue the external call-arrow
  // stroke uses (CGA-RENDER-01), so the row indicator and its outgoing
  // arrow agree. A local-only caller's glyph is the neutral field-ty grey
  // (#64748b); this is the exact local oracle, not merely "not blue".
  it('CGA-RENDER-06 locality glyph: external blue agrees with arrow, local is neutral', () => {
    const ext = render(callInputs(true));
    const extGlyphs = Array.from(ext.zoom.querySelectorAll('text.locality-glyph'));
    expect(extGlyphs.length).toBeGreaterThan(0);
    expect(extGlyphs[0]?.textContent).toBe('→');
    expect(extGlyphs[0]?.getAttribute('fill')).toBe(BLUE_EXTERNAL);

    const loc = render(callInputs(false));
    const locGlyph = loc.zoom.querySelector('text.locality-glyph[fill]');
    // Non-vacuity: the local glyph is actually rendered (the row has an
    // outgoing call) — then assert its exact neutral fill.
    expect(locGlyph, 'local-only caller still renders a locality glyph').not.toBeNull();
    expect(locGlyph?.getAttribute('fill')).toBe(NEUTRAL_LOCAL_GLYPH);
  });

  // CGA-RENDER-06b: the third locality branch. A caller whose only call is
  // to an UNRESOLVED symbol renders the `→` glyph in orange (#f97316) and
  // materializes NO call arrow (there is no workspace row to land on). This
  // is the only coverage of the unresolved glyph branch in this area; the
  // data classification is pinned separately by CGA-DATA-01.
  it('CGA-RENDER-06b unresolved caller glyph is orange and no arrow is drawn', () => {
    const { layout, zoom } = render(callInputs('unresolved'));
    expect(layout.arrows.filter((a) => a.kind === 'call').length).toBe(0);
    const glyph = zoom.querySelector('text.locality-glyph[fill]');
    expect(glyph, 'unresolved caller still renders a locality glyph').not.toBeNull();
    expect(glyph?.textContent).toBe('→');
    expect(glyph?.getAttribute('fill')).toBe('#f97316');
  });
});

// --- edge picker DOM (view/edge_picker.ts) -------------------------------

function showArgs(over: Partial<EdgePickerShowArgs> = {}): EdgePickerShowArgs {
  const noop = (): void => {};
  return {
    entries: [],
    anchorX: 100,
    anchorY: 100,
    direction: 'outgoing',
    onPick: noop,
    onShowAll: noop,
    onHideAll: noop,
    ...over,
  };
}

function resolvedEntry(over: Partial<EdgeEntry> = {}): EdgeEntry {
  return { otherFullPath: 'c::callee', label: 'callee()', active: false, ...over };
}

describe('call-graph-arrows — edge picker affordances', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.getElementById('edge-picker')?.remove();
  });

  // CGA-PICK-02: an unresolved entry is informational only — class
  // `unresolved`, NO role=button, NO tabindex, NOT `.active`, and neither a
  // click nor Enter calls onPick.
  it('CGA-PICK-02 unresolved entry is inert (no role/tabindex/active/handlers)', () => {
    let picked = 0;
    const picker = createEdgePicker();
    picker.show(
      showArgs({
        // pass active:true to prove the picker still won't bold/activate it.
        entries: [
          { otherFullPath: 'ext::thing', label: 'thing()', active: true, unresolved: true },
        ],
        onPick: () => {
          picked += 1;
        },
      }),
    );
    const row = document.querySelector('.edge-picker-row');
    expect(row?.classList.contains('unresolved')).toBe(true);
    expect(row?.getAttribute('role')).toBeNull();
    expect((row as HTMLElement | null)?.tabIndex).toBe(-1); // not focusable
    expect(row?.classList.contains('active')).toBe(false);

    row?.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 5, clientY: 6 }));
    row?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(picked).toBe(0);
  });

  // CGA-PICK-07: onPick must receive the REAL click coordinates (so the host
  // pans the target under the cursor), not the picker's opening anchor. The
  // opening anchor here is (100,100) but the click lands at (640,480).
  it('CGA-PICK-07 onPick passes the click coords, not the opening anchor', () => {
    let anchor: { x: number; y: number } | null = null;
    const picker = createEdgePicker();
    picker.show(
      showArgs({
        anchorX: 100,
        anchorY: 100,
        entries: [resolvedEntry()],
        onPick: (_entry, clickAnchor) => {
          anchor = { ...clickAnchor };
        },
      }),
    );
    const row = document.querySelector('.edge-picker-row');
    row?.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 640, clientY: 480 }));
    expect(anchor).toEqual({ x: 640, y: 480 });
  });

  // CGA-PICK-07 (keyboard): Enter uses the row's center rect as the anchor,
  // NOT the opening anchor. (jsdom getBoundingClientRect is all-zero, so the
  // center is (0,0) — the point is that it does NOT reuse (100,100).)
  it('CGA-PICK-07 keyboard activation uses the row rect center, not the opening anchor', () => {
    let anchor: { x: number; y: number } | null = null;
    const picker = createEdgePicker();
    picker.show(
      showArgs({
        anchorX: 100,
        anchorY: 100,
        entries: [resolvedEntry()],
        onPick: (_entry, clickAnchor) => {
          anchor = { ...clickAnchor };
        },
      }),
    );
    const row = document.querySelector('.edge-picker-row');
    row?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(anchor).not.toBeNull();
    // Strong oracle: the anchor is the row rect's CENTER, not the opening
    // anchor. jsdom getBoundingClientRect returns all-zero, so the center
    // is exactly (0,0); a code path that reused the opening (100,100) or
    // the raw rect.left/top would not produce this.
    expect(anchor).toEqual({ x: 0, y: 0 });
  });

  // CGA-PICK-08: ESC dismisses; a capture-phase outside click dismisses; a
  // wheel on the panel is forwarded to the canvas (preventDefault'd, so the
  // panel itself doesn't scroll away).
  it('CGA-PICK-08 ESC and outside-click dismiss', () => {
    const root = () => document.getElementById('edge-picker') as HTMLElement;
    const picker = createEdgePicker();
    picker.show(showArgs({ entries: [resolvedEntry()] }));
    expect(root().style.display).toBe('block');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(root().style.display).toBe('none');

    picker.show(showArgs({ entries: [resolvedEntry()] }));
    expect(root().style.display).toBe('block');
    // Outside click (on body, not inside the panel) dismisses.
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    expect(root().style.display).toBe('none');
  });

  it('CGA-PICK-08 wheel on the panel forwards to the canvas and is prevented', () => {
    const canvas = document.createElement('div');
    canvas.id = 'canvas-scroll';
    document.body.appendChild(canvas);
    let forwarded = 0;
    canvas.addEventListener('wheel', () => {
      forwarded += 1;
    });
    const picker = createEdgePicker();
    picker.show(showArgs({ entries: [resolvedEntry()] }));
    const panel = document.querySelector('.edge-picker-panel') as HTMLElement;
    const evt = new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true });
    panel.dispatchEvent(evt);
    expect(forwarded).toBe(1);
    expect(evt.defaultPrevented).toBe(true);
  });

  // CGA-PICK-02 (positive control): a resolved entry IS interactive — role,
  // tabindex, and onPick fire — so the inert assertion above isn't vacuous.
  it('CGA-PICK-02 resolved entry is interactive (role/tabindex/onPick)', () => {
    let picked = 0;
    const picker = createEdgePicker();
    picker.show(
      showArgs({
        entries: [resolvedEntry({ active: true })],
        onPick: () => {
          picked += 1;
        },
      }),
    );
    const row = document.querySelector('.edge-picker-row') as HTMLElement;
    expect(row.getAttribute('role')).toBe('button');
    expect(row.tabIndex).toBe(0);
    expect(row.classList.contains('active')).toBe(true);
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 1, clientY: 2 }));
    expect(picked).toBe(1);
  });
});
