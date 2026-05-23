import { describe, expect, it } from 'vitest';

import { contiguousRuns, windowAroundEntity } from '../src/view/code_panel.ts';

// Regression cover for the "huge focus frame" bug: when an entity's
// span covered multiple diff hunks separated by collapse markers,
// the focus frame was computed from the first/last entity-row in
// the panel — producing a single rectangle that stretched across
// the gap and visually attributed unrelated code to the entity.
// The fix splits the frame into one rectangle per contiguous run.
describe('contiguousRuns', () => {
  it('finds a single run when all flagged items are adjacent', () => {
    const items = [false, true, true, true, false, false];
    expect(contiguousRuns(items, (b) => b)).toEqual([[1, 3]]);
  });

  it('splits into separate runs across a gap of unflagged items', () => {
    // Models a method whose span [63, 107] is split across diff hunks:
    // entity-rows at indices 0-2 (hunk a), 4-6 (hunk b — collapse
    // marker at 3 between them). The frame must NOT span index 3.
    const items = [true, true, true, false, true, true, true];
    expect(contiguousRuns(items, (b) => b)).toEqual([
      [0, 2],
      [4, 6],
    ]);
  });

  it('handles a run that ends at the last index', () => {
    const items = [false, true, true];
    expect(contiguousRuns(items, (b) => b)).toEqual([[1, 2]]);
  });

  it('returns no runs when nothing matches', () => {
    expect(contiguousRuns([false, false], (b) => b)).toEqual([]);
  });

  it('returns no runs for an empty input', () => {
    expect(contiguousRuns([], (b) => b)).toEqual([]);
  });

  it('handles many short runs (multi-hunk method)', () => {
    // Real-world shape from arm64::control::lower_terminator_dispatch
    // [63, 107] in the example diff: rows alternate between
    // entity-rows (in-hunk) and collapse markers / out-of-entity
    // context. Each contiguous in-hunk slice should be its own frame.
    const items = [
      true, true, true, true, // hunk a
      false, // collapse marker
      true, true, true, true, true, true, true, // hunk b
      false, // collapse marker
      true, true, true, // hunk c
    ];
    expect(contiguousRuns(items, (b) => b)).toEqual([
      [0, 3],
      [5, 11],
      [13, 15],
    ]);
  });
});

describe('windowAroundEntity', () => {
  it('clamps a tiny window around an entity in a huge collapse gap', () => {
    // Real-world repro: `into_alloc_vec` at head lines 2319-2323
    // sitting inside the trailing collapse marker [1200, 2348).
    // Without clamping, the entire 1148-line gap would expand and
    // bury the diff hunks far above. With pad=5, the visible window
    // is just 14 lines, so hunks remain in the same scroll viewport.
    const { wStart, wEnd } = windowAroundEntity(1200, 2348, 2319, 2323, 5);
    expect(wStart).toBe(2314);
    expect(wEnd).toBe(2328);
  });

  it('clamps the upper edge to gapStart when the entity is near the top', () => {
    // Entity starts only 2 lines into the gap; the upper pad would
    // wander out of the gap. Clamp to gapStart so the above-marker
    // ends up empty (no marker needed).
    const { wStart, wEnd } = windowAroundEntity(100, 200, 102, 108, 5);
    expect(wStart).toBe(100);
    expect(wEnd).toBe(113);
  });

  it('clamps the lower edge to gapEnd-1 when the entity is near the bottom', () => {
    const { wStart, wEnd } = windowAroundEntity(100, 200, 195, 198, 5);
    expect(wStart).toBe(190);
    expect(wEnd).toBe(199);
  });

  it('returns the full gap when the entity fully covers it', () => {
    // Entity range covers more than the gap — the window collapses
    // to the whole gap, no above/below markers needed.
    const { wStart, wEnd } = windowAroundEntity(50, 60, 30, 80, 5);
    expect(wStart).toBe(50);
    expect(wEnd).toBe(59);
  });
});
