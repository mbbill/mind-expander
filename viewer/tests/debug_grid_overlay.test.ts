import { describe, expect, it } from 'vitest';
import { LAYOUT_GRID } from '../src/analysis/layout_metrics.ts';
import { debugGridPatternTile } from '../src/view/tree.ts';

describe('debug grid overlay', () => {
  it('uses one extent-independent pattern tile instead of per-dot geometry', () => {
    const base = {
      originX: 10,
      originY: 8,
      ...LAYOUT_GRID,
      width: 32,
      height: 32,
    };
    const expanded = { ...base, width: 128, height: 128 };

    expect(debugGridPatternTile(expanded)).toEqual(debugGridPatternTile(base));
    expect(debugGridPatternTile(base)).toEqual({
      x: 10,
      y: 8,
      width: LAYOUT_GRID.cellWidth,
      height: LAYOUT_GRID.cellHeight,
    });
  });
});
