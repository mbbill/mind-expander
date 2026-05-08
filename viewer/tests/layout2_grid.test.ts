import { describe, expect, it } from 'vitest';
import {
  type Clearance,
  type GridRect,
  conflicts,
  expandGridRect,
  gridRectToPx,
  layoutBox,
  overlaps,
  snapPxRectToGrid,
} from '../src/layout2/grid.ts';

const NONE: Clearance = { top: 0, right: 0, bottom: 0, left: 0 };

function rect(col: number, row: number, cols: number, rows: number): GridRect {
  return { col, row, cols, rows };
}

describe('layout2 grid primitives', () => {
  it('snap rounds measured px rectangles outward and never inward', () => {
    const measured = { x: 11, y: 19, width: 20, height: 22 };
    const grid = { cellWidth: 10, cellHeight: 10 };
    const snapped = snapPxRectToGrid(measured, grid);
    const px = gridRectToPx(snapped, grid);

    expect(snapped).toEqual({ col: 1, row: 1, cols: 3, rows: 4 });
    expect(px.x).toBeLessThanOrEqual(measured.x);
    expect(px.y).toBeLessThanOrEqual(measured.y);
    expect(px.x + px.width).toBeGreaterThanOrEqual(measured.x + measured.width);
    expect(px.y + px.height).toBeGreaterThanOrEqual(measured.y + measured.height);
  });

  it('allows zero-sized measured rectangles in the half-open grid model', () => {
    expect(
      snapPxRectToGrid({ x: 20, y: 30, width: 0, height: 0 }, { cellWidth: 10, cellHeight: 10 }),
    ).toEqual({
      col: 2,
      row: 3,
      cols: 0,
      rows: 0,
    });
  });

  it('rejects negative measured width or height', () => {
    const grid = { cellWidth: 10, cellHeight: 10 };

    expect(() => snapPxRectToGrid({ x: 0, y: 0, width: -1, height: 1 }, grid)).toThrow(
      /non-negative/,
    );
    expect(() => snapPxRectToGrid({ x: 0, y: 0, width: 1, height: -1 }, grid)).toThrow(
      /non-negative/,
    );
  });

  it('expands a grid rect by asymmetric clearance', () => {
    expect(expandGridRect(rect(4, 6, 3, 2), { top: 1, right: 2, bottom: 3, left: 4 })).toEqual({
      col: 0,
      row: 5,
      cols: 9,
      rows: 6,
    });
  });

  it('rejects negative clearance values when expanding or building layout boxes', () => {
    expect(() =>
      expandGridRect(rect(0, 0, 1, 1), { top: -1, right: 0, bottom: 0, left: 0 }),
    ).toThrow(/non-negative/);
    expect(() =>
      expandGridRect(rect(0, 0, 1, 1), { top: 0, right: -1, bottom: 0, left: 0 }),
    ).toThrow(/non-negative/);
    expect(() =>
      expandGridRect(rect(0, 0, 1, 1), { top: 0, right: 0, bottom: -1, left: 0 }),
    ).toThrow(/non-negative/);
    expect(() => layoutBox(rect(0, 0, 1, 1), { top: 0, right: 0, bottom: 0, left: -1 })).toThrow(
      /non-negative/,
    );
  });

  it('detects half-open overlaps and allows edge contact', () => {
    expect(overlaps(rect(0, 0, 2, 2), rect(1, 1, 2, 2))).toBe(true);
    expect(overlaps(rect(0, 0, 2, 2), rect(2, 0, 2, 2))).toBe(false);
    expect(overlaps(rect(0, 0, 2, 2), rect(0, 2, 2, 2))).toBe(false);
  });

  it('own-vs-clearance conflicts are order-independent when clearances differ', () => {
    const noGapBox = layoutBox(rect(0, 0, 2, 2), NONE);
    const leftGapBox = layoutBox(rect(3, 0, 2, 2), { top: 0, right: 0, bottom: 0, left: 2 });

    expect(overlaps(noGapBox.own, leftGapBox.clearance)).toBe(true);
    expect(overlaps(noGapBox.clearance, leftGapBox.own)).toBe(false);
    expect(conflicts(noGapBox, leftGapBox)).toBe(true);
    expect(conflicts(leftGapBox, noGapBox)).toBe(true);
  });

  it('does not use clearance-vs-clearance because that would be over-conservative', () => {
    const left = layoutBox(rect(0, 0, 2, 2), { top: 0, right: 2, bottom: 0, left: 0 });
    const right = layoutBox(rect(4, 0, 2, 2), { top: 0, right: 0, bottom: 0, left: 2 });

    expect(overlaps(left.clearance, right.clearance)).toBe(true);
    expect(conflicts(left, right)).toBe(false);
    expect(conflicts(right, left)).toBe(false);
  });

  it('lets zero-clearance long rows coexist with type boxes only when requested gaps are respected', () => {
    const longRow = layoutBox(rect(0, 0, 6, 1), NONE);
    const typeGap: Clearance = { top: 1, right: 2, bottom: 1, left: 2 };

    const tooCloseType = layoutBox(rect(7, 0, 2, 3), typeGap);
    const respectedType = layoutBox(rect(8, 0, 2, 3), typeGap);

    expect(conflicts(longRow, tooCloseType)).toBe(true);
    expect(conflicts(tooCloseType, longRow)).toBe(true);
    expect(conflicts(longRow, respectedType)).toBe(false);
    expect(conflicts(respectedType, longRow)).toBe(false);
  });
});
