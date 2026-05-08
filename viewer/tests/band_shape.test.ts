import { describe, expect, it } from 'vitest';
import { type BandDepth, type BandShapeItem, planBandShape } from '../src/layout2/band_shape.ts';

const prelude: BandDepth = { kind: 'prelude' };

function rankDepth(depth: number): BandDepth {
  return { kind: 'rank', depth };
}

function item(name: string, depth: BandDepth): BandShapeItem {
  return {
    id: `${depth.kind}:${depth.kind === 'rank' ? depth.depth : 'prelude'}:${name}`,
    name,
    depth,
  };
}

function namesByGroup(items: readonly BandShapeItem[]): readonly (readonly string[])[] {
  return planBandShape(items).groups.map((group) =>
    group.items.map((assignment) => assignment.name),
  );
}

describe('layout2 band shape planner', () => {
  it('sorts unsorted input deterministically by prelude, rank depth, then name', () => {
    const input = [
      item('Delta', rankDepth(2)),
      item('Zulu', prelude),
      item('Bravo', rankDepth(1)),
      item('Alpha', rankDepth(1)),
      item('Echo', rankDepth(2)),
      item('Beta', prelude),
    ];
    const shuffled = [input[3], input[0], input[5], input[1], input[4], input[2]].filter(
      (entry): entry is BandShapeItem => entry !== undefined,
    );

    expect(planBandShape(input).assignments).toEqual(planBandShape(shuffled).assignments);
    expect(planBandShape(input).assignments.map((assignment) => assignment.name)).toEqual([
      'Beta',
      'Zulu',
      'Alpha',
      'Bravo',
      'Delta',
      'Echo',
    ]);
  });

  it('plans from stable identity, name, depth, and counts rather than measured boxes', () => {
    const inputs = ['A', 'B', 'C', 'D'].map((name) => item(name, rankDepth(1)));

    expect(planBandShape(inputs)).toEqual(
      planBandShape(inputs.map(({ id, name, depth }) => ({ id, name, depth }))),
    );
  });

  it('assigns ten same-depth items into stable count-only rightward groups', () => {
    const inputs = ['J', 'H', 'F', 'D', 'B', 'I', 'G', 'E', 'C', 'A'].map((name) =>
      item(name, rankDepth(1)),
    );

    expect(namesByGroup(inputs)).toEqual([
      ['A', 'B', 'C'],
      ['D', 'E', 'F'],
      ['G', 'H', 'I'],
      ['J'],
    ]);
  });

  it('uses full-band context when choosing same-depth group counts', () => {
    const crowdedDepth = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'].map((name) =>
      item(name, rankDepth(1)),
    );
    const laterDepths = [2, 3, 4, 5, 6].map((depth) => item(`D${depth}`, rankDepth(depth)));

    const crowdedAloneGroups = planBandShape(crowdedDepth).groups.filter(
      (group) => group.depth.kind === 'rank' && group.depth.depth === 1,
    ).length;
    const fullBandGroups = planBandShape([...crowdedDepth, ...laterDepths]).groups.filter(
      (group) => group.depth.kind === 'rank' && group.depth.depth === 1,
    ).length;

    expect(crowdedAloneGroups).toBe(4);
    expect(fullBandGroups).toBeLessThan(crowdedAloneGroups);
  });

  it('exposes band-global group order across prelude and rank depth groups', () => {
    const plan = planBandShape(
      [
        item('TypeB', rankDepth(0)),
        item('FunctionGroup', prelude),
        item('TypeC', rankDepth(0)),
        item('DepthOne', rankDepth(1)),
        item('TypeA', rankDepth(0)),
      ],
      () => [1, 2, 1],
    );

    expect(
      plan.groups.map((group) => ({
        depth: group.depth.kind === 'rank' ? group.depth.depth : 'prelude',
        bandOrder: group.bandOrder,
        groupIndex: group.groupIndex,
        names: group.items.map((assignment) => assignment.name),
      })),
    ).toEqual([
      { depth: 'prelude', bandOrder: 0, groupIndex: 0, names: ['FunctionGroup'] },
      { depth: 0, bandOrder: 1, groupIndex: 0, names: ['TypeA', 'TypeB'] },
      { depth: 0, bandOrder: 2, groupIndex: 1, names: ['TypeC'] },
      { depth: 1, bandOrder: 3, groupIndex: 0, names: ['DepthOne'] },
    ]);

    expect(plan.assignments.map((assignment) => assignment.name)).toEqual([
      'FunctionGroup',
      'TypeA',
      'TypeB',
      'TypeC',
      'DepthOne',
    ]);
    expect(plan.assignments.map((assignment) => assignment.groupOrder)).toEqual([0, 1, 1, 2, 3]);
  });
});
