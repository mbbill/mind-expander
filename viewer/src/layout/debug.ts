// Debug overlay primitives produced by the layout pipeline. The renderer
// reads this when the "layout debug" toggle is on and draws the rects /
// lines / labels at the right z-order.

import type { Gutter, LaneSlot, Obstacle } from './types.ts';

export interface LayoutDebugSnapshot {
  readonly obstacles: readonly Obstacle[];
  readonly gutters: readonly Gutter[];
  /** Allocated lanes, one entry per used slot per gutter. */
  readonly lanes: readonly LaneSlot[];
  /** Per-edge annotations: arrow id → slot label, for callouts in the
   *  overlay. Optional — emitted only when verbose debug is on. */
  readonly arrowSlots?: ReadonlyMap<string, number>;
}

export function emptyDebug(): LayoutDebugSnapshot {
  return { obstacles: [], gutters: [], lanes: [] };
}
