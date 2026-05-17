import { describe, expect, it } from 'vitest';

import { moduleStickyTopPx } from '../src/view/html_tree.ts';
import { ROW_H } from '../src/analysis/layout_metrics.ts';

// `moduleStickyTopPx` is the single source of truth for where a module
// row lands when it's in the sticky stack. The renderer uses it to set
// `header.style.top`, and the scroll-to-module action (main.ts) targets
// it so a clicked sticky module is exposed below its ancestor stack
// rather than hidden behind it (image #163 regression).

describe('moduleStickyTopPx', () => {
  it('depth-0 rows stick at the top of the viewport', () => {
    expect(moduleStickyTopPx(0, 1)).toBe(0);
    expect(moduleStickyTopPx(0, 0.5)).toBe(0);
  });

  it('depth-N rows stack N full rows below the top', () => {
    expect(moduleStickyTopPx(1, 1)).toBe(ROW_H);
    expect(moduleStickyTopPx(2, 1)).toBe(2 * ROW_H);
    expect(moduleStickyTopPx(3, 1)).toBe(3 * ROW_H);
  });

  it('scales linearly with zoom k so the stack stays flush at any scale', () => {
    expect(moduleStickyTopPx(2, 0.5)).toBe(ROW_H);
    expect(moduleStickyTopPx(2, 2)).toBe(4 * ROW_H);
  });
});
