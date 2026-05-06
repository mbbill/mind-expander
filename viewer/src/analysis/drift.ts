// LCA-based drift classification per type. Mirrors `tools/mind-expander/src/unified.rs`.
//
// For each type T with structural owners {O_i}:
//   ownerModules = unique sorted moduleOf(O_i)
//   lca          = longest common module-path prefix
//   typeMod      = moduleOf(T)
//
//   typeMod === lca                                     → at_lca
//   typeMod is descendant of lca, depth-diff ≤ N        → within_budget
//   typeMod is descendant of lca, depth-diff >  N       → drift_below
//   lca is strict descendant of typeMod                 → drift_above
//   otherwise (different subtrees)                      → drift_sideways
//
// `at_lca` and `within_budget` are "canonical" — the type sits where the LCA
// rule says it should (or within a small budget below). `drift_*` are
// anomalies. Layout uses canonical edges only; arrows render every edge but
// color by the target's class.

import type { OwnershipIndex } from './ownership.ts';

export type DriftClass =
  | 'at_lca'
  | 'within_budget'
  | 'drift_below'
  | 'drift_above'
  | 'drift_sideways';

export interface Policy {
  /** Max levels a type may sit below its owners' LCA before counting as drift. */
  readonly maxBelowLca: number;
}

export const DEFAULT_POLICY: Policy = { maxBelowLca: 1 };

export interface DriftIndex {
  /** Per type fullPath → drift class. Types without owners default to at_lca. */
  readonly typeClass: ReadonlyMap<string, DriftClass>;
  /** Per type fullPath → computed LCA (crate-relative module path). For debug/inspection. */
  readonly lca: ReadonlyMap<string, string>;
}

/**
 * Compute drift classification per type.
 *
 * @param ownership   Full ownership index (intra-crate, structural-vias).
 * @param typeModule  fullPath → crate-relative modulePath for every type in the crate.
 */
export function computeDrift(
  ownership: OwnershipIndex,
  typeModule: ReadonlyMap<string, string>,
  policy: Policy = DEFAULT_POLICY,
): DriftIndex {
  const typeClass = new Map<string, DriftClass>();
  const lcaMap = new Map<string, string>();

  for (const [typePath, modPath] of typeModule) {
    const owners = ownership.ownedBy.get(typePath);
    if (!owners || owners.length === 0) {
      // Roots have no owners → no LCA constraint; treat as at_lca.
      typeClass.set(typePath, 'at_lca');
      continue;
    }
    const ownerMods = uniqueOwnerModules(owners, typeModule);
    if (ownerMods.length === 0) {
      typeClass.set(typePath, 'at_lca');
      continue;
    }
    const lca = longestCommonModulePrefix(ownerMods);
    lcaMap.set(typePath, lca);
    typeClass.set(typePath, classify(modPath, lca, policy));
  }

  return { typeClass, lca: lcaMap };
}

/** True when target's class is at_lca or within_budget. Used as edge filter. */
export function isCanonicalTarget(target: string, drift: DriftIndex): boolean {
  const c = drift.typeClass.get(target);
  return c === 'at_lca' || c === 'within_budget';
}

function classify(typeMod: string, lca: string, policy: Policy): DriftClass {
  if (typeMod === lca) return 'at_lca';
  if (isDescendantOf(typeMod, lca)) {
    const levels = depthDiff(typeMod, lca);
    return levels <= policy.maxBelowLca ? 'within_budget' : 'drift_below';
  }
  if (isDescendantOf(lca, typeMod)) {
    return 'drift_above';
  }
  return 'drift_sideways';
}

/** True iff `child` === `parent` or is a strict descendant of it. */
function isDescendantOf(child: string, parent: string): boolean {
  if (parent === '') return true;
  return child === parent || child.startsWith(`${parent}::`);
}

/**
 * Number of additional `::`-segments `child` has below `parent`.
 * Precondition: `isDescendantOf(child, parent)`.
 */
function depthDiff(child: string, parent: string): number {
  if (child === parent) return 0;
  const tail = parent === '' ? child : child.slice(parent.length + 2);
  return tail.split('::').length;
}

function longestCommonModulePrefix(modules: readonly string[]): string {
  if (modules.length === 0) return '';
  if (modules.length === 1) return modules[0] ?? '';
  const split = modules.map((m) => (m === '' ? [] : m.split('::')));
  const minLen = Math.min(...split.map((s) => s.length));
  const common: string[] = [];
  for (let i = 0; i < minLen; i++) {
    const seg = split[0]?.[i];
    if (seg === undefined) break;
    if (split.every((s) => s[i] === seg)) common.push(seg);
    else break;
  }
  return common.join('::');
}

function uniqueOwnerModules(
  owners: readonly string[],
  typeModule: ReadonlyMap<string, string>,
): string[] {
  const set = new Set<string>();
  for (const o of owners) {
    const m = typeModule.get(o);
    if (m !== undefined) set.add(m);
  }
  return [...set];
}
