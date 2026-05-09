import type { DriftIndex } from '../analysis/drift.ts';
import type { OwnershipIndex } from '../analysis/ownership.ts';
import { classifyOwnershipRouteByDepth } from '../layout/routing_class.ts';

export interface MemberArrowRow {
  readonly rowName: string;
  readonly rowKind: 'field' | 'method';
}

// The type-click affordance may reveal extra target modules, but only for
// ownership arrows that the layout will route through the forward-LCA corridor.
// This uses routing class strictly as visibility policy; drift remains the
// color/semantic classification.
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
      if (classifyOwnershipRouteByDepth(sourceDepth, targetDepth, driftClass) !== 'lca-forward') {
        continue;
      }
      for (const id of ancestorModuleIds(targetFullPath, crateName)) {
        out.add(id);
      }
    }
  }
  return [...out];
}

export function targetModulesForMemberRow(
  typeId: string,
  rowName: string,
  rowKind: 'field' | 'method',
  ownership: OwnershipIndex,
  crateName: string,
): string[] {
  const targets =
    rowKind === 'method'
      ? ownership.methodTargets.get(typeId)?.get(rowName)
      : ownership.fieldTargets.get(typeId)?.get(rowName);
  if (targets === undefined) return [];

  const out = new Set<string>();
  for (const target of targets) {
    for (const id of ancestorModuleIds(target, crateName)) {
      out.add(id);
    }
  }
  return [...out];
}

export function memberArrowRowsForType(
  typeId: string,
  ownership: OwnershipIndex,
): readonly MemberArrowRow[] {
  const out: MemberArrowRow[] = [];
  for (const rowName of ownership.fieldTargets.get(typeId)?.keys() ?? []) {
    out.push({ rowName, rowKind: 'field' });
  }
  for (const rowName of ownership.methodTargets.get(typeId)?.keys() ?? []) {
    out.push({ rowName, rowKind: 'method' });
  }
  return out;
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
