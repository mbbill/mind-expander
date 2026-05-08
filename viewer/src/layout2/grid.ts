export interface GridSpec {
  readonly cellWidth: number;
  readonly cellHeight: number;
}

export interface PxRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface GridRect {
  readonly col: number;
  readonly row: number;
  readonly cols: number;
  readonly rows: number;
}

export interface Clearance {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface LayoutBox {
  readonly own: GridRect;
  readonly clearance: GridRect;
}

export const ZERO_CLEARANCE: Clearance = {
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
};

export function snapPxRectToGrid(rect: PxRect, grid: GridSpec): GridRect {
  if (grid.cellWidth <= 0 || grid.cellHeight <= 0) {
    throw new Error('Grid cells must have positive dimensions.');
  }
  if (rect.width < 0 || rect.height < 0) {
    throw new Error('Measured rectangles must have non-negative dimensions.');
  }

  const col = Math.floor(rect.x / grid.cellWidth);
  const row = Math.floor(rect.y / grid.cellHeight);
  const rightCol = Math.ceil((rect.x + rect.width) / grid.cellWidth);
  const bottomRow = Math.ceil((rect.y + rect.height) / grid.cellHeight);

  return {
    col,
    row,
    cols: Math.max(0, rightCol - col),
    rows: Math.max(0, bottomRow - row),
  };
}

export function gridRectToPx(rect: GridRect, grid: GridSpec): PxRect {
  return {
    x: rect.col * grid.cellWidth,
    y: rect.row * grid.cellHeight,
    width: rect.cols * grid.cellWidth,
    height: rect.rows * grid.cellHeight,
  };
}

export function expandGridRect(rect: GridRect, clearance: Clearance): GridRect {
  assertNonNegativeClearance(clearance);

  return {
    col: rect.col - clearance.left,
    row: rect.row - clearance.top,
    cols: rect.cols + clearance.left + clearance.right,
    rows: rect.rows + clearance.top + clearance.bottom,
  };
}

export function layoutBox(own: GridRect, clearance: Clearance = ZERO_CLEARANCE): LayoutBox {
  return {
    own,
    clearance: expandGridRect(own, clearance),
  };
}

export function overlaps(a: GridRect, b: GridRect): boolean {
  return (
    a.col < b.col + b.cols &&
    b.col < a.col + a.cols &&
    a.row < b.row + b.rows &&
    b.row < a.row + a.rows
  );
}

export function conflicts(a: LayoutBox, b: LayoutBox): boolean {
  // Clearance is box-specific. Checking own-vs-clearance in both directions
  // preserves each box's requested gap without double-counting both gaps.
  return overlaps(a.own, b.clearance) || overlaps(a.clearance, b.own);
}

function assertNonNegativeClearance(clearance: Clearance): void {
  if (clearance.top < 0 || clearance.right < 0 || clearance.bottom < 0 || clearance.left < 0) {
    throw new Error('Clearance values must be non-negative.');
  }
}
