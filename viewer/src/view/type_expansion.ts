import type { FunctionCallIndex } from '../analysis/calls.ts';
import type { DriftClass, DriftIndex } from '../analysis/drift.ts';
import type { Arrow } from '../analysis/layout_model.ts';
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
      for (const id of ancestorModuleIds(targetFullPath)) {
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
): string[] {
  const out = new Set<string>();
  if (rowKind === 'field') {
    const targets = ownership.fieldTargets.get(typeId)?.get(rowName);
    if (targets === undefined) return [];
    for (const target of targets) {
      for (const id of ancestorModuleIds(target)) {
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
): string[] {
  if (rowKind === 'field') {
    return targetModulesForMemberRow(typeId, rowName, rowKind, ownership, calls);
  }

  const out = new Set<string>();
  const row = calls.rowsByType
    .get(typeId)
    ?.find((r) => r.rowName === rowName && r.rowKind === rowKind);
  if (row === undefined) return [];

  for (const target of calls.callTargetsByFunction.get(row.functionFullPath) ?? []) {
    for (const id of ancestorModuleIds(target.typeId)) {
      out.add(id);
    }
    out.add(target.typeId);
    if (target.bucketId !== null) out.add(target.bucketId);
  }
  return [...out];
}

/**
 * Names of the fields on `ownerTypeId` whose ownership targets include
 * `targetTypePath`. Used by the "expand all owners" affordance to also
 * select those fields, so drifted (non-canonical) ownership arrows are
 * allowed through the routing filter. Without this, expanding an owner
 * type makes its rows visible but a drifted incoming arrow would still
 * be suppressed because drifted arrows are opt-in per-field.
 */
export function ownerFieldsPointingTo(
  ownership: OwnershipIndex,
  ownerTypeId: string,
  targetTypePath: string,
): string[] {
  const fields = ownership.fieldTargets.get(ownerTypeId);
  if (fields === undefined) return [];
  const out: string[] = [];
  for (const [fieldName, targets] of fields) {
    if (targets.includes(targetTypePath)) out.push(fieldName);
  }
  return out;
}

export function callerExpansionIdsForFunction(
  functionFullPath: string,
  calls: FunctionCallIndex,
): string[] {
  const out = new Set<string>();
  for (const call of calls.incomingCallsByFunction.get(functionFullPath) ?? []) {
    const caller = call.callerRow;
    for (const id of ancestorModuleIds(caller.typeId)) {
      out.add(id);
    }
    out.add(caller.typeId);
    if (caller.bucketId !== null) out.add(caller.bucketId);
  }
  return [...out];
}

export function targetExpansionIdsForArrowTarget(
  arrow: Arrow,
  calls: FunctionCallIndex,
): string[] {
  return endpointExpansionIds(arrow, 'target', calls);
}

export function sourceExpansionIdsForArrowSource(
  arrow: Arrow,
  calls: FunctionCallIndex,
): string[] {
  return endpointExpansionIds(arrow, 'source', calls);
}

function endpointExpansionIds(
  arrow: Arrow,
  endpoint: 'source' | 'target',
  calls: FunctionCallIndex,
): string[] {
  // Whichever endpoint the user is navigating to must be visible after a
  // redraw: expand ancestor modules, the containing type, and (for call
  // arrows) the method bucket that owns the row. Otherwise the freshly
  // built layout still hides the row and the viewport pans to nowhere.
  const typeId = endpoint === 'target' ? arrow.toTypeId : arrow.fromTypeId;
  const rowName = endpoint === 'target' ? arrow.toFieldName : arrow.fromFieldName;
  const rowKind = endpoint === 'target' ? arrow.toRowKind : arrow.fromRowKind;
  const out = new Set<string>();
  for (const id of ancestorModuleIds(typeId)) {
    out.add(id);
  }
  out.add(typeId);

  if (rowName !== undefined && rowName !== '' && rowKind !== undefined) {
    const row = calls.rowsByType
      .get(typeId)
      ?.find((candidate) => candidate.rowName === rowName && candidate.rowKind === rowKind);
    const bucketId = row?.bucketId;
    if (bucketId !== null && bucketId !== undefined) out.add(bucketId);
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
/**
 * Module ids on the path from the crate root to (but not including) the
 * type itself. The crate is derived from the type's full path — the first
 * `::`-separated segment — so the same helper works across all crates in
 * a workspace.
 *
 * For `my-crate::a::b::Foo` returns
 *   ['my-crate', 'my-crate::a', 'my-crate::a::b'].
 *
 * Returns [] for a single-segment fullPath (no crate prefix).
 */
export function ancestorModuleIds(typeFullPath: string): string[] {
  const segments = typeFullPath.split('::');
  if (segments.length < 2) return [];
  const crateName = segments[0] ?? '';
  const ids = [crateName];
  let path = '';
  for (let i = 1; i < segments.length - 1; i++) {
    const seg = segments[i] ?? '';
    path = path === '' ? seg : `${path}::${seg}`;
    ids.push(`${crateName}::${path}`);
  }
  return ids;
}
