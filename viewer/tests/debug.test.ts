// Debug helper. Not part of the normal test suite — `describe.skip` keeps it
// silent during `npm test`. Run explicitly to trace the layout pipeline:
//   npx vitest run tests/debug.test.ts --reporter=verbose
// Inside this file, change `describe.skip` to `describe` to enable.

import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { computeDrift } from '../src/analysis/drift.ts';
import { type Layout, buildLayout, buildOptimizedLayout } from '../src/analysis/layout.ts';
import { type TreeNode, buildModuleTree } from '../src/analysis/module_tree.ts';
import {
  type OwnershipIndex,
  buildOwnershipIndex,
  computeOwnershipDepth,
} from '../src/analysis/ownership.ts';
import { canonicalize } from '../src/data/canonicalize.ts';
import type { Facts } from '../src/data/schema.ts';
import { ViewState } from '../src/state/view_state.ts';

describe('debug layout pipeline', () => {
  it('traces sf-nano-core Module-band ordering', () => {
    const raw = JSON.parse(readFileSync('./data/facts.json', 'utf8')) as Facts;
    const facts = canonicalize(raw);
    const crate = facts.crates['sf-nano-core'];
    if (!crate) throw new Error('no sf-nano-core in facts.json');

    const root = buildModuleTree(crate);
    const ownership = buildOwnershipIndex(facts, 'sf-nano-core');
    const allTypeIds = collectIds(root);
    const typeModule = collectTypeModule(root);
    const drift = computeDrift(ownership, typeModule);
    const depth = computeOwnershipDepth(ownership, allTypeIds, drift);

    // Match the live default state: crate root + module + entities + Module type.
    const expandedIds = [
      'sf-nano-core',
      'sf-nano-core::module',
      'sf-nano-core::module::entities',
      'sf-nano-core::module::Module',
    ];

    // First: naive layout for the same expansion.
    const naive = buildLayout({
      staticRoot: root,
      ownership,
      depth,
      drift,
      state: new ViewState(expandedIds),
    });
    print('NAIVE', naive, ownership);

    // Replicate barycenterKeys to inspect what it produces from the naive layout.
    const sortKey = inspectBarycenter(naive, ownership);
    console.log('\n=== BARYCENTER SORT KEYS (incoming, from naive) ===');
    const entityNames = ['Data', 'Element', 'Function', 'Global', 'Memory', 'Table', 'Tag'];
    for (const t of naive.types) {
      if (entityNames.includes(t.label)) {
        console.log(`  ${t.label.padEnd(10)} key=${(sortKey.get(t.fullPath) ?? -1).toFixed(1)}`);
      }
    }

    // Now drive a single buildLayout call with the sortKey directly, bypassing
    // buildOptimizedLayout to see if sortKey reaches packBand.
    const oneShot = buildLayout({
      staticRoot: root,
      ownership,
      depth,
      drift,
      state: new ViewState(expandedIds),
      sortKey,
    });
    print('ONE-SHOT (sortKey applied to naive)', oneShot, ownership);

    // Then: optimized layout.
    const opt = buildOptimizedLayout({
      staticRoot: root,
      ownership,
      depth,
      drift,
      state: new ViewState(expandedIds),
    });
    print('OPTIMIZED', opt, ownership);
  });
});

function collectTypeModule(root: TreeNode): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (n: TreeNode): void => {
    if (n.kind === 'type') out.set(n.fullPath, n.modulePath);
    else for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
}

function inspectBarycenter(layout: Layout, ownership: OwnershipIndex): Map<string, number> {
  const typeByPath = new Map<string, Layout['types'][number]>();
  for (const t of layout.types) typeByPath.set(t.fullPath, t);
  const keys = new Map<string, number>();
  for (const t of layout.types) {
    const ys: number[] = [];
    for (const ownerId of ownership.ownedBy.get(t.fullPath) ?? []) {
      const owner = typeByPath.get(ownerId);
      if (!owner) continue;
      let pushed = false;
      if (owner.expanded) {
        for (const f of owner.fields) {
          if (f.targets.includes(t.fullPath)) {
            ys.push(f.y);
            pushed = true;
          }
        }
      }
      if (!pushed) ys.push(owner.y);
    }
    if (ys.length > 0) keys.set(t.fullPath, ys.reduce((a, b) => a + b, 0) / ys.length);
    else keys.set(t.fullPath, t.y);
  }
  return keys;
}

function collectIds(root: ReturnType<typeof buildModuleTree>): string[] {
  const out: string[] = [];
  type N = { kind: string; fullPath?: string; children?: readonly N[] };
  const walk = (n: N): void => {
    if (n.kind === 'type' && n.fullPath) out.push(n.fullPath);
    else for (const c of n.children ?? []) walk(c);
  };
  walk(root as never);
  return out;
}

function print(
  label: string,
  layout: ReturnType<typeof buildLayout>,
  ownership: OwnershipIndex,
): void {
  console.log(`\n=== ${label} ===`);
  // Print Module's expanded fields and their absolute y.
  const moduleType = layout.types.find((t) => t.label === 'Module');
  if (moduleType?.expanded) {
    console.log('\nModule fields (in struct order):');
    for (const f of moduleType.fields) {
      console.log(
        `  ${f.name.padEnd(20)} y=${f.y.toFixed(0).padStart(5)}  targets=${[...f.targets].join(', ')}`,
      );
    }
  }
  // Print entities at depth 1 in entities band, in y-order.
  const entityNames = ['Data', 'Element', 'Function', 'Global', 'Memory', 'Table', 'Tag'];
  const entities = layout.types
    .filter((t) => entityNames.includes(t.label))
    .sort((a, b) => a.y - b.y);
  console.log('\nEntities band (in y-order):');
  for (const t of entities) {
    const owners = [...(ownership.ownedBy.get(t.fullPath) ?? [])];
    console.log(
      `  ${t.label.padEnd(10)} y=${t.y.toFixed(0).padStart(5)} x=${t.x.toFixed(0).padStart(5)}  owners=${owners.join(', ')}`,
    );
  }
  // Print arrows that touch entities, with source/target y.
  const arrows = layout.arrows.filter(
    (a) =>
      entityNames.some((e) => a.toTypeId.endsWith(`::${e}`)) ||
      entityNames.some((e) => a.fromTypeId.endsWith(`::${e}`)),
  );
  console.log('\nArrows touching entities:');
  for (const a of arrows) {
    console.log(
      `  ${shortName(a.fromTypeId).padEnd(20)} → ${shortName(a.toTypeId).padEnd(20)}  ${a.waypoints.map((w) => `(${w.x.toFixed(0)},${w.y.toFixed(0)})`).join(' → ')}`,
    );
  }
}

function shortName(fullPath: string): string {
  const parts = fullPath.split('::');
  return parts[parts.length - 1] ?? fullPath;
}
