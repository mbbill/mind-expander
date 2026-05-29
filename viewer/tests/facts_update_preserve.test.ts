import { describe, expect, it } from 'vitest';
import { buildFunctionCallIndex } from '../src/analysis/calls.ts';
import { buildWorkspaceTree } from '../src/analysis/module_tree.ts';
import { fieldId } from '../src/data/ids.ts';
import { buildSpanIndex } from '../src/data/spans.ts';
import { ROW_ARROW_KEY_SEP, specificCallArrowKey } from '../src/analysis/layout_model.ts';
import { fieldKey } from '../src/view/tree.ts';
import { ViewState } from '../src/state/view_state.ts';
import { buildIdUniverse, pruneStaleState } from '../src/state/prune_stale.ts';
import { anchorScreenPoint, nearestToCenter } from '../src/view/reload_anchor.ts';
import type {
  CallEdge,
  CrateFacts,
  Facts,
  FieldFacts,
  FnFacts,
  ModuleFacts,
  ReExport,
  TypeFacts,
} from '../src/data/schema.ts';

// --- fixture builders --------------------------------------------------

function field(name: string): FieldFacts {
  return { name, ty_text: 'u32', ownership: 'owned' };
}

function fn(name: string, visibility = 'pub'): FnFacts {
  return { name, visibility };
}

function struct(
  crateName: string,
  modulePath: string,
  name: string,
  fields: FieldFacts[],
  methods: FnFacts[] = [],
): TypeFacts {
  const prefix = modulePath === '' ? crateName : `${crateName}::${modulePath}`;
  return {
    name,
    full_path: `${prefix}::${name}`,
    kind: 'struct',
    visibility: 'pub',
    fields,
    methods,
  };
}

function mod(
  path: string,
  types: TypeFacts[],
  functions: FnFacts[] = [],
  reExports: ReExport[] = [],
): ModuleFacts {
  return {
    path,
    file: path === '' ? 'src/lib.rs' : `src/${path.replace(/::/g, '/')}.rs`,
    types,
    functions,
    ...(reExports.length > 0 ? { re_exports: reExports } : {}),
  };
}

function facts(modules: ModuleFacts[], callEdges: CallEdge[] = []): Facts {
  const crate: CrateFacts = {
    name: 'c',
    modules: Object.fromEntries(modules.map((m) => [m.path, m])),
  };
  return { crates: { c: crate }, edges: [], call_edges: callEdges };
}

// --- tests -------------------------------------------------------------

describe('pruneStaleState', () => {
  it('drops expanded/selected/shown ids absent from the new facts, preserves survivors', () => {
    // OLD facts: Survivor (with field f + method run) + Doomed (with field g),
    // and a call edge Survivor::run -> Doomed::gone so both rows are callable.
    const oldFacts = facts(
      [
        mod('', [
          struct('c', '', 'Survivor', [field('f')], [fn('run')]),
          struct('c', '', 'Doomed', [field('g')], [fn('gone')]),
        ]),
      ],
      [
        {
          caller: 'c::Survivor::run',
          callee: 'c::Doomed::gone',
          kind: 'method',
          resolution: 'exact',
          origin: '.gone',
        },
      ],
    );
    // NEW facts: Doomed and all its members are gone; Survivor remains.
    const newFacts = facts([
      mod('', [struct('c', '', 'Survivor', [field('f')], [fn('run')])]),
    ]);

    const newRoot = buildWorkspaceTree(newFacts);
    const newCalls = buildFunctionCallIndex(newFacts, newRoot);
    const newSpanIndex = buildSpanIndex(newFacts);
    const universe = buildIdUniverse(newRoot);

    // Seed the persistent sets as if the user had interacted with the old tree.
    const viewState = new ViewState([
      'c', // module survives
      'c::Survivor', // type survives
      'c::Doomed', // type gone -> prune
      'c::Doomed::__methods_pub', // bucket gone -> prune
    ]);
    const selectedFields = new Set<string>([
      fieldKey('c::Survivor', 'f', 'field'), // survives
      fieldKey('c::Doomed', 'g', 'field'), // gone -> prune
      fieldKey('c::Survivor', 'run', 'method'), // survives
      fieldKey('c::Doomed', 'gone', 'method'), // gone -> prune
    ]);
    const incomingCallTargetsShown = new Set<string>([
      'c::Survivor::run', // survives (still a row)
      'c::Doomed::gone', // gone -> prune
    ]);
    const specificCallArrowsShown = new Set<string>([
      specificCallArrowKey('c::Survivor::run', 'c::Doomed::gone'), // caller survives -> keep
      specificCallArrowKey('c::Doomed::gone', 'c::Survivor::run'), // caller gone -> prune
    ]);
    const ghostArrowsShown = new Set<string>();

    const res = pruneStaleState({
      universe,
      spanIndex: newSpanIndex,
      calls: newCalls,
      viewState,
      selectedFields,
      incomingCallTargetsShown,
      specificCallArrowsShown,
      ghostArrowsShown,
      selectedElementId: 'c::Doomed',
      selectedElementKind: 'type',
    });

    // Expansion
    const expanded = new Set(viewState.expandedIds());
    expect(expanded.has('c')).toBe(true);
    expect(expanded.has('c::Survivor')).toBe(true);
    expect(expanded.has('c::Doomed')).toBe(false);
    expect(expanded.has('c::Doomed::__methods_pub')).toBe(false);

    // Field/member selection
    expect(selectedFields.has(fieldKey('c::Survivor', 'f', 'field'))).toBe(true);
    expect(selectedFields.has(fieldKey('c::Survivor', 'run', 'method'))).toBe(true);
    expect(selectedFields.has(fieldKey('c::Doomed', 'g', 'field'))).toBe(false);
    expect(selectedFields.has(fieldKey('c::Doomed', 'gone', 'method'))).toBe(false);

    // Incoming-call targets (functionFullPath key space)
    expect(incomingCallTargetsShown.has('c::Survivor::run')).toBe(true);
    expect(incomingCallTargetsShown.has('c::Doomed::gone')).toBe(false);

    // Specific call arrows: keyed on caller presence only.
    expect(
      specificCallArrowsShown.has(specificCallArrowKey('c::Survivor::run', 'c::Doomed::gone')),
    ).toBe(true);
    expect(
      specificCallArrowsShown.has(specificCallArrowKey('c::Doomed::gone', 'c::Survivor::run')),
    ).toBe(false);

    // Selected element vanished -> caller must clear the code panel.
    expect(res.selectedStillPresent).toBe(false);
  });

  it('keeps a specificCallArrow whose CALLEE is external/unresolved but caller survives', () => {
    const newFacts = facts(
      [mod('', [struct('c', '', 'Caller', [], [fn('go')])])],
      // No call_edges -> callee is unresolved, but the caller row exists.
    );
    const newRoot = buildWorkspaceTree(newFacts);
    const newCalls = buildFunctionCallIndex(newFacts, newRoot);
    const newSpanIndex = buildSpanIndex(newFacts);
    const universe = buildIdUniverse(newRoot);

    const specificCallArrowsShown = new Set<string>([
      specificCallArrowKey('c::Caller::go', 'external::thing::unresolved'),
    ]);

    pruneStaleState({
      universe,
      spanIndex: newSpanIndex,
      calls: newCalls,
      viewState: new ViewState([]),
      selectedFields: new Set(),
      incomingCallTargetsShown: new Set(),
      specificCallArrowsShown,
      ghostArrowsShown: new Set(),
      selectedElementId: null,
      selectedElementKind: null,
    });

    // calls.rowByFunction has c::Caller::go even with no edges, so the arrow
    // survives despite the callee being unknown.
    expect(newCalls.rowByFunction.has('c::Caller::go')).toBe(true);
    expect(
      specificCallArrowsShown.has(
        specificCallArrowKey('c::Caller::go', 'external::thing::unresolved'),
      ),
    ).toBe(true);
  });

  it('drops a ghost-arrow id when its ghost node is gone, keeps a surviving ghost', () => {
    const reSurvivor: ReExport = {
      exposed_name: 'Reexp',
      target_path: 'c::deep::Target',
      visibility: 'pub',
      kind: 'type',
      target_kind: 'struct',
    };
    const newFacts = facts([
      mod('', [], [], [reSurvivor]),
      mod('deep', [struct('c', 'deep', 'Target', [])]),
    ]);
    const newRoot = buildWorkspaceTree(newFacts);
    const newCalls = buildFunctionCallIndex(newFacts, newRoot);
    const newSpanIndex = buildSpanIndex(newFacts);
    const universe = buildIdUniverse(newRoot);

    // Ghost ids are `${moduleId}::__re_${exposed_name}` (module_tree.ts).
    const survivingGhost = 'c::__re_Reexp';
    const deletedGhost = 'c::__re_Gone';
    expect(universe.ghostNodeIds.has(survivingGhost)).toBe(true);
    expect(universe.ghostNodeIds.has(deletedGhost)).toBe(false);

    const ghostArrowsShown = new Set<string>([survivingGhost, deletedGhost]);
    pruneStaleState({
      universe,
      spanIndex: newSpanIndex,
      calls: newCalls,
      viewState: new ViewState([]),
      selectedFields: new Set(),
      incomingCallTargetsShown: new Set(),
      specificCallArrowsShown: new Set(),
      ghostArrowsShown,
      selectedElementId: null,
      selectedElementKind: null,
    });

    expect(ghostArrowsShown.has(survivingGhost)).toBe(true);
    expect(ghostArrowsShown.has(deletedGhost)).toBe(false);
  });

  it('reports selectedStillPresent=true when the selection survives', () => {
    const newFacts = facts([mod('', [struct('c', '', 'Keep', [field('x')])])]);
    const newRoot = buildWorkspaceTree(newFacts);
    const res = pruneStaleState({
      universe: buildIdUniverse(newRoot),
      spanIndex: buildSpanIndex(newFacts),
      calls: buildFunctionCallIndex(newFacts, newRoot),
      viewState: new ViewState([]),
      selectedFields: new Set(),
      incomingCallTargetsShown: new Set(),
      specificCallArrowsShown: new Set(),
      ghostArrowsShown: new Set(),
      selectedElementId: fieldId('c::Keep', 'x'),
      selectedElementKind: 'field',
    });
    expect(res.selectedStillPresent).toBe(true);
  });
});

describe('buildIdUniverse', () => {
  it('includes module, type, method-bucket and signature ids', () => {
    const f = facts([
      mod('', [struct('c', '', 'T', [field('a')], [fn('m')])], [fn('free')]),
    ]);
    const root = buildWorkspaceTree(f);
    const u = buildIdUniverse(root);
    expect(u.expandable.has('c')).toBe(true); // crate-root module id
    expect(u.expandable.has('c::T')).toBe(true); // type id
    expect(u.expandable.has('c::T::__methods_pub')).toBe(true); // method bucket
    expect(u.expandable.has('sig::c::T::m')).toBe(true); // method signature id
    expect(u.expandable.has('c::__fn_pub')).toBe(true); // function-group pseudo-type
    expect(u.expandable.has('sig::c::free')).toBe(true); // free-fn signature id
  });
});

describe('anchorScreenPoint', () => {
  it('maps a data point to the on-screen pixel via the TOP - scrollTop mapping', () => {
    // x uses the SVG transform (dataX*k + t.x); y uses native scroll
    // (TOP - scrollTop + dataY*k), NOT t.y.
    const top = 800;
    const scrollTop = 950;
    const transform = { x: 40, k: 2 };
    const p = anchorScreenPoint({ x: 10, y: 100 }, transform, top, scrollTop);
    expect(p.x).toBe(10 * 2 + 40); // 60
    expect(p.y).toBe(800 - 950 + 100 * 2); // 50
  });
});

describe('nearestToCenter', () => {
  it('picks the in-range candidate closest to the range centre', () => {
    const range = { min: 0, max: 100 }; // centre 50
    const best = nearestToCenter(
      [
        { id: 'far', y: 5 },
        { id: 'near', y: 48 },
        { id: 'offscreen', y: 200 },
      ],
      range,
    );
    expect(best?.id).toBe('near');
  });

  it('returns null when no candidate falls inside the visible range', () => {
    const best = nearestToCenter(
      [
        { id: 'above', y: -10 },
        { id: 'below', y: 999 },
      ],
      { min: 0, max: 100 },
    );
    expect(best).toBeNull();
  });
});
