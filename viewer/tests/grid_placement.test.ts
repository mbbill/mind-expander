import { describe, expect, it } from 'vitest';
import { type Clearance, type GridRect, conflicts, layoutBox } from '../src/layout/grid.ts';
import {
  GridPlacementFailure,
  type GridPlacementFragment,
  type GridPlacementItem,
  placeGridItemsTopToBottom,
} from '../src/layout/grid_placement.ts';

const NONE: Clearance = { top: 0, right: 0, bottom: 0, left: 0 };

function rect(col: number, row: number, cols: number, rows: number): GridRect {
  return { col, row, cols, rows };
}

function fragment(
  ownerId: string,
  fragmentId: string,
  own: GridRect,
  clearance: Clearance = NONE,
): GridPlacementFragment {
  const box = layoutBox(own, clearance);

  return {
    ownerId,
    fragmentId,
    own: box.own,
    clearance: box.clearance,
  };
}

function item(
  id: string,
  groupOrder: number,
  indexInGroup: number,
  fragments: readonly GridPlacementFragment[],
  rankOrder = groupOrder,
  predecessorIds: readonly string[] = [],
): GridPlacementItem {
  return {
    id,
    ownerId: id,
    rankOrder,
    predecessorIds,
    groupOrder,
    indexInGroup,
    fragments,
  };
}

function singleFragmentItem(
  id: string,
  groupOrder: number,
  indexInGroup: number,
  own: GridRect,
  clearance: Clearance = NONE,
  rankOrder = groupOrder,
): GridPlacementItem {
  return item(id, groupOrder, indexInGroup, [fragment(id, 'main', own, clearance)], rankOrder);
}

function inRegion(item: GridPlacementItem, regionId: string): GridPlacementItem {
  return {
    ...item,
    regionId,
  };
}

describe('layout grid placement', () => {
  it('places a single group top-down and preserves item order', () => {
    const result = placeGridItemsTopToBottom(
      [
        singleFragmentItem('third', 0, 2, rect(0, 0, 2, 1)),
        singleFragmentItem('first', 0, 0, rect(0, 0, 2, 2)),
        singleFragmentItem('second', 0, 1, rect(0, 0, 2, 1)),
      ],
      { maxCols: 8, maxRows: 8 },
    );

    expect(result.items.map((placed) => placed.id)).toEqual(['first', 'second', 'third']);
    expect(result.items.map((placed) => placed.origin)).toEqual([
      { col: 0, row: 0 },
      { col: 0, row: 2 },
      { col: 0, row: 3 },
    ]);
    expect(result.fragments.map((placed) => placed.own)).toEqual([
      rect(0, 0, 2, 2),
      rect(0, 2, 2, 1),
      rect(0, 3, 2, 1),
    ]);
  });

  it('places a second group after the previous group max width', () => {
    const result = placeGridItemsTopToBottom(
      [
        singleFragmentItem('previous:narrow-top', 0, 0, rect(0, 0, 2, 1)),
        singleFragmentItem('previous:wide-lower', 0, 1, rect(0, 0, 10, 1), {
          top: 0,
          right: 2,
          bottom: 0,
          left: 0,
        }),
        item('next:top', 1, 0, [fragment('next:top', 'main', rect(0, 0, 1, 1))], 0),
      ],
      { maxCols: 18, maxRows: 6 },
    );

    expect(result.items.map((placed) => [placed.id, placed.origin])).toEqual([
      ['previous:narrow-top', { col: 0, row: 0 }],
      ['previous:wide-lower', { col: 0, row: 1 }],
      ['next:top', { col: 12, row: 0 }],
    ]);
  });

  it('keeps later display groups on rightward tracks instead of backfilling under earlier groups', () => {
    const result = placeGridItemsTopToBottom(
      [
        // All groups spread from one depth bucket, so they share a single
        // rankOrder (band_shape rankOrderForBucket); same-rank spreading floors
        // later groups onto rightward tracks.
        singleFragmentItem('group0:narrow-top', 0, 0, rect(0, 0, 2, 1), NONE, 0),
        singleFragmentItem('group0:wide-lower', 0, 1, rect(0, 0, 14, 2), NONE, 0),
        singleFragmentItem('group1:top', 1, 0, rect(0, 0, 2, 1), NONE, 0),
        singleFragmentItem('group2:top', 2, 0, rect(0, 0, 2, 1), NONE, 0),
        singleFragmentItem('group6:top', 6, 0, rect(0, 0, 2, 1), NONE, 0),
      ],
      { maxCols: 32, maxRows: 12 },
    );

    const firstColByGroup = new Map(
      result.items.map((placed) => [placed.groupOrder, placed.origin.col] as const),
    );

    expect(firstColByGroup.get(0)).toBe(0);
    expect(firstColByGroup.get(1)).toBe(14);
    expect(firstColByGroup.get(2)).toBeGreaterThan(firstColByGroup.get(1) ?? -1);
    expect(firstColByGroup.get(6)).toBeGreaterThan(firstColByGroup.get(2) ?? -1);
  });

  it('aligns all same-display-group items on the computed group column', () => {
    const result = placeGridItemsTopToBottom(
      [
        // Same depth bucket spread into two display groups: shared rankOrder.
        singleFragmentItem('group0:narrow-top', 0, 0, rect(0, 0, 2, 1), NONE, 0),
        singleFragmentItem('group0:wide-lower', 0, 1, rect(0, 0, 13, 3), NONE, 0),
        singleFragmentItem('group1:first', 1, 0, rect(0, 0, 2, 1), NONE, 0),
        singleFragmentItem('group1:second', 1, 1, rect(0, 0, 2, 1), NONE, 0),
      ],
      { maxCols: 24, maxRows: 12 },
    );

    const first = result.items.find((placed) => placed.id === 'group1:first');
    const second = result.items.find((placed) => placed.id === 'group1:second');

    expect(first?.origin).toEqual({ col: 13, row: 0 });
    expect(second?.origin.col).toBe(first?.origin.col);
    expect(second?.origin.row).toBe(1);
  });

  it('keeps a target to the right of its actual predecessor', () => {
    const result = placeGridItemsTopToBottom(
      [
        singleFragmentItem('owner:narrow-top', 0, 0, rect(0, 0, 2, 1), NONE),
        item('target:top', 1, 0, [fragment('target:top', 'main', rect(0, 0, 1, 1))], 1, [
          'owner:narrow-top',
        ]),
      ],
      { maxCols: 16, maxRows: 6 },
    );

    expect(result.items.map((placed) => [placed.id, placed.origin])).toEqual([
      ['owner:narrow-top', { col: 0, row: 0 }],
      ['target:top', { col: 2, row: 0 }],
    ]);
  });

  it('uses previous display-group max width for later rank placement', () => {
    const result = placeGridItemsTopToBottom(
      [
        // Later display group at the SAME depth/rank as the earlier group:
        // its column comes from the previous same-rank group's max width.
        singleFragmentItem('unrelated:narrow-top', 0, 0, rect(0, 0, 2, 1), NONE, 0),
        singleFragmentItem('unrelated:wide-lower', 0, 1, rect(0, 0, 10, 1), NONE, 0),
        item('later:unblocked', 1, 0, [fragment('later:unblocked', 'main', rect(0, 0, 2, 1))], 0),
      ],
      { maxCols: 32, maxRows: 4 },
    );

    expect(result.items.find((placed) => placed.id === 'later:unblocked')?.origin).toEqual({
      col: 10,
      row: 0,
    });
  });

  it('respects clearance conflicts using grid conflict semantics', () => {
    const result = placeGridItemsTopToBottom(
      [
        singleFragmentItem('left', 0, 0, rect(0, 0, 2, 2), {
          top: 0,
          right: 2,
          bottom: 0,
          left: 0,
        }),
        singleFragmentItem('right', 1, 0, rect(0, 0, 2, 2)),
      ],
      { maxCols: 8, maxRows: 4 },
    );

    const [left, right] = result.fragments;
    if (left === undefined || right === undefined) {
      throw new Error('Expected two placed fragments.');
    }

    expect(right.own).toEqual(rect(4, 0, 2, 2));
    expect(conflicts(left, right)).toBe(false);
    expect(conflicts(right, left)).toBe(false);
  });

  it('applies rank-layer gap across regions without adding it to clearance', () => {
    const lowerRank = inRegion(
      singleFragmentItem('lower-rank', 0, 0, rect(0, 0, 10, 1), {
        top: 0,
        right: 2,
        bottom: 0,
        left: 0,
      }),
      'module:a',
    );
    // The rank-layer gap is predecessor-relative: next-rank actually depends on
    // lower-rank, so the inter-rank floor applies against its right edge.
    const nextRank = inRegion(
      item('next-rank', 0, 0, [fragment('next-rank', 'main', rect(0, 0, 1, 1))], 1, ['lower-rank']),
      'module:b',
    );

    const result = placeGridItemsTopToBottom([lowerRank, nextRank], {
      maxCols: 24,
      maxRows: 4,
      rankLayerGapCells: 2,
    });

    expect(result.items.find((placed) => placed.id === 'next-rank')?.origin.col).toBe(12);
  });

  it('uses the larger of rank-layer gap and fragment clearance between ranks', () => {
    const lowClearance = inRegion(
      singleFragmentItem('low-clearance', 0, 0, rect(0, 0, 10, 1), {
        top: 0,
        right: 1,
        bottom: 0,
        left: 0,
      }),
      'module:a',
    );
    const wideClearance = inRegion(
      singleFragmentItem('wide-clearance', 0, 1, rect(0, 0, 10, 1), {
        top: 0,
        right: 3,
        bottom: 0,
        left: 0,
      }),
      'module:a',
    );
    // Predecessor links so the inter-rank floor (max of rank gap vs clearance)
    // applies against each item's actual forward predecessor.
    const afterLow = inRegion(
      item('after-low', 0, 0, [fragment('after-low', 'main', rect(0, 0, 1, 1))], 1, [
        'low-clearance',
      ]),
      'module:b',
    );
    const afterWide = inRegion(
      item('after-wide', 0, 0, [fragment('after-wide', 'main', rect(0, 0, 1, 1))], 1, [
        'wide-clearance',
      ]),
      'module:b',
    );

    const lowResult = placeGridItemsTopToBottom([lowClearance, afterLow], {
      maxCols: 24,
      maxRows: 4,
      rankLayerGapCells: 3,
    });
    const wideResult = placeGridItemsTopToBottom([wideClearance, afterWide], {
      maxCols: 24,
      maxRows: 4,
      rankLayerGapCells: 2,
    });

    expect(lowResult.items.find((placed) => placed.id === 'after-low')?.origin.col).toBe(13);
    expect(wideResult.items.find((placed) => placed.id === 'after-wide')?.origin.col).toBe(13);
  });

  it('does not apply the rank-layer floor between items in the same rank', () => {
    const left = inRegion(singleFragmentItem('left', 0, 0, rect(0, 0, 10, 1)), 'module:a');
    const peer = inRegion(
      item('peer', 0, 0, [fragment('peer', 'main', rect(0, 0, 1, 1))], 0),
      'module:b',
    );

    const result = placeGridItemsTopToBottom([left, peer], {
      maxCols: 24,
      maxRows: 4,
      rankLayerGapCells: 2,
    });

    expect(result.items.find((placed) => placed.id === 'peer')?.origin.col).toBe(0);
  });

  it('can exclude prelude orders from the rank-layer floor', () => {
    const prelude = inRegion(singleFragmentItem('prelude', 0, 0, rect(0, 0, 10, 1)), 'module:a');
    const realRank = inRegion(
      item('real-rank', 0, 0, [fragment('real-rank', 'main', rect(0, 0, 1, 1))], 1),
      'module:b',
    );

    const result = placeGridItemsTopToBottom([prelude, realRank], {
      maxCols: 24,
      maxRows: 4,
      rankLayerGapCells: 2,
      firstRankLayerOrder: 1,
    });

    expect(result.items.find((placed) => placed.id === 'real-rank')?.origin.col).toBe(0);
  });

  it('preserves multi-fragment item layout when translating fragments', () => {
    const result = placeGridItemsTopToBottom(
      [
        singleFragmentItem('anchor', 0, 0, rect(0, 0, 3, 1)),
        item('multi', 1, 0, [
          fragment('multi', 'header', rect(0, 0, 2, 1)),
          fragment('multi', 'split-row', rect(1, 2, 4, 1), {
            top: 0,
            right: 2,
            bottom: 0,
            left: 1,
          }),
        ]),
      ],
      { maxCols: 12, maxRows: 6 },
    );

    const placedMulti = result.items.find((placed) => placed.id === 'multi');

    expect(placedMulti?.origin).toEqual({ col: 3, row: 0 });
    expect(placedMulti?.fragments.map((placed) => placed.own)).toEqual([
      rect(3, 0, 2, 1),
      rect(4, 2, 4, 1),
    ]);
    expect(placedMulti?.fragments[1]?.clearance).toEqual(rect(3, 2, 7, 1));
  });

  it('is deterministic and does not consume previous physical positions', () => {
    // a/b/c share one depth bucket's rankOrder; c is a later same-rank group
    // floored right of b's width.
    const input = [
      singleFragmentItem('a', 0, 0, rect(0, 0, 2, 2)),
      singleFragmentItem('b', 0, 1, rect(0, 0, 3, 1)),
      singleFragmentItem('c', 1, 0, rect(0, 0, 1, 1), NONE, 0),
    ];

    const first = placeGridItemsTopToBottom(input, { maxCols: 10, maxRows: 10 });
    const second = placeGridItemsTopToBottom(input, { maxCols: 10, maxRows: 10 });

    expect(second).toEqual(first);
    expect(first.items.map((placed) => placed.origin)).toEqual([
      { col: 0, row: 0 },
      { col: 0, row: 2 },
      { col: 3, row: 0 },
    ]);
  });

  it('preserves placement behavior when no extra gaps are provided', () => {
    const input = [
      singleFragmentItem('a', 0, 0, rect(0, 0, 2, 1)),
      singleFragmentItem('b', 1, 0, rect(0, 0, 2, 1)),
      singleFragmentItem('c', 2, 0, rect(0, 0, 2, 1)),
    ];
    const options = { maxCols: 20, maxRows: 6 };

    expect(placeGridItemsTopToBottom(input, { ...options, extraGaps: [] })).toEqual(
      placeGridItemsTopToBottom(input, options),
    );
  });

  it('applies an x afterOrder extra gap as physical spacing for later groups', () => {
    const result = placeGridItemsTopToBottom(
      [
        // Same-rank spreading groups; the extra gap widens the rightward track.
        singleFragmentItem('left', 0, 0, rect(0, 0, 2, 1), NONE, 0),
        singleFragmentItem('right', 1, 0, rect(0, 0, 2, 1), NONE, 0),
      ],
      {
        maxCols: 20,
        maxRows: 6,
        extraGaps: [{ bandId: 'band:a', axis: 'x', afterOrder: 0, cells: 3 }],
      },
    );

    expect(
      result.items.map((placed) => [placed.id, placed.groupOrder, placed.indexInGroup]),
    ).toEqual([
      ['left', 0, 0],
      ['right', 1, 0],
    ]);
    expect(result.items.find((placed) => placed.id === 'right')?.origin.col).toBe(5);
  });

  it('accumulates multiple prior x afterOrder extra gaps in group coordinates', () => {
    const result = placeGridItemsTopToBottom(
      [
        // Three same-rank spreading groups; gaps accumulate along the tracks.
        singleFragmentItem('first', 0, 0, rect(0, 0, 1, 1), NONE, 0),
        singleFragmentItem('second', 1, 0, rect(0, 0, 1, 1), NONE, 0),
        singleFragmentItem('third', 2, 0, rect(0, 0, 1, 1), NONE, 0),
      ],
      {
        maxCols: 20,
        maxRows: 6,
        extraGaps: [
          { bandId: 'band:a', axis: 'x', afterOrder: 0, cells: 2 },
          { bandId: 'band:a', axis: 'x', afterOrder: 1, cells: 3 },
        ],
      },
    );

    expect(result.items.map((placed) => [placed.id, placed.origin.col])).toEqual([
      ['first', 0],
      ['second', 3],
      ['third', 7],
    ]);
  });

  it('does not encode extra gaps into fragment clearance or change group assignment', () => {
    const left = singleFragmentItem('left', 0, 0, rect(0, 0, 2, 1), NONE, 0);
    const rightFragment = fragment('right', 'main', rect(0, 0, 2, 1));
    // Same-rank later group; the gap shifts its track without touching clearance.
    const right = item('right', 1, 0, [rightFragment], 0);

    const result = placeGridItemsTopToBottom([left, right], {
      maxCols: 20,
      maxRows: 6,
      extraGaps: [{ bandId: 'band:a', axis: 'x', afterOrder: 0, cells: 4 }],
    });

    const placedRight = result.items.find((placed) => placed.id === 'right');

    expect(rightFragment.clearance).toEqual(rect(0, 0, 2, 1));
    expect(placedRight?.groupOrder).toBe(1);
    expect(placedRight?.indexInGroup).toBe(0);
    expect(placedRight?.fragments[0]?.clearance).toEqual(rect(6, 0, 2, 1));
  });

  it('rejects unsupported extra gap channels explicitly', () => {
    const input = [
      singleFragmentItem('left', 0, 0, rect(0, 0, 2, 1)),
      singleFragmentItem('right', 1, 0, rect(0, 0, 2, 1)),
    ];

    expect(() =>
      placeGridItemsTopToBottom(input, {
        maxCols: 20,
        maxRows: 6,
        extraGaps: [{ bandId: 'band:a', axis: 'y', afterOrder: 0, cells: 1 }],
      }),
    ).toThrow(/only x-axis afterOrder/);
    expect(() =>
      placeGridItemsTopToBottom(input, {
        maxCols: 20,
        maxRows: 6,
        extraGaps: [{ bandId: 'band:a', axis: 'x', betweenRegions: ['left', 'right'], cells: 1 }],
      }),
    ).toThrow(/only x-axis afterOrder/);
  });

  it('fails explicitly when the bounded search window is too small', () => {
    expect(() =>
      placeGridItemsTopToBottom(
        [
          singleFragmentItem('first', 0, 0, rect(0, 0, 1, 1)),
          singleFragmentItem('second', 0, 1, rect(0, 0, 1, 1)),
        ],
        { maxCols: 4, maxRows: 1 },
      ),
    ).toThrow(GridPlacementFailure);

    expect(() =>
      placeGridItemsTopToBottom([singleFragmentItem('too-wide', 0, 0, rect(0, 0, 5, 1))], {
        maxCols: 4,
        maxRows: 2,
      }),
    ).toThrow(/Unable to place item too-wide within search window 4x2/);
  });
});
