import { describe, expect, it } from 'vitest';
import type { Arrow, Layout } from '../src/analysis/layout_model.ts';
import { directArrowsFromMany } from '../src/view/tree.ts';

function arrow(fromTypeId: string, fromFieldName: string, toTypeId: string): Arrow {
  return {
    waypoints: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ],
    fromTypeId,
    fromFieldName,
    fromRowKind: 'field',
    toTypeId,
    kind: 'ownership',
    driftClass: 'at_lca',
  };
}

describe('directArrowsFromMany', () => {
  it('does not include downstream arrows from expanded target types', () => {
    const selected = arrow('A', 'to_b', 'B');
    const downstream = arrow('B', 'to_c', 'C');
    const layout: Layout = {
      modules: [],
      types: [],
      arrows: [selected, downstream],
      totalHeight: 0,
      totalWidth: 0,
    };

    expect(
      directArrowsFromMany(layout, [{ typePath: 'A', fieldName: 'to_b', kind: 'field' }]),
    ).toEqual(new Set([selected]));
  });
});
