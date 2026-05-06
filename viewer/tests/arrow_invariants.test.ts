// Layout invariants: every arrow's polyline must obey direction rules
// regardless of the input crate. Run against the live sf-nano-core data
// at "everything expanded" so we exercise the densest arrow set we
// realistically render. Any backward final segment, leftward canonical
// first segment, etc. is a routing or depth-assignment bug.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeDrift } from '../src/analysis/drift.ts';
import { type Layout, buildOptimizedLayout } from '../src/analysis/layout.ts';
import { type TreeNode, buildModuleTree } from '../src/analysis/module_tree.ts';
import { buildOwnershipIndex, computeOwnershipDepth } from '../src/analysis/ownership.ts';
import { canonicalize } from '../src/data/canonicalize.ts';
import type { Facts } from '../src/data/schema.ts';
import { ViewState } from '../src/state/view_state.ts';

function collectAllIds(root: TreeNode): { all: string[]; types: string[] } {
  const all: string[] = [];
  const types: string[] = [];
  const walk = (n: TreeNode): void => {
    if (n.kind === 'type') {
      all.push(n.fullPath);
      types.push(n.fullPath);
      // Method-bucket ids are synthesised by the layout but live in the
      // same expansion set as types/modules. Surface them here so the
      // "everything expanded" universe used by this invariant test
      // actually reveals method rows (and therefore exercises the
      // arrows method rows produce).
      for (const mb of n.methodBuckets) {
        all.push(`${n.fullPath}::__methods_${mb.bucket}`);
      }
    } else {
      all.push(n.id);
      for (const c of n.children) walk(c);
    }
  };
  walk(root);
  return { all, types };
}

function collectTypeModule(root: TreeNode): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (n: TreeNode): void => {
    if (n.kind === 'type') out.set(n.fullPath, n.modulePath);
    else for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
}

interface Violation {
  readonly kind: 'final-backward' | 'canonical-first-backward';
  readonly arrow: string; // human-readable description
}

function findViolations(layout: Layout): Violation[] {
  const out: Violation[] = [];
  for (const a of layout.arrows) {
    // Method arrows aren't structural ownership and don't follow LCA
    // placement — source/target columns can land in any order. The
    // layout already routes them via canonical lanes when they go
    // forward and via the drift channel when they go backward, so
    // they're internally consistent, just not subject to this rule.
    if (a.kind === 'method') continue;
    // Re-export arrows aren't subject to ownership direction discipline:
    // a `pub use` can sit either to the left or right of the canonical
    // definition (e.g. a crate-root re-export of a deep module item lives
    // in the same column as the target). They have their own routing
    // (forward vs drift channel chosen by relative x) and the renderer
    // styles them violet/dashed so they read as a different category.
    if (a.kind === 'reexport') continue;
    const w = a.waypoints;
    if (w.length < 2) continue;
    const last = w[w.length - 1];
    const beforeLast = w[w.length - 2];
    if (!last || !beforeLast) continue;

    const desc = `${a.fromTypeId}.${a.fromFieldName} → ${a.toTypeId} [${a.driftClass}]`;

    // Final segment must enter the target rightward — true for both
    // canonical (lane between source/target → into target's left edge)
    // and drift (lane left of target → into target's left edge from
    // outside). A backward final segment indicates either misrouted
    // lanes or that owner/owned ended up at the same column.
    if (last.x < beforeLast.x) {
      out.push({ kind: 'final-backward', arrow: desc });
    }

    // Canonical arrows must also leave their source rightward; drift
    // arrows are explicitly leftward at the source side.
    const isCanonical = a.driftClass === 'at_lca' || a.driftClass === 'within_budget';
    if (isCanonical && w.length >= 2) {
      const first = w[0];
      const second = w[1];
      if (first && second && second.x < first.x) {
        out.push({ kind: 'canonical-first-backward', arrow: desc });
      }
    }
  }
  return out;
}

describe('arrow direction invariants — sf-nano-core crate', () => {
  // Loaded once and reused across the cases below; parsing the 4MB facts
  // file repeatedly is wasteful.
  const raw = JSON.parse(readFileSync('./data/facts.json', 'utf8')) as Facts;
  const facts = canonicalize(raw);
  const crate = facts.crates['sf-nano-core'];
  if (!crate) throw new Error('no sf-nano-core in facts.json');

  const root = buildModuleTree(crate);
  const ownership = buildOwnershipIndex(facts, 'sf-nano-core');
  const typeModule = collectTypeModule(root);
  const { all: allIds, types: allTypeIds } = collectAllIds(root);
  const drift = computeDrift(ownership, typeModule);
  const depth = computeOwnershipDepth(ownership, allTypeIds, drift);

  it('produces no backward arrow segments when everything is expanded', () => {
    const layout = buildOptimizedLayout({
      staticRoot: root,
      ownership,
      depth,
      drift,
      state: new ViewState(allIds),
    });
    const violations = findViolations(layout);
    if (violations.length > 0) {
      // First few are usually enough to diagnose — print them in the
      // assertion message so a CI failure points at the real culprit.
      const sample = violations.slice(0, 8).map((v) => `  ${v.kind}: ${v.arrow}`);
      const tail = violations.length > 8 ? `\n  ... and ${violations.length - 8} more` : '';
      throw new Error(
        `${violations.length} arrow direction violation(s):\n${sample.join('\n')}${tail}`,
      );
    }
    expect(violations).toEqual([]);
  });
});
