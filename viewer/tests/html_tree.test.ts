import { describe, expect, it } from 'vitest';

import { isModuleStuck, moduleStickyTopPx } from '../src/view/html_tree.ts';
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

// `isModuleStuck` is the click-handler's decision rule: a click on a
// stuck row scrolls back to it; on an un-stuck row it toggles
// expand/collapse. Depth-aware threshold matters — a depth-N row
// sticks N rows earlier than depth-0, and a flat `< scrollTop` check
// misfired toggling in the narrow window where the row had just
// entered the sticky stack (image #167 regression).

describe('isModuleStuck', () => {
  it('depth-0 row is stuck only once its natural top scrolls past scrollTop', () => {
    // natural at 100; scrollTop 50 → row is below scrollTop, not stuck.
    expect(isModuleStuck(100, 50, 0, 1)).toBe(false);
    // scrollTop 100 → row at viewport-top, boundary (treated as
    // un-stuck — natural < scrollTop is the strict trigger).
    expect(isModuleStuck(100, 100, 0, 1)).toBe(false);
    // scrollTop 150 → row scrolled past, stuck.
    expect(isModuleStuck(100, 150, 0, 1)).toBe(true);
  });

  it('depth-N row is stuck N rows EARLIER than depth-0', () => {
    // Same natural-top of 100, but at depth 2 (ancestors stack above).
    // Sticky threshold = scrollTop + 2*ROW_H. With ROW_H = 24 (3 grid
    // cells of 8px) → threshold = scrollTop + 48.
    const naturalTop = 100;
    // scrollTop 60 → threshold = 108, natural 100 < 108 → STUCK
    // (the depth-0 check would have said un-stuck because 100 > 60).
    expect(isModuleStuck(naturalTop, 60, 2, 1)).toBe(true);
    // Verify the bug-trigger window is non-empty: depth-0 says un-stuck
    // (toggle), depth-2 says stuck (scroll). That's the bug.
    expect(isModuleStuck(naturalTop, 60, 0, 1)).toBe(false);
  });

  it('threshold scales with zoom k', () => {
    // At k=2, the sticky stack is twice as tall; a depth-1 row sticks
    // when natural < scrollTop + 1*ROW_H*2.
    expect(isModuleStuck(100, 60, 1, 2)).toBe(true); // 100 < 60 + 48
    expect(isModuleStuck(100, 60, 1, 1)).toBe(false); // 100 < 60 + 24 false
  });
});
