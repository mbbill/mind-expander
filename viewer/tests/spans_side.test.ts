import { describe, expect, it } from 'vitest';

import type { Facts } from '../src/data/schema.ts';
import {
  buildSpanIndex,
  findElementAtLine,
  lookupSpan,
} from '../src/data/spans.ts';

// Modified entities cover the click-correctness case originally
// caught for `signal_handler`: clicking a red `del` line at OLD
// line 35 used to misroute to whichever sibling lived at HEAD line
// 35 (the spanIndex was head-coord-only). With Side::Modified +
// prev_span carrying the base location, both reverse indexes resolve
// to the same entity id — no side disambiguation needed at the
// click target.

function modifiedFnFacts(): Facts {
  // One conceptual `signal_handler` with side='modified', span at
  // head [40,62] and prev_span at base [35,55]. Mirrors what
  // unified_facts::merge_fn emits when the function body changes.
  return {
    crates: {
      crate: {
        name: 'crate',
        modules: {
          '': {
            path: '',
            file: '/head/lib.rs',
            side: 'both',
            types: [],
            functions: [
              {
                name: 'signal_handler',
                visibility: 'pub',
                span: { file: '/head/lib.rs', start_line: 40, end_line: 62 },
                prev_span: { file: '/base/lib.rs', start_line: 35, end_line: 55 },
                side: 'modified',
              },
            ],
          },
        },
      },
    },
    edges: [],
  };
}

describe('side-aware span index', () => {
  it('routes a click at base line 35 to the Modified entity via prev_span', () => {
    const idx = buildSpanIndex(modifiedFnFacts());
    const hit = findElementAtLine(idx, '/base/lib.rs', 35, 'base');
    expect(hit).not.toBeNull();
    expect(hit!.elementId).toBe('crate::signal_handler');
    expect(hit!.side).toBe('modified');
    expect(hit!.startLine).toBe(35);
    expect(hit!.endLine).toBe(55);
  });

  it('routes a click at head line 40 to the same Modified entity via span', () => {
    const idx = buildSpanIndex(modifiedFnFacts());
    const hit = findElementAtLine(idx, '/head/lib.rs', 40, 'head');
    expect(hit).not.toBeNull();
    expect(hit!.elementId).toBe('crate::signal_handler');
    expect(hit!.side).toBe('modified');
    expect(hit!.startLine).toBe(40);
    expect(hit!.endLine).toBe(62);
  });

  it('returns null when looking up base coords on the head file', () => {
    // The base file doesn't appear in byFileHead; protects against
    // accidentally mixing coord spaces.
    const idx = buildSpanIndex(modifiedFnFacts());
    const hit = findElementAtLine(idx, '/base/lib.rs', 35, 'head');
    expect(hit).toBeNull();
  });

  it('lookupSpan returns a SpanRecord with span and prev_span', () => {
    const idx = buildSpanIndex(modifiedFnFacts());
    const rec = lookupSpan(idx, 'crate::signal_handler', 'function');
    expect(rec).not.toBeNull();
    expect(rec!.side).toBe('modified');
    expect(rec!.span.start_line).toBe(40);
    expect(rec!.span.end_line).toBe(62);
    expect(rec!.prev_span?.start_line).toBe(35);
    expect(rec!.prev_span?.end_line).toBe(55);
  });

  it('Both entities resolve from either coord space', () => {
    // Truly-unchanged entities have a single span shared across
    // both snapshots; the index appends them to BOTH byFile maps so
    // a click in either side's coordinate system finds them.
    const facts: Facts = {
      crates: {
        c: {
          name: 'c',
          modules: {
            '': {
              path: '',
              file: '/h/lib.rs',
              side: 'both',
              types: [],
              functions: [
                {
                  name: 'stable',
                  visibility: 'pub',
                  span: { file: '/h/lib.rs', start_line: 10, end_line: 12 },
                  side: 'both',
                },
              ],
            },
          },
        },
      },
      edges: [],
    };
    const idx = buildSpanIndex(facts);
    const headHit = findElementAtLine(idx, '/h/lib.rs', 11, 'head');
    const baseHit = findElementAtLine(idx, '/h/lib.rs', 11, 'base');
    expect(headHit?.elementId).toBe('c::stable');
    expect(baseHit?.elementId).toBe('c::stable');
    expect(headHit?.side).toBe('both');
    expect(baseHit?.side).toBe('both');
  });
});
