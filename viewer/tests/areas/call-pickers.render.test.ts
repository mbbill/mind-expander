// @vitest-environment jsdom
//
// Tier-1 DOM-binding tests for GROUP H — the call-target / caller pickers
// and the cross-crate call-arrow style. Two renderers are exercised:
//
//   view/edge_picker.ts — the floating picker DOM: cross-crate crate
//     span (purple), dimmed module prefix span, hide-all toolbar button,
//     Space-key activation, and the inside-click-picks-without-premature-
//     dismiss contract.
//
//   view/tree.ts — the incoming-call marker's active/inactive fill, and
//     the cross-crate call-arrow morse dash (`6 2 1 2 1 2`) which wins
//     over the kind-specific call dash.
//
// These complement call-graph-arrows.render.test.ts (which covers the
// outgoing locality-glyph color, resolved/unresolved picker affordance,
// and click-anchor contract) without duplicating it — every assertion
// here is a distinct GROUP H gap row.
//
// Only synchronously-set d3 enter attributes are asserted (opacity tweens
// don't run under jsdom).

import { beforeEach, describe, expect, it } from 'vitest';
import { buildFunctionCallIndex } from '../../src/analysis/calls.ts';
import { computeDrift } from '../../src/analysis/drift.ts';
import { specificCallArrowKey } from '../../src/analysis/layout_model.ts';
import type { Layout, LayoutInputs } from '../../src/analysis/layout_model.ts';
import { type TreeNode, buildWorkspaceTree } from '../../src/analysis/module_tree.ts';
import { buildOwnershipIndex, computeOwnershipDepth } from '../../src/analysis/ownership.ts';
import type { CallEdge, CrateFacts, Facts, FnFacts, ModuleFacts } from '../../src/data/schema.ts';
import { buildLayout } from '../../src/layout/pipeline.ts';
import { ViewState } from '../../src/state/view_state.ts';
import {
  type EdgeEntry,
  type EdgePickerShowArgs,
  createEdgePicker,
} from '../../src/view/edge_picker.ts';
import { type TreeRenderOptions, renderTree } from '../../src/view/tree.ts';
import type { ZoomLayers } from '../../src/view/zoom.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';
const measure = (s: string): number => s.length * 7;
const BLUE_ACTIVE = '#2563eb'; // incoming-marker active fill (call external blue)
const GREY_CHEVRON = '#94a3b8'; // incoming-marker inactive fill (COLOR_CHEVRON)
const CROSS_CRATE_DASH = '6 2 1 2 1 2';

function fn(name: string): FnFacts {
  return { name, visibility: 'pub' };
}
function mod(path: string, functions: FnFacts[]): ModuleFacts {
  const file = path === '' ? 'src/lib.rs' : `src/${path.replace(/::/g, '/')}.rs`;
  return { path, file, types: [], functions };
}
function crateFacts(name: string, modules: ModuleFacts[]): CrateFacts {
  return { name, modules: Object.fromEntries(modules.map((m) => [m.path, m])) };
}

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

/** Build a workspace layout over `crates` (a real multi-crate workspace
 *  via buildWorkspaceTree), expanding every module + function-group so all
 *  call rows render. `specific` are the (caller,callee) keys to reveal. */
function workspaceLayout(
  crates: CrateFacts[],
  callEdges: CallEdge[],
  specific: ReadonlySet<string>,
  incomingShown: ReadonlySet<string> = new Set(),
): { layout: Layout; inputs: LayoutInputs } {
  const facts: Facts = {
    crates: Object.fromEntries(crates.map((c) => [c.name, c])),
    edges: [],
    call_edges: callEdges,
  };
  const root = buildWorkspaceTree(facts);
  const calls = buildFunctionCallIndex(facts, root);
  const ownership = buildOwnershipIndex(facts);
  const typeModule = new Map<string, string>();
  const typeIds: string[] = [];
  const moduleIds: string[] = [];
  const walk = (n: TreeNode): void => {
    if (n.kind === 'type') {
      typeModule.set(n.fullPath, n.modulePath);
      typeIds.push(n.fullPath);
    } else {
      moduleIds.push(n.id);
      for (const c of n.children) walk(c);
    }
  };
  walk(root);
  const drift = computeDrift(ownership, typeModule);
  const depth = computeOwnershipDepth(ownership, typeIds, drift);
  const state = new ViewState([...moduleIds, ...typeIds]);
  const inputs: LayoutInputs = {
    staticRoot: root,
    ownership,
    depth,
    state,
    drift,
    calls,
    specificCallArrowsShown: specific,
    measureText: measure,
  };
  return { layout: buildLayout(inputs), inputs };
}

// --- tree.ts: incoming marker fill + cross-crate call arrow dash ---------

describe('GROUP H — incoming-call marker active/inactive fill', () => {
  // CP-MARK-01: the incoming-call marker (`→` to the LEFT of a callee row)
  // is BLUE (#2563eb) when that callee is in `incomingCallTargetsShown`
  // (its incoming arrows are revealed) and GREY (#94a3b8) otherwise. The
  // two states must DISAGREE — a single hardcoded fill would lose the
  // active-state cue.
  function buildIncoming(activeShown: boolean): SVGGElement {
    document.body.innerHTML = '';
    // caller() calls callee() (same crate, other module → resolved
    // incoming edge so callee gets an incoming marker).
    const crate = crateFacts('c', [
      mod('', [fn('caller')]),
      mod('sub', [fn('callee')]),
    ]);
    const incomingShown = activeShown ? new Set(['c::sub::callee']) : new Set<string>();
    const { layout, inputs } = workspaceLayout(
      [crate],
      [
        {
          caller: 'c::caller',
          callee: 'c::sub::callee',
          kind: 'function',
          resolution: 'exact',
          origin: 'callee',
        },
      ],
      new Set(),
      incomingShown,
    );
    const made = makeLayers();
    renderTree(
      made.layers,
      layout,
      makeOpts(inputs.ownership, { incomingCallTargetsShown: incomingShown }),
    );
    return made.zoom;
  }

  it('CP-MARK-01 incoming marker is blue when active, grey when inactive', () => {
    const activeZoom = buildIncoming(true);
    const activeMarker = activeZoom.querySelector('text.incoming-call-marker[fill]');
    expect(activeMarker, 'callee renders an incoming marker').not.toBeNull();
    expect(activeMarker?.textContent).toBe('→');
    expect(activeMarker?.getAttribute('fill')).toBe(BLUE_ACTIVE);

    const inactiveZoom = buildIncoming(false);
    const inactiveMarker = inactiveZoom.querySelector('text.incoming-call-marker[fill]');
    expect(inactiveMarker, 'inactive callee still renders an incoming marker').not.toBeNull();
    expect(inactiveMarker?.getAttribute('fill')).toBe(GREY_CHEVRON);

    // Non-vacuity: the two states genuinely differ.
    expect(activeMarker?.getAttribute('fill')).not.toBe(
      inactiveMarker?.getAttribute('fill'),
    );
  });
});

describe('GROUP H — cross-crate call arrow morse dash', () => {
  // CP-DASH-01: a call arrow that crosses a CRATE boundary uses the morse
  // dash `6 2 1 2 1 2` regardless of kind — the boundary pattern wins over
  // the kind-specific call dash (`4 3`). Two crates, a function in crate
  // `a` calls a function in crate `b`; the revealed call arrow's
  // stroke-dasharray is the cross-crate morse pattern, NOT the plain call
  // dash. This is the only Tier-1 coverage of the cross-crate-wins branch
  // for a *call* arrow.
  it('CP-DASH-01 cross-crate call arrow uses morse dash, not the call dash', () => {
    document.body.innerHTML = '';
    const crateA = crateFacts('a', [mod('', [fn('caller')])]);
    const crateB = crateFacts('b', [mod('', [fn('callee')])]);
    const edges: CallEdge[] = [
      {
        caller: 'a::caller',
        callee: 'b::callee',
        kind: 'function',
        resolution: 'exact',
        origin: 'callee',
      },
    ];
    const { layout, inputs } = workspaceLayout(
      [crateA, crateB],
      edges,
      new Set([specificCallArrowKey('a::caller', 'b::callee')]),
    );
    // The materialized call arrow is flagged cross-crate.
    const callArrow = layout.arrows.find((arr) => arr.kind === 'call');
    expect(callArrow, 'a cross-crate call arrow materialized').toBeDefined();
    expect(callArrow?.isCrossCrate).toBe(true);

    const made = makeLayers();
    renderTree(made.layers, layout, makeOpts(inputs.ownership));
    const path = made.zoom.querySelector('g.arrow path.visible.call');
    expect(path, 'the call arrow path is rendered').not.toBeNull();
    expect(path?.getAttribute('stroke-dasharray')).toBe(CROSS_CRATE_DASH);
  });
});

// --- edge_picker.ts: crate/prefix spans, hide-all, Space, inside-click ---

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

describe('GROUP H — edge picker crate/prefix spans + bulk + keyboard', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.getElementById('edge-picker')?.remove();
  });

  // CP-PICK-CC: a cross-crate entry leads with a purple crate span carrying
  // the crate name AND a trailing `::` (the boundary reads as one segment),
  // then the dimmed module prefix, then the bare function label. A
  // same-crate entry omits the crate span entirely.
  it('CP-PICK-CC cross-crate entry renders crate span (with ::) + dimmed prefix', () => {
    const picker = createEdgePicker();
    picker.show(
      showArgs({
        entries: [
          {
            otherFullPath: 'vm::store::put',
            label: 'put()',
            prefix: 'store::',
            crateName: 'vm',
            active: false,
          },
        ],
      }),
    );
    const row = document.querySelector('.edge-picker-row');
    const crate = row?.querySelector('.edge-picker-crate');
    const prefix = row?.querySelector('.edge-picker-prefix');
    const main = row?.querySelector('.edge-picker-main');
    // Crate span carries the crate name + the boundary `::`.
    expect(crate?.textContent).toBe('vm::');
    // Module prefix is its own dimmed span, distinct from the crate.
    expect(prefix?.textContent).toBe('store::');
    expect(main?.textContent).toBe('put()');
    // Order: crate, then prefix, then main — boundary is the first thing read.
    const order = [...(row?.children ?? [])].map((c) => c.className);
    expect(order).toEqual(['edge-picker-crate', 'edge-picker-prefix', 'edge-picker-main']);
  });

  it('CP-PICK-CC same-crate entry omits the crate span but keeps the dimmed prefix', () => {
    const picker = createEdgePicker();
    picker.show(
      showArgs({
        entries: [
          { otherFullPath: 'c::store::put', label: 'put()', prefix: 'store::', active: false },
        ],
      }),
    );
    const row = document.querySelector('.edge-picker-row');
    expect(row?.querySelector('.edge-picker-crate')).toBeNull();
    expect(row?.querySelector('.edge-picker-prefix')?.textContent).toBe('store::');
    expect(row?.querySelector('.edge-picker-main')?.textContent).toBe('put()');
  });

  // CP-PICK-HIDE: the toolbar's "hide all" button calls onHideAll and
  // dismisses the picker. Symmetric to the existing show-all coverage; the
  // hide-all path was previously untested.
  it('CP-PICK-HIDE hide-all button calls onHideAll and dismisses', () => {
    const root = () => document.getElementById('edge-picker') as HTMLElement;
    let hidAll = 0;
    let shownAll = 0;
    const picker = createEdgePicker();
    picker.show(
      showArgs({
        entries: [resolvedEntry({ active: true })],
        onHideAll: () => {
          hidAll += 1;
        },
        onShowAll: () => {
          shownAll += 1;
        },
      }),
    );
    const hideBtn = [...document.querySelectorAll('.edge-picker-toolbar button')].find(
      (b) => b.textContent === 'hide all',
    ) as HTMLButtonElement | undefined;
    expect(hideBtn, 'hide-all button present').toBeDefined();
    expect(root().style.display).toBe('block');
    hideBtn?.click();
    expect(hidAll).toBe(1);
    // hide-all must NOT also trigger show-all.
    expect(shownAll).toBe(0);
    // Picker dismisses after the bulk action.
    expect(root().style.display).toBe('none');
  });

  // CP-PICK-SPACE: keyboard activation works with Space (not only Enter).
  // jsdom getBoundingClientRect is all-zero, so the anchor lands at (0,0)
  // — proving Space takes the row-rect-center path (same as Enter), not the
  // opening anchor (100,100).
  it('CP-PICK-SPACE Space activates a row (row-center anchor), like Enter', () => {
    let anchor: { x: number; y: number } | null = null;
    let picked = 0;
    const picker = createEdgePicker();
    picker.show(
      showArgs({
        anchorX: 100,
        anchorY: 100,
        entries: [resolvedEntry()],
        onPick: (_entry, clickAnchor) => {
          picked += 1;
          anchor = { ...clickAnchor };
        },
      }),
    );
    const row = document.querySelector('.edge-picker-row');
    row?.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(picked).toBe(1);
    expect(anchor).toEqual({ x: 0, y: 0 });
  });

  // CP-PICK-INSIDE: clicking a row INSIDE the panel picks it (onPick fires)
  // and then dismisses — it must NOT be treated as an outside-click that
  // dismisses WITHOUT picking. The picker registers a capture-phase
  // document click that ignores clicks inside the panel; the row's own
  // handler is what dismisses (after onPick). So a single inside click
  // yields exactly one onPick AND a hidden picker.
  it('CP-PICK-INSIDE inside-row click picks then dismisses (not a bare outside-dismiss)', () => {
    const root = () => document.getElementById('edge-picker') as HTMLElement;
    let picked = 0;
    const picker = createEdgePicker();
    picker.show(
      showArgs({
        entries: [resolvedEntry()],
        onPick: () => {
          picked += 1;
        },
      }),
    );
    expect(root().style.display).toBe('block');
    const row = document.querySelector('.edge-picker-row') as HTMLElement;
    // A real click bubbles to the capture-phase document listener too; the
    // listener sees the target is inside the panel and does NOT dismiss,
    // while the row's own handler fires onPick and dismisses.
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, clientX: 3, clientY: 4 }));
    expect(picked).toBe(1);
    expect(root().style.display).toBe('none');
  });
});
