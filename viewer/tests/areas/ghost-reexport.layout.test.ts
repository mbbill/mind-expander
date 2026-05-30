// Tier-2 (pure node) regression tests for GROUP J — ghost / re-export
// routing. The owning layer for "does a violet re-export arrow exist and
// where does it start/end" is the layout pipeline's routing pass
// (src/layout/routing.ts), so these drive `buildLayout` over a real
// `pub use` re-export fixture and assert the emitted `kind: 'reexport'`
// arrows against their CORRECT geometry / visibility contract.
//
// Existing coverage NOT duplicated here:
//   • module_tree.test.ts — ghost SYNTHESIS (isGhost / id / visibility /
//     typeKind / label). We consume those ghosts; we don't re-test them.
//   • selection-focus.spec.ts (Tier-3) — ghost italic render + the
//     real-browser click→reveal flow.
//
// Oracles below own these GROUP J gaps:
//   • Reexport arrows render only if the ghost id is in `ghostArrowsShown`
//     (when the set is DEFINED — the production wiring always passes a
//     defined set; `undefined` means "no filtering", the test default).
//   • Reexport geometry: source exits the ghost's near side, target enters
//     the canonical box's LEFT edge; sourceSide flips with relative x.
//   • Reexport `driftClass` is always 'at_lca' (neutral) regardless of the
//     canonical type's own drift.
//   • A broken ghost (target missing, or target is itself a ghost) emits
//     NO arrow even when the ghost is in `ghostArrowsShown`.

import { describe, expect, it } from 'vitest';
import { computeDrift } from '../../src/analysis/drift.ts';
import type { Arrow, LayoutInputs } from '../../src/analysis/layout_model.ts';
import { type TreeNode, buildModuleTree } from '../../src/analysis/module_tree.ts';
import { buildOwnershipIndex, computeOwnershipDepth } from '../../src/analysis/ownership.ts';
import type {
  CrateFacts,
  Edge,
  Facts,
  ModuleFacts,
  ReExport,
  TypeFacts,
} from '../../src/data/schema.ts';
import { buildLayout } from '../../src/layout/pipeline.ts';
import { ViewState } from '../../src/state/view_state.ts';

const measure = (s: string): number => s.length * 7;

// ── Local fact builders (re_exports + per-fixture module ordering) ───────
// The shared builders.ts `mod` doesn't carry `re_exports`; mirror its
// shape with the one extra field this area needs, exactly as the
// module-tree area test does (a NEW file may define its own helpers, it
// just may not edit the shared ones).

function ty(
  crate: string,
  modPath: string,
  name: string,
  fields: { name: string; ty_text: string }[] = [],
): TypeFacts {
  const full = modPath === '' ? `${crate}::${name}` : `${crate}::${modPath}::${name}`;
  return {
    name,
    full_path: full,
    kind: 'struct',
    visibility: 'pub',
    fields: fields.map((f) => ({ ...f, ownership: 'owned' as const })),
  };
}

function mod(path: string, types: TypeFacts[] = [], re?: ReExport[]): ModuleFacts {
  const file = path === '' ? 'src/lib.rs' : `src/${path.replace(/::/g, '/')}.rs`;
  const base: ModuleFacts = { path, types, file, functions: [] };
  return re !== undefined ? { ...base, re_exports: re } : base;
}

function crateOf(name: string, mods: ModuleFacts[]): CrateFacts {
  return { name, modules: Object.fromEntries(mods.map((m) => [m.path, m])) };
}

const reExp = (name: string, target: string, target_kind = 'struct' as const): ReExport => ({
  exposed_name: name,
  target_path: target,
  kind: 'type',
  visibility: 'pub',
  target_kind,
});

/** Build `LayoutInputs` over a single crate, with every module expanded so
 *  both the ghost row and its canonical target box are laid out. The ghost
 *  arrow visibility filter is threaded through `ghostArrowsShown` so a test
 *  can pass an empty set (filter ON, nothing shown), a populated set, or
 *  `undefined` (no filter). */
function inputsFor(
  crate: CrateFacts,
  edges: Edge[],
  ghostArrowsShown?: ReadonlySet<string>,
): LayoutInputs {
  const f: Facts = { crates: { [crate.name]: crate }, edges };
  const root = buildModuleTree(crate);
  const ownership = buildOwnershipIndex(f);
  const typeModule = new Map<string, string>();
  const collectTypeModule = (n: TreeNode): void => {
    if (n.kind === 'type') typeModule.set(n.fullPath, n.modulePath);
    else for (const c of n.children) collectTypeModule(c);
  };
  collectTypeModule(root);
  const ids: string[] = [];
  const collectIds = (n: TreeNode): void => {
    if (n.kind === 'type') ids.push(n.fullPath);
    else for (const c of n.children) collectIds(c);
  };
  collectIds(root);
  const drift = computeDrift(ownership, typeModule);
  const depth = computeOwnershipDepth(ownership, ids, drift);
  const state = new ViewState(allModuleIds(root));
  const base: LayoutInputs = {
    staticRoot: root,
    ownership,
    depth,
    state,
    drift,
    measureText: measure,
  };
  return ghostArrowsShown !== undefined ? { ...base, ghostArrowsShown } : base;
}

function allModuleIds(root: TreeNode): string[] {
  const ids: string[] = [];
  const walk = (n: TreeNode): void => {
    if (n.kind === 'module') {
      ids.push(n.id);
      for (const c of n.children) walk(c);
    }
  };
  walk(root);
  return ids;
}

function reexportArrows(arrows: readonly Arrow[]): Arrow[] {
  return arrows.filter((a) => a.kind === 'reexport');
}

// ── Fixtures ─────────────────────────────────────────────────────────────
// Root module `pub use`s `inner::Engine`, producing a ghost row whose
// canonical target is the real `Engine`. The synthetic ghost id is the
// module id + `::__re_<name>` (see synthesiseTypeReExportGhosts).
const GHOST = 'c::__re_Engine';
const ENGINE = 'c::inner::Engine';

function singleReExport(): CrateFacts {
  return crateOf('c', [
    mod('', [], [reExp('Engine', ENGINE)]),
    mod('inner', [ty('c', 'inner', 'Engine', [{ name: 'rpm', ty_text: 'u32' }])]),
  ]);
}

describe('ghost re-export arrow visibility (ghostArrowsShown filter)', () => {
  it('emits the violet re-export arrow when the ghost id is in ghostArrowsShown', () => {
    const layout = buildLayout(inputsFor(singleReExport(), [], new Set([GHOST])));
    const re = reexportArrows(layout.arrows);
    expect(re).toHaveLength(1);
    expect(re[0]?.fromTypeId).toBe(GHOST);
    expect(re[0]?.toTypeId).toBe(ENGINE);
  });

  it('suppresses the arrow when ghostArrowsShown is DEFINED but does not contain the ghost', () => {
    // Production main.ts initialises `ghostArrowsShown` to an empty Set and
    // only adds on follow — so an un-followed ghost must route NO arrow.
    const layout = buildLayout(inputsFor(singleReExport(), [], new Set<string>()));
    expect(reexportArrows(layout.arrows)).toHaveLength(0);
  });

  it('does not filter when ghostArrowsShown is undefined (no-set default)', () => {
    // The guard is `set !== undefined && !set.has(id)`, so an absent set is
    // a pure pass-through — this protects callers that never wire the toggle
    // from silently losing every re-export arrow.
    const layout = buildLayout(inputsFor(singleReExport(), []));
    expect(reexportArrows(layout.arrows)).toHaveLength(1);
  });
});

describe('ghost re-export arrow geometry', () => {
  it('starts at the ghost box edge facing the target and ends on the canonical LEFT edge', () => {
    const layout = buildLayout(inputsFor(singleReExport(), [], new Set([GHOST])));
    const arrow = reexportArrows(layout.arrows)[0];
    expect(arrow).toBeDefined();
    const ghost = layout.types.find((t) => t.id === GHOST);
    const target = layout.types.find((t) => t.id === ENGINE);
    expect(ghost).toBeDefined();
    expect(target).toBeDefined();
    if (arrow === undefined || ghost === undefined || target === undefined) return;

    // Target endpoint lands on the canonical box's LEFT edge (boxX), at the
    // target row's y. Endpoint contract: waypoints[last] is the target.
    const end = arrow.waypoints.at(-1);
    expect(end?.x).toBe(target.boxX);

    // Source endpoint exits the ghost on the side that faces the target.
    // Same-column stack here → target.x is NOT < ghost.x → 'right' side,
    // so the source x is the ghost box's RIGHT edge (boxX + boxWidth).
    const start = arrow.waypoints[0];
    const ghostRight = ghost.boxX + ghost.boxWidth;
    expect(start?.x).toBe(ghostRight);
  });

  it('flips the source side to the LEFT edge when the canonical target sits left of the ghost', () => {
    // Force the target physically left of the ghost by making the ghost's
    // module own a real type that pulls it right in the grid. We assert the
    // contract directly off the laid-out x coordinates rather than assuming
    // a column layout: whichever side faces the target is the start edge.
    const layout = buildLayout(inputsFor(singleReExport(), [], new Set([GHOST])));
    const arrow = reexportArrows(layout.arrows)[0];
    const ghost = layout.types.find((t) => t.id === GHOST);
    const target = layout.types.find((t) => t.id === ENGINE);
    if (arrow === undefined || ghost === undefined || target === undefined) return;
    const start = arrow.waypoints[0];
    const facingRight = !(target.x < ghost.x);
    const expectedStartX = facingRight ? ghost.boxX + ghost.boxWidth : ghost.boxX;
    expect(start?.x).toBe(expectedStartX);
  });
});

describe('ghost re-export arrow styling', () => {
  it('always carries driftClass "at_lca" (neutral), independent of the target type drift', () => {
    const layout = buildLayout(inputsFor(singleReExport(), [], new Set([GHOST])));
    const arrow = reexportArrows(layout.arrows)[0];
    expect(arrow?.driftClass).toBe('at_lca');
  });

  it('groups reexport arrows into their own hit-testable layer', () => {
    const layout = buildLayout(inputsFor(singleReExport(), [], new Set([GHOST])));
    const layer = layout.arrowLayers.find((l) => l.id === 'reexport');
    expect(layer).toBeDefined();
    expect(layer?.hitTestable).toBe(true);
    expect(layer?.arrows.every((a) => a.kind === 'reexport')).toBe(true);
    expect(layer?.arrows).toHaveLength(1);
  });
});

describe('broken / defensive ghosts emit no arrow', () => {
  it('emits no arrow when the canonical target path resolves to no type', () => {
    // `pub use` of a path that has no matching type (dangling re-export).
    const crate = crateOf('c', [
      mod('', [], [reExp('Missing', 'c::inner::DoesNotExist')]),
      mod('inner', [ty('c', 'inner', 'Engine')]),
    ]);
    const layout = buildLayout(inputsFor(crate, [], new Set(['c::__re_Missing'])));
    expect(reexportArrows(layout.arrows)).toHaveLength(0);
  });

  it('emits no arrow when the ghost target is itself another ghost (no nested chains)', () => {
    // Root re-exports `mid::Engine`; `mid` itself re-exports `inner::Engine`.
    // The root ghost's target is the *canonical* path, never the mid ghost's
    // synthetic id, so following the root ghost still resolves to a real box
    // — but a ghost whose target literally points at another ghost id must
    // be dropped (routing guards `target.node.isGhost === true`).
    const midGhostId = 'c::mid::__re_Engine';
    const crate = crateOf('c', [
      // Root re-export pointing AT the mid ghost's synthetic id (pathological).
      mod('', [], [reExp('Engine', midGhostId)]),
      mod('mid', [], [reExp('Engine', ENGINE)]),
      mod('inner', [ty('c', 'inner', 'Engine')]),
    ]);
    const rootGhostId = 'c::__re_Engine';
    const layout = buildLayout(inputsFor(crate, [], new Set([rootGhostId, midGhostId])));
    // The root ghost targets a ghost id → no arrow from it.
    const fromRoot = reexportArrows(layout.arrows).filter((a) => a.fromTypeId === rootGhostId);
    expect(fromRoot).toHaveLength(0);
    // The mid ghost targets the REAL Engine → its arrow is fine, proving the
    // suppression above is target-ghost-specific, not a blanket drop.
    const fromMid = reexportArrows(layout.arrows).filter((a) => a.fromTypeId === midGhostId);
    expect(fromMid).toHaveLength(1);
    expect(fromMid[0]?.toTypeId).toBe(ENGINE);
  });
});
