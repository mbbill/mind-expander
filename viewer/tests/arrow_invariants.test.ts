// Layout invariants: every arrow's polyline must obey active-router
// direction and obstacle-clearance rules regardless of the input crate. Run
// against the live sf-nano-core data at "everything expanded" so we exercise
// the densest arrow set we realistically render.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeDrift } from '../src/analysis/drift.ts';
import type { Arrow, ArrowWaypoint, LayoutInputs } from '../src/analysis/layout_model.ts';
import { type TreeNode, buildModuleTree } from '../src/analysis/module_tree.ts';
import { buildOwnershipIndex, computeOwnershipDepth } from '../src/analysis/ownership.ts';
import { canonicalize } from '../src/data/canonicalize.ts';
import type { Facts } from '../src/data/schema.ts';
import { computeGeometry } from '../src/layout/geometry.ts';
import { type ObstacleMap, computeObstacles } from '../src/layout/obstacles.ts';
import { type RoutingResult, routeArrows } from '../src/layout/routing.ts';
import type { Obstacle } from '../src/layout/types.ts';
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
      // actually reveals method rows while preserving the app's opt-in
      // method-arrow contract below.
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
  readonly kind: 'final-backward';
  readonly arrow: string; // human-readable description
}

interface SegmentObstacleViolation {
  readonly arrow: string;
  readonly segment: string;
  readonly obstacle: string;
  readonly fallback: boolean;
}

interface RoutedLayoutPass {
  readonly obstacles: ObstacleMap;
  readonly routing: RoutingResult;
}

function findViolations(arrows: readonly Arrow[]): Violation[] {
  const out: Violation[] = [];
  for (const a of arrows) {
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

    // Layout picks forward vs reverse source side from physical endpoint
    // positions, so even canonical ownership may leave leftward. The stable
    // direction invariant is that target entry still comes from the left.
  }
  return out;
}

function routeFinalLayoutPass(inputs: LayoutInputs): RoutedLayoutPass {
  const measure = inputs.measureText ?? ((s: string) => s.length * 7);
  const firstGeometry = computeGeometry(inputs);
  const firstObstacles = computeObstacles(firstGeometry, measure);
  const firstRouting = routeArrows(firstGeometry, firstObstacles, inputs, measure);
  if (firstRouting.routingPressure.length === 0) {
    return { obstacles: firstObstacles, routing: firstRouting };
  }

  // Match buildLayout's bounded routing-feedback contract so this
  // invariant checks the same final arrows the app renders, while retaining
  // obstacle type ids that Layout.debug.routing intentionally omits.
  const geometry = computeGeometry(inputs, { routingExtraGaps: firstRouting.routingPressure });
  const obstacles = computeObstacles(geometry, measure);
  const routing = routeArrows(geometry, obstacles, inputs, measure);
  return { obstacles, routing };
}

function findObstacleViolations(
  arrows: readonly Arrow[],
  obstacles: readonly Obstacle[],
  blockedLaneSignatures: ReadonlySet<string>,
): SegmentObstacleViolation[] {
  const out: SegmentObstacleViolation[] = [];
  for (const arrow of arrows) {
    const fallback = arrowHasBlockedLane(arrow, blockedLaneSignatures);
    for (let index = 1; index < arrow.waypoints.length; index++) {
      const from = arrow.waypoints[index - 1];
      const to = arrow.waypoints[index];
      if (from === undefined || to === undefined) {
        continue;
      }
      if (from.x !== to.x && from.y !== to.y) {
        out.push({
          arrow: describeArrow(arrow),
          segment: `${index - 1}: non-orthogonal (${point(from)} -> ${point(to)})`,
          obstacle: 'n/a',
          fallback,
        });
        continue;
      }
      if (from.x === to.x && from.y === to.y) {
        continue;
      }
      for (const obstacle of obstacles) {
        if (obstacle.typeId === arrow.fromTypeId || obstacle.typeId === arrow.toTypeId) {
          continue;
        }
        if (segmentIntersectsObstacle(from, to, obstacle)) {
          out.push({
            arrow: describeArrow(arrow),
            segment: `${index - 1}: ${point(from)} -> ${point(to)}`,
            obstacle: describeObstacle(obstacle),
            fallback,
          });
        }
      }
    }
  }
  return out;
}

function blockedLaneSignatures(routing: RoutingResult): ReadonlySet<string> {
  const out = new Set<string>();
  for (const lane of routing.debug.routing.lanes) {
    if (!lane.blocked) continue;
    out.add(laneSignature(lane.fromTypeId, lane.toTypeId, lane.x, lane.yMin, lane.yMax));
  }
  return out;
}

function arrowHasBlockedLane(arrow: Arrow, blockedLaneSignatures: ReadonlySet<string>): boolean {
  for (let index = 1; index < arrow.waypoints.length; index++) {
    const from = arrow.waypoints[index - 1];
    const to = arrow.waypoints[index];
    if (from === undefined || to === undefined || from.x !== to.x || from.y === to.y) {
      continue;
    }
    const signature = laneSignature(
      arrow.fromTypeId,
      arrow.toTypeId,
      from.x,
      Math.min(from.y, to.y),
      Math.max(from.y, to.y),
    );
    if (blockedLaneSignatures.has(signature)) {
      return true;
    }
  }
  return false;
}

function laneSignature(
  fromTypeId: string,
  toTypeId: string,
  x: number,
  yMin: number,
  yMax: number,
): string {
  return `${fromTypeId}\x1F${toTypeId}\x1F${x}\x1F${yMin}\x1F${yMax}`;
}

function segmentIntersectsObstacle(from: ArrowWaypoint, to: ArrowWaypoint, obstacle: Obstacle) {
  const left = obstacle.x;
  const right = obstacle.x + obstacle.width;
  const top = obstacle.y;
  const bottom = obstacle.y + obstacle.height;

  if (from.x === to.x) {
    return (
      from.x >= left &&
      from.x <= right &&
      rangesOverlap(Math.min(from.y, to.y), Math.max(from.y, to.y), top, bottom)
    );
  }

  return (
    from.y >= top &&
    from.y <= bottom &&
    rangesOverlap(Math.min(from.x, to.x), Math.max(from.x, to.x), left, right)
  );
}

function rangesOverlap(aMin: number, aMax: number, bMin: number, bMax: number): boolean {
  return aMin < bMax && bMin < aMax;
}

function describeArrow(a: Arrow): string {
  return `${a.kind} ${a.fromTypeId}.${a.fromFieldName || '<header>'} -> ${a.toTypeId}`;
}

function describeObstacle(obstacle: Obstacle): string {
  return `${obstacle.kind} ${obstacle.typeId}#${obstacle.fragmentId} rect=(${obstacle.x},${obstacle.y},${obstacle.width},${obstacle.height})`;
}

function point(p: ArrowWaypoint): string {
  return `(${p.x},${p.y})`;
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
  const inputs: LayoutInputs = {
    staticRoot: root,
    ownership,
    depth,
    drift,
    state: new ViewState(allIds),
    // Match the active app wiring: full expansion controls row visibility,
    // while method and ghost arrows are opt-in overlays. Leaving these
    // undefined would enable every such arrow and test a stale, non-UI state.
    methodArrowsShown: new Set<string>(),
    ghostArrowsShown: new Set<string>(),
  };

  it('allocated router produces no backward arrow segments when everything is expanded', () => {
    const { routing } = routeFinalLayoutPass(inputs);
    const violations = findViolations(routing.arrows);
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

  it('routes every non-fallback segment around non-endpoint obstacles when everything is expanded', () => {
    const { obstacles, routing } = routeFinalLayoutPass(inputs);
    const violations = findObstacleViolations(
      routing.arrows,
      obstacles.all,
      blockedLaneSignatures(routing),
    );
    const unexpected = violations.filter((v) => !v.fallback);
    if (unexpected.length > 0) {
      const fallbackCount = violations.length - unexpected.length;
      const sample = unexpected
        .slice(0, 8)
        .map((v) => `  ${v.arrow}\n    segment ${v.segment}\n    obstacle ${v.obstacle}`);
      const tail = unexpected.length > 8 ? `\n  ... and ${unexpected.length - 8} more` : '';
      const blocked =
        fallbackCount > 0
          ? `\n${fallbackCount} crossing(s) were explicitly marked as blocked fallback routes.`
          : '';
      throw new Error(
        `${unexpected.length} non-fallback arrow obstacle violation(s):\n${sample.join('\n')}${tail}${blocked}`,
      );
    }
    // The real fully-expanded crate can still produce router-declared
    // fallback lanes. This assertion keeps those explicit: ordinary routes
    // must clear obstacles, and any crossing without fallback metadata fails.
    expect(unexpected).toEqual([]);
  });
});
