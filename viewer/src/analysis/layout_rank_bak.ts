import type { ModuleNode, TypeNode } from './module_tree.ts';

// Rank is the semantic left-to-right constraint. It is intentionally not the
// final x coordinate: later placement may move a type farther right to satisfy
// routing capacity, but it must not move a type left of its LCA-derived rank.

export function semanticDepthOf(t: TypeNode, depth: ReadonlyMap<string, number>): number {
  if (t.isGhost === true && t.ghostTarget !== undefined) {
    const targetDepth = depth.get(t.ghostTarget);
    if (targetDepth !== undefined) return targetDepth;
  }
  return depth.get(t.fullPath) ?? 0;
}

export function layoutRankOfType(t: TypeNode, depth: ReadonlyMap<string, number>): number {
  return t.typeKind === 'function_group' ? 0 : semanticDepthOf(t, depth) + 1;
}

export function rootXForRank(
  t: TypeNode,
  depth: ReadonlyMap<string, number>,
  globalXStart: number,
  realTypeOffset: number,
): number {
  return layoutRankOfType(t, depth) === 0 ? globalXStart : globalXStart + realTypeOffset;
}

export interface StableRankPlacement {
  readonly xOffsetByType: ReadonlyMap<string, number>;
  readonly subrankByType: ReadonlyMap<string, number>;
  readonly columnCountByGroup: ReadonlyMap<string, number>;
}

const DENSE_RANK_THRESHOLD = 8;
const DENSE_RANK_MAX_COLUMNS = 3;
const DENSE_RANK_X_STEP = 170;

export function computeStableRankPlacement(
  root: ModuleNode,
  depth: ReadonlyMap<string, number>,
): StableRankPlacement {
  const byGroup = new Map<string, TypeNode[]>();
  const visit = (m: ModuleNode): void => {
    for (const child of m.children) {
      if (child.kind === 'module') {
        visit(child);
        continue;
      }
      if (child.typeKind === 'function_group') continue;
      const key = `${child.modulePath}\x1F${semanticDepthOf(child, depth)}`;
      const group = byGroup.get(key) ?? [];
      group.push(child);
      byGroup.set(key, group);
    }
  };
  visit(root);

  const xOffsetByType = new Map<string, number>();
  const subrankByType = new Map<string, number>();
  const columnCountByGroup = new Map<string, number>();

  for (const [key, group] of byGroup) {
    const ordered = [...group].sort((a, b) => a.fullPath.localeCompare(b.fullPath));
    const columnCount =
      ordered.length >= DENSE_RANK_THRESHOLD
        ? Math.min(DENSE_RANK_MAX_COLUMNS, Math.ceil(Math.sqrt(ordered.length)))
        : 1;
    columnCountByGroup.set(key, columnCount);
    for (let i = 0; i < ordered.length; i++) {
      const type = ordered[i] as TypeNode;
      const subrank = i % columnCount;
      subrankByType.set(type.fullPath, subrank);
      xOffsetByType.set(type.fullPath, subrank * DENSE_RANK_X_STEP);
    }
  }

  return { xOffsetByType, subrankByType, columnCountByGroup };
}
