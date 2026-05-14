import { describe, expect, it } from 'vitest';
import { buildFunctionCallIndex } from '../src/analysis/calls.ts';
import type { TypeBox } from '../src/analysis/layout_model.ts';
import { callArrowKey, rowArrowKey } from '../src/analysis/layout_model.ts';
import { buildModuleTree } from '../src/analysis/module_tree.ts';
import type { Facts } from '../src/data/schema.ts';
import {
  BAND_GRID_CELL_H,
  BAND_GRID_CELL_W,
  FIELD_ROW_H,
  type Geometry,
  ROW_H,
  TOP_PAD,
  TYPE_X_GAP,
  computeGeometry,
} from '../src/layout/geometry.ts';
import { computeObstacles } from '../src/layout/obstacles.ts';
import { buildLayout } from '../src/layout/pipeline.ts';
import type { Obstacle, PositionedType } from '../src/layout/types.ts';
import { buildInputs, crateFacts, edge, mod, ty } from './fixtures/builders.ts';
import { mediumFixtureInputs } from './fixtures/medium.ts';
import { smallFixtureInputs } from './fixtures/small.ts';

function positionsKey(g: Geometry): string {
  // Stable, ordered fingerprint of every type's (id, x, y, w, h) plus
  // every module's (id, y, bandHeight). Sorted so the comparison doesn't
  // depend on emission order.
  const types = [...g.types]
    .map((t) => `${t.node.id}|${t.x}|${t.y}|${t.width}|${t.height}`)
    .sort()
    .join('\n');
  const modules = [...g.modules]
    .map((m) => `${m.node.id}|${m.y}|${m.bandHeight}`)
    .sort()
    .join('\n');
  return `T:\n${types}\nM:\n${modules}`;
}

const SMALL_EXPANDED = ['c', 'c::core', 'c::render'];
const measure = (s: string): number => s.length * 7;

function crowdedTargetInputs() {
  const fields = Array.from({ length: 10 }, (_, index) => ({
    name: `target${index}`,
    ty_text: 'Target',
  }));
  const c = crateFacts('c', [mod('m', [ty('c', 'm', 'Source', fields), ty('c', 'm', 'Target')])]);
  const edges = fields.map((field) => edge('c::m::Source', 'c::m::Target', `field ${field.name}`));

  return buildInputs(c, edges, ['c', 'c::m', 'c::m::Source']);
}

function fallbackPressureInputs() {
  const blockerField = `blocker_${'wide'.repeat(80)}`;
  const c = crateFacts('c', [
    mod('m', [
      ty('c', 'm', 'A_Wall', [
        { name: 'hiddenA', ty_text: 'hidden::A' },
        { name: blockerField, ty_text: 'hidden::B' },
      ]),
      ty('c', 'm', 'Source', [{ name: 'target', ty_text: 'Target' }]),
      ty('c', 'm', 'Target'),
    ]),
    mod('hidden', [ty('c', 'hidden', 'A'), ty('c', 'hidden', 'B')]),
  ]);
  const edges = [
    edge('c::m::A_Wall', 'c::hidden::A', 'field hiddenA'),
    edge('c::m::A_Wall', 'c::hidden::B', `field ${blockerField}`),
    edge('c::m::Source', 'c::m::Target', 'field target'),
  ];

  return buildInputs(c, edges, ['c', 'c::m', 'c::m::A_Wall', 'c::m::Source']);
}

interface Rect {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

function typeRect(t: PositionedType): Rect {
  const top = t.y - ROW_H / 2;
  return {
    left: t.x,
    right: t.x + t.width,
    top,
    bottom: top + t.height,
  };
}

function obstacleRect(o: Pick<Obstacle, 'x' | 'y' | 'width' | 'height'>): Rect {
  return {
    left: o.x,
    right: o.x + o.width,
    top: o.y,
    bottom: o.y + o.height,
  };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

function labelsByPhysicalOrder(types: readonly PositionedType[]): string[] {
  return [...types]
    .sort((a, b) => a.x - b.x || a.y - b.y || a.node.label.localeCompare(b.node.label))
    .map((t) => t.node.label);
}

function positionedIdsByPhysicalOrder(types: readonly PositionedType[]): string[] {
  return [...types]
    .sort((a, b) => a.x - b.x || a.y - b.y || a.node.id.localeCompare(b.node.id))
    .map((t) => t.node.id);
}

function typeBoxGeometryFingerprint(types: readonly TypeBox[]): string[] {
  return [...types].map((t) => `${t.id}|${t.x}|${t.y}|${t.width}|${t.height}`);
}

describe('computeGeometry — determinism', () => {
  it('same inputs produce byte-identical positions across 25 runs', () => {
    // Build a fresh inputs object on each run so we're not just reading
    // a memoized result from shared mutable state.
    const reference = computeGeometry(smallFixtureInputs(SMALL_EXPANDED));
    const ref = positionsKey(reference);
    for (let i = 0; i < 24; i++) {
      const next = computeGeometry(smallFixtureInputs(SMALL_EXPANDED));
      expect(positionsKey(next)).toBe(ref);
    }
  });

  it('rank ordering is independent of TypeNode iteration order — sort key is data-derived', () => {
    // Same logical fixture; we check that the ranks map uses stable type
    // identity, not traversal order. Two semantically identical fixtures must
    // produce identical rank assignments.
    const a = computeGeometry(smallFixtureInputs());
    const b = computeGeometry(smallFixtureInputs());
    for (const [id, r] of a.ranks) {
      expect(b.ranks.get(id)).toEqual(r);
    }
  });

  it('orders same-depth rank types by name instead of edge degree', () => {
    const c = crateFacts('c', [
      mod('m', [
        ty('c', 'm', 'ZuluOwner', [{ name: 'child', ty_text: 'Child' }]),
        ty('c', 'm', 'AlphaPlain'),
        ty('c', 'm', 'Child'),
      ]),
    ]);
    const inputs = buildInputs(
      c,
      [edge('c::m::ZuluOwner', 'c::m::Child', 'field child')],
      ['c', 'c::m'],
    );
    const g = computeGeometry(inputs);

    const alphaRank = g.ranks.get('c::m::AlphaPlain');
    const zuluRank = g.ranks.get('c::m::ZuluOwner');
    expect(alphaRank?.depth).toBe(0);
    expect(zuluRank?.depth).toBe(0);
    expect(alphaRank?.subrank).toBeLessThan(zuluRank?.subrank ?? Number.POSITIVE_INFINITY);

    // ZuluOwner has an outgoing ownership edge, but that must not make it jump
    // ahead of AlphaPlain inside the same rank depth group.
    expect(positionedIdsByPhysicalOrder(g.types.filter((t) => t.depth === 0))).toEqual([
      'c::m::AlphaPlain',
      'c::m::ZuluOwner',
    ]);
  });
});

describe('computeGeometry — rank invariant', () => {
  it('every owns-edge satisfies owner.x ≤ owned.x (small fixture)', () => {
    const inputs = smallFixtureInputs(SMALL_EXPANDED);
    const g = computeGeometry(inputs);
    for (const [ownerId, ownedList] of inputs.ownership.owns) {
      const ownerPos = g.typesById.get(ownerId);
      if (!ownerPos) continue; // not visible
      for (const ownedId of ownedList) {
        const ownedPos = g.typesById.get(ownedId);
        if (!ownedPos) continue;
        expect(ownerPos.x, `${ownerId} → ${ownedId}`).toBeLessThanOrEqual(ownedPos.x);
      }
    }
  });

  it('holds on the medium fixture (dense bundles + back-edge)', () => {
    const inputs = mediumFixtureInputs(['c', 'c::m']);
    const g = computeGeometry(inputs);
    for (const [ownerId, ownedList] of inputs.ownership.owns) {
      const ownerPos = g.typesById.get(ownerId);
      if (!ownerPos) continue;
      for (const ownedId of ownedList) {
        const ownedPos = g.typesById.get(ownedId);
        if (!ownedPos) continue;
        expect(ownerPos.x, `${ownerId} → ${ownedId}`).toBeLessThanOrEqual(ownedPos.x);
      }
    }
  });
});

describe('computeGeometry — subrank stability', () => {
  it('adding a leaf at the deepest depth does not shift any existing type', () => {
    const baseline = computeGeometry(smallFixtureInputs(SMALL_EXPANDED));
    const baselineX = new Map<string, number>();
    for (const t of baseline.types) baselineX.set(t.node.id, t.x);

    // Add Z_LEAF owned by Cylinder. Cylinder is currently the deepest
    // type; Z_LEAF lands one depth past it, so it gets the highest rank
    // and cannot push any earlier type. Every existing type should
    // keep its x.
    const c = crateFacts('c', [
      mod('', [
        ty('c', '', 'App', [
          { name: 'engine', ty_text: 'core::Engine' },
          { name: 'renderer', ty_text: 'render::Renderer' },
        ]),
      ]),
      mod('core', [
        ty('c', 'core', 'Engine', [{ name: 'cyl', ty_text: 'Cylinder' }]),
        ty('c', 'core', 'Cylinder', [{ name: 'leaf', ty_text: 'Z_LEAF' }]),
        ty('c', 'core', 'Z_LEAF'),
      ]),
      mod('render', [
        ty('c', 'render', 'Renderer', [{ name: 'pix', ty_text: 'Pixel' }]),
        ty('c', 'render', 'Pixel'),
      ]),
    ]);
    const edges = [
      edge('c::App', 'c::core::Engine'),
      edge('c::App', 'c::render::Renderer'),
      edge('c::core::Engine', 'c::core::Cylinder'),
      edge('c::render::Renderer', 'c::render::Pixel'),
      edge('c::core::Cylinder', 'c::core::Z_LEAF'),
    ];
    const withLeaf = computeGeometry(buildInputs(c, edges, SMALL_EXPANDED));

    for (const [id, x] of baselineX) {
      expect(withLeaf.typesById.get(id)?.x, `${id} should not shift`).toBe(x);
    }
  });
});

describe('computeGeometry — basic placement', () => {
  it('small fixture: types are placed left-to-right in dependency order', () => {
    const inputs = smallFixtureInputs(SMALL_EXPANDED);
    const g = computeGeometry(inputs);
    const xOf = (id: string): number => g.typesById.get(id)?.x ?? Number.NaN;

    // Separate module bands place their own local rank groups. Cross-band
    // ownership must not move a target left of its owner, but it no longer
    // implies the old globally reserved depth columns.
    expect(xOf('c::App')).toBeLessThanOrEqual(xOf('c::core::Engine'));
    expect(xOf('c::App')).toBeLessThanOrEqual(xOf('c::render::Renderer'));
    expect(xOf('c::core::Engine')).toBeLessThanOrEqual(xOf('c::core::Cylinder'));
    expect(xOf('c::render::Renderer')).toBeLessThanOrEqual(xOf('c::render::Pixel'));
  });

  it('respects ViewState: collapsed module hides its types', () => {
    // Only crate root expanded; child modules stay collapsed.
    const inputs = smallFixtureInputs(['c']);
    const g = computeGeometry(inputs);
    // App lives at the crate root, so it renders even though core/render
    // are collapsed.
    expect(g.types.map((t) => t.node.id)).toEqual(['c::App']);
    expect(g.modules.map((m) => m.node.id)).toEqual(['c', 'c::core', 'c::render']);
  });

  it('respects focusModules by dropping modules outside the focused subtree', () => {
    const inputs = smallFixtureInputs(SMALL_EXPANDED);
    const focused = { ...inputs, focusModules: new Set(['c', 'c::core']) };
    const g = computeGeometry(focused);

    expect(g.modules.map((m) => m.node.id)).toEqual(['c', 'c::core']);
    expect(g.types.map((t) => t.node.id)).not.toContain('c::render::Renderer');
    expect(g.types.map((t) => t.node.id)).not.toContain('c::render::Pixel');
  });

  it('orders rank depths left-to-right without relying on old fixed columns', () => {
    const inputs = smallFixtureInputs(SMALL_EXPANDED);
    const g = computeGeometry(inputs);
    const xOf = (id: string): number => g.typesById.get(id)?.x ?? Number.NaN;

    expect(xOf('c::App')).toBeGreaterThanOrEqual(g.globalXStart);
    expect(xOf('c::App')).toBeLessThanOrEqual(xOf('c::core::Engine'));
    expect(xOf('c::core::Engine')).toBeLessThanOrEqual(xOf('c::core::Cylinder'));
  });

  it('keeps cross-module owned types to the right of their visible owners', () => {
    const c = crateFacts('c', [
      mod('', [ty('c', '', 'Owner', [{ name: 'target', ty_text: 'deep::Target' }])]),
      mod('deep', [ty('c', 'deep', 'Target')]),
    ]);
    const g = computeGeometry(
      buildInputs(c, [edge('c::Owner', 'c::deep::Target', 'field target')], ['c', 'c::deep']),
    );
    const owner = g.typesById.get('c::Owner');
    const target = g.typesById.get('c::deep::Target');

    expect(owner).toBeDefined();
    expect(target).toBeDefined();
    expect(target?.x ?? 0).toBeGreaterThanOrEqual((owner?.x ?? 0) + (owner?.width ?? 0));
  });

  it('dense same-depth types keep a stable physical label order under expansion', () => {
    const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
    const c = crateFacts('c', [
      mod(
        'm',
        names.map((name) =>
          ty(
            'c',
            'm',
            name,
            name === 'A'
              ? [
                  { name: 'f0', ty_text: 'u8' },
                  { name: 'f1', ty_text: 'u8' },
                  { name: 'f2', ty_text: 'u8' },
                  { name: 'f3', ty_text: 'u8' },
                  { name: 'f4', ty_text: 'u8' },
                  { name: 'f5', ty_text: 'u8' },
                ]
              : [],
          ),
        ),
      ),
    ]);
    const collapsed = computeGeometry(buildInputs(c, [], ['c', 'c::m']));
    const expanded = computeGeometry(buildInputs(c, [], ['c', 'c::m', 'c::m::A']));

    expect(labelsByPhysicalOrder(expanded.types)).toEqual(labelsByPhysicalOrder(collapsed.types));
    expect(expanded.modules.find((m) => m.node.id === 'c::m')?.bandHeight).toBeGreaterThan(
      collapsed.modules.find((m) => m.node.id === 'c::m')?.bandHeight ?? 0,
    );
  });

  it('dense same-depth type boxes do not overlap after band-local placement', () => {
    const inputs = mediumFixtureInputs(['c', 'c::m']);
    const g = computeGeometry(inputs);
    const rLeaves = g.types.filter((t) => /^c::m::R\d+$/.test(t.node.id));
    expect(rLeaves).toHaveLength(12);

    for (let i = 0; i < rLeaves.length; i++) {
      const a = rLeaves[i];
      if (a === undefined) continue;
      for (let j = i + 1; j < rLeaves.length; j++) {
        const b = rLeaves[j];
        if (b === undefined) continue;
        expect(overlaps(typeRect(a), typeRect(b)), `${a.node.id} overlaps ${b.node.id}`).toBe(
          false,
        );
      }
    }
  });

  it('placed fragments never overlap inside the same module band', () => {
    const inputs = mediumFixtureInputs(['c', 'c::m', 'c::m::Root']);
    const g = computeGeometry(inputs);
    const byBand = new Map<string, typeof g.placedFragments>();
    for (const fragment of g.placedFragments) {
      byBand.set(fragment.bandId, [...(byBand.get(fragment.bandId) ?? []), fragment]);
    }

    for (const [bandId, fragments] of byBand) {
      for (let i = 0; i < fragments.length; i++) {
        const a = fragments[i];
        if (a === undefined) continue;
        for (let j = i + 1; j < fragments.length; j++) {
          const b = fragments[j];
          if (b === undefined) continue;
          const message = `${bandId}: ${a.typeId}#${a.fragmentId} overlaps ${b.typeId}#${b.fragmentId}`;
          expect(overlaps(obstacleRect(a), obstacleRect(b)), message).toBe(false);
        }
      }
    }
  });

  it('non-rank types (function-groups, ghosts) get the leftmost column', () => {
    // Hand-build a CrateFacts with one struct AND one free function so a
    // function-group pseudo-type is synthesized.
    const c = crateFacts('c', [
      {
        path: 'm',
        file: 'src/m.rs',
        types: [ty('c', 'm', 'Real')],
        functions: [{ name: 'do_thing', visibility: 'pub' }],
      },
    ]);
    const inputs = buildInputs(c, [], ['c', 'c::m']);
    const g = computeGeometry(inputs);

    const fnGroup = g.types.find((t) => t.node.typeKind === 'function_group');
    const real = g.types.find((t) => t.node.id === 'c::m::Real');
    expect(fnGroup).toBeDefined();
    expect(real).toBeDefined();
    // Function-group is not in the rank grid → x = globalXStart, depth = -1.
    expect(fnGroup?.x).toBe(g.globalXStart);
    expect(fnGroup?.depth).toBe(-1);
    expect(real?.x).toBeGreaterThan(fnGroup?.x ?? 0);
  });

  it('computes globalXStart from visible modules only, not from collapsed deep paths', () => {
    // When a deeply-nested module is collapsed its row is NOT in the
    // module column — neither its leaf chip nor its indented position
    // should pre-reserve space in globalXStart. Walking the whole tree
    // (the previous behaviour) produced a giant default gap whenever
    // any long-leaf module existed anywhere, even if hidden. The long
    // leaf sits at the BOTTOM of the path so it only becomes visible
    // once the intermediate modules are expanded.
    const longLeaf = 'reallyLongModule'.repeat(4);
    const c = crateFacts('c', [
      mod('', [ty('c', '', 'A')]),
      mod(`a::b::${longLeaf}`, [ty('c', `a::b::${longLeaf}`, 'Hidden')]),
    ]);
    // Expand only the crate root — 'a' (depth 1) is visible but its
    // descendants stay hidden, so the long leaf does not contribute.
    const collapsed = computeGeometry(buildInputs(c, [], ['c']));
    // Expand the chain so the long leaf becomes visible at depth 3.
    const expanded = computeGeometry(
      buildInputs(c, [], ['c', 'c::a', 'c::a::b']),
    );

    expect(collapsed.globalXStart).toBeLessThan(expanded.globalXStart);
  });

  it('reserves a global leftmost column for module-level function groups', () => {
    // The reserved fn column is global: a function group in `with_fns` pushes
    // every type — including bands that have no function groups, like `plain`
    // — past the column's right edge so types align across bands. Function
    // groups themselves stay at the global start (col 0 inside the band grid).
    const c = crateFacts('c', [
      {
        path: 'with_fns',
        file: 'src/with_fns.rs',
        types: [ty('c', 'with_fns', 'Real')],
        functions: [{ name: 'do_thing', visibility: 'pub' }],
      },
      mod('plain', [ty('c', 'plain', 'Plain')]),
    ]);
    const g = computeGeometry(buildInputs(c, [], ['c', 'c::with_fns', 'c::plain']));

    const fnGroup = g.types.find((t) => t.node.typeKind === 'function_group');
    const real = g.types.find((t) => t.node.id === 'c::with_fns::Real');
    const plain = g.types.find((t) => t.node.id === 'c::plain::Plain');

    expect(fnGroup).toBeDefined();
    expect(real).toBeDefined();
    expect(plain).toBeDefined();
    expect(fnGroup?.x).toBe(g.globalXStart);
    expect(real?.x).toBeGreaterThan(fnGroup?.x ?? 0);
    // Plain has no fn group in its own band, but the global column still
    // applies — Plain sits at the same x as Real (both at the type-area floor).
    expect(plain?.x).toBe(real?.x);
    expect(plain?.x).toBeGreaterThan(g.globalXStart);
  });

  it('same-depth long headers do not overlap neighboring boxes or obstacles', () => {
    const longName = `A${'VeryLongHeader'.repeat(20)}`;
    const c = crateFacts('c', [mod('m', [ty('c', 'm', longName), ty('c', 'm', 'B')])]);
    const inputs = {
      ...buildInputs(c, [], ['c', 'c::m']),
      measureText: (s: string) => s.length * 10,
    };
    const g = computeGeometry(inputs);
    const obstacles = computeObstacles(g, inputs.measureText);
    const longType = g.types.find((t) => t.node.label === longName);
    const neighbor = g.types.find((t) => t.node.label === 'B');

    expect(longType).toBeDefined();
    expect(neighbor).toBeDefined();
    expect(
      overlaps(typeRect(longType as PositionedType), typeRect(neighbor as PositionedType)),
    ).toBe(false);

    const longObstacles = obstacles.all.filter((o) => o.typeId === longType?.node.id);
    const neighborObstacles = obstacles.all.filter((o) => o.typeId === neighbor?.node.id);
    for (const a of longObstacles) {
      for (const b of neighborObstacles) {
        expect(overlaps(obstacleRect(a), obstacleRect(b))).toBe(false);
      }
    }
  });

  it('widens the stable column stride for long always-visible headers', () => {
    const longName = `A${'ReallyLongTypeName'.repeat(8)}`;
    const c = crateFacts('c', [mod('m', [ty('c', 'm', longName), ty('c', 'm', 'BShort')])]);
    const inputs = {
      ...buildInputs(c, [], ['c', 'c::m']),
      measureText: (s: string) => s.length * 10,
    };
    const g = computeGeometry(inputs);
    const byX = [...g.types].sort((a, b) => a.x - b.x);
    const left = byX[0];
    const right = byX[1];

    expect(left).toBeDefined();
    expect(right).toBeDefined();
    expect((left?.x ?? 0) + (left?.width ?? 0) + TYPE_X_GAP).toBeLessThanOrEqual(right?.x ?? 0);
  });

  it('reserves header space for the rendered expand chevron', () => {
    const label = 'CachedLocalBinding';
    const c = crateFacts('c', [
      mod('m', [ty('c', 'm', label, [{ name: 'value', ty_text: 'u8' }])]),
    ]);
    const inputs = {
      ...buildInputs(c, [], ['c', 'c::m']),
      measureText: (s: string) => s.length * 10,
    };
    const g = computeGeometry(inputs);
    const box = g.typesById.get(`c::m::${label}`);
    const fragment = g.placedFragments.find((f) => f.typeId === `c::m::${label}`);

    expect(box).toBeDefined();
    expect(fragment).toBeDefined();
    // Type headers render larger than field rows and append a chevron after
    // the label. The layout box must cover that visible affordance so the
    // debug rectangle and collision shape match what the user sees.
    expect(box?.width ?? 0).toBeGreaterThan(label.length * 10 + 48);
    expect(fragment?.width ?? 0).toBeGreaterThanOrEqual(box?.width ?? 0);
  });

  it('keeps member drift class on rows even when the target type is hidden', () => {
    const c = crateFacts('c', [
      mod('x::a', [ty('c', 'x::a', 'OwnerA', [{ name: 'target', ty_text: 'T' }])]),
      mod('x::b', [ty('c', 'x::b', 'OwnerB', [{ name: 'target', ty_text: 'T' }])]),
      mod('y', [ty('c', 'y', 'T')]),
    ]);
    const inputs = buildInputs(
      c,
      [
        edge('c::x::a::OwnerA', 'c::y::T', 'field target'),
        edge('c::x::b::OwnerB', 'c::y::T', 'field target'),
      ],
      ['c', 'c::x', 'c::x::a', 'c::x::a::OwnerA'],
    );
    const layout = buildLayout(inputs);
    const owner = layout.types.find((t) => t.fullPath === 'c::x::a::OwnerA');
    const row = owner?.fields.find((f) => f.name === 'target');

    expect(layout.types.find((t) => t.fullPath === 'c::y::T')).toBeUndefined();
    expect(layout.arrows).toHaveLength(0);
    expect(row?.memberDriftClass).toBe('drift_sideways');
  });

  it('keeps canonical field ownership arrows visible when field arrow keys are provided', () => {
    const c = crateFacts('c', [
      mod('m', [
        ty('c', 'm', 'Owner', [
          { name: 'first', ty_text: 'TargetA' },
          { name: 'second', ty_text: 'TargetB' },
        ]),
        ty('c', 'm', 'TargetA'),
        ty('c', 'm', 'TargetB'),
      ]),
    ]);
    const inputs = buildInputs(
      c,
      [
        edge('c::m::Owner', 'c::m::TargetA', 'field first'),
        edge('c::m::Owner', 'c::m::TargetB', 'field second'),
      ],
      ['c', 'c::m', 'c::m::Owner'],
    );
    const none = buildLayout({ ...inputs, fieldArrowsShown: new Set() });
    const firstOnly = buildLayout({
      ...inputs,
      fieldArrowsShown: new Set([rowArrowKey('c::m::Owner', 'first')]),
    });

    expect(none.arrows.map((a) => a.fromFieldName).sort()).toEqual(['first', 'second']);
    expect(firstOnly.arrows.map((a) => a.fromFieldName).sort()).toEqual(['first', 'second']);
  });

  it('emits drifted field ownership arrows only for selected field arrow keys', () => {
    const c = crateFacts('c', [
      mod('x::a', [ty('c', 'x::a', 'OwnerA', [{ name: 'target', ty_text: 'T' }])]),
      mod('x::b', [ty('c', 'x::b', 'OwnerB', [{ name: 'target', ty_text: 'T' }])]),
      mod('y', [ty('c', 'y', 'T')]),
    ]);
    const inputs = buildInputs(
      c,
      [
        edge('c::x::a::OwnerA', 'c::y::T', 'field target'),
        edge('c::x::b::OwnerB', 'c::y::T', 'field target'),
      ],
      ['c', 'c::x', 'c::x::a', 'c::x::a::OwnerA', 'c::y'],
    );
    const hidden = buildLayout({ ...inputs, fieldArrowsShown: new Set() });
    const shown = buildLayout({
      ...inputs,
      fieldArrowsShown: new Set([rowArrowKey('c::x::a::OwnerA', 'target')]),
    });

    expect(hidden.arrows).toHaveLength(0);
    expect(shown.arrows.map((a) => a.fromTypeId)).toEqual(['c::x::a::OwnerA']);
    expect(shown.arrows.map((a) => a.driftClass)).toEqual(['drift_sideways']);
  });

  it('emits measured visual fragment bounds instead of snapped packing width', () => {
    const label = 'RefType';
    const id = `c::m::${label}`;
    const c = crateFacts('c', [
      mod('m', [ty('c', 'm', label, [{ name: 'heap_type', ty_text: 'HeapType' }])]),
    ]);
    const inputs = {
      ...buildInputs(c, [], ['c', 'c::m']),
      measureText: (s: string) => s.length * 10,
    };
    const g = computeGeometry(inputs);
    const box = g.typesById.get(id);
    const fragment = g.placedFragments.find((f) => f.typeId === id);
    const snappedWidth = Math.ceil((box?.width ?? 0) / BAND_GRID_CELL_W) * BAND_GRID_CELL_W;

    expect(box).toBeDefined();
    expect(fragment).toBeDefined();
    expect(snappedWidth).toBeGreaterThan(box?.width ?? 0);
    expect(fragment?.width).toBeCloseTo(box?.width ?? 0);
    expect(fragment?.width ?? 0).toBeLessThan(snappedWidth);
  });

  it('does not let verbose method signatures widen the physical block', () => {
    const thingId = 'c::m::Thing';
    const c = crateFacts('c', [
      mod('m', [
        {
          ...ty('c', 'm', 'Thing'),
          methods: [
            {
              name: 'short',
              visibility: 'pub',
              params: [
                {
                  name: 'arg',
                  ty_text: `collections::Vec<${'FrameSlot'.repeat(12)}>`,
                },
              ],
              return_ty_text: `Result<${'VeryLongReturn'.repeat(10)}>`,
            },
          ],
        },
      ]),
    ]);
    const inputs = {
      ...buildInputs(c, [], ['c', 'c::m', thingId, `${thingId}::__methods_pub`]),
      measureText: (s: string) => s.length * 10,
    };
    const g = computeGeometry(inputs);
    const fragments = g.placedFragments.filter((fragment) => fragment.typeId === thingId);
    const methodRow = g.typesById.get(thingId)?.visibleRows.find((row) => row.name === 'short');

    expect(methodRow?.tyText.length ?? 0).toBeGreaterThan(120);
    expect(fragments.map((fragment) => fragment.fragmentKind)).toEqual(['main']);
    expect(fragments[0]?.width).toBeLessThan(220);
  });
});

describe('buildLayout — Layout shape', () => {
  it('returns populated modules + types for the small fixture (all expanded)', () => {
    const layout = buildLayout(smallFixtureInputs(SMALL_EXPANDED));
    expect(layout.modules.length).toBeGreaterThan(0);
    expect(layout.types).toHaveLength(5);
    expect(layout.totalWidth).toBeGreaterThan(0);
    expect(layout.totalHeight).toBeGreaterThan(0);
    expect(layout.arrows).toEqual([]); // Phase 5 fills these in
  });

  it('expanded type with fields renders a TypeBox of the expected height', () => {
    // Expand App: 2 fields → height = ROW_H + 2 × FIELD_ROW_H.
    const layout = buildLayout(smallFixtureInputs([...SMALL_EXPANDED, 'c::App']));
    const app = layout.types.find((t) => t.id === 'c::App');
    expect(app).toBeDefined();
    expect(app?.expanded).toBe(true);
    expect(app?.fields).toHaveLength(2);
    expect(app?.height).toBe(ROW_H + 2 * FIELD_ROW_H);
  });

  it('carries stable header hit geometry for the renderer', () => {
    const c = crateFacts('c', [
      mod('m', [ty('c', 'm', 'Thing', [{ name: 'field', ty_text: 'Target' }])]),
    ]);
    const collapsed = buildLayout(buildInputs(c, [], ['c', 'c::m']));
    const expanded = buildLayout(buildInputs(c, [], ['c', 'c::m', 'c::m::Thing']));
    const collapsedThing = collapsed.types.find((t) => t.id === 'c::m::Thing');
    const expandedThing = expanded.types.find((t) => t.id === 'c::m::Thing');

    expect(collapsedThing?.headerArrowX).not.toBeNull();
    expect(collapsedThing?.headerHitWidth).toBeGreaterThan(0);
    expect(expandedThing?.headerArrowX).toBe(collapsedThing?.headerArrowX);
    expect(expandedThing?.headerHitWidth).toBe(collapsedThing?.headerHitWidth);
  });

  it('renders method bucket and method rows from the shared geometry row contract', () => {
    const c = crateFacts('c', [
      mod('m', [
        {
          ...ty('c', 'm', 'Thing'),
          methods: [
            { name: 'alpha', visibility: 'pub', self_kind: 'ref' },
            { name: 'beta', visibility: 'pub', params: [{ name: 'n', ty_text: 'usize' }] },
          ],
        },
      ]),
    ]);
    const thingId = 'c::m::Thing';
    const layout = buildLayout(
      buildInputs(c, [], ['c', 'c::m', thingId, `${thingId}::__methods_pub`]),
    );
    const thing = layout.types.find((t) => t.id === thingId);

    expect(thing?.fields.map((f) => `${f.kind}:${f.name}`)).toEqual([
      'method_bucket:pub fn (2)',
      'method:alpha',
      'method:beta',
    ]);
    expect(thing?.height).toBe(ROW_H + 3 * FIELD_ROW_H);
  });

  it('renders module function rows from the shared callable row contract', () => {
    const c = crateFacts('c', [
      {
        path: 'm',
        file: 'src/m.rs',
        types: [],
        functions: [
          {
            name: 'parse',
            visibility: 'pub',
            params: [{ name: 'n', ty_text: 'usize' }],
            return_ty_text: 'bool',
          },
        ],
      },
    ]);
    const fnGroupId = 'c::m::__fn_pub';
    const layout = buildLayout(buildInputs(c, [], ['c', 'c::m', fnGroupId]));
    const group = layout.types.find((t) => t.id === fnGroupId);

    expect(group?.fields.map((f) => `${f.kind}:${f.name}:${f.tyText}`)).toEqual([
      'function:parse:(n: usize) -> bool',
    ]);
    expect(group?.fields[0]?.functionFullPath).toBe('c::m::parse');
    expect(group?.fields[0]?.hasOutgoingCalls).toBe(false);
    expect(group?.totalFieldCount).toBe(1);
    expect(group?.height).toBe(ROW_H + FIELD_ROW_H);
  });

  it('applies call behavior to module function rows through the same layout contract', () => {
    const c = crateFacts('c', [
      {
        path: 'm',
        file: 'src/m.rs',
        types: [],
        functions: [
          { name: 'local', visibility: 'pub' },
          { name: 'helper', visibility: 'pub' },
          { name: 'outbound', visibility: 'pub' },
          { name: 'unresolved', visibility: 'pub' },
        ],
      },
      {
        path: 'other',
        file: 'src/other.rs',
        types: [],
        functions: [{ name: 'far', visibility: 'pub' }],
      },
    ]);
    const facts: Facts = {
      crates: { c },
      edges: [],
      call_edges: [
        {
          caller: 'c::m::local',
          callee: 'c::m::helper',
          kind: 'function',
          resolution: 'exact',
          origin: 'helper',
        },
        {
          caller: 'c::m::outbound',
          callee: 'c::other::far',
          kind: 'function',
          resolution: 'exact',
          origin: 'other::far',
        },
        {
          caller: 'c::m::unresolved',
          callee: 'c::m::missing',
          kind: 'function',
          resolution: 'exact',
          origin: 'missing',
        },
      ],
    };
    const root = buildModuleTree(c);
    const calls = buildFunctionCallIndex(facts, root);
    const layout = buildLayout({
      ...buildInputs(c, [], ['c', 'c::m', 'c::m::__fn_pub', 'c::other']),
      calls,
    });
    const group = layout.types.find((t) => t.id === 'c::m::__fn_pub');
    const local = group?.fields.find((f) => f.name === 'local');
    const helper = group?.fields.find((f) => f.name === 'helper');
    const outbound = group?.fields.find((f) => f.name === 'outbound');
    const unresolved = group?.fields.find((f) => f.name === 'unresolved');

    expect(local?.callsOutsideModule).toBe(false);
    expect(local?.hasExternalCalls).toBe(false);
    expect(local?.hasUnresolvedCalls).toBe(false);
    expect(local?.hasOutgoingCalls).toBe(true);
    expect(local?.callTargets.map((target) => target.functionFullPath)).toEqual(['c::m::helper']);
    expect(helper?.hasIncomingCalls).toBe(true);
    expect(helper?.incomingCallRefs.map((call) => call.caller)).toEqual(['c::m::local']);
    expect(outbound?.callsOutsideModule).toBe(true);
    expect(outbound?.hasExternalCalls).toBe(true);
    expect(outbound?.hasUnresolvedCalls).toBe(false);
    expect(outbound?.hasOutgoingCalls).toBe(true);
    expect(outbound?.callTargets.map((target) => target.functionFullPath)).toEqual([
      'c::other::far',
    ]);
    expect(unresolved?.callsOutsideModule).toBe(true);
    expect(unresolved?.hasExternalCalls).toBe(false);
    expect(unresolved?.hasUnresolvedCalls).toBe(true);
    expect(unresolved?.hasOutgoingCalls).toBe(true);
    expect(unresolved?.callTargets).toEqual([]);
    expect(layout.arrowLayers.find((layer) => layer.id === 'call')?.arrows).toEqual([]);

    const active = buildLayout({
      ...buildInputs(c, [], ['c', 'c::m', 'c::m::__fn_pub', 'c::other']),
      calls,
      callArrowsShown: new Set([callArrowKey('c::m::__fn_pub', 'local', 'function')]),
    });
    const activeCallArrows = active.arrowLayers.find((layer) => layer.id === 'call')?.arrows ?? [];

    expect(activeCallArrows.map((arrow) => arrow.fromFieldName)).toEqual(['local']);
    expect(activeCallArrows.map((arrow) => arrow.toFieldName)).toEqual(['helper']);
  });

  it('keeps crowded target geometry unchanged during one-pass routing', () => {
    const inputs = crowdedTargetInputs();
    const firstGeometry = computeGeometry(inputs);
    const layout = buildLayout(inputs);

    expect(typeBoxGeometryFingerprint(layout.types)).toEqual(
      typeBoxGeometryFingerprint(toTypeBoxLike(firstGeometry.types)),
    );
    expect(layout.arrows.length).toBeGreaterThan(0);
  });

  it('keeps pressure fixture geometry unchanged during direct arrow emission', () => {
    const inputs = fallbackPressureInputs();
    const firstGeometry = computeGeometry(inputs);
    const layout = buildLayout({ ...inputs, measureText: measure });

    expect(typeBoxGeometryFingerprint(layout.types)).toEqual(
      typeBoxGeometryFingerprint(toTypeBoxLike(firstGeometry.types)),
    );
    expect(layout.arrows.length).toBeGreaterThan(0);
  });

  it('keeps the first-pass geometry when routing produces no pressure', () => {
    const c = crateFacts('c', [mod('m', [ty('c', 'm', 'Solo'), ty('c', 'm', 'Peer')])]);
    const inputs = buildInputs(c, [], ['c', 'c::m']);
    const firstGeometry = computeGeometry(inputs);
    const layout = buildLayout(inputs);

    expect(typeBoxGeometryFingerprint(layout.types)).toEqual(
      typeBoxGeometryFingerprint(toTypeBoxLike(firstGeometry.types)),
    );
  });

  it('surfaces the actual placement grid to the debug overlay', () => {
    const inputs = smallFixtureInputs(SMALL_EXPANDED);
    const geometry = computeGeometry(inputs);
    const layout = buildLayout(inputs);

    expect(layout.debug?.routing.layoutGrid).toEqual(geometry.debugGrid);
    expect(layout.debug?.routing.layoutGrid).toMatchObject({
      originX: geometry.globalXStart,
      originY: TOP_PAD,
      cellWidth: BAND_GRID_CELL_W,
      cellHeight: BAND_GRID_CELL_H,
    });
  });
});

describe('buildLayout — signature expansion', () => {
  function moduleWithFn(
    name: string,
    params: { name: string; ty_text: string }[],
    extras: { return_ty_text?: string; self_kind?: 'none' | 'by_value' | 'ref' | 'ref_mut' } = {},
  ): import('../src/data/schema.ts').CrateFacts {
    return crateFacts('c', [
      {
        path: 'm',
        file: 'src/m.rs',
        types: [],
        functions: [
          {
            name,
            visibility: 'pub',
            params,
            ...(extras.return_ty_text !== undefined
              ? { return_ty_text: extras.return_ty_text }
              : {}),
            ...(extras.self_kind !== undefined ? { self_kind: extras.self_kind } : {}),
          },
        ],
      },
    ]);
  }

  const fnGroupId = 'c::m::__fn_pub';
  const sigId = 'sig::c::m::parse';

  it('does not emit signature rows when the toggle is off', () => {
    const c = moduleWithFn('parse', [{ name: 'n', ty_text: 'usize' }], {
      return_ty_text: 'bool',
    });
    const layout = buildLayout(buildInputs(c, [], ['c', 'c::m', fnGroupId]));
    const group = layout.types.find((t) => t.id === fnGroupId);
    expect(group?.fields.map((f) => f.kind)).toEqual(['function']);
  });

  it('emits one signature_arg row per param plus a return row when the toggle is on', () => {
    const c = moduleWithFn(
      'parse',
      [
        { name: 'n', ty_text: 'usize' },
        { name: 'flag', ty_text: 'bool' },
      ],
      { return_ty_text: 'bool' },
    );
    const layout = buildLayout(buildInputs(c, [], ['c', 'c::m', fnGroupId, sigId]));
    const group = layout.types.find((t) => t.id === fnGroupId);
    expect(group?.fields.map((f) => `${f.kind}:${f.name}:${f.tyText}`)).toEqual([
      'function:parse:(n: usize, flag: bool) -> bool',
      'signature_arg:n:usize',
      'signature_arg:flag:bool',
      'signature_arg:->:bool',
    ]);
  });

  it('omits the return row when the return type is unit', () => {
    const c = moduleWithFn('parse', [{ name: 'n', ty_text: 'usize' }], {
      return_ty_text: '()',
    });
    const layout = buildLayout(buildInputs(c, [], ['c', 'c::m', fnGroupId, sigId]));
    const group = layout.types.find((t) => t.id === fnGroupId);
    expect(group?.fields.map((f) => `${f.kind}:${f.name}`)).toEqual([
      'function:parse',
      'signature_arg:n',
    ]);
  });

  it('emits a self-receiver row for ref methods when expanded', () => {
    const c = crateFacts('c', [
      mod('m', [
        {
          ...ty('c', 'm', 'Thing'),
          methods: [
            {
              name: 'alpha',
              visibility: 'pub',
              self_kind: 'ref_mut',
              params: [{ name: 'n', ty_text: 'usize' }],
              return_ty_text: '()',
            },
          ],
        },
      ]),
    ]);
    const thingId = 'c::m::Thing';
    const layout = buildLayout(
      buildInputs(c, [], [
        'c',
        'c::m',
        thingId,
        `${thingId}::__methods_pub`,
        'sig::c::m::Thing::alpha',
      ]),
    );
    const thing = layout.types.find((t) => t.id === thingId);
    expect(thing?.fields.map((f) => `${f.kind}:${f.name}`)).toEqual([
      'method_bucket:pub fn (1)',
      'method:alpha',
      'signature_arg:&mut self',
      'signature_arg:n',
    ]);
  });

  it('grows the type box height to include signature rows', () => {
    const c = moduleWithFn(
      'parse',
      [
        { name: 'n', ty_text: 'usize' },
        { name: 'flag', ty_text: 'bool' },
      ],
      { return_ty_text: 'bool' },
    );
    const collapsed = buildLayout(buildInputs(c, [], ['c', 'c::m', fnGroupId]));
    const expanded = buildLayout(buildInputs(c, [], ['c', 'c::m', fnGroupId, sigId]));
    const collapsedH = collapsed.types.find((t) => t.id === fnGroupId)?.height ?? 0;
    const expandedH = expanded.types.find((t) => t.id === fnGroupId)?.height ?? 0;
    // Three extra rows: two params + return.
    expect(expandedH).toBe(collapsedH + 3 * FIELD_ROW_H);
  });

  it('stamps each signature row with its parent function path so renderers can key them uniquely', () => {
    // Regression: when two callable rows both have a `-> Self` signature
    // row (or both have a param named `n`), the renderer's data-join must
    // not collapse them onto one DOM node. Including the parent function
    // path on each row makes that key uniqueness possible.
    const c = crateFacts('c', [
      {
        path: 'm',
        file: 'src/m.rs',
        types: [],
        functions: [
          { name: 'new', visibility: 'pub', return_ty_text: 'Self' },
          { name: 'default', visibility: 'pub', return_ty_text: 'Self' },
        ],
      },
    ]);
    const layout = buildLayout(
      buildInputs(c, [], [
        'c',
        'c::m',
        'c::m::__fn_pub',
        'sig::c::m::new',
        'sig::c::m::default',
      ]),
    );
    const group = layout.types.find((t) => t.id === 'c::m::__fn_pub');
    const sigRows = group?.fields.filter((f) => f.kind === 'signature_arg') ?? [];
    expect(sigRows.map((r) => r.functionFullPath)).toEqual(['c::m::default', 'c::m::new']);
  });

  it('reserves room for the `→` locality glyph so callable arrowSourceX is past the row name', () => {
    const c = moduleWithFn('parse', [], {});
    const layout = buildLayout(buildInputs(c, [], ['c', 'c::m', fnGroupId]));
    const fn = layout.types
      .find((t) => t.id === fnGroupId)
      ?.fields.find((f) => f.kind === 'function');
    if (!fn) throw new Error('expected function row');
    // arrowSourceX sits past the row name PLUS the reserved `→` glyph,
    // not just past the name. Without the reserve, outgoing call arrows
    // would draw straight through the locality glyph.
    // Glyph sits a small fixed gap after the row name; arrowSourceX is
    // past the glyph plus its trailing gap. We assert the structural
    // relationship rather than the exact pixel constant — the constant
    // is allowed to shrink/grow without breaking the test.
    expect(fn.arrowSourceX).toBeGreaterThan(fn.x + fn.textWidth);
    expect(fn.localityGlyphX).toBeGreaterThan(fn.x + fn.textWidth);
    expect(fn.localityGlyphX).toBeLessThan(fn.arrowSourceX);
  });

  it('uses bold measurement for callable textWidth only when the row is selected', () => {
    // Selected callables render bold; bold measurement is only correct
    // for those rows. Unselected callables stay tight (regular measure)
    // so the `→` glyph hugs the row name. Selection toggle rebuilds the
    // layout, so the geometry sees current selection via callArrowsShown.
    const c = moduleWithFn('parse', [], {});
    const base = buildInputs(c, [], ['c', 'c::m', fnGroupId]);
    const measure = (s: string): number => s.length * 7;
    const measureBold = (s: string): number => s.length * 70;

    const unselected = buildLayout({
      ...base,
      measureText: measure,
      measureBoldText: measureBold,
    });
    const unselectedRow = unselected.types
      .find((t) => t.id === fnGroupId)
      ?.fields.find((f) => f.kind === 'function');
    if (!unselectedRow) throw new Error('expected function row');
    expect(unselectedRow.textWidth).toBe(measure('parse'));

    const selected = buildLayout({
      ...base,
      measureText: measure,
      measureBoldText: measureBold,
      callArrowsShown: new Set([callArrowKey(fnGroupId, 'parse', 'function')]),
    });
    const selectedRow = selected.types
      .find((t) => t.id === fnGroupId)
      ?.fields.find((f) => f.kind === 'function');
    if (!selectedRow) throw new Error('expected function row');
    expect(selectedRow.textWidth).toBe(measureBold('parse'));
  });
});

describe('buildLayout — leftPortX accounts for drift dot', () => {
  function makeDriftedField(): import('../src/data/schema.ts').CrateFacts {
    return crateFacts('c', [
      mod('a::b::c', [
        ty('c', 'a::b::c', 'Source', [{ name: 'target_field', ty_text: 'crate::Far' }]),
      ]),
      mod('', [ty('c', '', 'Far')]),
    ]);
  }

  it('canonical field rows have leftPortX equal to row x', () => {
    const c = crateFacts('c', [
      mod('m', [ty('c', 'm', 'S', [{ name: 'f', ty_text: 'Target' }]), ty('c', 'm', 'Target')]),
    ]);
    const layout = buildLayout(
      buildInputs(c, [edge('c::m::S', 'c::m::Target', 'field f')], [
        'c',
        'c::m',
        'c::m::S',
      ]),
    );
    const f = layout.types
      .find((t) => t.id === 'c::m::S')
      ?.fields.find((row) => row.name === 'f');
    if (!f) throw new Error('expected field row');
    expect(f.leftPortX).toBe(f.x);
  });

  it('field rows with drift_above push leftPortX left of row x to clear the dot', () => {
    // Source is deep (c::a::b::c::Source); target is at the crate root
    // (c::Far). Ownership depth says the source field's target should be
    // deeper than the source — so the field is drift_above and renders a
    // red dot. The row's leftPortX must sit past the dot.
    const layout = buildLayout(
      buildInputs(
        makeDriftedField(),
        [edge('c::a::b::c::Source', 'c::Far', 'field target_field')],
        ['c', 'c::a', 'c::a::b', 'c::a::b::c', 'c::a::b::c::Source'],
      ),
    );
    const f = layout.types
      .find((t) => t.id === 'c::a::b::c::Source')
      ?.fields.find((row) => row.name === 'target_field');
    if (!f) throw new Error('expected field row');
    expect(f.memberDriftClass).not.toBeNull();
    expect(f.memberDriftClass).not.toBe('at_lca');
    expect(f.memberDriftClass).not.toBe('within_budget');
    expect(f.leftPortX).toBeLessThan(f.x);
  });
});

function toTypeBoxLike(types: readonly PositionedType[]): readonly TypeBox[] {
  return types.map(
    (t): TypeBox => ({
      id: t.node.id,
      label: t.node.label,
      typeKind: t.node.typeKind,
      visibility: t.node.visibility,
      fullPath: t.node.fullPath,
      modulePath: t.node.modulePath,
      col: t.depth,
      x: t.x,
      y: t.y,
      width: t.width,
      boxX: t.x,
      boxY: t.y - 12,
      boxWidth: t.width,
      boxHeight: t.height,
      headerArrowX: t.headerArrowX,
      headerHitWidth: t.headerHitWidth,
      height: t.height,
      hasFields: t.node.fields.length > 0 || t.node.methodBuckets.length > 0,
      expanded: t.expanded,
      fields: [],
      totalFieldCount: t.node.fields.length,
      isGhost: t.node.isGhost ?? false,
      ghostTarget: t.node.ghostTarget ?? null,
    }),
  );
}
