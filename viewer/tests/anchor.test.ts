import { describe, expect, it } from 'vitest';
import { anchorTranslation } from '../src/view/anchor.ts';

describe('viewport anchor translation', () => {
  it('preserves both x and y movement across layout-changing expansion', () => {
    expect(anchorTranslation({ x: 300, y: 120 }, { x: 180, y: 250 })).toEqual({
      dx: 120,
      dy: -130,
    });
  });

  it('does not request a viewport shift when either endpoint is missing', () => {
    expect(anchorTranslation(null, { x: 1, y: 2 })).toBeNull();
    expect(anchorTranslation({ x: 1, y: 2 }, null)).toBeNull();
  });
});
