import { describe, expect, it } from 'vitest';
import { polylinePath } from '../src/view/tree.ts';

describe('polylinePath', () => {
  it('does not round straight-through boundary ports before upward doglegs', () => {
    const path = polylinePath([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: -20 },
    ]);

    expect(path).toBe('M0,0L12,0Q20,0 20,-8L20,-20');
  });
});
