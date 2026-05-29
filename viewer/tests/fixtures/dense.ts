// Dense, parameterized fixture generator — stress layout/routing AT SCALE.
//
// The hand-written small/medium fixtures exercise specific shapes, but the
// "sf-nano crowding" class of bugs (gutter contention, channel exhaustion,
// LCA placement under deep nesting) only appears once many types/modules
// share the same gutters. This generator builds arbitrarily large
// LayoutInputs from a small set of structural knobs.
//
// HARD INVARIANT: fully deterministic. Every id, edge, and field is derived
// from integer indices — no Math.random, no Date.now. Same opts in → byte
// identical LayoutInputs out, so failures are reproducible.
//
// It reuses builders.ts (ty/mod/crateFacts/edge/buildInputs) for all fact
// construction; this file only decides the *shape*, never how a Fact is built.

import type { LayoutInputs } from '../../src/analysis/layout_model.ts';
import { idForModule } from '../../src/analysis/module_tree.ts';
import type { Edge, ModuleFacts, TypeFacts } from '../../src/data/schema.ts';
import { buildInputs, crateFacts, edge, mod, ty } from './builders.ts';

export interface DenseOptions {
  /** Workspace crate name. All ids are prefixed with `${crate}::`. */
  readonly crate: string;
  /** Number of leaf modules to spread types across. Must be >= 1. */
  readonly modules: number;
  /** Types created in each module. Total type count = modules * typesPerModule. */
  readonly typesPerModule: number;
  /** Ownership fan-out: each "owner" type owns this many other types. The
   *  generator picks one owner per module (the first type) and points it at
   *  `ownershipFanout` sibling/cross-module targets, producing dense gutters. */
  readonly ownershipFanout: number;
  /** Fraction (0..1) of ownership edges that should cross module boundaries
   *  rather than stay intra-module. 0 = all intra-module, 1 = all cross-module.
   *  Cross-module edges force the LCA up the module tree and create the
   *  long-haul arrows that contend for shared gutters. */
  readonly crossModuleRatio: number;
  /** Module-tree nesting depth. Leaf modules are placed under a chain/tree of
   *  intermediate directory modules `m0::m1::...`. Depth 1 = flat (all modules
   *  directly under the crate root). Must be >= 1. */
  readonly nestingDepth: number;
  /** Branching factor of the nesting tree at each level. With branchFactor=1
   *  the tree is a single deep chain; larger values make it wide-and-deep. */
  readonly branchFactor: number;
  /** Which type/module ids start expanded. If omitted, every module on every
   *  path AND every type id start expanded (worst case for crowding — all
   *  field rows and arrows are visible). To compute a focused subset, use the
   *  ids returned by `denseShapeIds(opts)`. */
  readonly expandedIds?: readonly string[];
}

const DEFAULTS: DenseOptions = {
  crate: 'd',
  modules: 8,
  typesPerModule: 6,
  ownershipFanout: 3,
  crossModuleRatio: 0.5,
  nestingDepth: 2,
  branchFactor: 2,
};

interface DenseShape {
  /** Module path (`::`-joined) for each leaf module index. */
  readonly modulePaths: string[];
  /** Per-module list of bare type names. */
  readonly typeNamesByModule: string[][];
  /** Full path (`crate::mod::Name`) for every generated type, in module order. */
  readonly allTypeIds: string[];
  /** Every module node id (leaf modules AND synthesized directory
   *  intermediates) that must be expanded for the deepest types to be
   *  visible. A node renders only when all its ancestors are expanded, so a
   *  nested fixture has to expand each path prefix, not just the leaf. */
  readonly allModuleIds: string[];
}

/** Build the module paths for `count` leaf modules under a nesting tree of the
 *  requested depth/branch factor. Deterministic: module i always lands at the
 *  same path. Intermediate directory segments are `nK` (level index), leaf
 *  segments are `lI` (module index) so leaf names stay unique. */
function buildModulePaths(count: number, nestingDepth: number, branchFactor: number): string[] {
  const depth = Math.max(1, nestingDepth);
  const branch = Math.max(1, branchFactor);
  const paths: string[] = [];
  for (let i = 0; i < count; i++) {
    const segments: string[] = [];
    let acc = i;
    // First (depth-1) segments come from the nesting tree, base-`branch` digits
    // of the module index, so siblings cluster under shared parents.
    for (let level = 0; level < depth - 1; level++) {
      const digit = acc % branch;
      acc = Math.floor(acc / branch);
      segments.push(`n${level}_${digit}`);
    }
    segments.push(`l${i}`);
    paths.push(segments.join('::'));
  }
  return paths;
}

function buildShape(opts: DenseOptions): DenseShape {
  const modulePaths = buildModulePaths(opts.modules, opts.nestingDepth, opts.branchFactor);
  const typeNamesByModule: string[][] = [];
  const allTypeIds: string[] = [];
  // The crate root is a real module node; its children only render when it is
  // itself expanded (geometry treats only the root's *parent* as implicit).
  const moduleIdSet = new Set<string>([idForModule(opts.crate, '')]);
  for (let m = 0; m < opts.modules; m++) {
    const modulePath = modulePaths[m] ?? '';
    const names: string[] = [];
    for (let t = 0; t < opts.typesPerModule; t++) {
      const name = `T${m}_${t}`;
      names.push(name);
      allTypeIds.push(`${opts.crate}::${modulePath}::${name}`);
    }
    typeNamesByModule.push(names);
    // Expand every prefix of this leaf path so synthesized directory
    // intermediates between the crate root and the leaf are all open.
    const segments = modulePath.split('::');
    for (let s = 1; s <= segments.length; s++) {
      moduleIdSet.add(idForModule(opts.crate, segments.slice(0, s).join('::')));
    }
  }
  return { modulePaths, typeNamesByModule, allTypeIds, allModuleIds: [...moduleIdSet] };
}

export interface DenseShapeIds {
  /** Full path of every generated type, in module-then-type order. */
  readonly typeIds: readonly string[];
  /** Every module node id (leaf + synthesized directory intermediates). */
  readonly moduleIds: readonly string[];
}

/** Expose the deterministic id space for a given opts so callers can build a
 *  focused `expandedIds` subset (e.g. expand only some modules) without
 *  re-deriving id formats. Same opts → same ids as `denseInputs`. */
export function denseShapeIds(options: Partial<DenseOptions> = {}): DenseShapeIds {
  const opts: DenseOptions = { ...DEFAULTS, ...options };
  const shape = buildShape(opts);
  return { typeIds: shape.allTypeIds, moduleIds: shape.allModuleIds };
}

/** Generic dense generator. Returns LayoutInputs ready for buildLayout. */
export function denseInputs(options: Partial<DenseOptions> = {}): LayoutInputs {
  const opts: DenseOptions = { ...DEFAULTS, ...options };
  const shape = buildShape(opts);
  const { crate } = opts;

  // Collect (owner -> target) ownership edges first so we can attach a field
  // to each owner type before constructing the ModuleFacts.
  interface Edge0 {
    readonly ownerId: string;
    readonly targetId: string;
    readonly fieldName: string;
  }
  const edges0: Edge0[] = [];
  // Per-owner field accumulation, keyed by owner full id.
  const fieldsByOwner = new Map<string, { name: string; ty_text: string }[]>();

  let crossCounter = 0; // drives the deterministic cross/intra decision
  for (let m = 0; m < opts.modules; m++) {
    const ownerNames = shape.typeNamesByModule[m] ?? [];
    const ownerName = ownerNames[0] ?? `T${m}_0`;
    const ownerId = `${crate}::${shape.modulePaths[m] ?? ''}::${ownerName}`;
    for (let k = 0; k < opts.ownershipFanout; k++) {
      // Deterministic cross-module decision: spread the cross edges evenly
      // using a ratio accumulator (chooseCross), instead of randomness.
      crossCounter += 1;
      const cross = chooseCross(opts.crossModuleRatio, crossCounter) && opts.modules > 1;

      let targetModule: number;
      let targetIndex: number;
      if (cross) {
        // Step to another module deterministically; offset by k+1 so a single
        // owner fans out to several distinct modules.
        targetModule = (m + 1 + k) % opts.modules;
        targetIndex = (k + 1) % opts.typesPerModule;
      } else {
        targetModule = m;
        // Avoid self-ownership: pick a sibling type in the same module.
        targetIndex = (k + 1) % opts.typesPerModule;
        if (targetIndex === 0) targetIndex = 1 % opts.typesPerModule;
      }
      const targetNames = shape.typeNamesByModule[targetModule] ?? [];
      const targetName = targetNames[targetIndex] ?? targetNames[0] ?? `T${targetModule}_0`;
      const targetId = `${crate}::${shape.modulePaths[targetModule] ?? ''}::${targetName}`;
      if (targetId === ownerId) continue; // degenerate (typesPerModule==1)

      const fieldName = `f${m}_${k}`;
      edges0.push({ ownerId, targetId, fieldName });
      const fld = fieldsByOwner.get(ownerId) ?? [];
      fld.push({ name: fieldName, ty_text: targetName });
      fieldsByOwner.set(ownerId, fld);
    }
  }

  // Build ModuleFacts. Every leaf module gets its full set of types; owners
  // carry the accumulated fields.
  const modules: ModuleFacts[] = [];
  for (let m = 0; m < opts.modules; m++) {
    const modPath = shape.modulePaths[m] ?? '';
    const names = shape.typeNamesByModule[m] ?? [];
    const types: TypeFacts[] = names.map((name) => {
      const id = `${crate}::${modPath}::${name}`;
      const fields = fieldsByOwner.get(id) ?? [];
      return ty(crate, modPath, name, fields);
    });
    modules.push(mod(modPath, types));
  }

  const edges: Edge[] = edges0.map((e) =>
    edge(e.ownerId, e.targetId, `field ${e.fieldName}`),
  );

  const c = crateFacts(crate, modules);
  // Default (worst case for crowding): expand every module on every path AND
  // every type, so all field rows and arrows are materialized. Callers can
  // override with a focused set to test partial-expansion behavior.
  const expanded =
    opts.expandedIds !== undefined
      ? [...opts.expandedIds]
      : [...shape.allModuleIds, ...shape.allTypeIds];
  return buildInputs(c, edges, expanded);
}

/** Deterministic, evenly-spread cross/intra choice. Bresenham-style: walk a
 *  ratio accumulator so that over N calls roughly `ratio*N` return true, with
 *  no clustering and no randomness. */
function chooseCross(ratio: number, counter: number): boolean {
  if (ratio <= 0) return false;
  if (ratio >= 1) return true;
  // floor(counter*ratio) increments by 1 every ~1/ratio steps.
  return Math.floor(counter * ratio) > Math.floor((counter - 1) * ratio);
}

// ---------------------------------------------------------------------------
// Named presets
// ---------------------------------------------------------------------------

/** High fan-out single owner: one type owns >= `fanout` (default 24) targets
 *  spread across modules, all entering through the same gutter zone — the
 *  canonical gutter-contention / channel-allocation stress case. */
export function denseHighFanout(fanout = 24): LayoutInputs {
  // Put every target in its own module so all fanout arrows are cross-module
  // long-hauls that share the owner's outgoing gutter.
  return denseInputs({
    crate: 'fan',
    modules: fanout + 1,
    typesPerModule: 1,
    ownershipFanout: fanout,
    crossModuleRatio: 1,
    nestingDepth: 1,
    branchFactor: 1,
  });
}

/** Deep AND wide nested module tree: many leaf modules under several levels of
 *  intermediate directory modules, with mixed cross-module ownership so the
 *  LCA is pushed up through the nesting and long arrows traverse the tree. */
export function denseDeepNested(): LayoutInputs {
  return denseInputs({
    crate: 'tree',
    modules: 16,
    typesPerModule: 4,
    ownershipFanout: 3,
    crossModuleRatio: 0.6,
    nestingDepth: 4,
    branchFactor: 2,
  });
}
