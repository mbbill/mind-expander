// Shared physical layout tokens. The grid is the ground truth for placement
// dimensions; changing the cell size here should resize row/gap geometry
// without hunting for hardcoded pixel constants across layout and rendering.
export const LAYOUT_GRID_CELL_W = 8;
export const LAYOUT_GRID_CELL_H = 8;

export const LAYOUT_GRID = {
  cellWidth: LAYOUT_GRID_CELL_W,
  cellHeight: LAYOUT_GRID_CELL_H,
} as const;

export function gridCols(cols: number): number {
  return cols * LAYOUT_GRID_CELL_W;
}

export function gridRows(rows: number): number {
  return rows * LAYOUT_GRID_CELL_H;
}

export const ROW_H = gridRows(3);
export const FIELD_ROW_H = gridRows(2);
// The module overlay is transparent and the chevron renders at CHEVRON_X=6
// inside each row group, so the row's transform-x needs no outer slot for it.
// LEFT_PAD = 0 lets the depth-0 chevron sit ~6px from the viewport edge.
// INDENT_PX = 0 because every label carries its full module path, so depth
// is already conveyed in the text — a per-depth indent would just be visual
// noise and make the column ragged.
export const INDENT_PX = 0;
export const LEFT_PAD = 0;
export const TOP_PAD = gridRows(1);

export const TYPE_X_GAP = gridCols(3);
export const MODULE_BAND_X_GAP = gridCols(3);
export const MODULE_GLYPH_W = 0;
export const MODULE_LABEL_X = 18;
export const TYPE_GLYPH_W = gridCols(4);
export const TYPE_LABEL_X = gridCols(3);
export const FIELD_LABEL_INSET = gridCols(5);
export const FUNCTION_GROUP_LABEL_INSET = gridCols(3);
export const METHOD_INDENT = gridCols(2);
export const INCOMING_CALL_MARKER_OFFSET = 14;
// Drift dot — a small filled circle to the left of a field row name flagging
// non-canonical ownership placement. Shared between the renderer (where the
// circle is painted) and the geometry (where the row's leftPortX accounts
// for the dot so an outgoing arrow that exits left doesn't draw through it).
export const DRIFT_DOT_RADIUS = 2.5;
export const DRIFT_DOT_OFFSET = 7; // center distance from row.x going left
// Gap between the dot's left edge and the row's left-side arrow port, so
// arrows that exit left clear the dot completely instead of kissing it.
export const DRIFT_DOT_PORT_GAP = 2;
export const HIT_MIN_W = gridCols(5);
// Right-side breathing room added to the module label hit-rect / chip
// background so the chip doesn't end flush against the leaf glyphs.
export const MODULE_HIT_PAD_RIGHT = 8;
export const MIN_TYPE_BOX_W = gridCols(12);

export const BASE_FONT_SIZE = 12;
export const TYPE_LABEL_FONT_SIZE = 14;
export const TYPE_EXPAND_ARROW_FONT_SIZE = 22;
export const TYPE_LABEL_FONT_SCALE = TYPE_LABEL_FONT_SIZE / BASE_FONT_SIZE;
export const TYPE_EXPAND_ARROW_FONT_SCALE = TYPE_EXPAND_ARROW_FONT_SIZE / BASE_FONT_SIZE;
export const TYPE_EXPAND_ARROW_GAP = 6;
export const TYPE_EXPAND_ARROW_CLOSED = '▸';
export const TYPE_EXPAND_ARROW_OPEN = '▾';
export const MODULE_LABEL_PREFIX_FONT_SCALE = 1;
export const MODULE_LABEL_LEAF_FONT_SCALE = 14 / 12;

export interface TypeHeaderMetrics {
  readonly width: number;
  readonly arrowX: number | null;
  readonly hitWidth: number;
}

export function measureTypeHeaderMetrics(
  label: string,
  hasExpandArrow: boolean,
  measureText: (text: string) => number,
): TypeHeaderMetrics {
  const renderedLabelWidth = measureText(label) * TYPE_LABEL_FONT_SCALE;
  const labelRight = TYPE_LABEL_X + renderedLabelWidth;
  if (!hasExpandArrow) {
    // Non-expandable headers have no trailing affordance. Their layout box
    // should cover the rendered anchors only; adding a grid-cell pad here
    // turns into real obstacle/debug width with no matching visual content.
    const width = Math.max(MIN_TYPE_BOX_W, labelRight);
    return { width, arrowX: null, hitWidth: width };
  }

  const arrowX = labelRight + TYPE_EXPAND_ARROW_GAP;
  // The transparent click target must match the visible header box. If hit
  // width is wider than placement width, debug/obstacle boxes no longer match
  // what the user can actually click.
  const arrowWidth =
    Math.max(measureText(TYPE_EXPAND_ARROW_CLOSED), measureText(TYPE_EXPAND_ARROW_OPEN)) *
    TYPE_EXPAND_ARROW_FONT_SCALE;
  const width = Math.max(MIN_TYPE_BOX_W, arrowX + arrowWidth);
  return { width, arrowX, hitWidth: width };
}

/** One ancestor module name in the dimmed prefix portion of a row label.
 *  E.g. for `crate::vm::middle::ssa_ir::target`, the row gets three segments
 *  named `vm`, `middle`, `ssa_ir`. The renderer paints a coloured rect of
 *  width `width` at relative x `xStart` so segment colour groups sibling
 *  rows under the same parent. */
export interface PrefixSegment {
  readonly name: string;
  readonly xStart: number;
  readonly width: number;
}

export function computePrefixSegments(
  id: string,
  measureText: (text: string) => number,
): readonly PrefixSegment[] {
  const segs = id.split('::');
  if (segs.length <= 2) return [];
  const ancestors = segs.slice(1, -1);
  const out: PrefixSegment[] = [];
  let x = MODULE_LABEL_X;
  for (const name of ancestors) {
    const width = measureText(`${name}::`) * MODULE_LABEL_PREFIX_FONT_SCALE;
    out.push({ name, xStart: x, width });
    x += width;
  }
  return out;
}

/** Background segment under the leaf, sized for the bold/leaf font.
 *  `isParent` is true when the row has at least one module child — so its
 *  leaf name shows up as a coloured prefix in deeper rows and the renderer
 *  should use the hashed colour. Otherwise the renderer falls back to a
 *  neutral fill (white) so leaf-only rows still get a defined chip without
 *  burning a palette slot on a name that never appears as a prefix. */
export interface LeafBgSegment {
  readonly name: string;
  readonly xStart: number;
  readonly width: number;
  readonly isParent: boolean;
}

export function computeLeafSegment(
  id: string,
  prefixSegments: readonly PrefixSegment[],
  measureBoldText: (text: string) => number,
  isParent: boolean,
): LeafBgSegment {
  const segs = id.split('::');
  const leaf = segs[segs.length - 1] ?? id;
  const last = prefixSegments[prefixSegments.length - 1];
  const xStart = last ? last.xStart + last.width : MODULE_LABEL_X;
  const width = measureBoldText(leaf) * MODULE_LABEL_LEAF_FONT_SCALE;
  return { name: leaf, xStart, width, isParent };
}

export function splitModuleDisplayLabel(id: string): { prefix: string; leaf: string } {
  const segs = id.split('::');
  const leaf = segs[segs.length - 1] ?? id;
  if (segs.length <= 2) return { prefix: '', leaf };
  return { prefix: `${segs.slice(1, -1).join('::')}::`, leaf };
}

export function measureModuleHitWidth(
  id: string,
  measureText: (text: string) => number,
  measureBoldText: (text: string) => number = measureText,
): number {
  const { prefix, leaf } = splitModuleDisplayLabel(id);
  // The leaf is rendered bold for the crate-root row and may render slightly
  // wider than its non-bold metrics suggest. Always measure the leaf with the
  // bold font so the chip background and click hit-rect never under-fit the
  // rendered text. Prefix stays non-bold (matches the renderer).
  // MODULE_HIT_PAD_RIGHT keeps the chip from ending flush against the glyphs.
  const labelWidth =
    measureText(prefix) * MODULE_LABEL_PREFIX_FONT_SCALE +
    measureBoldText(leaf) * MODULE_LABEL_LEAF_FONT_SCALE;
  return MODULE_LABEL_X + labelWidth + MODULE_HIT_PAD_RIGHT;
}
