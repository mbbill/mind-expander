import type { CallKind, CallResolution, Facts } from '../data/schema.ts';
import { type ModuleNode, type TreeNode, methodBucketId } from './module_tree.ts';

export type FunctionRowKind = 'function' | 'method';

export interface FunctionRowRef {
  readonly functionFullPath: string;
  readonly typeId: string;
  readonly rowName: string;
  readonly rowKind: FunctionRowKind;
  readonly moduleId: string;
  readonly bucketId: string | null;
}

export type FunctionCallLocality = 'same_module' | 'other_module' | 'unresolved';

export interface FunctionCallRef {
  readonly caller: string;
  readonly callee: string;
  readonly kind: CallKind;
  readonly resolution: CallResolution;
  readonly origin: string;
  readonly locality: FunctionCallLocality;
  readonly callerRow: FunctionRowRef;
  readonly calleeRow: FunctionRowRef | null;
}

export interface FunctionCallIndex {
  readonly rowByFunction: ReadonlyMap<string, FunctionRowRef>;
  readonly callTargetsByFunction: ReadonlyMap<string, readonly FunctionRowRef[]>;
  readonly callsByFunction: ReadonlyMap<string, readonly FunctionCallRef[]>;
  readonly incomingCallsByFunction: ReadonlyMap<string, readonly FunctionCallRef[]>;
  readonly nonLocalCallers: ReadonlySet<string>;
  readonly rowsByType: ReadonlyMap<string, readonly FunctionRowRef[]>;
}

export function buildFunctionCallIndex(
  facts: Facts,
  crateName: string,
  root: ModuleNode,
): FunctionCallIndex {
  const rowByFunction = new Map<string, FunctionRowRef>();
  const rowsByType = new Map<string, FunctionRowRef[]>();

  const addRow = (row: FunctionRowRef): void => {
    rowByFunction.set(row.functionFullPath, row);
    const rows = rowsByType.get(row.typeId) ?? [];
    rows.push(row);
    rowsByType.set(row.typeId, rows);
  };

  const walk = (node: TreeNode): void => {
    if (node.kind === 'module') {
      for (const child of node.children) walk(child);
      return;
    }

    if (node.typeKind === 'function_group') {
      for (const fn of node.functions) {
        addRow({
          functionFullPath: fn.fullPath,
          typeId: node.fullPath,
          rowName: fn.fn.name,
          rowKind: 'function',
          moduleId: moduleId(crateName, node.modulePath),
          bucketId: null,
        });
      }
      return;
    }

    for (const bucket of node.methodBuckets) {
      for (const method of bucket.methods) {
        addRow({
          functionFullPath: `${node.fullPath}::${method.name}`,
          typeId: node.fullPath,
          rowName: method.name,
          rowKind: 'method',
          moduleId: moduleId(crateName, node.modulePath),
          bucketId: methodBucketId(node.fullPath, bucket.bucket),
        });
      }
    }
  };
  walk(root);

  const callTargets = new Map<string, FunctionRowRef[]>();
  const callsByFunction = new Map<string, FunctionCallRef[]>();
  const incomingCallsByFunction = new Map<string, FunctionCallRef[]>();
  const nonLocal = new Set<string>();
  const inCrate = (path: string): boolean => path.startsWith(`${crateName}::`);

  for (const edge of facts.call_edges ?? []) {
    if (!inCrate(edge.caller)) continue;

    const callerRow = rowByFunction.get(edge.caller);
    if (callerRow === undefined) continue;

    const calleeRow = rowByFunction.get(edge.callee);
    const locality =
      calleeRow === undefined
        ? 'unresolved'
        : calleeRow.moduleId === callerRow.moduleId
          ? 'same_module'
          : 'other_module';
    if (locality !== 'same_module') {
      nonLocal.add(edge.caller);
    }

    const callRef: FunctionCallRef = {
      caller: edge.caller,
      callee: edge.callee,
      kind: edge.kind,
      resolution: edge.resolution,
      origin: edge.origin,
      locality,
      callerRow,
      calleeRow: calleeRow ?? null,
    };
    const calls = callsByFunction.get(edge.caller) ?? [];
    calls.push(callRef);
    callsByFunction.set(edge.caller, calls);

    if (calleeRow !== undefined) {
      const incoming = incomingCallsByFunction.get(edge.callee) ?? [];
      incoming.push(callRef);
      incomingCallsByFunction.set(edge.callee, incoming);

      const targets = callTargets.get(edge.caller) ?? [];
      if (!targets.some((target) => target.functionFullPath === calleeRow.functionFullPath)) {
        targets.push(calleeRow);
      }
      callTargets.set(edge.caller, targets);
    }
  }

  return {
    rowByFunction,
    callTargetsByFunction: callTargets,
    callsByFunction,
    incomingCallsByFunction,
    nonLocalCallers: nonLocal,
    rowsByType,
  };
}

export function targetModulesForFunction(
  functionFullPath: string,
  calls: FunctionCallIndex,
): string[] {
  const out = new Set<string>();
  for (const target of calls.callTargetsByFunction.get(functionFullPath) ?? []) {
    out.add(target.moduleId);
  }
  return [...out];
}

function moduleId(crateName: string, modulePath: string): string {
  return modulePath === '' ? crateName : `${crateName}::${modulePath}`;
}
