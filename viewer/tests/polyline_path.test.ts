import { describe, expect, it } from 'vitest';
import { polylinePath } from '../src/view/tree.ts';

describe('polylinePath', () => {
  it('does not round straight-through boundary ports before an upward turn', () => {
    const path = polylinePath([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: -20 },
    ]);

    expect(path).toBe('M0,0L16,0Q20,0 20,-4L20,-20');
  });
});
