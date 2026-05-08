import { describe, expect, it } from 'vitest';
import {
  distanceToPolyline,
  distanceToSegment,
  pickArrowsAtPoint,
} from '../src/analysis/arrow_hit.ts';
import type { Arrow } from '../src/analysis/layout_bak.ts';

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
    // Horizontal segment (0,0)→(10,0). Point at (5, 3) projects onto (5,0),
    // distance 3.
    expect(distanceToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(3);
  });

  it('clamps to the segment endpoints when the projection falls outside', () => {
    // Point left of the segment — distance is to the left endpoint.
    expect(distanceToSegment({ x: -5, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
    // Point right of the segment — distance is to the right endpoint.
    expect(distanceToSegment({ x: 15, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
  });

  it('handles zero-length segments without dividing by zero', () => {
    expect(distanceToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(5);
  });
});

describe('distanceToPolyline', () => {
  it('returns the min distance across all segments', () => {
    // L-shaped polyline: (0,0) → (10,0) → (10,10). Point (12, 5) is closest
    // to the vertical leg, distance 2.
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
  const opts = { hitTolerance: 5, headRadius: 8 };

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

  it('classifies a click near the FINAL waypoint as a head click', () => {
    // Final waypoint is (100, 0). A click at (98, 0) is within headRadius=8.
    const a = arrow([
      [0, 0],
      [100, 0],
    ]);
    const hits = pickArrowsAtPoint({ x: 98, y: 0 }, [a], opts);
    expect(hits[0]?.zone).toBe('head');
  });

  it('classifies a click far from the head as a body click', () => {
    const a = arrow([
      [0, 0],
      [100, 0],
    ]);
    const hits = pickArrowsAtPoint({ x: 30, y: 0 }, [a], opts);
    expect(hits[0]?.zone).toBe('body');
  });

  it('is forgiving: a click on the arrowhead tip itself counts as head', () => {
    // The final waypoint IS the head tip — distance 0 → 'head'.
    const a = arrow([
      [0, 0],
      [50, 0],
    ]);
    const hits = pickArrowsAtPoint({ x: 50, y: 0 }, [a], opts);
    expect(hits[0]?.zone).toBe('head');
  });

  it('returns multiple candidates when several arrows overlap the click', () => {
    // Two arrows both passing through (50, 0).
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
    // Tighter tolerance: y=4 no longer counts.
    expect(
      pickArrowsAtPoint({ x: 50, y: 4 }, [a], { hitTolerance: 3, headRadius: 8 }),
    ).toHaveLength(0);
    // Larger tolerance: y=4 does count.
    expect(
      pickArrowsAtPoint({ x: 50, y: 4 }, [a], { hitTolerance: 5, headRadius: 8 }),
    ).toHaveLength(1);
  });
});
