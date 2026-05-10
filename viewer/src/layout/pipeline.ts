// layout orchestrator. Pure function: same inputs → same output. The
// output type matches the renderer-facing `Layout` model so
// the renderer doesn't need to know which implementation produced it.
//
//   inputs → geometry → obstacles → simple routing → Layout
//
// Each pass is implemented in its own module and tested independently.

import type {
  FieldRow,
  Layout,
  LayoutInputs,
  ModuleRow,
  TypeBox,
} from '../analysis/layout_model.ts';
import { type Geometry, computeGeometry } from './geometry.ts';
import { computeObstacles } from './obstacles.ts';
import { type PlacementLayoutPlan, buildPlacementLayoutPlan } from './placement_plan.ts';
import { type RoutingResult, routeArrows } from './routing.ts';
import type { PositionedType } from './types.ts';

export interface LayoutBuildInputs extends LayoutInputs {
  readonly placementPlan?: PlacementLayoutPlan;
}

export function buildLayout(inputs: LayoutBuildInputs): Layout {
  const measure = inputs.measureText ?? ((s: string) => s.length * 7);
  const placementPlan =
    inputs.placementPlan ??
    buildPlacementLayoutPlan(inputs.staticRoot, inputs.depth, inputs.ownership);
  return toLayout(...runLayoutPass(inputs, measure, placementPlan));
}

function runLayoutPass(
  inputs: LayoutBuildInputs,
  measure: (s: string) => number,
  placementPlan: PlacementLayoutPlan,
): readonly [Geometry, RoutingResult] {
  const geometry = computeGeometry(inputs, { placementPlan });
  const obstacles = computeObstacles(geometry, measure);
  const routing = routeArrows(geometry, obstacles, inputs, measure);

  return [geometry, routing];
}

function toLayout(geometry: Geometry, routing: RoutingResult): Layout {
  return {
    modules: toModuleRows(geometry),
    types: toTypeBoxes(geometry),
    arrows: routing.arrows,
    totalHeight: geometry.totalHeight,
    totalWidth: geometry.totalWidth,
    debug: routing.debug,
  };
}

function toModuleRows(geometry: Geometry): ModuleRow[] {
  return geometry.modules.map(
    (m): ModuleRow => ({
      id: m.node.id,
      label: m.node.label,
      modDepth: m.modDepth,
      labelX: m.labelX,
      hitWidth: m.hitWidth,
      y: m.y,
      bandHeight: m.bandHeight,
      expanded: m.expanded,
      hasChildren: m.hasChildren,
      prefixSegments: m.prefixSegments,
      leafBg: m.leafBg,
    }),
  );
}

function toTypeBoxes(geometry: Geometry): TypeBox[] {
  return geometry.types.map(
    (t): TypeBox => ({
      id: t.node.id,
      label: t.node.label,
      typeKind: t.node.typeKind,
      visibility: t.node.visibility,
      fullPath: t.node.fullPath,
      modulePath: t.node.modulePath,
      // `col` is metadata for the renderer; layout reports ownership rank here
      // (function-groups use the prelude marker). The renderer
      // doesn't drive layout from this, only encoding.
      col: t.depth,
      x: t.x,
      y: t.y,
      width: t.width,
      headerArrowX: t.headerArrowX,
      headerHitWidth: t.headerHitWidth,
      height: t.height,
      hasFields:
        t.node.fields.length > 0 || t.node.functions.length > 0 || t.node.methodBuckets.length > 0,
      expanded: t.expanded,
      fields: buildFieldRows(t),
      totalFieldCount: t.node.fields.length + t.node.functions.length,
      isGhost: t.node.isGhost ?? false,
      ghostTarget: t.node.ghostTarget ?? null,
    }),
  );
}

function buildFieldRows(t: PositionedType): FieldRow[] {
  if (!t.expanded) return [];
  return t.visibleRows.map(
    (r): FieldRow => ({
      ...r,
      memberDriftClass: r.memberDriftClass ?? null,
    }),
  );
}
