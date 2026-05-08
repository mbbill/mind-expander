import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeDrift } from '../src/analysis/drift.ts';
import type { LayoutInputs } from '../src/analysis/layout_model.ts';
import { type TreeNode, buildModuleTree } from '../src/analysis/module_tree.ts';
import { buildOwnershipIndex, computeOwnershipDepth } from '../src/analysis/ownership.ts';
import { canonicalize } from '../src/data/canonicalize.ts';
import type { Facts } from '../src/data/schema.ts';
import { TYPE_X_GAP, computeGeometry } from '../src/layout/geometry.ts';
import { ViewState } from '../src/state/view_state.ts';

function collectTypeIds(root: TreeNode): string[] {
  const out: string[] = [];
  const walk = (node: TreeNode): void => {
    if (node.kind === 'type') {
      out.push(node.fullPath);
      return;
    }
    for (const child of node.children) walk(child);
  };
  walk(root);
  return out;
}

function collectTypeModule(root: TreeNode): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (node: TreeNode): void => {
    if (node.kind === 'type') {
      out.set(node.fullPath, node.modulePath);
      return;
    }
    for (const child of node.children) walk(child);
  };
  walk(root);
  return out;
}

function sfNanoCoreInputs(expandedIds: readonly string[]): LayoutInputs {
  const raw = JSON.parse(readFileSync('./data/facts.json', 'utf8')) as Facts;
  const facts = canonicalize(raw);
  const crate = facts.crates['sf-nano-core'];
  if (crate === undefined) {
    throw new Error('sf-nano-core facts missing from test data.');
  }

  const staticRoot = buildModuleTree(crate);
  const ownership = buildOwnershipIndex(facts, 'sf-nano-core');
  const typeModule = collectTypeModule(staticRoot);
  const drift = computeDrift(ownership, typeModule);
  const depth = computeOwnershipDepth(ownership, collectTypeIds(staticRoot), drift);

  return {
    staticRoot,
    ownership,
    depth,
    drift,
    state: new ViewState(expandedIds),
  };
}

describe('layout ownership-DAG placement — sf-nano-core regression', () => {
  it('places ValueType to the right of visible owners from earlier rank order', () => {
    const inputs = sfNanoCoreInputs([
      'sf-nano-core',
      'sf-nano-core::module',
      'sf-nano-core::module::type_defs',
      'sf-nano-core::value_type',
    ]);
    const geometry = computeGeometry(inputs);
    const owner = geometry.typesById.get('sf-nano-core::module::type_defs::StorageType');
    const valueType = geometry.typesById.get('sf-nano-core::value_type::ValueType');

    expect(owner).toBeDefined();
    expect(valueType).toBeDefined();
    expect(owner?.depth).toBeLessThan(valueType?.depth ?? Number.NEGATIVE_INFINITY);
    expect(valueType?.x ?? 0).toBeGreaterThanOrEqual((owner?.x ?? 0) + (owner?.width ?? 0));
  });

  it('keeps a single-owner target near its visible owner instead of after unrelated ranks', () => {
    const inputs = sfNanoCoreInputs([
      'sf-nano-core',
      'sf-nano-core::vm',
      'sf-nano-core::vm::entities',
    ]);
    const geometry = computeGeometry(inputs);
    const owner = geometry.typesById.get('sf-nano-core::vm::entities::GlobalInst');
    const target = geometry.typesById.get('sf-nano-core::vm::entities::GlobalCell');

    expect(owner).toBeDefined();
    expect(target).toBeDefined();
    expect(owner?.depth).toBeLessThan(target?.depth ?? Number.NEGATIVE_INFINITY);
    expect(target?.x ?? 0).toBeGreaterThanOrEqual((owner?.x ?? 0) + (owner?.width ?? 0));
    expect((target?.x ?? 0) - ((owner?.x ?? 0) + (owner?.width ?? 0))).toBeLessThanOrEqual(
      TYPE_X_GAP * 2,
    );
  });
});
