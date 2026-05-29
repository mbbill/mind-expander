// Tier-2 model/analysis invariants for the `diff-unified-mode` area.
//
// These are pure, node-env tests over the analysis/integration layer
// functions that own union-diff state, asserting the precise
// correct-behavior oracle from test-plan/diff-unified-mode.md:
//
//   - T-C1/T-C2: `canonicalize` cfg-dup merge keeps the `modified`
//     variant (and its prev_span) and resolves Side precedence
//     Modified > Both > Head > Base. Dropping `modified`/prev_span
//     would erase the only base location and collapse the union focus
//     frame to head-only.
//   - T-P1/T-P2: the dormant-but-exported folding contract helpers
//     `windowAroundEntity` / `contiguousRuns`. They are not wired into
//     the current FLAT code-panel renderer, so these are CONTRACT
//     GUARDS for a possible re-introduction of folding — not live-path
//     coverage. They pin the clamp/run-splitting math so folding can
//     return without re-opening the "auto-expand drowns hunks" and
//     "focus frame spans gaps" bugs.
//
// The Tier-2 rollup tests T-A1..A5 from the plan require extracting
// `rebuildDiffMapsSync`/`rebuildDiffRollup` out of the `setupWorkspace`
// closure in main.ts into an exported `analysis/diff_rollup.ts`. That
// module does not exist yet (the plan flags it as required structural
// work), so those tests are deferred to the Tier-3 wave per the plan.

import { describe, expect, it } from 'vitest';
import { canonicalize } from '../../src/data/canonicalize.ts';
import type { Facts, Side, Span, TypeFacts } from '../../src/data/schema.ts';
import { contiguousRuns, windowAroundEntity } from '../../src/view/code_panel.ts';

// --- helpers ----------------------------------------------------------

const FILE = 'src/lib.rs';

/** A `TypeFacts` for a single cfg-blind variant. All variants in a
 *  test share `full_path` so `canonicalize` runs the dedup/merge path
 *  (a single variant short-circuits and never calls `pickSide`). */
function variant(side: Side, opts: { prev_span?: Span; fieldName?: string } = {}): TypeFacts {
  return {
    name: 'Widget',
    full_path: 'c::Widget',
    kind: 'struct',
    visibility: 'pub',
    side,
    fields:
      opts.fieldName !== undefined
        ? [{ name: opts.fieldName, ty_text: 'u32', ownership: 'owned' }]
        : [],
    ...(opts.prev_span !== undefined ? { prev_span: opts.prev_span } : {}),
  };
}

/** Wrap variants of one type (same module) into a Facts the
 *  canonicalizer accepts, then return the single merged TypeFacts. */
function mergeVariants(variants: readonly TypeFacts[]): TypeFacts {
  const facts: Facts = {
    crates: {
      c: {
        name: 'c',
        modules: { '': { path: '', file: FILE, types: variants, functions: [] } },
      },
    },
    edges: [],
  };
  const out = canonicalize(facts);
  const merged = out.crates.c?.modules['']?.types ?? [];
  expect(merged.length, 'cfg-dup variants merge to one record').toBe(1);
  const first = merged[0];
  if (first === undefined) throw new Error('no merged record');
  return first;
}

// --- T-C1 -------------------------------------------------------------

describe('canonicalize — cfg-dup merge keeps the modified variant (T-C1)', () => {
  it('a `both` + `modified` pair merges to `modified` AND lifts prev_span', () => {
    // The modified variant carries the ONLY base location. A naive
    // "first wins" / "Both wins" merge drops prev_span, collapsing the
    // union focus frame to head-only and hiding the deleted half of a
    // modified entity.
    const prev: Span = { file: 'base/lib.rs', start_line: 90, end_line: 98 };
    const merged = mergeVariants([variant('both'), variant('modified', { prev_span: prev })]);

    expect(merged.side).toBe('modified');
    expect(merged.prev_span).toEqual(prev);
  });

  it('prev_span comes from the modified variant even when it is not the structural representative', () => {
    // pickRepresentative prefers the richest variant (more fields), so
    // the `both` variant here is the representative — yet the merged
    // record must still carry the modified variant's prev_span, not the
    // representative's (which has none).
    const prev: Span = { file: 'base/lib.rs', start_line: 5, end_line: 12 };
    const richBoth = variant('both', { fieldName: 'a' });
    const modifiedThin = variant('modified', { prev_span: prev });
    const merged = mergeVariants([richBoth, modifiedThin]);

    expect(merged.side).toBe('modified');
    expect(merged.prev_span).toEqual(prev);
  });

  it('drops a stale prev_span carried by the representative when the merged side is NOT modified', () => {
    // The other half of the prev_span contract (canonicalize.ts:95-97):
    // when no variant is `modified`, the merged record must NOT keep a
    // prev_span — even if the structural representative happened to
    // carry one. A leaked base location on a `both`/`head` entity would
    // draw a phantom red half in the union focus frame for an entity
    // that was never modified.
    const stale: Span = { file: 'base/lib.rs', start_line: 40, end_line: 50 };
    // `richBoth` is the representative (more fields) AND carries the
    // stale prev_span; the merge resolves to `both`, so prev_span must
    // be stripped.
    const richBoth = variant('both', { fieldName: 'a', prev_span: stale });
    const headThin = variant('head');
    const merged = mergeVariants([richBoth, headThin]);

    expect(merged.side).toBe('both');
    expect(merged.prev_span).toBeUndefined();
  });
});

// --- T-C2 -------------------------------------------------------------

describe('canonicalize — Side precedence Modified > Both > Head > Base (T-C2)', () => {
  // Each row pairs two variants; the resolved side must be the highest
  // of the two by the documented ranking. Base is LOWEST because a
  // base-only variant shadowed by any head/both/modified variant for
  // the SAME full_path means the entity still exists in head — it was
  // not removed, so it must not resolve to `base`.
  const cases: ReadonlyArray<{ a: Side; b: Side; expected: Side }> = [
    { a: 'modified', b: 'both', expected: 'modified' },
    { a: 'modified', b: 'head', expected: 'modified' },
    { a: 'modified', b: 'base', expected: 'modified' },
    { a: 'both', b: 'head', expected: 'both' },
    { a: 'both', b: 'base', expected: 'both' },
    { a: 'head', b: 'base', expected: 'head' },
    // Same-side pairs resolve to that side (no spurious promotion).
    { a: 'base', b: 'base', expected: 'base' },
    { a: 'head', b: 'head', expected: 'head' },
  ];

  for (const { a, b, expected } of cases) {
    it(`{${a}, ${b}} ⇒ ${expected}`, () => {
      // Order-independence: assert both orderings resolve identically so
      // the precedence is a true ranking, not an artifact of insertion
      // order.
      const prevFor = (s: Side): { prev_span?: Span } =>
        s === 'modified' ? { prev_span: { file: 'base/lib.rs', start_line: 1, end_line: 2 } } : {};
      expect(mergeVariants([variant(a, prevFor(a)), variant(b, prevFor(b))]).side).toBe(expected);
      expect(mergeVariants([variant(b, prevFor(b)), variant(a, prevFor(a))]).side).toBe(expected);
    });
  }
});

// --- T-P1 -------------------------------------------------------------

describe('windowAroundEntity — clamps auto-expand to entity ± pad (T-P1)', () => {
  // CONTRACT GUARD: this fn is dormant (the flat renderer never folds).
  // It pins the clamp so re-introducing folding cannot recur the
  // "auto-expand of a huge trailing collapse marker drowns the real
  // hunks off-screen" bug. The naive behavior (reveal the whole gap) is
  // exactly what the clamp prevents.
  it('reveals only entity ± pad inside a large trailing gap, not the whole gap', () => {
    // gap [1, 1201) — 1200-line trailing collapse marker; entity at
    // [1100, 1110]; pad 5.
    const { wStart, wEnd } = windowAroundEntity(1, 1201, 1100, 1110, 5);
    expect(wStart).toBe(1095);
    expect(wEnd).toBe(1115);
    // The revealed window is a tiny slice, not the 1200-line gap.
    expect(wEnd - wStart).toBe(20);
  });

  it('clamps the window to the gap bounds when the entity sits at an edge', () => {
    // Entity flush against the gap start: wStart cannot precede gapStart.
    expect(windowAroundEntity(100, 300, 100, 104, 5)).toEqual({ wStart: 100, wEnd: 109 });
    // Entity flush against the gap end: wEnd cannot exceed gapEnd-1
    // (gapEnd is the half-open upper bound).
    expect(windowAroundEntity(100, 300, 296, 299, 5)).toEqual({ wStart: 291, wEnd: 299 });
  });
});

// --- T-P2 -------------------------------------------------------------

describe('contiguousRuns — one run per contiguous block (T-P2)', () => {
  // CONTRACT GUARD (dormant, see T-P1). A multi-hunk entity must get one
  // focus frame PER contiguous run of its rows, never one monolith
  // stretching across the gaps between hunks.
  const pred = (b: boolean): boolean => b;

  it('splits at a gap: [T,T,F,T] ⇒ [[0,1],[3,3]]', () => {
    expect(contiguousRuns([true, true, false, true], pred)).toEqual([
      [0, 1],
      [3, 3],
    ]);
  });

  it('all-true ⇒ a single run spanning the array', () => {
    expect(contiguousRuns([true, true, true], pred)).toEqual([[0, 2]]);
  });

  it('empty input ⇒ no runs', () => {
    expect(contiguousRuns([], pred)).toEqual([]);
  });

  it('a trailing true closes the final run at the last index', () => {
    expect(contiguousRuns([false, true, false, false, true], pred)).toEqual([
      [1, 1],
      [4, 4],
    ]);
  });

  it('all-false ⇒ no runs', () => {
    expect(contiguousRuns([false, false], pred)).toEqual([]);
  });
});
