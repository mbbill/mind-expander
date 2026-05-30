// Tier-2 (node env) regression tests for GROUP H — call-arrow locality
// gating + distinct-count dedup at the data/layout layer.
//
// These cover the PURE half of the locality-glyph / incoming-marker
// pickers — the part that decides whether a marker renders at all (0
// outgoing → no glyph; 0 incoming → no marker) and the distinct-count
// the hover badge and picker share. The renderer (tree.ts) reads the
// per-row `hasOutgoingCalls` / `hasIncomingCalls` booleans to decide
// glyph/marker presence, and the badge counts DISTINCT callees/callers
// off `callRefs` / `incomingCallRefs`; both are owned here, so they are
// asserted off `buildLayout` output and `buildFunctionCallIndex` rather
// than the DOM.
//
// Existing call-graph-arrows.layout.test.ts covers locality
// classification, resolved/unresolved split, and arrow routing. This
// file adds the gating booleans (0/1/2+ boundary) and the distinct-vs-raw
// count contract that the badges/pickers depend on — neither asserted
// elsewhere.
//
// `calls_fixture` is built inline (builders.ts emit ownership edges only,
// never call_edges).

import { describe, expect, it } from 'vitest';
import { buildFunctionCallIndex } from '../../src/analysis/calls.ts';
import { computeDrift } from '../../src/analysis/drift.ts';
import type { Layout, LayoutInputs } from '../../src/analysis/layout_model.ts';
import { type TreeNode, buildModuleTree } from '../../src/analysis/module_tree.ts';
import { buildOwnershipIndex, computeOwnershipDepth } from '../../src/analysis/ownership.ts';
import type { CallEdge, CrateFacts, Facts, FnFacts, ModuleFacts } from '../../src/data/schema.ts';
import { buildLayout } from '../../src/layout/pipeline.ts';
import { ViewState } from '../../src/state/view_state.ts';

const measure = (s: string): number => s.length * 7;

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

function makeFacts(crate: CrateFacts, callEdges: CallEdge[]): Facts {
  return { crates: { [crate.name]: crate }, edges: [], call_edges: callEdges };
}

function edge(caller: string, callee: string, resolution: 'exact' | 'heuristic' = 'exact'): CallEdge {
  return {
    caller,
    callee,
    kind: 'function',
    resolution,
    origin: callee.slice(callee.lastIndexOf('::') + 2),
  };
}

/** Build a fully-expanded LayoutInputs for one crate's call graph. Every
 *  function-group pseudo-type is expanded so each function row (and its
 *  call gating flags) materializes. */
function layoutFor(crate: CrateFacts, callEdges: CallEdge[]): Layout {
  const facts = makeFacts(crate, callEdges);
  const root = buildModuleTree(crate);
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
  // Expand every module and every function-group so all function rows render.
  const state = new ViewState([...moduleIds, ...typeIds]);
  const inputs: LayoutInputs = {
    staticRoot: root,
    ownership,
    depth,
    state,
    drift,
    calls,
    specificCallArrowsShown: new Set(),
    measureText: measure,
  };
  return buildLayout(inputs);
}

/** Find a function row by its function full path across all type boxes. */
function rowFor(layout: Layout, functionFullPath: string): Layout['types'][number]['fields'][number] {
  for (const t of layout.types) {
    for (const f of t.fields) {
      if (f.functionFullPath === functionFullPath) return f;
    }
  }
  throw new Error(`no row for ${functionFullPath} (rows: ${
    layout.types.flatMap((t) => t.fields.map((f) => f.functionFullPath)).join(', ')
  })`);
}

// Single crate covering all four call-fan cardinalities at once:
//   leaf()        — calls nothing, called by nobody (0 out / 0 in)
//   one()         — calls exactly solo() (1 out); solo() called by exactly
//                   one() (1 in)
//   solo()        — leaf callee with 1 distinct caller
//   hub()         — calls a(), b(), c() (3 distinct out)
//   target()      — called by p(), q() (2 distinct in)
//   twice()       — calls dup() at two sites (2 raw refs, 1 distinct callee)
//   dup()         — called by twice() twice (2 raw refs, 1 distinct caller)
function fanCrate(): CrateFacts {
  return crateFacts('c', [
    mod('', [
      fn('leaf'),
      fn('one'),
      fn('solo'),
      fn('hub'),
      fn('a'),
      fn('b'),
      fn('c'),
      fn('target'),
      fn('p'),
      fn('q'),
      fn('twice'),
      fn('dup'),
    ]),
  ]);
}

function fanEdges(): CallEdge[] {
  return [
    edge('c::one', 'c::solo'),
    edge('c::hub', 'c::a'),
    edge('c::hub', 'c::b'),
    edge('c::hub', 'c::c'),
    edge('c::p', 'c::target'),
    edge('c::q', 'c::target'),
    // twice → dup at two call sites: 2 raw refs, 1 distinct callee/caller.
    edge('c::twice', 'c::dup'),
    edge('c::twice', 'c::dup'),
  ];
}

describe('GROUP H — call-arrow gating flags (glyph/marker visibility)', () => {
  // CE-GATE-01: a function with ZERO outgoing calls has hasOutgoingCalls
  // === false (so tree.ts renders no locality glyph) and ZERO incoming
  // has hasIncomingCalls === false (no incoming marker). This is the
  // 0-callee / 0-caller "no-op (hidden)" boundary — the renderer's
  // `if (f.hasOutgoingCalls)` / `if (f.hasIncomingCalls)` guards.
  it('CE-GATE-01 leaf row has neither outgoing glyph nor incoming marker flag', () => {
    const layout = layoutFor(fanCrate(), fanEdges());
    const leaf = rowFor(layout, 'c::leaf');
    expect(leaf.hasOutgoingCalls).toBe(false);
    expect(leaf.hasIncomingCalls).toBe(false);
    // The glyph slot is still reserved on every callable row (so
    // arrowSourceX stays stable across redraws) — but tree.ts only paints
    // the glyph when `hasOutgoingCalls` is true, so an unpainted glyph is
    // the *gating flag* being false, NOT the absence of the slot.
    expect(leaf.localityGlyphX).toBeTypeOf('number');
  });

  // CE-GATE-02: the 1-out / 1-in boundary. `one()` makes exactly one call
  // and `solo()` receives exactly one — both flags flip true (marker
  // renders), and the single-edge auto-toggle path (host side) is gated on
  // exactly these counts being 1. Asserted via the distinct counts the
  // host reads.
  it('CE-GATE-02 single-call row flags true with exactly one distinct edge', () => {
    const layout = layoutFor(fanCrate(), fanEdges());
    const one = rowFor(layout, 'c::one');
    expect(one.hasOutgoingCalls).toBe(true);
    expect(new Set(one.callRefs.map((r) => r.callee)).size).toBe(1);

    const solo = rowFor(layout, 'c::solo');
    expect(solo.hasIncomingCalls).toBe(true);
    expect(new Set(solo.incomingCallRefs.map((r) => r.caller)).size).toBe(1);
    // solo() itself makes no calls → no outgoing glyph.
    expect(solo.hasOutgoingCalls).toBe(false);
  });

  // CE-GATE-03: the 2+ boundary (picker opens). `hub()` has 3 distinct
  // callees, `target()` has 2 distinct callers — both > 1, so a click fans
  // a picker rather than auto-toggling.
  it('CE-GATE-03 multi-call rows expose >1 distinct callees/callers', () => {
    const layout = layoutFor(fanCrate(), fanEdges());
    const hub = rowFor(layout, 'c::hub');
    expect(hub.hasOutgoingCalls).toBe(true);
    expect(new Set(hub.callRefs.map((r) => r.callee)).size).toBe(3);

    const target = rowFor(layout, 'c::target');
    expect(target.hasIncomingCalls).toBe(true);
    expect(new Set(target.incomingCallRefs.map((r) => r.caller)).size).toBe(2);
  });

  // CE-GATE-04: same-target-twice dedup. `twice()` calls `dup()` at two
  // sites: callRefs carries BOTH raw refs (length 2) but only ONE distinct
  // callee — the count the hover badge and picker show. Symmetrically,
  // dup()'s incoming has 2 raw refs but 1 distinct caller. A badge that
  // counted raw refs would read (2) while the picker shows 1 row — the
  // exact mismatch the distinct-count contract prevents.
  it('CE-GATE-04 same-target-twice: 2 raw refs but 1 distinct callee/caller', () => {
    const layout = layoutFor(fanCrate(), fanEdges());
    const twice = rowFor(layout, 'c::twice');
    expect(twice.callRefs.length).toBe(2);
    expect(new Set(twice.callRefs.map((r) => r.callee)).size).toBe(1);

    const dup = rowFor(layout, 'c::dup');
    expect(dup.incomingCallRefs.length).toBe(2);
    expect(new Set(dup.incomingCallRefs.map((r) => r.caller)).size).toBe(1);
  });

  // CE-GATE-05: unresolved-only caller still flags hasOutgoingCalls (the
  // orange glyph renders) but hasUnresolvedCalls drives its color, and the
  // distinct callee count is still 1 — so the host shows the picker (a lone
  // unresolved edge is NOT auto-toggled). Guards the "1 unresolved → picker
  // not auto-toggle" branch's data precondition.
  it('CE-GATE-05 unresolved-only caller flags outgoing+unresolved with 1 distinct callee', () => {
    const crate = crateFacts('c', [mod('', [fn('caller')])]);
    const layout = layoutFor(crate, [edge('c::caller', 'c::no_such_fn', 'heuristic')]);
    const caller = rowFor(layout, 'c::caller');
    expect(caller.hasOutgoingCalls).toBe(true);
    expect(caller.hasUnresolvedCalls).toBe(true);
    expect(caller.hasExternalCalls).toBe(false);
    expect(new Set(caller.callRefs.map((r) => r.callee)).size).toBe(1);
  });
});
