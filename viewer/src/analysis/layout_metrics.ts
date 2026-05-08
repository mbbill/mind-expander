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
export const INDENT_PX = gridCols(2);
export const LEFT_PAD = gridCols(1);
export const TOP_PAD = gridRows(1);

export const TYPE_X_GAP = gridCols(2);
export const MODULE_BAND_X_GAP = gridCols(3);
export const MODULE_GLYPH_W = gridCols(2);
export const MODULE_LABEL_X = 18;
export const TYPE_GLYPH_W = gridCols(4);
export const TYPE_LABEL_X = gridCols(3);
export const FIELD_LABEL_INSET = gridCols(5);
export const FUNCTION_GROUP_LABEL_INSET = gridCols(3);
export const METHOD_INDENT = gridCols(2);
export const HIT_MIN_W = gridCols(5);
export const MIN_TYPE_BOX_W = gridCols(12);

export const TYPE_LABEL_FONT_SCALE = 14 / 12;
export const TYPE_EXPAND_ARROW_GAP = 6;
export const TYPE_EXPAND_ARROW_W = 14;
export const TYPE_EXPAND_ARROW_HIT_PAD = 4;
export const TYPE_HEADER_TRAILING_PAD = gridCols(1);
export const HIT_PAD_RIGHT = gridCols(1);
export const MODULE_LABEL_PREFIX_FONT_SCALE = 11 / 12;
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
    const width = Math.max(MIN_TYPE_BOX_W, labelRight + TYPE_HEADER_TRAILING_PAD);
    return { width, arrowX: null, hitWidth: Math.max(width, HIT_MIN_W) };
  }

  const arrowX = labelRight + TYPE_EXPAND_ARROW_GAP;
  const width = Math.max(MIN_TYPE_BOX_W, arrowX + TYPE_EXPAND_ARROW_W + TYPE_EXPAND_ARROW_HIT_PAD);
  return { width, arrowX, hitWidth: Math.max(width, HIT_MIN_W) };
}

export function splitModuleDisplayLabel(id: string): { prefix: string; leaf: string } {
  const segs = id.split('::');
  const leaf = segs[segs.length - 1] ?? id;
  if (segs.length <= 2) return { prefix: '', leaf };
  return { prefix: `${segs.slice(1, -1).join('::')}::`, leaf };
}

export function measureModuleHitWidth(id: string, measureText: (text: string) => number): number {
  const { prefix, leaf } = splitModuleDisplayLabel(id);
  // Module rows use two font sizes in the renderer. Layout owns this width so
  // frozen-pane sizing and row hit areas do not need browser getBBox() calls
  // during expand/collapse redraws.
  const labelWidth =
    measureText(prefix) * MODULE_LABEL_PREFIX_FONT_SCALE +
    measureText(leaf) * MODULE_LABEL_LEAF_FONT_SCALE;
  return Math.max(MODULE_LABEL_X + labelWidth + HIT_PAD_RIGHT, HIT_MIN_W);
}
