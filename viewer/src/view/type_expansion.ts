import type { FunctionCallIndex } from '../analysis/calls.ts';
import type { DriftClass, DriftIndex } from '../analysis/drift.ts';
import type { OwnershipIndex } from '../analysis/ownership.ts';

export interface MemberArrowRow {
  readonly rowName: string;
  readonly rowKind: 'field' | 'method' | 'function';
}

// The type-click affordance may reveal extra target modules, but only for
// canonical ownership edges that move from a source to a deeper target. Drift
// remains the color/semantic classification.
export function forwardRoutedTargetModulesFor(
  typeId: string,
  ownership: OwnershipIndex,
  depth: ReadonlyMap<string, number>,
  drift: DriftIndex,
  crateName: string,
): string[] {
  const fields = ownership.fieldTargets.get(typeId);
  const sourceDepth = depth.get(typeId);
  if (!fields || sourceDepth === undefined) return [];

  const out = new Set<string>();
  for (const targets of fields.values()) {
    for (const targetFullPath of targets) {
      const targetDepth = depth.get(targetFullPath);
      if (targetDepth === undefined) continue;
      const driftClass = drift.typeClass.get(targetFullPath) ?? 'at_lca';
      if (!isForwardOwnershipTarget(sourceDepth, targetDepth, driftClass)) continue;
      for (const id of ancestorModuleIds(targetFullPath, crateName)) {
        out.add(id);
      }
    }
  }
  return [...out];
}

function isForwardOwnershipTarget(
  sourceDepth: number,
  targetDepth: number,
  driftClass: DriftClass,
): boolean {
  return (driftClass === 'at_lca' || driftClass === 'within_budget') && targetDepth > sourceDepth;
}

export function targetModulesForMemberRow(
  typeId: string,
  rowName: string,
  rowKind: 'field' | 'method' | 'function',
  ownership: OwnershipIndex,
  calls: FunctionCallIndex,
  crateName: string,
): string[] {
  const out = new Set<string>();
  if (rowKind === 'field') {
    const targets = ownership.fieldTargets.get(typeId)?.get(rowName);
    if (targets === undefined) return [];
    for (const target of targets) {
      for (const id of ancestorModuleIds(target, crateName)) {
        out.add(id);
      }
    }
  } else {
    const row = calls.rowsByType
      .get(typeId)
      ?.find((r) => r.rowName === rowName && r.rowKind === rowKind);
    if (row === undefined) return [];
    for (const target of calls.callTargetsByFunction.get(row.functionFullPath) ?? []) {
      out.add(target.moduleId);
    }
  }
  return [...out];
}

export function targetExpansionIdsForMemberRow(
  typeId: string,
  rowName: string,
  rowKind: 'field' | 'method' | 'function',
  ownership: OwnershipIndex,
  calls: FunctionCallIndex,
  crateName: string,
): string[] {
  if (rowKind === 'field') {
    return targetModulesForMemberRow(typeId, rowName, rowKind, ownership, calls, crateName);
  }

  const out = new Set<string>();
  const row = calls.rowsByType
    .get(typeId)
    ?.find((r) => r.rowName === rowName && r.rowKind === rowKind);
  if (row === undefined) return [];

  for (const target of calls.callTargetsByFunction.get(row.functionFullPath) ?? []) {
    for (const id of ancestorModuleIds(target.typeId, crateName)) {
      out.add(id);
    }
    out.add(target.typeId);
    if (target.bucketId !== null) out.add(target.bucketId);
  }
  return [...out];
}

export function memberArrowRowsForType(
  typeId: string,
  ownership: OwnershipIndex,
  calls: FunctionCallIndex,
): readonly MemberArrowRow[] {
  const out: MemberArrowRow[] = [];
  for (const rowName of ownership.fieldTargets.get(typeId)?.keys() ?? []) {
    out.push({ rowName, rowKind: 'field' });
  }
  for (const row of calls.rowsByType.get(typeId) ?? []) {
    if ((calls.callTargetsByFunction.get(row.functionFullPath)?.length ?? 0) === 0) continue;
    out.push({ rowName: row.rowName, rowKind: row.rowKind });
  }
  return out;
}

export function callableBucketIdsForType(
  typeId: string,
  calls: FunctionCallIndex,
): readonly string[] {
  const out = new Set<string>();
  for (const row of calls.rowsByType.get(typeId) ?? []) {
    if (row.bucketId !== null) out.add(row.bucketId);
  }
  return [...out];
}

// `crate::a::b::Type` -> [`crate`, `crate::a`, `crate::a::b`].
export function ancestorModuleIds(typeFullPath: string, crateName: string): string[] {
  const segments = typeFullPath.split('::');
  if (segments[0] !== crateName || segments.length < 2) return [];
  const ids = [crateName];
  let path = '';
  for (let i = 1; i < segments.length - 1; i++) {
    const seg = segments[i] ?? '';
    path = path === '' ? seg : `${path}::${seg}`;
    ids.push(`${crateName}::${path}`);
  }
  return ids;
}
