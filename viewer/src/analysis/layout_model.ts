import type { Ownership, TypeKind } from '../data/schema.ts';
import type { ViewState } from '../state/view_state.ts';
import type { DriftClass, DriftIndex } from './drift.ts';
import type { ModuleNode } from './module_tree.ts';
import type { OwnershipIndex } from './ownership.ts';

export { FIELD_ROW_H, INDENT_PX, LEFT_PAD, ROW_H, TOP_PAD } from './layout_metrics.ts';

export interface ModuleRow {
  readonly id: string;
  readonly label: string;
  readonly modDepth: number;
  readonly labelX: number;
  /** Row hit width is produced by layout so rendering can redraw without
   *  synchronously measuring SVG text on the click path. */
  readonly hitWidth: number;
  readonly y: number;
  readonly bandHeight: number;
  readonly expanded: boolean;
  readonly hasChildren: boolean;
}

export type RowKind = 'field' | 'method_bucket' | 'method';

export interface FieldRow {
  readonly name: string;
  readonly tyText: string;
  readonly ownership: Ownership;
  readonly x: number;
  readonly y: number;
  readonly arrowSourceX: number;
  readonly targets: readonly string[];
  readonly kind: RowKind;
  readonly bucketId: string | null;
}

export interface TypeBox {
  readonly id: string;
  readonly label: string;
  readonly typeKind: TypeKind;
  readonly visibility: string;
  readonly fullPath: string;
  readonly modulePath: string;
  /** Renderer metadata for ownership rank/debug labels. Physical placement is
   *  owned by layout and must not be recomputed from this value. */
  readonly col: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly headerArrowX: number | null;
  readonly headerHitWidth: number;
  readonly height: number;
  readonly hasFields: boolean;
  readonly expanded: boolean;
  readonly fields: readonly FieldRow[];
  readonly totalFieldCount: number;
  readonly isGhost: boolean;
  readonly ghostTarget: string | null;
}

export interface ArrowWaypoint {
  readonly x: number;
  readonly y: number;
}

export type ArrowKind = 'ownership' | 'reexport' | 'method';

export interface Arrow {
  readonly waypoints: readonly ArrowWaypoint[];
  readonly fromTypeId: string;
  readonly fromFieldName: string;
  readonly fromRowKind: 'field' | 'method';
  readonly toTypeId: string;
  readonly kind: ArrowKind;
  readonly driftClass: DriftClass;
}

export interface Layout {
  readonly modules: readonly ModuleRow[];
  readonly types: readonly TypeBox[];
  readonly arrows: readonly Arrow[];
  readonly totalHeight: number;
  readonly totalWidth: number;
  readonly debug?: LayoutDebug;
}

export interface LayoutDebug {
  readonly routing: ChannelDebug;
}

export interface ChannelObstacle {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export interface ChannelDebugLane {
  readonly x: number;
  readonly yMin: number;
  readonly yMax: number;
  readonly fromTypeId: string;
  readonly toTypeId: string;
  readonly bundleKey: string;
  readonly blocked: boolean;
}

export interface ChannelDebugGroup {
  readonly id: number;
  readonly laneCount: number;
  readonly targetIds: readonly string[];
  readonly xMin: number;
  readonly xMax: number;
}

export interface LayoutDebugLabel {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly label: string;
}

export interface LayoutDebugGrid {
  readonly originX: number;
  readonly originY: number;
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly width: number;
  readonly height: number;
}

export interface ChannelDebug {
  readonly lanes: readonly ChannelDebugLane[];
  readonly groups: readonly ChannelDebugGroup[];
  readonly obstacles: readonly ChannelObstacle[];
  readonly layoutLabels?: readonly LayoutDebugLabel[];
  readonly layoutGrid?: LayoutDebugGrid;
}

export interface LayoutInputs {
  readonly staticRoot: ModuleNode;
  readonly ownership: OwnershipIndex;
  readonly depth: ReadonlyMap<string, number>;
  readonly state: ViewState;
  readonly drift: DriftIndex;
  readonly measureText?: (text: string) => number;
  readonly focusModules?: ReadonlySet<string>;
  readonly ghostArrowsShown?: ReadonlySet<string>;
  readonly methodsHidden?: boolean;
  readonly methodArrowsShown?: ReadonlySet<string>;
  /** Legacy callers can still pass these while layout ignores them. Keeping
   *  the properties in the contract avoids UI call-site churn during removal
   *  of the old implementation. */
  readonly sortKey?: ReadonlyMap<string, number>;
  readonly anchorY?: ReadonlyMap<string, number>;
}
