import { describe, expect, it } from 'vitest';
import {
  type LayoutBoxFragment,
  type LayoutBoxSplitStrategy,
  buildLayoutBoxFragments,
} from '../src/layout2/box_fragments.ts';
import { gridRectToPx } from '../src/layout2/grid.ts';

const TEN_PX_GRID = { cellWidth: 10, cellHeight: 10 };

function fragmentAt(fragments: readonly LayoutBoxFragment[], index: number): LayoutBoxFragment {
  const fragment = fragments[index];
  if (fragment === undefined) {
    throw new Error(`Expected fragment at index ${index}`);
  }
  return fragment;
}

describe('layout2 box fragments', () => {
  it('produces one main fragment for a normal object with normal rows', () => {
    const result = buildLayoutBoxFragments({
      objectId: 'type:normal',
      name: 'Normal',
      header: { measuredWidthPx: 100, measuredHeightPx: 20 },
      rows: [
        { id: 'field:a', name: 'a', measuredWidthPx: 120, measuredHeightPx: 15 },
        { id: 'field:b', name: 'b', measuredWidthPx: 130, measuredHeightPx: 15 },
      ],
      grid: TEN_PX_GRID,
    });

    const main = fragmentAt(result.fragments, 0);

    expect(result.fragments).toHaveLength(1);
    expect(result.ownerId).toBe('type:normal');
    expect(main.ownerId).toBe('type:normal');
    expect(main.kind).toBe('main');
    expect(main.fragmentIndex).toBe(0);
    expect(main.fragmentId).toBe('0:main');
    expect(main.rowIds).toEqual(['field:a', 'field:b']);
    expect(main.own).toEqual({ col: 0, row: 0, cols: 13, rows: 5 });
    expect(main.clearance).toEqual(main.own);
  });

  it('splits a super-long row into an owner-scoped fragment without changing row identity', () => {
    const result = buildLayoutBoxFragments({
      objectId: 'type:Vec',
      name: 'Vec',
      header: { measuredWidthPx: 140, measuredHeightPx: 20 },
      rows: [
        { id: 'field:len', name: 'len', measuredWidthPx: 150, measuredHeightPx: 18 },
        {
          id: 'field:huge',
          name: 'huge',
          measuredWidthPx: 520,
          measuredHeightPx: 18,
        },
      ],
      grid: TEN_PX_GRID,
      clearance: {
        main: { top: 1, right: 2, bottom: 1, left: 2 },
        splitRow: { top: 0, right: 1, bottom: 0, left: 1 },
      },
    });

    const main = fragmentAt(result.fragments, 0);
    const split = fragmentAt(result.fragments, 1);

    expect(result.fragments).toHaveLength(2);
    expect(main.rowIds).toEqual(['field:len']);
    expect(main.own).toEqual({ col: 0, row: 0, cols: 15, rows: 4 });
    expect(main.clearance).toEqual({ col: -2, row: -1, cols: 19, rows: 6 });

    expect(split.ownerId).toBe('type:Vec');
    expect(split.kind).toBe('split-row');
    expect(split.rowIds).toEqual(['field:huge']);
    expect(split.own).toEqual({ col: 0, row: 4, cols: 52, rows: 2 });
    expect(split.clearance).toEqual({ col: -1, row: 4, cols: 54, rows: 2 });
    expect(split.fragmentId).not.toBe('type:Vec');
    expect(split.fragmentId).not.toBe('field:huge');
  });

  it('keeps multiple long-row fragments in stable top-down order', () => {
    const input = {
      objectId: 'type:Order',
      name: 'Order',
      header: { measuredWidthPx: 140, measuredHeightPx: 20 },
      rows: [
        { id: 'field:normal-a', name: 'normal-a', measuredWidthPx: 150, measuredHeightPx: 20 },
        { id: 'field:long-first', name: 'long-first', measuredWidthPx: 600, measuredHeightPx: 10 },
        { id: 'field:normal-b', name: 'normal-b', measuredWidthPx: 160, measuredHeightPx: 10 },
        {
          id: 'field:long-second',
          name: 'long-second',
          measuredWidthPx: 580,
          measuredHeightPx: 21,
        },
      ],
      grid: TEN_PX_GRID,
    };

    const first = buildLayoutBoxFragments(input);
    const second = buildLayoutBoxFragments(input);

    expect(first).toEqual(second);
    expect(first.fragments.map((fragment) => fragment.kind)).toEqual([
      'main',
      'split-row',
      'body',
      'split-row',
    ]);
    expect(first.fragments.map((fragment) => fragment.rowIds)).toEqual([
      ['field:normal-a'],
      ['field:long-first'],
      ['field:normal-b'],
      ['field:long-second'],
    ]);

    const localRows = first.fragments.map((fragment) => fragment.own.row);
    expect(localRows).toEqual([0, 4, 5, 6]);
    expect(localRows).toEqual([...localRows].sort((a, b) => a - b));
  });

  it('snaps fragment sizes outward and never inward', () => {
    const grid = { cellWidth: 16, cellHeight: 12 };
    const splitWideRow: LayoutBoxSplitStrategy = () => ['row:wide'];
    const result = buildLayoutBoxFragments({
      objectId: 'type:Snap',
      name: 'Snap',
      header: { measuredWidthPx: 33, measuredHeightPx: 13 },
      rows: [
        { id: 'row:normal', name: 'normal', measuredWidthPx: 49, measuredHeightPx: 11 },
        { id: 'row:wide', name: 'wide', measuredWidthPx: 83, measuredHeightPx: 14 },
      ],
      grid,
      splitStrategy: splitWideRow,
    });

    for (const fragment of result.fragments) {
      const px = gridRectToPx(
        { col: 0, row: 0, cols: fragment.own.cols, rows: fragment.own.rows },
        grid,
      );

      expect(px.width).toBeGreaterThanOrEqual(fragment.measuredWidthPx);
      expect(px.height).toBeGreaterThanOrEqual(fragment.measuredHeightPx);
    }
  });

  it('keeps the split strategy deterministic and free of previous-position inputs', () => {
    const seenStrategyInputKeys: string[][] = [];
    const deterministicStrategy: LayoutBoxSplitStrategy = (strategyInput) => {
      seenStrategyInputKeys.push(Object.keys(strategyInput).sort());
      return strategyInput.rows.filter((row) => row.name === 'split me').map((row) => row.id);
    };
    const input = {
      objectId: 'type:Strategy',
      name: 'Strategy',
      header: { measuredWidthPx: 120, measuredHeightPx: 20 },
      rows: [
        { id: 'row:keep', name: 'keep me', measuredWidthPx: 130, measuredHeightPx: 18 },
        { id: 'row:split', name: 'split me', measuredWidthPx: 500, measuredHeightPx: 18 },
      ],
      grid: TEN_PX_GRID,
      splitStrategy: deterministicStrategy,
    };

    const first = buildLayoutBoxFragments(input);
    const second = buildLayoutBoxFragments(input);

    expect(first).toEqual(second);
    expect(seenStrategyInputKeys).toEqual([
      ['header', 'name', 'objectId', 'rows'],
      ['header', 'name', 'objectId', 'rows'],
    ]);
  });

  it('preserves visual identity by exposing fragments as owner-scoped keys, not graph node ids', () => {
    const result = buildLayoutBoxFragments({
      objectId: 'type:Identity',
      name: 'Identity',
      header: { measuredWidthPx: 120, measuredHeightPx: 20 },
      rows: [{ id: 'row:long', name: 'long', measuredWidthPx: 500, measuredHeightPx: 18 }],
      grid: TEN_PX_GRID,
    });

    expect(result.fragments.map((fragment) => fragment.ownerId)).toEqual([
      'type:Identity',
      'type:Identity',
    ]);
    expect(result.fragments.map((fragment) => fragment.fragmentId)).toEqual([
      '0:main',
      '1:split-row',
    ]);
    for (const fragment of result.fragments) {
      expect('id' in fragment).toBe(false);
    }
  });
});
