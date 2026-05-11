import { describe, expect, it } from 'vitest';
import {
  distanceToPolyline,
  distanceToSegment,
  pickArrowsAtPoint,
} from '../src/analysis/arrow_hit.ts';
import type { Arrow } from '../src/analysis/layout_model.ts';

function arrow(
  waypoints: Array<[number, number]>,
  fromTypeId = 'A',
  fromFieldName = 'f',
  toTypeId = 'B',
  kind: Arrow['kind'] = 'ownership',
): Arrow {
  return {
    waypoints: waypoints.map(([x, y]) => ({ x, y })),
    fromTypeId,
    fromFieldName,
    fromRowKind: 'field',
    toTypeId,
    kind,
    driftClass: 'at_lca',
  };
}

describe('distanceToSegment', () => {
  it('returns euclidean distance to nearest interior point on the segment', () => {
    expect(distanceToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(3);
  });

  it('clamps to the segment endpoints when the projection falls outside', () => {
    expect(distanceToSegment({ x: -5, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
    expect(distanceToSegment({ x: 15, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
  });

  it('handles zero-length segments without dividing by zero', () => {
    expect(distanceToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(5);
  });
});

describe('distanceToPolyline', () => {
  it('returns the min distance across all segments', () => {
    const w = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ];
    expect(distanceToPolyline({ x: 12, y: 5 }, w)).toBe(2);
  });

  it('returns Infinity when fewer than two waypoints exist', () => {
    expect(distanceToPolyline({ x: 0, y: 0 }, [])).toBe(Number.POSITIVE_INFINITY);
    expect(distanceToPolyline({ x: 0, y: 0 }, [{ x: 1, y: 1 }])).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('pickArrowsAtPoint', () => {
  const opts = { hitTolerance: 5, endpointRadius: 20 };

  it('returns arrows whose polyline comes within tolerance', () => {
    const a = arrow([
      [0, 0],
      [100, 0],
    ]);
    const hits = pickArrowsAtPoint({ x: 50, y: 3 }, [a], opts);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.arrow).toBe(a);
  });

  it('drops arrows farther than tolerance', () => {
    const a = arrow([
      [0, 0],
      [100, 0],
    ]);
    const hits = pickArrowsAtPoint({ x: 50, y: 50 }, [a], opts);
    expect(hits).toHaveLength(0);
  });

  it('classifies a click within the first endpointRadius of arc length as source', () => {
    // Polyline 0..100 along x; click at x=15 is 15 along arc, inside the
    // 20-unit source window.
    const a = arrow([
      [0, 0],
      [100, 0],
    ]);
    const hits = pickArrowsAtPoint({ x: 15, y: 0 }, [a], opts);
    expect(hits[0]?.zone).toBe('source');
  });

  it('classifies a click within the last endpointRadius of arc length as target', () => {
    const a = arrow([
      [0, 0],
      [100, 0],
    ]);
    const hits = pickArrowsAtPoint({ x: 85, y: 0 }, [a], opts);
    expect(hits[0]?.zone).toBe('target');
  });

  it('classifies a click in the middle band as middle', () => {
    const a = arrow([
      [0, 0],
      [100, 0],
    ]);
    const hits = pickArrowsAtPoint({ x: 50, y: 0 }, [a], opts);
    expect(hits[0]?.zone).toBe('middle');
  });

  it('measures arc length along the polyline, not Euclidean distance', () => {
    // L-shaped polyline (0,0)→(100,0)→(100,100), total arc length 200.
    // endpointRadius=20: source window is first 20 along x, target window
    // is last 20 along the vertical leg. A click near (100, 50) is at arc
    // length 150 — in the middle band — even though Euclidean distance to
    // the target endpoint (100, 100) is only 50.
    const a = arrow([
      [0, 0],
      [100, 0],
      [100, 100],
    ]);
    const hits = pickArrowsAtPoint({ x: 100, y: 50 }, [a], opts);
    expect(hits[0]?.zone).toBe('middle');
  });

  it('clamps source/target windows to half the polyline length on short arrows', () => {
    // Polyline length 10, endpointRadius=20 → each window is 5 (half).
    // The two zones meet exactly at the midpoint with no overlap; the
    // midpoint itself resolves to source.
    const a = arrow([
      [0, 0],
      [10, 0],
    ]);
    expect(pickArrowsAtPoint({ x: 4, y: 0 }, [a], opts)[0]?.zone).toBe('source');
    expect(pickArrowsAtPoint({ x: 5, y: 0 }, [a], opts)[0]?.zone).toBe('source');
    expect(pickArrowsAtPoint({ x: 6, y: 0 }, [a], opts)[0]?.zone).toBe('target');
  });

  it('returns multiple candidates when several arrows overlap the click', () => {
    const a = arrow(
      [
        [0, 0],
        [100, 0],
      ],
      'A',
      'f1',
      'B',
    );
    const b = arrow(
      [
        [50, -10],
        [50, 10],
      ],
      'C',
      'f2',
      'D',
    );
    const hits = pickArrowsAtPoint({ x: 50, y: 0 }, [a, b], opts);
    expect(hits).toHaveLength(2);
  });

  it('sorts candidates by distance, closest first', () => {
    const close = arrow(
      [
        [0, 0],
        [100, 0],
      ],
      'CLOSE',
    );
    const far = arrow(
      [
        [0, 4],
        [100, 4],
      ],
      'FAR',
    );
    const hits = pickArrowsAtPoint({ x: 50, y: 0 }, [close, far], opts);
    expect(hits.map((h) => h.arrow.fromTypeId)).toEqual(['CLOSE', 'FAR']);
  });

  it('skips degenerate arrows (fewer than 2 waypoints)', () => {
    const degenerate = arrow([[0, 0]]);
    const hits = pickArrowsAtPoint({ x: 0, y: 0 }, [degenerate], opts);
    expect(hits).toEqual([]);
  });

  it('honors the per-call tolerance values', () => {
    const a = arrow([
      [0, 0],
      [100, 0],
    ]);
    expect(
      pickArrowsAtPoint({ x: 50, y: 4 }, [a], { hitTolerance: 3, endpointRadius: 20 }),
    ).toHaveLength(0);
    expect(
      pickArrowsAtPoint({ x: 50, y: 4 }, [a], { hitTolerance: 5, endpointRadius: 20 }),
    ).toHaveLength(1);
  });
});
