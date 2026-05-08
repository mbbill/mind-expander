// Obstacle model: adapt geometry's physical placed fragments into the router's
// obstacle contract.
//
// Geometry owns pixel-space placement. This pass deliberately does not
// re-measure rows or rebuild protrusion thresholds; the debug overlay and
// router must see the exact fragment rectangles emitted by geometry.

import type { Geometry } from './geometry.ts';
import type { Obstacle, PlacedFragmentRect } from './types.ts';

export interface ObstacleMap {
  readonly all: readonly Obstacle[];
  /** Legacy primary block indexed by type id. Multi-fragment types can have
   *  more blocks in `blocksByType`; the first block preserves old endpoint
   *  lookup semantics for callers that ask for one block by type id. */
  readonly blockByType: ReadonlyMap<string, Obstacle>;
  /** Exact block fragments indexed by type id. */
  readonly blocksByType: ReadonlyMap<string, readonly Obstacle[]>;
  /** Split-row obstacles for a type. Empty for types with no split rows. */
  readonly protrusionsByType: ReadonlyMap<string, readonly Obstacle[]>;
}

export function computeObstacles(
  geometry: Geometry,
  _measure?: (s: string) => number,
): ObstacleMap {
  const all = geometry.placedFragments.map(obstacleForFragment);
  const blockByType = new Map<string, Obstacle>();
  const blockBuckets = new Map<string, Obstacle[]>();
  const protrusionBuckets = new Map<string, Obstacle[]>();

  for (const obstacle of all) {
    if (obstacle.kind === 'block') {
      if (!blockByType.has(obstacle.typeId)) {
        blockByType.set(obstacle.typeId, obstacle);
      }
      appendObstacle(blockBuckets, obstacle);
    } else {
      appendObstacle(protrusionBuckets, obstacle);
    }
  }

  return {
    all,
    blockByType,
    blocksByType: blockBuckets,
    protrusionsByType: protrusionBuckets,
  };
}

function obstacleForFragment(fragment: PlacedFragmentRect): Obstacle {
  return {
    // Split rows are isolated physical fragments so the router can treat
    // their extra width as a protrusion without inventing approximate row
    // rectangles outside the placement model.
    kind: fragment.fragmentKind === 'split-row' ? 'protrusion' : 'block',
    typeId: fragment.typeId,
    fragmentId: fragment.fragmentId,
    fragmentIndex: fragment.fragmentIndex,
    fragmentKind: fragment.fragmentKind,
    rowIds: fragment.rowIds,
    x: fragment.x,
    y: fragment.y,
    width: fragment.width,
    height: fragment.height,
  };
}

function appendObstacle(bucket: Map<string, Obstacle[]>, obstacle: Obstacle): void {
  const existing = bucket.get(obstacle.typeId);
  if (existing === undefined) {
    bucket.set(obstacle.typeId, [obstacle]);
    return;
  }
  existing.push(obstacle);
}
