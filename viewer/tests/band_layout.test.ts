import { describe, expect, it } from 'vitest';
import {
  type BandLayoutItem,
  type BandLayoutResult,
  layoutOneModuleBand,
} from '../src/layout/band_layout.ts';
import { type BandDepth, planBandShape } from '../src/layout/band_shape.ts';
import type {
  LayoutBoxFragmentClearance,
  LayoutBoxSplitStrategy,
  MeasuredBoxPart,
  MeasuredLayoutRow,
} from '../src/layout/box_fragments.ts';
import type { GridSpec } from '../src/layout/grid.ts';

const GRID: GridSpec = { cellWidth: 10, cellHeight: 10 };
const prelude: BandDepth = { kind: 'prelude' };

interface ItemOptions {
  readonly id?: string;
  readonly header?: MeasuredBoxPart;
  readonly rows?: readonly MeasuredLayoutRow[];
  readonly rowWidthPx?: number;
  readonly grid?: GridSpec;
  readonly clearance?: LayoutBoxFragmentClearance;
  readonly splitStrategy?: LayoutBoxSplitStrategy;
}

function rankDepth(depth: number): BandDepth {
  return { kind: 'rank', depth };
}

function item(name: string, depth: BandDepth, options: ItemOptions = {}): BandLayoutItem {
  const rows = options.rows ?? [
    {
      id: `row:${name}`,
      name: `${name} row`,
      measuredWidthPx: options.rowWidthPx ?? 80,
      measuredHeightPx: 10,
    },
  ];

  return {
    id: options.id ?? `item:${name}`,
    name,
    depth,
    header: options.header ?? { measuredWidthPx: 60, measuredHeightPx: 20 },
    rows,
    grid: options.grid ?? GRID,
    ...(options.clearance !== undefined ? { clearance: options.clearance } : {}),
    ...(options.splitStrategy !== undefined ? { splitStrategy: options.splitStrategy } : {}),
  };
}

function assignmentSummary(result: BandLayoutResult): readonly unknown[] {
  return result.shapePlan.assignments.map((assignment) => ({
    id: assignment.id,
    name: assignment.name,
    depth: assignment.depth,
    groupOrder: assignment.groupOrder,
    indexInGroup: assignment.indexInGroup,
  }));
}

function placedItem(result: BandLayoutResult, id: string) {
  const placed = result.placedItems.find((candidate) => candidate.id === id);

  if (placed === undefined) {
    throw new Error(`Expected placed item ${id}`);
  }

  return placed;
}

describe('layout one-module band layout', () => {
  it('places prelude items before rank items through the composed path', () => {
    const result = layoutOneModuleBand(
      [item('TypeB', rankDepth(1)), item('FunctionGroup', prelude), item('TypeA', rankDepth(0))],
      {
        shapeStrategy: () => [1, 1, 1],
        placementOptions: { maxCols: 40, maxRows: 20 },
      },
    );

    expect(result.shapePlan.assignments.map((assignment) => assignment.name)).toEqual([
      'FunctionGroup',
      'TypeA',
      'TypeB',
    ]);
    expect(result.gridItems.map((gridItem) => gridItem.id)).toEqual([
      'item:FunctionGroup',
      'item:TypeA',
      'item:TypeB',
    ]);
    expect(result.placedItems.map((placed) => placed.id)).toEqual([
      'item:FunctionGroup',
      'item:TypeA',
      'item:TypeB',
    ]);
    expect(placedItem(result, 'item:FunctionGroup').origin.col).toBe(0);
    expect(placedItem(result, 'item:TypeA').origin.col).toBeGreaterThan(
      placedItem(result, 'item:FunctionGroup').origin.col,
    );
  });

  it('plans same-depth items by name and count with deterministic placement under shuffled input', () => {
    const names = ['J', 'H', 'F', 'D', 'B', 'I', 'G', 'E', 'C', 'A'];
    const input = names.map((name) => item(name, rankDepth(1)));
    const shuffled = [
      input[4],
      input[9],
      input[1],
      input[7],
      input[0],
      input[5],
      input[2],
      input[8],
      input[3],
      input[6],
    ].filter((entry): entry is BandLayoutItem => entry !== undefined);

    const first = layoutOneModuleBand(input, { placementOptions: { maxCols: 80, maxRows: 80 } });
    const second = layoutOneModuleBand(shuffled, {
      placementOptions: { maxCols: 80, maxRows: 80 },
    });

    expect(first).toEqual(second);
    expect(
      first.shapePlan.groups.map((group) => group.items.map((assignment) => assignment.name)),
    ).toEqual([['A', 'B', 'C'], ['D', 'E', 'F'], ['G', 'H', 'I'], ['J']]);
  });

  it('lets measured row width change placement size without changing group assignment', () => {
    const base = layoutOneModuleBand(
      [item('A', rankDepth(1), { rowWidthPx: 70 }), item('B', rankDepth(1), { rowWidthPx: 70 })],
      {
        shapeStrategy: () => [2],
        placementOptions: { maxCols: 60, maxRows: 20 },
      },
    );
    const wider = layoutOneModuleBand(
      [item('A', rankDepth(1), { rowWidthPx: 230 }), item('B', rankDepth(1), { rowWidthPx: 70 })],
      {
        shapeStrategy: () => [2],
        placementOptions: { maxCols: 60, maxRows: 20 },
      },
    );

    expect(assignmentSummary(wider)).toEqual(assignmentSummary(base));
    expect(placedItem(wider, 'item:A').fragments[0]?.own.cols).toBeGreaterThan(
      placedItem(base, 'item:A').fragments[0]?.own.cols ?? 0,
    );
    expect(placedItem(wider, 'item:B').origin.col).toBeGreaterThan(
      placedItem(base, 'item:B').origin.col,
    );
  });

  it('threads placement extra gaps without changing band shape assignment', () => {
    // Two items in ONE depth bucket spread into two same-rank display groups
    // (band_shape rankOrderForBucket gives them a shared rankOrder). The extra
    // gap is a same-rank spreading channel, so group 1 (B) sits to the right of
    // group 0 (A) and the gap widens that track by its cells.
    const input = [item('A', rankDepth(1)), item('B', rankDepth(1))];
    const base = layoutOneModuleBand(input, {
      shapeStrategy: () => [2],
      placementOptions: { maxCols: 60, maxRows: 20 },
    });
    const spaced = layoutOneModuleBand(input, {
      shapeStrategy: () => [2],
      placementOptions: {
        maxCols: 60,
        maxRows: 20,
        extraGaps: [{ bandId: 'band:a', axis: 'x', afterOrder: 0, cells: 3 }],
      },
    });

    expect(assignmentSummary(spaced)).toEqual(assignmentSummary(base));
    expect(placedItem(spaced, 'item:B').origin.col).toBe(placedItem(base, 'item:B').origin.col + 3);
  });

  it('keeps long-row splits as multiple owner-scoped placed fragments in visual order', () => {
    const splitLongRow: LayoutBoxSplitStrategy = () => ['row:long'];
    const result = layoutOneModuleBand(
      [
        item('Vec', rankDepth(0), {
          rows: [
            { id: 'row:normal-a', name: 'normal-a', measuredWidthPx: 120, measuredHeightPx: 20 },
            { id: 'row:long', name: 'long', measuredWidthPx: 520, measuredHeightPx: 10 },
            { id: 'row:normal-b', name: 'normal-b', measuredWidthPx: 130, measuredHeightPx: 10 },
          ],
          splitStrategy: splitLongRow,
        }),
      ],
      { placementOptions: { maxCols: 80, maxRows: 20 } },
    );

    const placed = placedItem(result, 'item:Vec');

    expect(placed.fragments.map((fragment) => fragment.fragmentId)).toEqual([
      '0:main',
      '1:split-row',
      '2:body',
    ]);
    expect(placed.fragments.map((fragment) => fragment.ownerId)).toEqual([
      'item:Vec',
      'item:Vec',
      'item:Vec',
    ]);
    expect(placed.fragments.map((fragment) => fragment.itemId)).toEqual([
      'item:Vec',
      'item:Vec',
      'item:Vec',
    ]);
    expect(placed.fragments.map((fragment) => fragment.rowIds)).toEqual([
      ['row:normal-a'],
      ['row:long'],
      ['row:normal-b'],
    ]);
    expect(placed.fragments.map((fragment) => fragment.own.row)).toEqual([0, 4, 5]);
  });

  it('preserves full-band shape context for ten items at one depth plus later depths', () => {
    const crowdedDepth = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'].map((name) =>
      item(name, rankDepth(1)),
    );
    const laterDepths = [2, 3, 4, 5, 6].map((depth) => item(`D${depth}`, rankDepth(depth)));
    const result = layoutOneModuleBand([...crowdedDepth, ...laterDepths], {
      placementOptions: { maxCols: 120, maxRows: 120 },
    });

    const expectedPlan = planBandShape(
      [...crowdedDepth, ...laterDepths].map(({ id, name, depth }) => ({ id, name, depth })),
    );
    const crowdedAloneGroups = layoutOneModuleBand(crowdedDepth).shapePlan.groups.filter(
      (group) => group.depth.kind === 'rank' && group.depth.depth === 1,
    ).length;
    const fullBandGroups = result.shapePlan.groups.filter(
      (group) => group.depth.kind === 'rank' && group.depth.depth === 1,
    ).length;

    expect(result.shapePlan).toEqual(expectedPlan);
    expect(fullBandGroups).toBeLessThan(crowdedAloneGroups);
  });

  it('starts later display-group tracks after the previous group max width', () => {
    const result = layoutOneModuleBand(
      ['A', 'C', 'D', 'E', 'F', 'G']
        .map((name) => item(name, rankDepth(1)))
        .concat([item('B', rankDepth(1), { rowWidthPx: 320 })]),
      {
        shapeStrategy: () => [4],
        placementOptions: { maxCols: 120, maxRows: 80 },
      },
    );

    const groupFirsts = result.shapePlan.groups.map((group) => {
      const first = group.items[0];
      if (first === undefined) {
        throw new Error('Expected non-empty display group.');
      }
      return placedItem(result, first.id);
    });

    // The display group track is owned by placement. Later groups start after
    // the previous group's widest placed item, giving a simple aligned-column
    // layout instead of row-local backfilling.
    const groupCols = groupFirsts.map((placed) => placed.origin.col);
    for (let index = 1; index < groupCols.length; index += 1) {
      expect(groupCols[index]).toBeGreaterThan(groupCols[index - 1] ?? -1);
    }
    expect(placedItem(result, 'item:C').origin.col).toBeGreaterThanOrEqual(
      placedItem(result, 'item:B').fragments[0]?.own.cols ?? 0,
    );
  });

  it('does not consume previous positions; repeated calls produce equal layouts', () => {
    const input = [
      item('B', rankDepth(1), { rowWidthPx: 120 }),
      item('Prelude', prelude, { rowWidthPx: 90 }),
      item('A', rankDepth(1), { rowWidthPx: 80 }),
    ];

    const first = layoutOneModuleBand(input, { placementOptions: { maxCols: 80, maxRows: 80 } });
    const second = layoutOneModuleBand(input, { placementOptions: { maxCols: 80, maxRows: 80 } });

    expect(second).toEqual(first);
  });
});
