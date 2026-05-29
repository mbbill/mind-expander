// Tier-2 (node env) regression tests for the `call-graph-arrows` area.
//
// Scope per test-plan/call-graph-arrows.md. Two layers are exercised here:
//
//   data/model  (analysis/calls.ts) — locality classification, the
//     resolved/unresolved split between the outgoing-picker source
//     (`callsByFunction`, ALL edges) and the route source
//     (`callTargetsByFunction`, resolved only), incoming symmetry, and
//     dropping calls whose caller isn't a workspace row.
//
//   analysis/logic (layout/routing.ts via buildLayout) — that a
//     materialized call Arrow carries the source-row locality and exits
//     the caller's RIGHT side (`arrowSourceX`) as a semantic convention,
//     even when the callee sits to the LEFT and a shortest path would
//     exit left. This is the end-to-end buildLayout call-arrow path that
//     no existing per-pass test covers (routing.test.ts hand-builds
//     geometry/obstacles and calls routeArrows directly).
//
// `calls_fixture` is built inline (not a shared file): builders.ts/small/
// medium emit ownership edges only and never carry call_edges. This file
// constructs Facts with call_edges, runs buildFunctionCallIndex, and feeds
// both the index and `specificCallArrowsShown` into buildLayout.

import { describe, expect, it } from 'vitest';
import { buildFunctionCallIndex } from '../../src/analysis/calls.ts';
import { computeDrift } from '../../src/analysis/drift.ts';
import { specificCallArrowKey } from '../../src/analysis/layout_model.ts';
import type { LayoutInputs } from '../../src/analysis/layout_model.ts';
import { type TreeNode, buildModuleTree } from '../../src/analysis/module_tree.ts';
import { buildOwnershipIndex, computeOwnershipDepth } from '../../src/analysis/ownership.ts';
import type { CallEdge, CrateFacts, Facts, FnFacts, ModuleFacts } from '../../src/data/schema.ts';
import { buildLayout } from '../../src/layout/pipeline.ts';
import { ViewState } from '../../src/state/view_state.ts';

const measure = (s: string): number => s.length * 7;

// --- inline calls_fixture builders --------------------------------------

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

/** Build a LayoutInputs that carries a FunctionCallIndex plus the per-edge
 *  call-arrow visibility set, so buildLayout materializes call arrows. */
function callsLayoutInputs(
  crate: CrateFacts,
  callEdges: CallEdge[],
  expandedExtra: string[],
  specific: ReadonlySet<string>,
): LayoutInputs {
  const facts = makeFacts(crate, callEdges);
  const root = buildModuleTree(crate);
  const calls = buildFunctionCallIndex(facts, root);
  const ownership = buildOwnershipIndex(facts);
  const typeModule = new Map<string, string>();
  const typeIds: string[] = [];
  const walk = (n: TreeNode): void => {
    if (n.kind === 'type') {
      typeModule.set(n.fullPath, n.modulePath);
      typeIds.push(n.fullPath);
    } else for (const c of n.children) walk(c);
  };
  walk(root);
  const drift = computeDrift(ownership, typeModule);
  const depth = computeOwnershipDepth(ownership, typeIds, drift);
  const state = new ViewState([...expandedExtra, ...typeIds]);
  return {
    staticRoot: root,
    ownership,
    depth,
    state,
    drift,
    calls,
    specificCallArrowsShown: specific,
    measureText: measure,
  };
}

// Crate used by the data-layer tests: a free function `caller` in the root
// module calls (a) `callee` in the SAME module, (b) `far` in module
// `other`, and (c) `ghost` — a name with no workspace row. A second
// same-module-only caller `pure` is used to prove nonLocalCallers is
// selective.
function dataCrate(): CrateFacts {
  return crateFacts('c', [
    mod('', [fn('caller'), fn('callee'), fn('pure'), fn('sink')]),
    mod('other', [fn('far')]),
  ]);
}

function dataCallEdges(): CallEdge[] {
  return [
    {
      caller: 'c::caller',
      callee: 'c::callee',
      kind: 'function',
      resolution: 'exact',
      origin: 'callee',
    },
    {
      caller: 'c::caller',
      callee: 'c::other::far',
      kind: 'function',
      resolution: 'exact',
      origin: 'other::far',
    },
    {
      caller: 'c::caller',
      callee: 'c::no_such_fn',
      kind: 'function',
      resolution: 'heuristic',
      origin: 'no_such_fn',
    },
    // pure only calls same-module → must NOT be flagged non-local.
    {
      caller: 'c::pure',
      callee: 'c::callee',
      kind: 'function',
      resolution: 'exact',
      origin: 'callee',
    },
    // caller calls sink twice — 2 raw refs, 1 distinct callee.
    {
      caller: 'c::caller',
      callee: 'c::sink',
      kind: 'function',
      resolution: 'exact',
      origin: 'sink',
    },
    {
      caller: 'c::caller',
      callee: 'c::sink',
      kind: 'function',
      resolution: 'exact',
      origin: 'sink',
    },
  ];
}

function dataIndex() {
  const crate = dataCrate();
  const facts = makeFacts(crate, dataCallEdges());
  const root = buildModuleTree(crate);
  return buildFunctionCallIndex(facts, root);
}

describe('call-graph-arrows — data/model locality & resolution', () => {
  // CGA-DATA-01: locality is a data property derived from callee-row module
  // equality. The three edges from `caller` classify as same_module /
  // other_module / unresolved; nonLocalCallers includes `caller` (b,c are
  // non-local) but NOT a same-module-only caller.
  it('CGA-DATA-01 classifies same_module / other_module / unresolved', () => {
    const idx = dataIndex();
    const refs = idx.callsByFunction.get('c::caller') ?? [];
    const byCallee = new Map(refs.map((r) => [r.callee, r.locality]));
    expect(byCallee.get('c::callee')).toBe('same_module');
    expect(byCallee.get('c::other::far')).toBe('other_module');
    expect(byCallee.get('c::no_such_fn')).toBe('unresolved');
    expect(idx.nonLocalCallers.has('c::caller')).toBe(true);
    expect(idx.nonLocalCallers.has('c::pure')).toBe(false);
  });

  // CGA-DATA-02: the picker source of truth is callsByFunction (ALL edges),
  // NOT callTargetsByFunction (resolved-only). Asserting the picker count
  // off callTargets would reproduce the empty-picker bug. The unresolved
  // callee also produces no incoming entry.
  it('CGA-DATA-02 keeps unresolved in outgoing but excludes from targets & incoming', () => {
    const idx = dataIndex();
    const outgoing = idx.callsByFunction.get('c::caller') ?? [];
    const outgoingCallees = new Set(outgoing.map((r) => r.callee));
    expect(outgoingCallees.has('c::no_such_fn')).toBe(true);

    const targets = (idx.callTargetsByFunction.get('c::caller') ?? []).map(
      (r) => r.functionFullPath,
    );
    expect(targets).not.toContain('c::no_such_fn');
    // resolved targets are deduped (sink appears once despite 2 raw refs).
    expect(targets).toEqual(['c::callee', 'c::other::far', 'c::sink']);

    expect(idx.incomingCallsByFunction.has('c::no_such_fn')).toBe(false);
  });

  // CGA-DATA-03: incoming is symmetric to outgoing. A callee called by two
  // distinct callers yields 2 incoming refs; a callee called TWICE by one
  // caller yields 2 raw incoming refs but only 1 distinct caller — the badge
  // layer dedups on caller, the raw map does not.
  it('CGA-DATA-03 incoming symmetric; raw refs vs distinct callers', () => {
    const idx = dataIndex();
    // callee is called by caller (once) and pure (once): 2 distinct callers.
    const intoCallee = idx.incomingCallsByFunction.get('c::callee') ?? [];
    expect(new Set(intoCallee.map((r) => r.caller)).size).toBe(2);
    expect(intoCallee.map((r) => r.caller).sort()).toEqual(['c::caller', 'c::pure']);

    // sink is called twice by the SAME caller: 2 raw refs, 1 distinct caller.
    const intoSink = idx.incomingCallsByFunction.get('c::sink') ?? [];
    expect(intoSink.length).toBe(2);
    expect(new Set(intoSink.map((r) => r.caller)).size).toBe(1);
  });

  // CGA-DATA-04: a call_edge whose caller is not a registered row is dropped
  // (no crash, no callsByFunction entry).
  it('CGA-DATA-04 drops a call whose caller is not a workspace row', () => {
    const crate = dataCrate();
    const facts = makeFacts(crate, [
      {
        caller: 'c::ghost_caller',
        callee: 'c::callee',
        kind: 'function',
        resolution: 'exact',
        origin: 'callee',
      },
    ]);
    const root = buildModuleTree(crate);
    const idx = buildFunctionCallIndex(facts, root);
    expect(idx.callsByFunction.has('c::ghost_caller')).toBe(false);
    // The resolvable callee gains no spurious incoming entry from a dropped edge.
    expect(idx.incomingCallsByFunction.has('c::callee')).toBe(false);
  });
});

describe('call-graph-arrows — call Arrow routing (buildLayout end-to-end)', () => {
  // CGA-ROUTE-01: outgoing call arrow exits the caller's RIGHT side via the
  // preferred shape, even when the callee sits to the LEFT (here caller and
  // callee share the root function-group, so the callee row is to the left
  // and a shortest path would exit left). Oracle: waypoints[0].x ===
  // arrowSourceX (caller's right exit) AND waypoints[1].x > waypoints[0].x
  // (first move goes RIGHT). Asserting only orthogonality/short-path would
  // accept a left exit and lose the semantic convention.
  it('CGA-ROUTE-01 exits caller right side even when callee is to the left', () => {
    const crate = crateFacts('c', [mod('', [fn('caller'), fn('callee')])]);
    const edges: CallEdge[] = [
      {
        caller: 'c::caller',
        callee: 'c::callee',
        kind: 'function',
        resolution: 'exact',
        origin: 'callee',
      },
    ];
    const inputs = callsLayoutInputs(
      crate,
      edges,
      ['c'],
      new Set([specificCallArrowKey('c::caller', 'c::callee')]),
    );
    const layout = buildLayout(inputs);
    const arrow = layout.arrows.find((a) => a.kind === 'call');
    expect(arrow, 'a call arrow materialized').toBeDefined();
    if (arrow === undefined) return;

    // Source endpoint sits at the caller row's right-exit port (arrowSourceX).
    const fnGroup = layout.types.find((t) => t.id === 'c::__fn_pub');
    const callerRow = fnGroup?.fields.find((f) => f.name === 'caller');
    expect(callerRow, 'caller row present').toBeDefined();
    const first = arrow.waypoints[0];
    const second = arrow.waypoints[1];
    const last = arrow.waypoints[arrow.waypoints.length - 1];
    // Non-vacuity guard: the arrow's landing point (callee's left entry)
    // is to the LEFT of the caller's right exit, so a shortest path WOULD
    // exit left. Without this the "exits right" assertion could pass by
    // luck on a callee that already sits to the right.
    expect((last?.x ?? Number.POSITIVE_INFINITY) < (callerRow?.arrowSourceX ?? 0)).toBe(true);

    expect(first?.x).toBeCloseTo(callerRow?.arrowSourceX ?? Number.NaN, 1);
    // Source endpoint sits at the caller row's own y — it really is the
    // caller row's right port, not some other row's.
    expect(first?.y).toBeCloseTo(callerRow?.y ?? Number.NaN, 1);
    // First segment goes RIGHT — the source-exit convention, not a shortest path.
    expect((second?.x ?? 0) > (first?.x ?? 0)).toBe(true);
  });

  // CGA-ROUTE-03: locality is carried onto the materialized Arrow (the data
  // contract the renderer's arrowColor reads). Same-module → 'local',
  // cross-module → 'external'. Pinned end-to-end through buildLayout.
  it('CGA-ROUTE-03 carries same-module=local and cross-module=external onto the Arrow', () => {
    const crate = crateFacts('c', [
      mod('', [fn('caller'), fn('localCallee')]),
      mod('other', [fn('farCallee')]),
    ]);
    const edges: CallEdge[] = [
      {
        caller: 'c::caller',
        callee: 'c::localCallee',
        kind: 'function',
        resolution: 'exact',
        origin: 'localCallee',
      },
      {
        caller: 'c::caller',
        callee: 'c::other::farCallee',
        kind: 'function',
        resolution: 'exact',
        origin: 'other::farCallee',
      },
    ];
    const inputs = callsLayoutInputs(
      crate,
      edges,
      ['c', 'c::other'],
      new Set([
        specificCallArrowKey('c::caller', 'c::localCallee'),
        specificCallArrowKey('c::caller', 'c::other::farCallee'),
      ]),
    );
    const layout = buildLayout(inputs);
    const calls = layout.arrows.filter((a) => a.kind === 'call');
    const local = calls.find((a) => a.toFieldName === 'localCallee');
    const external = calls.find((a) => a.toFieldName === 'farCallee');
    expect(local?.locality).toBe('local');
    expect(external?.locality).toBe('external');
  });

  // CGA-ROUTE-04 (combined gating): a specific (caller,callee) pair NOT in
  // the set must not materialize, while one that IS in the set does — even
  // when both callers are visible. Guards the per-edge gating that fixes the
  // bulk-expand-all bug at the layout layer.
  it('CGA-ROUTE-04 only the specific pair in the set materializes', () => {
    const crate = crateFacts('c', [mod('', [fn('x'), fn('y'), fn('a'), fn('b')])]);
    const edges: CallEdge[] = [
      { caller: 'c::x', callee: 'c::y', kind: 'function', resolution: 'exact', origin: 'y' },
      { caller: 'c::a', callee: 'c::b', kind: 'function', resolution: 'exact', origin: 'b' },
    ];
    const inputs = callsLayoutInputs(
      crate,
      edges,
      ['c'],
      new Set([specificCallArrowKey('c::x', 'c::y')]),
    );
    const layout = buildLayout(inputs);
    const calls = layout.arrows.filter((a) => a.kind === 'call');
    expect(calls.length).toBe(1);
    expect(calls[0]?.fromFieldName).toBe('x');
    expect(calls[0]?.toFieldName).toBe('y');
  });
});
