// Routing strategy boundary. Geometry and obstacles are already computed when
// this module is called; the selected router only owns arrow paths.

import type { LayoutInputs } from '../analysis/layout_model.ts';
import type { Geometry } from './geometry.ts';
import type { ObstacleMap } from './obstacles.ts';
import { type RoutingResult, routeArrowsDogleg } from './routing_dogleg.ts';
import { routeArrowsGrid } from './routing_grid.ts';

export type { RoutingResult } from './routing_dogleg.ts';

export type RoutingAlgorithm = 'dogleg' | 'grid';

export interface RoutingOptions {
  readonly algorithm?: RoutingAlgorithm;
}

export function routeArrows(
  geometry: Geometry,
  obstacles: ObstacleMap,
  inputs: LayoutInputs,
  measure: (s: string) => number,
  options: RoutingOptions = {},
): RoutingResult {
  // Keep strategy selection centralized in the layout phase so rendering and
  // event handlers never need to know which routing implementation produced
  // the renderer-facing Arrow payload.
  if (options.algorithm === 'grid') {
    return routeArrowsGrid(geometry, obstacles, inputs, measure);
  }
  return routeArrowsDogleg(geometry, obstacles, inputs, measure);
}
