import { describe, expect, it } from 'vitest';
import type { FunctionCallIndex } from '../src/analysis/calls.ts';
import type { DriftIndex } from '../src/analysis/drift.ts';
import type { Arrow } from '../src/analysis/layout_model.ts';
import type { OwnershipIndex } from '../src/analysis/ownership.ts';
import {
  ancestorModuleIds,
  callableBucketIdsForType,
  callerExpansionIdsForFunction,
  forwardRoutedTargetModulesFor,
  memberArrowRowsForType,
  targetExpansionIdsForArrowTarget,
  targetExpansionIdsForMemberRow,
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

function calls(rows: FunctionCallIndex['rowsByType'] = new Map()): FunctionCallIndex {
  return {
    rowByFunction: new Map(),
    callTargetsByFunction: new Map(),
    callsByFunction: new Map(),
    incomingCallsByFunction: new Map(),
    nonLocalCallers: new Set(),
    rowsByType: rows,
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

    const callIndex = calls();
    expect(targetModulesForMemberRow('c::Owner', 'red', 'field', idx, callIndex, 'c')).toEqual([
      'c',
      'c::drifted',
    ]);
    expect(targetModulesForMemberRow('c::Owner', 'orange', 'field', idx, callIndex, 'c')).toEqual([
      'c',
      'c::deep',
    ]);
  });

  it('returns callee row expansion ids for selected local function rows', () => {
    const idx = ownership(new Map());
    const callIndex: FunctionCallIndex = {
      rowByFunction: new Map(),
      callTargetsByFunction: new Map([
        [
          'c::src::Owner::caller',
          [
            {
              functionFullPath: 'c::src::Target::callee',
              typeId: 'c::src::Target',
              rowName: 'callee',
              rowKind: 'method',
              moduleId: 'c::src',
              bucketId: 'c::src::Target::__methods_pub',
            },
            {
              functionFullPath: 'c::other::Far::callee',
              typeId: 'c::other::Far',
              rowName: 'callee',
              rowKind: 'method',
              moduleId: 'c::other',
              bucketId: 'c::other::Far::__methods_pub',
            },
          ],
        ],
      ]),
      callsByFunction: new Map(),
      incomingCallsByFunction: new Map(),
      nonLocalCallers: new Set(),
      rowsByType: new Map([
        [
          'c::src::Owner',
          [
            {
              functionFullPath: 'c::src::Owner::caller',
              typeId: 'c::src::Owner',
              rowName: 'caller',
              rowKind: 'method',
              moduleId: 'c::src',
              bucketId: 'c::src::Owner::__methods_pub',
            },
          ],
        ],
      ]),
    };

    expect(
      targetExpansionIdsForMemberRow('c::src::Owner', 'caller', 'method', idx, callIndex, 'c'),
    ).toEqual([
      'c',
      'c::src',
      'c::src::Target',
      'c::src::Target::__methods_pub',
      'c::other',
      'c::other::Far',
      'c::other::Far::__methods_pub',
    ]);
  });

  it('lists member rows that can emit arrows for a type', () => {
    const idx = ownership(
      new Map([
        [
          'c::Owner',
          new Map([
            ['field_a', ['c::TargetA']],
            ['field_b', ['c::TargetB']],
          ]),
        ],
      ]),
    );
    const callIndex: FunctionCallIndex = {
      rowByFunction: new Map(),
      callTargetsByFunction: new Map([
        [
          'c::Owner::method_a',
          [
            {
              functionFullPath: 'c::Target::callee',
              typeId: 'c::Target',
              rowName: 'callee',
              rowKind: 'method',
              moduleId: 'c',
              bucketId: 'c::Target::__methods_pub',
            },
          ],
        ],
      ]),
      callsByFunction: new Map(),
      incomingCallsByFunction: new Map(),
      nonLocalCallers: new Set(['c::Owner::method_a']),
      rowsByType: new Map([
        [
          'c::Owner',
          [
            {
              functionFullPath: 'c::Owner::method_a',
              typeId: 'c::Owner',
              rowName: 'method_a',
              rowKind: 'method',
              moduleId: 'c',
              bucketId: 'c::Owner::__methods_pub',
            },
          ],
        ],
      ]),
    };

    expect(memberArrowRowsForType('c::Owner', idx, callIndex)).toEqual([
      { rowName: 'field_a', rowKind: 'field' },
      { rowName: 'field_b', rowKind: 'field' },
      { rowName: 'method_a', rowKind: 'method' },
    ]);
  });

  it('lists callable buckets to expand without selecting callable rows', () => {
    const callIndex: FunctionCallIndex = {
      rowByFunction: new Map(),
      callTargetsByFunction: new Map(),
      callsByFunction: new Map(),
      incomingCallsByFunction: new Map(),
      nonLocalCallers: new Set(),
      rowsByType: new Map([
        [
          'c::Owner',
          [
            {
              functionFullPath: 'c::Owner::pub_method',
              typeId: 'c::Owner',
              rowName: 'pub_method',
              rowKind: 'method',
              moduleId: 'c',
              bucketId: 'c::Owner::__methods_pub',
            },
            {
              functionFullPath: 'c::Owner::private_method',
              typeId: 'c::Owner',
              rowName: 'private_method',
              rowKind: 'method',
              moduleId: 'c',
              bucketId: 'c::Owner::__methods_private',
            },
            {
              functionFullPath: 'c::free_function',
              typeId: 'c::__fn_pub',
              rowName: 'free_function',
              rowKind: 'function',
              moduleId: 'c',
              bucketId: null,
            },
          ],
        ],
      ]),
    };

    expect(callableBucketIdsForType('c::Owner', callIndex)).toEqual([
      'c::Owner::__methods_pub',
      'c::Owner::__methods_private',
    ]);
  });

  it('returns caller row expansion ids for incoming call targets', () => {
    const callerRow = {
      functionFullPath: 'c::src::Owner::caller',
      typeId: 'c::src::Owner',
      rowName: 'caller',
      rowKind: 'method' as const,
      moduleId: 'c::src',
      bucketId: 'c::src::Owner::__methods_pub',
    };
    const targetRow = {
      functionFullPath: 'c::dst::Target::callee',
      typeId: 'c::dst::Target',
      rowName: 'callee',
      rowKind: 'method' as const,
      moduleId: 'c::dst',
      bucketId: 'c::dst::Target::__methods_pub',
    };
    const callIndex: FunctionCallIndex = {
      rowByFunction: new Map(),
      callTargetsByFunction: new Map(),
      callsByFunction: new Map(),
      incomingCallsByFunction: new Map([
        [
          'c::dst::Target::callee',
          [
            {
              caller: callerRow.functionFullPath,
              callee: targetRow.functionFullPath,
              kind: 'method',
              resolution: 'exact',
              origin: '.callee',
              locality: 'other_module',
              callerRow,
              calleeRow: targetRow,
            },
          ],
        ],
      ]),
      nonLocalCallers: new Set(),
      rowsByType: new Map(),
    };

    expect(callerExpansionIdsForFunction('c::dst::Target::callee', callIndex, 'c')).toEqual([
      'c',
      'c::src',
      'c::src::Owner',
      'c::src::Owner::__methods_pub',
    ]);
  });

  it('returns expansion ids for the selected arrow target row', () => {
    const callIndex: FunctionCallIndex = {
      rowByFunction: new Map(),
      callTargetsByFunction: new Map(),
      callsByFunction: new Map(),
      incomingCallsByFunction: new Map(),
      nonLocalCallers: new Set(),
      rowsByType: new Map([
        [
          'c::dst::Target',
          [
            {
              functionFullPath: 'c::dst::Target::callee',
              typeId: 'c::dst::Target',
              rowName: 'callee',
              rowKind: 'method',
              moduleId: 'c::dst',
              bucketId: 'c::dst::Target::__methods_pub',
            },
          ],
        ],
      ]),
    };
    const arrow: Arrow = {
      waypoints: [
        { x: 0, y: 0 },
        { x: 10, y: 10 },
      ],
      fromTypeId: 'c::src::Owner',
      fromFieldName: 'caller',
      fromRowKind: 'method',
      toTypeId: 'c::dst::Target',
      toFieldName: 'callee',
      toRowKind: 'method',
      kind: 'call',
      driftClass: 'at_lca',
    };

    expect(targetExpansionIdsForArrowTarget(arrow, callIndex, 'c')).toEqual([
      'c',
      'c::dst',
      'c::dst::Target',
      'c::dst::Target::__methods_pub',
    ]);
  });
});
