import { describe, expect, it } from 'vitest';
import { MIN_TYPE_BOX_W } from '../src/analysis/layout_metrics.ts';
import type { LayoutInputs } from '../src/analysis/layout_model.ts';
import type { TypeFacts } from '../src/data/schema.ts';
import { FIELD_ROW_H, ROW_H, computeGeometry } from '../src/layout/geometry.ts';
import { computeObstacles } from '../src/layout/obstacles.ts';
import { buildLayout } from '../src/layout/pipeline.ts';
import type { Obstacle, PlacedFragmentRect } from '../src/layout/types.ts';
import { buildInputs, crateFacts, mod } from './fixtures/builders.ts';

// 10 px per character, keeping measurement-dependent fragment splits stable.
const measure = (s: string): number => s.length * 10;

function tyWith(name: string, fields: { name: string; ty_text: string }[]): TypeFacts {
  return {
    name,
    full_path: `c::m::${name}`,
    kind: 'struct',
    visibility: 'pub',
    fields: fields.map((f) => ({ ...f, ownership: 'owned' as const })),
  };
}

function makeInputs(types: TypeFacts[], expandedIds: string[]): LayoutInputs {
  const c = crateFacts('c', [mod(''), mod('m', types)]);
  const inputs = buildInputs(c, [], expandedIds);
  return { ...inputs, measureText: measure };
}

function obstacleFingerprint(obstacle: Obstacle) {
  return {
    kind: obstacle.kind,
    typeId: obstacle.typeId,
    fragmentId: obstacle.fragmentId,
    fragmentIndex: obstacle.fragmentIndex,
    fragmentKind: obstacle.fragmentKind,
    rowIds: obstacle.rowIds,
    x: obstacle.x,
    y: obstacle.y,
    width: obstacle.width,
    height: obstacle.height,
  };
}

function fragmentFingerprint(fragment: PlacedFragmentRect) {
  return {
    kind: fragment.fragmentKind === 'split-row' ? 'protrusion' : 'block',
    typeId: fragment.typeId,
    fragmentId: fragment.fragmentId,
    fragmentIndex: fragment.fragmentIndex,
    fragmentKind: fragment.fragmentKind,
    rowIds: fragment.rowIds,
    x: fragment.x,
    y: fragment.y,
    width: fragment.width,
    height: fragment.height,
  };
}

function debugRect(obstacle: Obstacle) {
  return {
    left: obstacle.x,
    right: obstacle.x + obstacle.width,
    top: obstacle.y,
    bottom: obstacle.y + obstacle.height,
  };
}

describe('computeObstacles — placed fragment source of truth', () => {
  it('builds exactly one obstacle per geometry placed fragment', () => {
    const longFieldName = `wide_${'A'.repeat(40)}`;
    const ty = tyWith('A', [
      { name: 'short_a', ty_text: 'u8' },
      { name: longFieldName, ty_text: 'u8' },
      { name: 'short_b', ty_text: 'u8' },
    ]);
    const inputs = makeInputs([ty], ['c', 'c::m', 'c::m::A']);
    const geometry = computeGeometry(inputs);
    const obstacles = computeObstacles(geometry, measure);

    const fragments = geometry.placedFragments.filter((fragment) => fragment.typeId === 'c::m::A');
    expect(fragments.map((fragment) => fragment.fragmentKind)).toEqual([
      'main',
      'split-row',
      'body',
    ]);
    expect(obstacles.all.map(obstacleFingerprint)).toEqual(
      geometry.placedFragments.map(fragmentFingerprint),
    );
  });

  it('keeps type metadata for endpoint block lookup when one type has multiple fragments', () => {
    const longFieldName = `wide_${'A'.repeat(40)}`;
    const ty = tyWith('A', [
      { name: 'short_a', ty_text: 'u8' },
      { name: longFieldName, ty_text: 'u8' },
      { name: 'short_b', ty_text: 'u8' },
    ]);
    const inputs = makeInputs([ty], ['c', 'c::m', 'c::m::A']);
    const geometry = computeGeometry(inputs);
    const obstacles = computeObstacles(geometry, measure);

    const blocks = obstacles.blocksByType.get('c::m::A') ?? [];
    const protrusions = obstacles.protrusionsByType.get('c::m::A') ?? [];

    expect(blocks.map((block) => block.fragmentId)).toEqual(['0:main', '2:body']);
    expect(protrusions.map((protrusion) => protrusion.fragmentId)).toEqual(['1:split-row']);
    expect(protrusions[0]?.rowIds).toEqual(['c::m::A:row:1']);
    expect(obstacles.blockByType.get('c::m::A')).toEqual(blocks[0]);
  });
});

describe('computeObstacles — snapped fragment rectangles', () => {
  it('collapsed types produce one block matching the placed fragment', () => {
    const inputs = makeInputs([tyWith('A', []), tyWith('B', [])], ['c', 'c::m']);
    const geometry = computeGeometry(inputs);
    const obstacles = computeObstacles(geometry, measure);

    expect(obstacles.all).toHaveLength(2);
    expect(obstacles.protrusionsByType.size).toBe(0);

    for (const fragment of geometry.placedFragments) {
      const block = obstacles.blockByType.get(fragment.typeId);
      expect(block).toBeDefined();
      expect(block?.kind).toBe('block');
      expect(block?.width).toBe(fragment.width);
      expect(block?.height).toBe(ROW_H);
      expect(block?.x).toBe(fragment.x);
      expect(block?.y).toBe(fragment.y);
    }
  });

  it('expanded short rows stay in one snapped main block', () => {
    const ty = tyWith('A', [
      { name: 'aa', ty_text: 'u8' },
      { name: 'bb', ty_text: 'u8' },
      { name: 'cc', ty_text: 'u8' },
      { name: 'dd', ty_text: 'u8' },
    ]);
    const inputs = makeInputs([ty], ['c', 'c::m', 'c::m::A']);
    const geometry = computeGeometry(inputs);
    const obstacles = computeObstacles(geometry, measure);

    const fragments = geometry.placedFragments.filter((fragment) => fragment.typeId === 'c::m::A');
    expect(fragments.map((fragment) => fragment.fragmentKind)).toEqual(['main']);
    expect(obstacles.protrusionsByType.size).toBe(0);

    const block = obstacles.blockByType.get('c::m::A');
    const fragment = fragments[0];
    expect(block?.height).toBe(ROW_H + 4 * FIELD_ROW_H);
    expect(block?.width).toBe(fragment?.width);
  });

  it('does not let verbose field type text widen the physical block', () => {
    const longTyText = 'collections::Vec<collections::Vec<FrameSlot>>';
    const ty = tyWith('A', [
      { name: 'aa', ty_text: 'u8' },
      { name: 'wide', ty_text: longTyText },
      { name: 'bb', ty_text: 'u8' },
    ]);
    const inputs = makeInputs([ty], ['c', 'c::m', 'c::m::A']);
    const geometry = computeGeometry(inputs);

    const fragments = geometry.placedFragments.filter((fragment) => fragment.typeId === 'c::m::A');
    expect(fragments.map((fragment) => fragment.fragmentKind)).toEqual(['main']);
    expect(fragments[0]?.width).toBe(MIN_TYPE_BOX_W);
    expect(geometry.typesById.get('c::m::A')?.visibleRows[1]?.tyText).toBe(longTyText);
  });
});

describe('layout debug routing obstacles', () => {
  it('draws the same rectangles computeObstacles returns', () => {
    const longFieldName = `wide_${'A'.repeat(40)}`;
    const ty = tyWith('A', [
      { name: 'short_a', ty_text: 'u8' },
      { name: longFieldName, ty_text: 'u8' },
      { name: 'short_b', ty_text: 'u8' },
    ]);
    const inputs = makeInputs([ty], ['c', 'c::m', 'c::m::A']);
    const geometry = computeGeometry(inputs);
    const obstacles = computeObstacles(geometry, measure);
    const layout = buildLayout(inputs);

    expect(layout.arrows).toEqual([]);
    expect(layout.debug?.routing.obstacles).toEqual(obstacles.all.map(debugRect));
  });
});
