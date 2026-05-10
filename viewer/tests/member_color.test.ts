import { describe, expect, it } from 'vitest';
import type { Arrow } from '../src/analysis/layout_model.ts';
import {
  callableRowColor,
  memberColorForDriftClass,
  memberRowColorForArrows,
} from '../src/view/tree.ts';

function arrow(kind: Arrow['kind'], driftClass: Arrow['driftClass']): Arrow {
  return {
    waypoints: [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ],
    fromTypeId: 'c::Owner',
    fromFieldName: 'field',
    fromRowKind: kind === 'call' ? 'method' : 'field',
    toTypeId: 'c::Target',
    kind,
    driftClass,
  };
}

describe('member row color', () => {
  it('uses no color when the row has no ownership target drift class', () => {
    expect(memberColorForDriftClass(null)).toBeNull();
  });

  it('uses no color when no ownership arrow is emitted', () => {
    expect(memberRowColorForArrows([])).toBeNull();
    expect(memberRowColorForArrows([arrow('call', 'drift_above')])).toBeNull();
    expect(memberRowColorForArrows([arrow('reexport', 'at_lca')])).toBeNull();
  });

  it('uses blue for canonical ownership members while arrows remain grey', () => {
    expect(memberColorForDriftClass('at_lca')).toBe('#3b82f6');
    expect(memberColorForDriftClass('within_budget')).toBe('#3b82f6');
  });

  it('mirrors drift ownership arrow colors', () => {
    expect(memberColorForDriftClass('drift_below')).toBe('#d97706');
    expect(memberColorForDriftClass('drift_above')).toBe('#ef4444');
    expect(memberColorForDriftClass('drift_sideways')).toBe('#ef4444');
  });

  it('uses the strongest drift color when a member has multiple ownership targets', () => {
    expect(
      memberRowColorForArrows([
        arrow('ownership', 'at_lca'),
        arrow('ownership', 'drift_below'),
        arrow('ownership', 'drift_above'),
      ]),
    ).toBe('#ef4444');
  });

  it('colors callable rows by call locality', () => {
    expect(
      callableRowColor({
        callsOutsideModule: true,
        hasExternalCalls: true,
        hasUnresolvedCalls: true,
        hasOutgoingCalls: true,
      }),
    ).toBe('#2563eb');
    expect(
      callableRowColor({
        callsOutsideModule: true,
        hasExternalCalls: false,
        hasUnresolvedCalls: true,
        hasOutgoingCalls: true,
      }),
    ).toBe('#f97316');
    expect(
      callableRowColor({
        callsOutsideModule: false,
        hasExternalCalls: false,
        hasUnresolvedCalls: false,
        hasOutgoingCalls: true,
      }),
    ).toBe('#334155');
    expect(callableRowColor({ callsOutsideModule: false, hasOutgoingCalls: false })).toBe(
      '#94a3b8',
    );
  });
});
