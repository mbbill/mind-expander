// Internal types for the layout pipeline. The pipeline's final output is the
// renderer-facing `Layout` shape from analysis/layout_model.ts.

import type { FunctionCallRef, FunctionRowRef } from '../analysis/calls.ts';
import type { DriftClass } from '../analysis/drift.ts';
import type { LeafBgSegment, PrefixSegment } from '../analysis/layout_metrics.ts';
import type { ModuleNode, TypeNode } from '../analysis/module_tree.ts';
import type { Ownership } from '../data/schema.ts';
import type { LayoutBoxFragmentKind } from './box_fragments.ts';

/** Stable ordering metadata within an ownership-rank slot. Physical placement
 *  can spread one rank across multiple display groups, but it must consume this
 *  order instead of deriving a new one from local measurements or edge counts. */
export interface RankAssignment {
  /** Ownership DAG depth — primary rank ordering. */
  readonly depth: number;
  /** Stable secondary ordering within the depth: type_name asc,
   *  module_path asc, full_path asc. */
  readonly subrank: number;
  /** Global rank — position in the (depth, subrank, …) sorted list.
   *  Physical x/y is owned by the band-local placement pass. */
  readonly rank: number;
}

/** A laid-out type box: renderer-facing header + rows, with header center y.
 *  Physical routeable extents live in `PlacedFragmentRect` so the
 *  obstacle/debug model can stay tied to snapped placement fragments. */
export interface PositionedType {
  readonly node: TypeNode;
  /** Module band that owns this physical placement. Used by placement,
   *  obstacles, routing, and debug output as the explicit region id. */
  readonly bandId: string;
  /** Band-local placement group order. Extra placement gaps can address this
   *  coordinate without mutating box clearance. */
  readonly bandOrder: number;
  /** Stable order inside `bandOrder`, retained for diagnostics/tests. */
  readonly indexInBandOrder: number;
  readonly x: number;
  /** Header center y. */
  readonly y: number;
  /** Header width retained for the external TypeBox contract. Wider row
   *  fragments are carried separately as placed fragments. */
  readonly width: number;
  /** Renderer-facing header hit geometry. Layout owns this because it has
   *  the measured label width; the renderer must not force SVG layout on
   *  every click just to place the chevron/hit rect. */
  readonly headerArrowX: number | null;
  readonly headerHitWidth: number;
  /** Total visible height. Collapsed = ROW_H; expanded = ROW_H + visible
   *  rows × FIELD_ROW_H. */
  readonly height: number;
  readonly depth: number;
  readonly subrank: number;
  readonly rank: number;
  readonly expanded: boolean;
  /** Detail rows shown when this type is expanded. Empty when collapsed.
   *  Geometry owns row construction so dimensions, hit targets, routing
   *  sources, and rendered rows all use the same coordinates. */
  readonly visibleRows: readonly PositionedRow[];
}

export type PositionedRowKind = 'field' | 'method_bucket' | 'method' | 'function';

export interface PositionedRow {
  readonly name: string;
  readonly tyText: string;
  readonly ownership: Ownership;
  readonly x: number;
  readonly y: number;
  readonly arrowSourceX: number;
  readonly targets: readonly string[];
  readonly callTargets: readonly FunctionRowRef[];
  readonly callRefs: readonly FunctionCallRef[];
  readonly functionFullPath: string | null;
  readonly callsOutsideModule: boolean;
  readonly hasExternalCalls: boolean;
  readonly hasUnresolvedCalls: boolean;
  readonly hasOutgoingCalls: boolean;
  readonly kind: PositionedRowKind;
  readonly bucketId: string | null;
  readonly memberDriftClass?: DriftClass | null;
}

export interface PositionedModule {
  readonly node: ModuleNode;
  readonly y: number;
  readonly bandHeight: number;
  readonly modDepth: number;
  readonly labelX: number;
  readonly hitWidth: number;
  readonly hasChildren: boolean;
  readonly expanded: boolean;
  readonly prefixSegments: readonly PrefixSegment[];
  readonly leafBg: LeafBgSegment;
}

/** Pixel-space visual/routing rectangle for one fragment anchored at its
 *  snapped grid placement. Packing owns the snapped cells, but consumers here
 *  need the measured visible bounds so debug boxes, hit areas, and routing
 *  obstacles do not grow by a hidden trailing grid cell. */
export interface PlacedFragmentRect {
  readonly typeId: string;
  readonly bandId: string;
  /** Band-local placement group metadata. Routing pressure reads this from
   *  fragments because rows can protrude beyond the legacy header box while
   *  the logical pressure channel must still target the owning group order. */
  readonly bandOrder: number;
  readonly indexInBandOrder: number;
  readonly fragmentId: string;
  readonly fragmentIndex: number;
  readonly fragmentKind: LayoutBoxFragmentKind;
  readonly rowIds: readonly string[];
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Spatial obstacle the router must avoid. Obstacles are adapted directly from
 *  geometry's placed fragments; `kind` preserves the existing routing contract
 *  where split rows act as protrusions and main/body fragments act as blocks. */
export interface Obstacle {
  readonly kind: 'block' | 'protrusion';
  readonly typeId: string;
  readonly fragmentId: string;
  readonly fragmentIndex: number;
  readonly fragmentKind: LayoutBoxFragmentKind;
  readonly rowIds: readonly string[];
  /** Inclusive of x; rect extends from x to x + width. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Vertical strip between two adjacent type-column groups, in which arrows
 *  route their vertical leg. Lane allocation lives here. Phase 5. */
export interface Gutter {
  readonly leftX: number;
  readonly rightX: number;
  readonly centerX: number;
}

/** A single allocated lane within a gutter. Lane 0 is the centerline; ±1, ±2
 *  alternate outward. Phase 5. */
export interface LaneSlot {
  readonly gutterIndex: number;
  readonly slot: number;
  readonly x: number;
}

/** Side from which an arrow leaves its source / enters its target. Phase 5. */
export type ArrowSide = 'left' | 'right';
