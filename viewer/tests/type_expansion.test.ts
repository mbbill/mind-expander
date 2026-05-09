import { describe, expect, it } from 'vitest';
import type { DriftIndex } from '../src/analysis/drift.ts';
import type { OwnershipIndex } from '../src/analysis/ownership.ts';
import {
  ancestorModuleIds,
  forwardRoutedTargetModulesFor,
  memberArrowRowsForType,
  targetModulesForMemberRow,
} from '../src/view/type_expansion.ts';

function ownership(fieldTargets: OwnershipIndex['fieldTargets']): OwnershipIndex {
  return {
    owns: new Map(),
    ownedBy: new Map(),
    fieldTargets,
    methodTargets: new Map(),
  };
}

describe('type expansion target modules', () => {
  it('returns ancestor modules for forward-routed ownership targets only', () => {
    const source = 'c::src::Owner';
    const forwardA = 'c::dst::ForwardA';
    const forwardB = 'c::dst::ForwardB';
    const backward = 'c::src::Backward';
    const drift = 'c::other::Drift';
    const idx = ownership(
      new Map([
        [
          source,
          new Map([
            ['a', [forwardA]],
            ['b', [forwardB]],
            ['backward', [backward]],
            ['drift', [drift]],
          ]),
        ],
      ]),
    );
    const depth = new Map([
      [source, 1],
      [forwardA, 2],
      [forwardB, 3],
      [backward, 1],
      [drift, 4],
    ]);
    const driftIndex: DriftIndex = {
      typeClass: new Map([
        [forwardA, 'at_lca'],
        [forwardB, 'within_budget'],
        [backward, 'at_lca'],
        [drift, 'drift_sideways'],
      ]),
      lca: new Map(),
    };

    expect(forwardRoutedTargetModulesFor(source, idx, depth, driftIndex, 'c')).toEqual([
      'c',
      'c::dst',
    ]);
  });

  it('computes ancestor module ids for a type path', () => {
    expect(ancestorModuleIds('c::a::b::Type', 'c')).toEqual(['c', 'c::a', 'c::a::b']);
  });

  it('returns target modules for a selected member row regardless of drift route class', () => {
    const idx = ownership(
      new Map([
        [
          'c::Owner',
          new Map([
            ['red', ['c::drifted::RedTarget']],
            ['orange', ['c::deep::OrangeTarget']],
          ]),
        ],
      ]),
    );

    expect(targetModulesForMemberRow('c::Owner', 'red', 'field', idx, 'c')).toEqual([
      'c',
      'c::drifted',
    ]);
    expect(targetModulesForMemberRow('c::Owner', 'orange', 'field', idx, 'c')).toEqual([
      'c',
      'c::deep',
    ]);
  });

  it('lists member rows that can emit arrows for a type', () => {
    const idx: OwnershipIndex = {
      ...ownership(
        new Map([
          [
            'c::Owner',
            new Map([
              ['field_a', ['c::TargetA']],
              ['field_b', ['c::TargetB']],
            ]),
          ],
        ]),
      ),
      methodTargets: new Map([['c::Owner', new Map([['method_a', ['c::TargetC']]])]]),
    };

    expect(memberArrowRowsForType('c::Owner', idx)).toEqual([
      { rowName: 'field_a', rowKind: 'field' },
      { rowName: 'field_b', rowKind: 'field' },
      { rowName: 'method_a', rowKind: 'method' },
    ]);
  });
});
