import { describe, expect, it } from 'vitest';
import { INCOMING_CALL_MARKER_OFFSET } from '../src/analysis/layout_metrics.ts';
import type { Arrow, FieldRow, Layout, TypeBox } from '../src/analysis/layout_model.ts';
import { arrowEndpointLayoutPoint } from '../src/view/arrow_navigation.ts';

describe('arrowEndpointLayoutPoint', () => {
  it('resolves the source endpoint to the caller row right edge (arrowSourceX)', () => {
    const layout = testLayout({
      types: [
        type('Caller', { x: 0, y: 20, width: 80, height: 40 }, [
          row({ name: 'caller', kind: 'method', x: 8, y: 30, arrowSourceX: 60 }),
        ]),
        type('Callee', { x: 200, y: 80, width: 80, height: 40 }, [
          row({ name: 'callee', kind: 'method', x: 208, y: 90, arrowSourceX: 260 }),
        ]),
      ],
    });
    const a = callArrow('Caller', 'caller', 'Callee', 'callee');

    expect(arrowEndpointLayoutPoint(layout, a, 'source')).toEqual({ x: 60, y: 30 });
  });

  it('resolves the target endpoint to the callee row arrow-tip x, not the label left edge', () => {
    // arrowTargetEntryPoint = row.x - markerOffset(if any) - LABEL_GAP(4).
    // No incoming marker → just row.x - 4.
    const layout = testLayout({
      types: [
        type('Caller', { x: 0, y: 20, width: 80, height: 40 }, [
          row({ name: 'caller', kind: 'method', x: 8, y: 30, arrowSourceX: 60 }),
        ]),
        type('Callee', { x: 200, y: 80, width: 80, height: 40 }, [
          row({ name: 'callee', kind: 'method', x: 208, y: 90, arrowSourceX: 260 }),
        ]),
      ],
    });
    const a = callArrow('Caller', 'caller', 'Callee', 'callee');

    expect(arrowEndpointLayoutPoint(layout, a, 'target')).toEqual({ x: 204, y: 90 });
  });

  it('subtracts the incoming-call marker offset from the callee target point', () => {
    const layout = testLayout({
      types: [
        type('Caller', { x: 0, y: 20, width: 80, height: 40 }, [
          row({ name: 'caller', kind: 'method', x: 8, y: 30, arrowSourceX: 60 }),
        ]),
        type('Callee', { x: 200, y: 80, width: 80, height: 40 }, [
          row({
            name: 'callee',
            kind: 'method',
            x: 208,
            y: 90,
            arrowSourceX: 260,
            hasIncomingCalls: true,
          }),
        ]),
      ],
    });
    const a = callArrow('Caller', 'caller', 'Callee', 'callee');

    expect(arrowEndpointLayoutPoint(layout, a, 'target')).toEqual({
      x: 208 - INCOMING_CALL_MARKER_OFFSET - 4,
      y: 90,
    });
  });

  it('falls back to the type box left-mid edge when the arrow has no row target', () => {
    const layout = testLayout({
      types: [
        type('Caller', { x: 0, y: 20, width: 80, height: 40 }, [
          row({ name: 'caller', kind: 'method', x: 8, y: 30, arrowSourceX: 60 }),
        ]),
        type('Target', { x: 200, y: 80, width: 120, height: 60 }, []),
      ],
    });
    const a = ownershipArrow('Caller', 'caller', 'Target');

    expect(arrowEndpointLayoutPoint(layout, a, 'target')).toEqual({ x: 200, y: 110 });
  });

  it('returns null when the endpoint type is not in the current layout', () => {
    const layout = testLayout({ types: [] });
    const a = callArrow('Caller', 'caller', 'Callee', 'callee');
    expect(arrowEndpointLayoutPoint(layout, a, 'source')).toBeNull();
    expect(arrowEndpointLayoutPoint(layout, a, 'target')).toBeNull();
  });

  it('returns null when the layout itself is null', () => {
    const a = callArrow('Caller', 'caller', 'Callee', 'callee');
    expect(arrowEndpointLayoutPoint(null, a, 'source')).toBeNull();
    expect(arrowEndpointLayoutPoint(null, a, 'target')).toBeNull();
  });
});

function callArrow(
  fromTypeId: string,
  fromFieldName: string,
  toTypeId: string,
  toFieldName: string,
): Arrow {
  return {
    waypoints: [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ],
    fromTypeId,
    fromFieldName,
    fromRowKind: 'method',
    toTypeId,
    toFieldName,
    toRowKind: 'method',
    kind: 'call',
    driftClass: 'at_lca',
  };
}

function ownershipArrow(fromTypeId: string, fromFieldName: string, toTypeId: string): Arrow {
  return {
    waypoints: [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ],
    fromTypeId,
    fromFieldName,
    fromRowKind: 'field',
    toTypeId,
    kind: 'ownership',
    driftClass: 'at_lca',
  };
}

function row(input: {
  name: string;
  kind: 'field' | 'method' | 'function';
  x: number;
  y: number;
  arrowSourceX: number;
  hasIncomingCalls?: boolean;
}): FieldRow {
  return {
    name: input.name,
    tyText: '',
    ownership: 'primitive',
    x: input.x,
    y: input.y,
    arrowSourceX: input.arrowSourceX,
    targets: [],
    callTargets: [],
    callRefs: [],
    incomingCallRefs: [],
    functionFullPath: null,
    callsOutsideModule: false,
    hasExternalCalls: false,
    hasUnresolvedCalls: false,
    hasOutgoingCalls: false,
    hasIncomingCalls: input.hasIncomingCalls ?? false,
    kind: input.kind,
    bucketId: null,
    memberDriftClass: null,
  };
}

function type(
  id: string,
  rect: { x: number; y: number; width: number; height: number },
  fields: readonly FieldRow[],
): TypeBox {
  return {
    id,
    label: id,
    typeKind: 'struct',
    visibility: 'pub',
    fullPath: id,
    modulePath: '',
    col: 0,
    x: rect.x,
    y: rect.y,
    width: rect.width,
    headerArrowX: null,
    headerHitWidth: rect.width,
    height: rect.height,
    hasFields: fields.length > 0,
    expanded: fields.length > 0,
    totalFieldCount: fields.length,
    isGhost: false,
    ghostTarget: null,
    fields,
  };
}

function testLayout(input: { types: readonly TypeBox[] }): Layout {
  return {
    modules: [],
    types: input.types,
    arrowLayers: [],
    arrows: [],
    totalHeight: 200,
    totalWidth: 400,
  };
}
