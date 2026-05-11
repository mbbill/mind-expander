import type { Ownership, TypeKind } from '../data/schema.ts';
import type { ViewState } from '../state/view_state.ts';
import type { FunctionCallIndex, FunctionCallRef, FunctionRowRef } from './calls.ts';
import type { DriftClass, DriftIndex } from './drift.ts';
import type { LeafBgSegment, PrefixSegment } from './layout_metrics.ts';
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
  /** Ancestor modules in the dimmed prefix portion. The renderer paints a
   *  coloured rect per segment so adjacent rows that share a parent share a
   *  colour. Empty for crate-root and one-level-deep rows (no prefix). */
  readonly prefixSegments: readonly PrefixSegment[];
  /** Background segment under the leaf. Always present for module rows so
   *  every row shows a defined chip; `isParent` tells the renderer whether
   *  to use the hashed colour (parent of deeper rows) or a neutral white. */
  readonly leafBg: LeafBgSegment;
}

export type RowKind = 'field' | 'method_bucket' | 'method' | 'function';
export const ROW_ARROW_KEY_SEP = '\x1F';

export function rowArrowKey(typePath: string, rowName: string): string {
  return `${typePath}${ROW_ARROW_KEY_SEP}${rowName}`;
}

export function callArrowKey(
  typePath: string,
  rowName: string,
  rowKind: 'method' | 'function',
): string {
  return `${typePath}${ROW_ARROW_KEY_SEP}${rowKind}${ROW_ARROW_KEY_SEP}${rowName}`;
}

export interface FieldRow {
  readonly name: string;
  readonly tyText: string;
  readonly ownership: Ownership;
  readonly x: number;
  readonly y: number;
  readonly arrowSourceX: number;
  readonly targets: readonly string[];
  readonly callTargets: readonly FunctionRowRef[];
  readonly callRefs: readonly FunctionCallRef[];
  readonly incomingCallRefs: readonly FunctionCallRef[];
  readonly functionFullPath: string | null;
  readonly callsOutsideModule: boolean;
  readonly hasExternalCalls: boolean;
  readonly hasUnresolvedCalls: boolean;
  readonly hasOutgoingCalls: boolean;
  readonly hasIncomingCalls: boolean;
  readonly kind: RowKind;
  readonly bucketId: string | null;
  /** Strongest target drift for structural ownership targets on this row.
   *  Null means no ownership target; rendering uses this for member text color
   *  even when the target module is not currently expanded enough to emit an
   *  arrow. */
  readonly memberDriftClass: DriftClass | null;
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

export type ArrowKind = 'ownership' | 'reexport' | 'call';
export type ArrowLayerId = 'ownership' | 'reexport' | 'call' | 'debug';

export interface Arrow {
  readonly waypoints: readonly ArrowWaypoint[];
  readonly fromTypeId: string;
  readonly fromFieldName: string;
  readonly fromRowKind: 'field' | 'method' | 'function';
  readonly toTypeId: string;
  readonly toFieldName?: string;
  readonly toRowKind?: 'method' | 'function';
  readonly kind: ArrowKind;
  readonly driftClass: DriftClass;
}

export interface ArrowLayer {
  readonly id: ArrowLayerId;
  /** Route geometry that is active for this render. Complete domain facts
   *  remain on rows/indexes; layers contain only arrows the canvas should
   *  paint and hit-test right now. */
  readonly arrows: readonly Arrow[];
  readonly hitTestable: boolean;
}

export interface Layout {
  readonly modules: readonly ModuleRow[];
  readonly types: readonly TypeBox[];
  readonly arrowLayers: readonly ArrowLayer[];
  /** Flattened compatibility view of `arrowLayers`. New code should choose
   *  layers when it needs rendering or interaction policy. */
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
  /** Bold-weight measurer for module label chip width — the crate-root leaf
   *  renders bold, so non-bold measurements under-fit the chip. Optional;
   *  falls back to `measureText` if absent. */
  readonly measureBoldText?: (text: string) => number;
  readonly focusModules?: ReadonlySet<string>;
  readonly ghostArrowsShown?: ReadonlySet<string>;
  readonly calls?: FunctionCallIndex;
  readonly methodsHidden?: boolean;
  /** Selected field ownership arrows to emit. Omitted means emit all visible
   *  field arrows; an empty set means emit none. Keys are rowArrowKey(typePath,
   *  fieldName). */
  readonly fieldArrowsShown?: ReadonlySet<string>;
  /** Callable rows whose caller/callee routes should be materialized in the
   *  active call-arrow layer. Call facts stay available on row.callRefs even
   *  when this set is empty. Keys are callArrowKey(typePath, rowName, kind). */
  readonly callArrowsShown?: ReadonlySet<string>;
  /** Target functions whose incoming caller/callee routes should be
   *  materialized. Values are full function paths from FunctionRowRef. */
  readonly incomingCallTargetsShown?: ReadonlySet<string>;
  /** Legacy callers can still pass these while layout ignores them. Keeping
   *  the properties in the contract avoids UI call-site churn during removal
   *  of the old implementation. */
  readonly sortKey?: ReadonlyMap<string, number>;
  readonly anchorY?: ReadonlyMap<string, number>;
}
