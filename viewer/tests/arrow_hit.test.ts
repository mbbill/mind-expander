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
  const opts = { hitTolerance: 5 };

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

  it('classifies a click in the first half of arc length as source', () => {
    const a = arrow([
      [0, 0],
      [100, 0],
    ]);
    expect(pickArrowsAtPoint({ x: 15, y: 0 }, [a], opts)[0]?.zone).toBe('source');
    expect(pickArrowsAtPoint({ x: 49, y: 0 }, [a], opts)[0]?.zone).toBe('source');
  });

  it('classifies a click in the second half of arc length as target', () => {
    const a = arrow([
      [0, 0],
      [100, 0],
    ]);
    expect(pickArrowsAtPoint({ x: 51, y: 0 }, [a], opts)[0]?.zone).toBe('target');
    expect(pickArrowsAtPoint({ x: 85, y: 0 }, [a], opts)[0]?.zone).toBe('target');
  });

  it('resolves the exact midpoint to source (forward-default)', () => {
    // Tie at half arc length → forward direction. Keeps "click to
    // advance" intuition rather than bouncing back to the source.
    const a = arrow([
      [0, 0],
      [100, 0],
    ]);
    expect(pickArrowsAtPoint({ x: 50, y: 0 }, [a], opts)[0]?.zone).toBe('source');
  });

  it('splits along arc length, not Euclidean distance', () => {
    // L-shaped polyline (0,0)→(100,0)→(100,100), total arc length 200.
    // The midpoint by ARC LENGTH is exactly at the corner (100, 0). A
    // click near (100, 50) is at arc length 150 — past the midpoint,
    // so it lands in the target half even though it's geometrically
    // closer to the target endpoint than the source endpoint.
    const a = arrow([
      [0, 0],
      [100, 0],
      [100, 100],
    ]);
    expect(pickArrowsAtPoint({ x: 100, y: 50 }, [a], opts)[0]?.zone).toBe('target');
    // A click at arc length 50 (along the horizontal leg) is in the
    // first half — source side.
    expect(pickArrowsAtPoint({ x: 50, y: 0 }, [a], opts)[0]?.zone).toBe('source');
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

  it('honors the per-call tolerance value', () => {
    const a = arrow([
      [0, 0],
      [100, 0],
    ]);
    expect(pickArrowsAtPoint({ x: 50, y: 4 }, [a], { hitTolerance: 3 })).toHaveLength(0);
    expect(pickArrowsAtPoint({ x: 50, y: 4 }, [a], { hitTolerance: 5 })).toHaveLength(1);
  });
});
