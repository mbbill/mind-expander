import { describe, expect, it } from 'vitest';
import type { Arrow, Layout } from '../src/analysis/layout_model.ts';
import { arrowEndpointLayoutPoint } from '../src/view/arrow_navigation.ts';

describe('arrowEndpointLayoutPoint', () => {
  it('returns the fresh arrow waypoints[0] for the source endpoint', () => {
    const stale = callArrow({
      waypoints: [
        { x: 0, y: 0 },
        { x: 9, y: 9 },
      ],
    });
    const fresh = callArrow({
      waypoints: [
        { x: 60, y: 30 },
        { x: 120, y: 30 },
        { x: 120, y: 90 },
        { x: 204, y: 90 },
      ],
    });
    const layout = layoutWith([fresh]);

    expect(arrowEndpointLayoutPoint(layout, stale, 'source')).toEqual({ x: 60, y: 30 });
  });

  it('returns the fresh arrow last waypoint for the target endpoint', () => {
    const stale = callArrow({
      waypoints: [
        { x: 0, y: 0 },
        { x: 9, y: 9 },
      ],
    });
    const fresh = callArrow({
      waypoints: [
        { x: 60, y: 30 },
        { x: 120, y: 30 },
        { x: 120, y: 90 },
        { x: 204, y: 90 },
      ],
    });
    const layout = layoutWith([fresh]);

    expect(arrowEndpointLayoutPoint(layout, stale, 'target')).toEqual({ x: 204, y: 90 });
  });

  it('reads from the fresh layout even when the stale arrow has different waypoints', () => {
    // Regression guard for the original bug: the consumer must not derive
    // endpoints from row/type positions or from the clicked arrow's stale
    // waypoints — it must read the freshly routed arrow's waypoints.
    const stale = callArrow({
      waypoints: [
        { x: 0, y: 0 },
        { x: 9, y: 9 },
      ],
    });
    const fresh = callArrow({
      waypoints: [
        { x: 1000, y: 2000 },
        { x: 3000, y: 4000 },
      ],
    });

    expect(arrowEndpointLayoutPoint(layoutWith([fresh]), stale, 'source')).toEqual({
      x: 1000,
      y: 2000,
    });
    expect(arrowEndpointLayoutPoint(layoutWith([fresh]), stale, 'target')).toEqual({
      x: 3000,
      y: 4000,
    });
  });

  it('matches arrows by edge identity (kind + from + to), not by waypoint shape', () => {
    const target = callArrow({
      fromTypeId: 'Caller',
      fromFieldName: 'caller',
      toTypeId: 'Callee',
      toFieldName: 'callee',
      waypoints: [
        { x: 10, y: 10 },
        { x: 20, y: 20 },
      ],
    });
    const decoy = callArrow({
      fromTypeId: 'Other',
      fromFieldName: 'caller',
      toTypeId: 'Callee',
      toFieldName: 'callee',
      waypoints: [
        { x: 999, y: 999 },
        { x: 1000, y: 1000 },
      ],
    });

    expect(
      arrowEndpointLayoutPoint(
        layoutWith([decoy, target]),
        callArrow({
          fromTypeId: 'Caller',
          fromFieldName: 'caller',
          toTypeId: 'Callee',
          toFieldName: 'callee',
        }),
        'source',
      ),
    ).toEqual({ x: 10, y: 10 });
  });

  it('distinguishes ownership and call arrows that share endpoints', () => {
    // The Arrow.kind is part of edge identity. An ownership edge from a
    // field row and a call edge from a method row could share fromTypeId +
    // toTypeId by coincidence — they must not be confused.
    const ownership = ownershipArrow({
      fromTypeId: 'Source',
      fromFieldName: 'member',
      toTypeId: 'Target',
      waypoints: [
        { x: 1, y: 1 },
        { x: 2, y: 2 },
      ],
    });
    const call = callArrow({
      fromTypeId: 'Source',
      fromFieldName: 'member',
      toTypeId: 'Target',
      toFieldName: 'callee',
      waypoints: [
        { x: 7, y: 7 },
        { x: 8, y: 8 },
      ],
    });
    const layout = layoutWith([ownership, call]);

    expect(
      arrowEndpointLayoutPoint(
        layout,
        ownershipArrow({ fromTypeId: 'Source', fromFieldName: 'member', toTypeId: 'Target' }),
        'target',
      ),
    ).toEqual({ x: 2, y: 2 });
    expect(
      arrowEndpointLayoutPoint(
        layout,
        callArrow({
          fromTypeId: 'Source',
          fromFieldName: 'member',
          toTypeId: 'Target',
          toFieldName: 'callee',
        }),
        'target',
      ),
    ).toEqual({ x: 8, y: 8 });
  });

  it('returns null when the arrow is not in the fresh layout', () => {
    const stale = callArrow({
      waypoints: [
        { x: 0, y: 0 },
        { x: 9, y: 9 },
      ],
    });
    expect(arrowEndpointLayoutPoint(layoutWith([]), stale, 'source')).toBeNull();
    expect(arrowEndpointLayoutPoint(layoutWith([]), stale, 'target')).toBeNull();
  });

  it('returns null when the matched arrow has fewer than two waypoints', () => {
    // routing emits degenerate single-waypoint routes when no clear path
    // exists; navigation has nothing useful to anchor on in that case.
    const degenerate = callArrow({ waypoints: [{ x: 5, y: 5 }] });
    const layout = layoutWith([degenerate]);
    const stale = callArrow({
      waypoints: [
        { x: 0, y: 0 },
        { x: 9, y: 9 },
      ],
    });

    expect(arrowEndpointLayoutPoint(layout, stale, 'source')).toBeNull();
    expect(arrowEndpointLayoutPoint(layout, stale, 'target')).toBeNull();
  });

  it('returns null when the layout itself is null', () => {
    const stale = callArrow({
      waypoints: [
        { x: 0, y: 0 },
        { x: 9, y: 9 },
      ],
    });
    expect(arrowEndpointLayoutPoint(null, stale, 'source')).toBeNull();
    expect(arrowEndpointLayoutPoint(null, stale, 'target')).toBeNull();
  });
});

function callArrow(input: Partial<Arrow> & { readonly waypoints?: Arrow['waypoints'] }): Arrow {
  return {
    waypoints: input.waypoints ?? [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ],
    fromTypeId: input.fromTypeId ?? 'Caller',
    fromFieldName: input.fromFieldName ?? 'caller',
    fromRowKind: input.fromRowKind ?? 'method',
    toTypeId: input.toTypeId ?? 'Callee',
    toFieldName: input.toFieldName ?? 'callee',
    toRowKind: input.toRowKind ?? 'method',
    kind: 'call',
    driftClass: input.driftClass ?? 'at_lca',
  };
}

function ownershipArrow(
  input: Partial<Arrow> & { readonly waypoints?: Arrow['waypoints'] },
): Arrow {
  return {
    waypoints: input.waypoints ?? [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ],
    fromTypeId: input.fromTypeId ?? 'Source',
    fromFieldName: input.fromFieldName ?? 'member',
    fromRowKind: input.fromRowKind ?? 'field',
    toTypeId: input.toTypeId ?? 'Target',
    kind: 'ownership',
    driftClass: input.driftClass ?? 'at_lca',
  };
}

function layoutWith(arrows: readonly Arrow[]): Layout {
  return {
    modules: [],
    types: [],
    arrowLayers: [],
    arrows,
    totalHeight: 0,
    totalWidth: 0,
  };
}
