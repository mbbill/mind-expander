import { describe, expect, it } from 'vitest';
import type { Layout } from '../src/analysis/layout_model.ts';
import { lookupLayoutPoint, lookupMemberRowPoint } from '../src/view/layout_lookup.ts';

const layout: Layout = {
  modules: [
    {
      id: 'c::m',
      label: 'm',
      modDepth: 1,
      labelX: 12,
      hitWidth: 40,
      y: 32,
      bandHeight: 80,
      expanded: true,
      hasChildren: false,
      prefixSegments: [],
      leafBg: { name: 'm', xStart: 0, width: 10, isParent: false },
    },
  ],
  types: [
    {
      id: 'c::m::Owner',
      label: 'Owner',
      typeKind: 'struct',
      visibility: 'pub',
      fullPath: 'c::m::Owner',
      modulePath: 'm',
      col: 0,
      x: 100,
      y: 40,
      width: 80,
      headerArrowX: null,
      headerHitWidth: 80,
      height: 56,
      hasFields: true,
      expanded: true,
      totalFieldCount: 1,
      isGhost: false,
      ghostTarget: null,
      fields: [
        {
          name: 'callee',
          tyText: '',
          ownership: 'primitive',
          x: 116,
          y: 64,
          textWidth: 32,
          arrowSourceX: 156,
          targets: [],
          callTargets: [],
          callRefs: [],
          incomingCallRefs: [],
          functionFullPath: 'c::m::Owner::callee',
          callsOutsideModule: false,
          hasExternalCalls: false,
          hasUnresolvedCalls: false,
          hasOutgoingCalls: false,
          hasIncomingCalls: false,
          kind: 'method',
          bucketId: null,
          memberDriftClass: null,
        },
      ],
    },
  ],
  arrowLayers: [],
  arrows: [],
  totalHeight: 120,
  totalWidth: 240,
};

describe('layout lookup helpers', () => {
  it('finds type/module anchor points used for viewport anchoring', () => {
    expect(lookupLayoutPoint(layout, 'c::m::Owner')).toEqual({ x: 100, y: 40 });
    expect(lookupLayoutPoint(layout, 'c::m')).toEqual({ x: 12, y: 32 });
  });

  it('finds member row anchor points by row kind', () => {
    expect(lookupMemberRowPoint(layout, 'c::m::Owner', 'callee', 'method')).toEqual({
      x: 116,
      y: 64,
    });
    expect(lookupMemberRowPoint(layout, 'c::m::Owner', 'callee', 'field')).toBeNull();
  });
});
