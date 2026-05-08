import type { ModuleNode, TreeNode, TypeNode } from '../analysis/module_tree.ts';
import type { OwnershipIndex } from '../analysis/ownership.ts';
import { BUCKET_ORDER, classifyVisibility } from '../analysis/visibility.ts';
import type { BandDepth } from './band_shape.ts';
import type { RankAssignment } from './types.ts';

export interface PlacementTypePlan {
  readonly node: TypeNode;
  readonly typeId: string;
  readonly moduleId: string;
  readonly modulePath: string;
  readonly depth: BandDepth;
  readonly rankOrder: number;
  readonly stableOrder: number;
  readonly rank: number;
  readonly forwardPredecessors: readonly string[];
  readonly nonForwardPredecessors: readonly string[];
  readonly isNonRank: boolean;
}

export interface PlacementLayoutPlan {
  readonly types: readonly TypeNode[];
  readonly ranks: ReadonlyMap<string, RankAssignment>;
  readonly placementsById: ReadonlyMap<string, PlacementTypePlan>;
  readonly maxRankOrder: number;
}

export function buildPlacementLayoutPlan(
  root: ModuleNode,
  depth: ReadonlyMap<string, number>,
  ownership: OwnershipIndex,
): PlacementLayoutPlan {
  const types = collectAllTypeNodes(root);
  const rankableTypeIds = new Set(types.filter((type) => !isNonRankType(type)).map((t) => t.id));
  const ranks = computeOwnershipRanks(types, depth);
  const nonRankOrderByModule = computeNonRankOrderByModule(types);
  const placementsById = new Map<string, PlacementTypePlan>();
  let maxRankOrder = 0;

  for (const node of types) {
    const nonRank = isNonRankType(node);
    const moduleId = idForModule(root.label, node.modulePath);
    const rank = ranks.get(node.id);
    const logicalDepth = nonRank
      ? ({ kind: 'prelude' } as const)
      : ({ kind: 'rank', depth: rank?.depth ?? 0 } as const);
    const rankOrder = rankOrderForDepth(logicalDepth);
    const stableOrder = nonRank
      ? (nonRankOrderByModule.get(moduleId)?.get(node.id) ?? 0)
      : (rank?.subrank ?? 0);
    const { forwardPredecessors, nonForwardPredecessors } = classifyPredecessors(
      node.id,
      nonRank,
      depth,
      rankableTypeIds,
      ownership,
    );
    const placement = {
      node,
      typeId: node.id,
      moduleId,
      modulePath: node.modulePath,
      depth: logicalDepth,
      rankOrder,
      stableOrder,
      rank: nonRank ? -1 : (rank?.rank ?? 0),
      forwardPredecessors,
      nonForwardPredecessors,
      isNonRank: nonRank,
    };
    placementsById.set(node.id, placement);
    if (rankOrder > maxRankOrder) maxRankOrder = rankOrder;
  }

  return { types, ranks, placementsById, maxRankOrder };
}

export function requirePlacement(plan: PlacementLayoutPlan, typeId: string): PlacementTypePlan {
  const placement = plan.placementsById.get(typeId);
  if (placement === undefined) {
    throw new Error(`Missing placement plan for type: ${typeId}`);
  }
  return placement;
}

export function isNonRankType(t: TypeNode): boolean {
  return t.isGhost === true || t.typeKind === 'function_group';
}

export function rankOrderForDepth(depth: BandDepth): number {
  return depth.kind === 'prelude' ? 0 : depth.depth + 1;
}

function collectAllTypeNodes(root: ModuleNode): TypeNode[] {
  const out: TypeNode[] = [];
  const walk = (n: TreeNode): void => {
    if (n.kind === 'type') out.push(n);
    else for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
}

function computeOwnershipRanks(
  types: readonly TypeNode[],
  depth: ReadonlyMap<string, number>,
): ReadonlyMap<string, RankAssignment> {
  const rankableTypes = types.filter((t) => !isNonRankType(t));
  const sorted = [...rankableTypes].sort(compareRankableTypes(depth));
  const ranks = new Map<string, RankAssignment>();
  const ordinalCounter = new Map<number, number>();

  for (let index = 0; index < sorted.length; index += 1) {
    const node = sorted[index];
    if (node === undefined) continue;
    const d = depth.get(node.id) ?? 0;
    const subrank = ordinalCounter.get(d) ?? 0;
    ordinalCounter.set(d, subrank + 1);
    ranks.set(node.id, { depth: d, subrank, rank: index });
  }

  return ranks;
}

function compareRankableTypes(depth: ReadonlyMap<string, number>) {
  return (a: TypeNode, b: TypeNode): number => {
    const da = depth.get(a.id) ?? 0;
    const db = depth.get(b.id) ?? 0;
    if (da !== db) return da - db;

    // The rank-local order is a static facts-derived contract. Edge degree,
    // expansion state, and measured width belong to later physical placement
    // so toggling a type cannot reshuffle identity inside one rank.
    return (
      a.label.localeCompare(b.label) ||
      a.modulePath.localeCompare(b.modulePath) ||
      a.fullPath.localeCompare(b.fullPath)
    );
  };
}

function classifyPredecessors(
  typeId: string,
  nonRank: boolean,
  depth: ReadonlyMap<string, number>,
  rankableTypeIds: ReadonlySet<string>,
  ownership: OwnershipIndex,
): Pick<PlacementTypePlan, 'forwardPredecessors' | 'nonForwardPredecessors'> {
  if (nonRank) {
    return { forwardPredecessors: [], nonForwardPredecessors: [] };
  }

  const ownDepth = depth.get(typeId) ?? 0;
  const forwardPredecessors: string[] = [];
  const nonForwardPredecessors: string[] = [];

  for (const ownerId of ownership.ownedBy.get(typeId) ?? []) {
    if (!rankableTypeIds.has(ownerId)) continue;
    const ownerDepth = depth.get(ownerId) ?? 0;
    if (ownerDepth < ownDepth) {
      forwardPredecessors.push(ownerId);
    } else {
      nonForwardPredecessors.push(ownerId);
    }
  }

  forwardPredecessors.sort();
  nonForwardPredecessors.sort();
  return { forwardPredecessors, nonForwardPredecessors };
}

function computeNonRankOrderByModule(
  types: readonly TypeNode[],
): ReadonlyMap<string, ReadonlyMap<string, number>> {
  const byModule = new Map<string, TypeNode[]>();
  for (const type of types) {
    if (!isNonRankType(type)) continue;
    const moduleId = idForModuleFromType(type);
    const list = byModule.get(moduleId) ?? [];
    list.push(type);
    byModule.set(moduleId, list);
  }

  const out = new Map<string, ReadonlyMap<string, number>>();
  for (const [moduleId, moduleTypes] of byModule) {
    const order = new Map<string, number>();
    [...moduleTypes].sort(compareNonRankTypes).forEach((type, index) => order.set(type.id, index));
    out.set(moduleId, order);
  }
  return out;
}

function compareNonRankTypes(a: TypeNode, b: TypeNode): number {
  const aFn = a.typeKind === 'function_group';
  const bFn = b.typeKind === 'function_group';
  if (aFn !== bFn) return aFn ? -1 : 1;
  if (aFn && bFn) {
    const ai = BUCKET_ORDER.indexOf(classifyVisibility(a.visibility));
    const bi = BUCKET_ORDER.indexOf(classifyVisibility(b.visibility));
    if (ai !== bi) return ai - bi;
  }
  return a.label.localeCompare(b.label) || a.fullPath.localeCompare(b.fullPath);
}

function idForModule(crateName: string, modulePath: string): string {
  return modulePath === '' ? crateName : `${crateName}::${modulePath}`;
}

function idForModuleFromType(type: TypeNode): string {
  const parts = type.fullPath.split('::');
  const crateName = parts[0] ?? '';
  return idForModule(crateName, type.modulePath);
}
