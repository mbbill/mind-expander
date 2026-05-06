import { describe, expect, it } from 'vitest';
import { computeDrift } from '../src/analysis/drift.ts';
import { FIELD_ROW_H, ROW_H, buildLayout, buildOptimizedLayout } from '../src/analysis/layout.ts';
import { buildModuleTree } from '../src/analysis/module_tree.ts';
import { buildOwnershipIndex, computeOwnershipDepth } from '../src/analysis/ownership.ts';
import type {
  CrateFacts,
  Edge,
  Facts,
  FnFacts,
  ModuleFacts,
  ReExport,
  TypeFacts,
} from '../src/data/schema.ts';
import { ViewState } from '../src/state/view_state.ts';

function ty(
  crate: string,
  modPath: string,
  name: string,
  fields: { name: string; ty_text: string }[] = [],
): TypeFacts {
  const full = modPath === '' ? `${crate}::${name}` : `${crate}::${modPath}::${name}`;
  return {
    name,
    full_path: full,
    kind: 'struct',
    visibility: 'pub',
    fields: fields.map((f) => ({ ...f, ownership: 'owned' as const })),
  };
}

function mod(
  path: string,
  types: TypeFacts[] = [],
  options: {
    readonly functions?: readonly FnFacts[];
    readonly re_exports?: readonly ReExport[];
  } = {},
): ModuleFacts {
  const file = path === '' ? 'src/lib.rs' : `src/${path.replace(/::/g, '/')}.rs`;
  const base: ModuleFacts = {
    path,
    types,
    file,
    functions: options.functions ?? [],
  };
  return options.re_exports !== undefined ? { ...base, re_exports: options.re_exports } : base;
}

function crateFacts(name: string, modules: ModuleFacts[]): CrateFacts {
  return { name, modules: Object.fromEntries(modules.map((m) => [m.path, m])) };
}

function edge(from: string, to: string, origin = 'field x'): Edge {
  return { from, to, kind: 'owns', via: 'struct_field', origin };
}

function facts(crate: CrateFacts, edges: Edge[]): Facts {
  return { crates: { [crate.name]: crate }, edges };
}

function setup(crate: CrateFacts, edges: Edge[], expandedIds: string[]) {
  const f = facts(crate, edges);
  const root = buildModuleTree(crate);
  const ownership = buildOwnershipIndex(f, crate.name);
  const typeModule = collectTypeModule(root);
  const drift = computeDrift(ownership, typeModule);
  const depth = computeOwnershipDepth(ownership, collectIds(root), drift);
  const state = new ViewState(expandedIds);
  return buildLayout({ staticRoot: root, ownership, depth, state, drift });
}

function collectTypeModule(root: ReturnType<typeof buildModuleTree>): Map<string, string> {
  const out = new Map<string, string>();
  type N = { kind: string; fullPath?: string; modulePath?: string; children?: readonly N[] };
  const walk = (n: N): void => {
    if (n.kind === 'type' && n.fullPath !== undefined && n.modulePath !== undefined) {
      out.set(n.fullPath, n.modulePath);
    } else {
      for (const c of n.children ?? []) walk(c);
    }
  };
  walk(root as never);
  return out;
}

function collectIds(node: {
  kind: string;
  children?: readonly { kind: string }[];
  fullPath?: string;
}): string[] {
  const out: string[] = [];
  const walk = (n: {
    kind: string;
    fullPath?: string;
    children?: readonly { kind: string }[];
  }): void => {
    if (n.kind === 'type' && n.fullPath) out.push(n.fullPath);
    else for (const c of n.children ?? []) walk(c as never);
  };
  walk(node as never);
  return out;
}

describe('buildLayout', () => {
  it('collapsed state: only the crate root row, all bands height = 1 row', () => {
    const c = crateFacts('c', [mod(''), mod('a', [ty('c', 'a', 'X')])]);
    const layout = setup(c, [], []); // crate root NOT expanded
    expect(layout.modules).toHaveLength(1);
    expect(layout.modules[0]?.bandHeight).toBe(ROW_H);
    expect(layout.types).toHaveLength(0);
  });

  it('expanded crate root reveals child modules; their bands are 1 row when collapsed', () => {
    const c = crateFacts('c', [mod(''), mod('a', [ty('c', 'a', 'X')]), mod('b')]);
    const root = buildModuleTree(c);
    const layout = setup(c, [], [root.id]);
    const labels = layout.modules.map((m) => m.label);
    expect(labels).toEqual(['c', 'a', 'b']);
    expect(layout.types).toHaveLength(0);
  });

  it('expanding a module renders its types in the band', () => {
    const c = crateFacts('c', [mod(''), mod('a', [ty('c', 'a', 'Foo'), ty('c', 'a', 'Bar')])]);
    const root = buildModuleTree(c);
    const layout = setup(c, [], [root.id, 'c::a']);
    expect(layout.types.map((t) => t.label).sort()).toEqual(['Bar', 'Foo']);
  });

  it('chain ownership A→B→C in one module packs into a single row', () => {
    const c = crateFacts('c', [
      mod(''),
      mod('a', [ty('c', 'a', 'A'), ty('c', 'a', 'B'), ty('c', 'a', 'C')]),
    ]);
    const root = buildModuleTree(c);
    const layout = setup(
      c,
      [edge('c::a::A', 'c::a::B'), edge('c::a::B', 'c::a::C')],
      [root.id, 'c::a'],
    );
    // All three types share a y → packed into 1 row → band height = 1 × ROW_H
    const aBand = layout.modules.find((m) => m.label === 'a');
    expect(aBand?.bandHeight).toBe(ROW_H);
    const ys = new Set(layout.types.map((t) => t.y));
    expect(ys.size).toBe(1);
    // x increases by depth: A < B < C
    const byName = new Map(layout.types.map((t) => [t.label, t.x]));
    expect(byName.get('A')).toBeLessThan(byName.get('B') as number);
    expect(byName.get('B')).toBeLessThan(byName.get('C') as number);
  });

  it('two unrelated roots in one module take two rows', () => {
    const c = crateFacts('c', [mod(''), mod('a', [ty('c', 'a', 'X'), ty('c', 'a', 'Y')])]);
    const root = buildModuleTree(c);
    const layout = setup(c, [], [root.id, 'c::a']);
    const aBand = layout.modules.find((m) => m.label === 'a');
    expect(aBand?.bandHeight).toBe(2 * ROW_H);
  });

  it('many unconstrained collapsed roots wrap into shelf columns', () => {
    const roots = Array.from({ length: 9 }, (_, i) => ty('c', 'a', `Root${i}`));
    const c = crateFacts('c', [mod(''), mod('a', roots)]);
    const root = buildModuleTree(c);
    const layout = setup(c, [], [root.id, 'c::a']);
    const aBand = layout.modules.find((m) => m.label === 'a');
    expect(aBand?.bandHeight).toBe(3 * ROW_H);
    expect(new Set(layout.types.map((t) => t.x)).size).toBe(3);
  });

  it('expanded type takes (1 + fieldCount) rows in its band', () => {
    const c = crateFacts('c', [
      mod(''),
      mod('a', [
        ty('c', 'a', 'A', [
          { name: 'x', ty_text: 'i32' },
          { name: 'y', ty_text: 'i32' },
          { name: 'z', ty_text: 'i32' },
        ]),
      ]),
    ]);
    const root = buildModuleTree(c);
    const layout = setup(c, [], [root.id, 'c::a', 'c::a::A']);
    const aBand = layout.modules.find((m) => m.label === 'a');
    // Expanded type: 1 header (ROW_H) + 3 field rows (FIELD_ROW_H each).
    expect(aBand?.bandHeight).toBe(ROW_H + 3 * FIELD_ROW_H);
    const aType = layout.types.find((t) => t.label === 'A');
    expect(aType?.expanded).toBe(true);
    expect(aType?.fields).toHaveLength(3);
  });

  it('arrows are emitted from expanded type fields to in-layout target types', () => {
    const c = crateFacts('c', [
      mod(''),
      mod('a', [ty('c', 'a', 'A', [{ name: 'b', ty_text: 'B' }]), ty('c', 'a', 'B')]),
    ]);
    const root = buildModuleTree(c);
    const layout = setup(c, [edge('c::a::A', 'c::a::B', 'field b')], [root.id, 'c::a', 'c::a::A']);
    expect(layout.arrows).toHaveLength(1);
    expect(layout.arrows[0]?.fromTypeId).toBe('c::a::A');
    expect(layout.arrows[0]?.toTypeId).toBe('c::a::B');
  });

  it('no arrow when target type module is collapsed (target not in layout)', () => {
    const c = crateFacts('c', [
      mod(''),
      mod('a', [ty('c', 'a', 'A', [{ name: 'b', ty_text: 'B' }])]),
      mod('b', [ty('c', 'b', 'B')]),
    ]);
    const root = buildModuleTree(c);
    // expand A but leave c::b collapsed
    const layout = setup(c, [edge('c::a::A', 'c::b::B', 'field b')], [root.id, 'c::a', 'c::a::A']);
    expect(layout.arrows).toHaveLength(0);
  });

  it('barycenter sweep reorders types within a band to bring partners close', () => {
    // Setup: T1, T2 in `a`; X1, X2 in `a::sub` so they're within_budget (LCA
    // of X's owner = `a`, X.modulePath = `a::sub`, depth-diff = 1, default
    // budget = 1 → canonical). Drift'd types would be skipped by the
    // barycenter sweep, which is correct but not what this test exercises.
    // T1 owns X2; T2 owns X1. Alphabetical order: T1,T2 / X1,X2 → 1 crossing.
    // After barycenter: T1@top→X2@top, T2@bottom→X1@bottom → zero crossings.
    const c = crateFacts('c', [
      mod(''),
      mod('a', [ty('c', 'a', 'T1'), ty('c', 'a', 'T2')]),
      mod('a::sub', [ty('c', 'a::sub', 'X1'), ty('c', 'a::sub', 'X2')]),
    ]);
    const root = buildModuleTree(c);
    const f = facts(c, [
      edge('c::a::T1', 'c::a::sub::X2', 'field x'),
      edge('c::a::T2', 'c::a::sub::X1', 'field x'),
    ]);
    const ownership = buildOwnershipIndex(f, c.name);
    const tm = collectTypeModule(root);
    const drift = computeDrift(ownership, tm);
    const dep = computeOwnershipDepth(ownership, collectIds(root), drift);
    const state = new ViewState([root.id, 'c::a', 'c::a::sub']);

    const naive = buildLayout({ staticRoot: root, ownership, depth: dep, state, drift });
    const optimized = buildOptimizedLayout({
      staticRoot: root,
      ownership,
      depth: dep,
      state,
      drift,
    });

    const yOf = (l: typeof naive, label: string) => l.types.find((t) => t.label === label)?.y ?? 0;

    // Naive: alphabetical → X1 above X2
    expect(yOf(naive, 'X1')).toBeLessThan(yOf(naive, 'X2'));
    // Optimized: barycenter pulls X2 above X1 to align with T1
    expect(yOf(optimized, 'X2')).toBeLessThan(yOf(optimized, 'X1'));
  });

  it('expanded barycenter placement anchors the header row, not the box center', () => {
    const c = crateFacts('c', [
      mod(''),
      mod('a', [
        ty('c', 'a', 'A', [
          { name: 'b', ty_text: 'B' },
          { name: 'pad1', ty_text: 'u8' },
          { name: 'pad2', ty_text: 'u8' },
          { name: 'pad3', ty_text: 'u8' },
          { name: 'pad4', ty_text: 'u8' },
        ]),
        ty('c', 'a', 'B', [{ name: 'value', ty_text: 'u8' }]),
      ]),
    ]);
    const root = buildModuleTree(c);
    const f = facts(c, [edge('c::a::A', 'c::a::B', 'field b')]);
    const ownership = buildOwnershipIndex(f, c.name);
    const tm = collectTypeModule(root);
    const drift = computeDrift(ownership, tm);
    const dep = computeOwnershipDepth(ownership, collectIds(root), drift);
    const state = new ViewState([root.id, 'c::a', 'c::a::A', 'c::a::B']);

    const layout = buildOptimizedLayout({
      staticRoot: root,
      ownership,
      depth: dep,
      state,
      drift,
    });
    const a = layout.types.find((t) => t.label === 'A');
    const b = layout.types.find((t) => t.label === 'B');
    expect(a?.fields[0]?.y).toBeDefined();
    expect(b?.y).toBe(a?.fields[0]?.y);
  });

  it('expanded bands keep collapsed neighbors from jumping upward into spare slots', () => {
    const c = crateFacts('c', [
      mod(''),
      mod('a', [
        ty('c', 'a', 'A'),
        ty('c', 'a', 'B', [
          { name: 'b0', ty_text: 'u8' },
          { name: 'b1', ty_text: 'u8' },
          { name: 'b2', ty_text: 'u8' },
          { name: 'b3', ty_text: 'u8' },
        ]),
        ty('c', 'a', 'C'),
      ]),
    ]);
    const root = buildModuleTree(c);
    const f = facts(c, []);
    const ownership = buildOwnershipIndex(f, c.name);
    const tm = collectTypeModule(root);
    const drift = computeDrift(ownership, tm);
    const dep = computeOwnershipDepth(ownership, collectIds(root), drift);
    const state = new ViewState([root.id, 'c::a', 'c::a::B']);
    const inputs = { staticRoot: root, ownership, depth: dep, state, drift };
    const baseline = buildLayout(inputs);
    const anchorY = new Map(baseline.types.map((t) => [t.fullPath, t.y]));
    const cBefore = baseline.types.find((t) => t.label === 'C');

    const pulled = buildLayout({
      ...inputs,
      anchorY,
      sortKey: new Map([
        ['c::a::C', 0],
        ['c::a::A', 1000],
        ['c::a::B', 1000],
      ]),
    });
    const cAfter = pulled.types.find((t) => t.label === 'C');

    expect(cBefore?.y).toBeDefined();
    expect(cAfter?.y).toBeGreaterThanOrEqual(cBefore?.y ?? 0);
  });

  it('totalWidth covers the rightmost type box and module label', () => {
    const c = crateFacts('c', [mod(''), mod('a', [ty('c', 'a', 'X')])]);
    const root = buildModuleTree(c);
    const layout = setup(c, [], [root.id, 'c::a']);
    // Must be at least as wide as every type's right edge.
    for (const t of layout.types) {
      expect(layout.totalWidth).toBeGreaterThanOrEqual(t.x + t.width);
    }
    // Must be positive when there's any content.
    expect(layout.totalWidth).toBeGreaterThan(0);
  });

  it('totalWidth grows or stays flat when a type expands', () => {
    const c = crateFacts('c', [
      mod(''),
      mod('a', [ty('c', 'a', 'WideType', [{ name: 'aLongFieldNameHere', ty_text: 'u32' }])]),
    ]);
    const root = buildModuleTree(c);
    const collapsed = setup(c, [], [root.id, 'c::a']);
    const expanded = setup(c, [], [root.id, 'c::a', 'c::a::WideType']);
    // Expanding a type can only add field-name width; it must not shrink
    // the overall horizontal extent.
    expect(expanded.totalWidth).toBeGreaterThanOrEqual(collapsed.totalWidth);
  });

  it('unrelated root types share the same starting x by default', () => {
    const c = crateFacts('c', [
      mod(''),
      mod('a', [ty('c', 'a', 'X')]),
      mod('a::b', [ty('c', 'a::b', 'Y')]),
    ]);
    const root = buildModuleTree(c);
    const layout = setup(c, [], [root.id, 'c::a', 'c::a::b']);
    const xs = layout.types.map((t) => t.x);
    // With no visible ownership path, both roots start at the same x.
    expect(new Set(xs).size).toBe(1);
  });
});

describe('buildLayout — per-channel routing', () => {
  it('TypeBox.col reflects rank: fn-group at 0, depth-0 at 1, depth-1 at 2', () => {
    const c = crateFacts('c', [
      mod(''),
      mod('a', [ty('c', 'a', 'A', [{ name: 'b', ty_text: 'B' }]), ty('c', 'a', 'B')]),
    ]);
    const root = buildModuleTree(c);
    const layout = setup(c, [edge('c::a::A', 'c::a::B', 'field b')], [root.id, 'c::a']);
    const a = layout.types.find((t) => t.label === 'A');
    const b = layout.types.find((t) => t.label === 'B');
    expect(a?.col).toBe(1);
    expect(b?.col).toBe(2);
  });

  it('structural arrow lane.x lives between the source box and target box', () => {
    // Multi-arrow setup at the test scale; verify every arrow's
    // vertical-segment x is in the target-local gutter, not over text.
    const c = crateFacts('c', [
      mod(''),
      mod('a', [
        ty('c', 'a', 'A', [
          { name: 'b1', ty_text: 'B' },
          { name: 'b2', ty_text: 'B' },
          { name: 'b3', ty_text: 'B' },
        ]),
        ty('c', 'a', 'B', [
          { name: 'c1', ty_text: 'C' },
          { name: 'c2', ty_text: 'C' },
        ]),
        ty('c', 'a', 'C'),
      ]),
    ]);
    const root = buildModuleTree(c);
    const layout = setup(
      c,
      [
        edge('c::a::A', 'c::a::B', 'field b1'),
        edge('c::a::A', 'c::a::B', 'field b2'),
        edge('c::a::A', 'c::a::B', 'field b3'),
        edge('c::a::B', 'c::a::C', 'field c1'),
        edge('c::a::B', 'c::a::C', 'field c2'),
      ],
      [root.id, 'c::a', 'c::a::A', 'c::a::B'],
    );
    const byId = new Map(layout.types.map((t) => [t.fullPath, t]));
    for (const a of layout.arrows) {
      if (a.kind !== 'ownership') continue;
      const source = byId.get(a.fromTypeId);
      const target = byId.get(a.toTypeId);
      expect(source).toBeDefined();
      expect(target).toBeDefined();
      const laneX = a.waypoints[a.waypoints.length - 2]?.x;
      expect(laneX).toBeGreaterThan(
        (source as NonNullable<typeof source>).x + (source as NonNullable<typeof source>).width,
      );
      expect(laneX).toBeLessThan((target as NonNullable<typeof target>).x);
    }
  });

  it('different same-x targets get separate vertical lanes when intervals overlap', () => {
    const c = crateFacts('c', [
      mod(''),
      mod('a', [
        ty('c', 'a', 'A', [
          { name: 'pad1', ty_text: 'u8' },
          { name: 'pad2', ty_text: 'u8' },
          { name: 'b', ty_text: 'B' },
          { name: 'c', ty_text: 'C' },
        ]),
        ty('c', 'a', 'B'),
        ty('c', 'a', 'C'),
      ]),
    ]);
    const root = buildModuleTree(c);
    const layout = setup(
      c,
      [edge('c::a::A', 'c::a::B', 'field b'), edge('c::a::A', 'c::a::C', 'field c')],
      [root.id, 'c::a', 'c::a::A'],
    );
    const b = layout.types.find((t) => t.label === 'B');
    const cType = layout.types.find((t) => t.label === 'C');
    expect(b).toBeDefined();
    expect(cType).toBeDefined();
    expect(b?.x).toBe(cType?.x);

    const arrows = layout.arrows.filter(
      (a) => a.toTypeId === 'c::a::B' || a.toTypeId === 'c::a::C',
    );
    expect(arrows).toHaveLength(2);
    const laneXs = new Set(arrows.map((a) => a.waypoints[a.waypoints.length - 2]?.x));
    expect(laneXs.size).toBe(2);
  });

  it('a heavy target-local incoming gutter is wider than a light one', () => {
    // 5 arrows into B (all overlapping y, so all need distinct slots),
    // 1 arrow into C. The target-local gutter before B should be wider
    // than the target-local gutter before C.
    const c = crateFacts('c', [
      mod(''),
      mod('a', [
        ty('c', 'a', 'A1', [{ name: 'p', ty_text: 'B' }]),
        ty('c', 'a', 'A2', [{ name: 'q', ty_text: 'B' }]),
        ty('c', 'a', 'A3', [{ name: 'r', ty_text: 'B' }]),
        ty('c', 'a', 'A4', [{ name: 's', ty_text: 'B' }]),
        ty('c', 'a', 'A5', [{ name: 't', ty_text: 'B' }]),
        ty('c', 'a', 'B', [{ name: 'c', ty_text: 'C' }]),
        ty('c', 'a', 'C'),
      ]),
    ]);
    const root = buildModuleTree(c);
    const layout = setup(
      c,
      [
        edge('c::a::A1', 'c::a::B', 'field p'),
        edge('c::a::A2', 'c::a::B', 'field q'),
        edge('c::a::A3', 'c::a::B', 'field r'),
        edge('c::a::A4', 'c::a::B', 'field s'),
        edge('c::a::A5', 'c::a::B', 'field t'),
        edge('c::a::B', 'c::a::C', 'field c'),
      ],
      [root.id, 'c::a', 'c::a::A1', 'c::a::A2', 'c::a::A3', 'c::a::A4', 'c::a::A5', 'c::a::B'],
    );
    const sources = layout.types.filter((t) => /^A[1-5]$/.test(t.label));
    const b = layout.types.find((t) => t.label === 'B');
    const cType = layout.types.find((t) => t.label === 'C');
    expect(b).toBeDefined();
    expect(cType).toBeDefined();
    const sourcesRight = Math.max(...sources.map((t) => t.x + t.width));
    const heavyGutter = (b as NonNullable<typeof b>).x - sourcesRight;
    const lightGutter =
      (cType as NonNullable<typeof cType>).x -
      ((b as NonNullable<typeof b>).x + (b as NonNullable<typeof b>).width);
    expect(heavyGutter).toBeGreaterThan(lightGutter);
  });

  it('same-rank branches diverge when one path is wider or busier', () => {
    const c = crateFacts('c', [
      mod(''),
      mod('a', [
        ty('c', 'a', 'A', [
          { name: 'b', ty_text: 'VeryWideBranchNode' },
          { name: 'd', ty_text: 'D' },
        ]),
        ty('c', 'a', 'VeryWideBranchNode', [{ name: 'c', ty_text: 'C' }]),
        ty('c', 'a', 'D', [{ name: 'e', ty_text: 'E' }]),
        ty('c', 'a', 'C'),
        ty('c', 'a', 'E'),
      ]),
    ]);
    const root = buildModuleTree(c);
    const layout = setup(
      c,
      [
        edge('c::a::A', 'c::a::VeryWideBranchNode', 'field b'),
        edge('c::a::A', 'c::a::D', 'field d'),
        edge('c::a::VeryWideBranchNode', 'c::a::C', 'field c'),
        edge('c::a::D', 'c::a::E', 'field e'),
      ],
      [root.id, 'c::a', 'c::a::A', 'c::a::VeryWideBranchNode', 'c::a::D'],
    );
    const byLabel = new Map(layout.types.map((t) => [t.label, t]));
    const b = byLabel.get('VeryWideBranchNode');
    const d = byLabel.get('D');
    const cType = byLabel.get('C');
    const e = byLabel.get('E');
    expect(b).toBeDefined();
    expect(d).toBeDefined();
    expect(cType).toBeDefined();
    expect(e).toBeDefined();
    expect((b as NonNullable<typeof b>).x).toBe((d as NonNullable<typeof d>).x);
    expect((cType as NonNullable<typeof cType>).x).toBeGreaterThan((e as NonNullable<typeof e>).x);
  });

  it('drift return rails share the left-side rail instead of filling the source-target corridor', () => {
    const c = crateFacts('c', [
      mod(''),
      mod('a', [], {
        functions: [
          { name: 'f0', visibility: 'pub' },
          { name: 'f1', visibility: 'pub' },
          { name: 'f2', visibility: 'pub' },
          { name: 'f3', visibility: 'pub' },
        ],
      }),
      mod('a::deep::deeper', [
        ty('c', 'a::deep::deeper', 'T0'),
        ty('c', 'a::deep::deeper', 'T1'),
        ty('c', 'a::deep::deeper', 'T2'),
        ty('c', 'a::deep::deeper', 'T3'),
      ]),
    ]);
    const root = buildModuleTree(c);
    const fnGroup = 'c::a::__fn_pub';
    const layout = setup(
      c,
      [
        edge(fnGroup, 'c::a::deep::deeper::T0', 'field f0'),
        edge(fnGroup, 'c::a::deep::deeper::T1', 'field f1'),
        edge(fnGroup, 'c::a::deep::deeper::T2', 'field f2'),
        edge(fnGroup, 'c::a::deep::deeper::T3', 'field f3'),
      ],
      [root.id, 'c::a', fnGroup, 'c::a::deep', 'c::a::deep::deeper'],
    );
    const driftArrows = layout.arrows.filter((a) => a.driftClass === 'drift_below');
    expect(driftArrows).toHaveLength(4);

    const leftmostTypeX = Math.min(...layout.types.map((t) => t.x));
    const laneXs = new Set<number>();
    for (const a of driftArrows) {
      const start = a.waypoints[0];
      const lane = a.waypoints[1];
      const target = a.waypoints[a.waypoints.length - 1];
      expect(start).toBeDefined();
      expect(lane).toBeDefined();
      expect(target).toBeDefined();
      const sourceToLane =
        (lane as NonNullable<typeof lane>).x - (start as NonNullable<typeof start>).x;
      const laneToTarget =
        (target as NonNullable<typeof target>).x - (lane as NonNullable<typeof lane>).x;
      expect(sourceToLane).toBeLessThan(0);
      expect(laneToTarget).toBeGreaterThan(0);
      expect((lane as NonNullable<typeof lane>).x).toBeLessThan(leftmostTypeX);
      laneXs.add((lane as NonNullable<typeof lane>).x);
    }
    expect(laneXs.size).toBe(1);
  });
});

describe('buildLayout — function-group column shift', () => {
  it('places function-group pseudo-types to the LEFT of real depth-0 types', () => {
    // Module owns one real type (depth 0) AND a free function. The function
    // group lives at column 0; the real type lives at column 1+.
    const c = crateFacts('c', [
      mod('', [ty('c', '', 'Real')], { functions: [{ name: 'f', visibility: 'pub' }] }),
    ]);
    const root = buildModuleTree(c);
    const layout = setup(c, [], [root.id]);
    const fnGroup = layout.types.find((t) => t.typeKind === 'function_group');
    const real = layout.types.find((t) => t.label === 'Real');
    expect(fnGroup).toBeDefined();
    expect(real).toBeDefined();
    // Strict less-than: real types are shifted right by one column.
    expect((fnGroup as NonNullable<typeof fnGroup>).x).toBeLessThan(
      (real as NonNullable<typeof real>).x,
    );
  });

  it('uses a tighter row indent for module-level function names', () => {
    const c = crateFacts('c', [
      mod('', [], { functions: [{ name: 'top_level', visibility: 'pub' }] }),
    ]);
    const root = buildModuleTree(c);
    const fnGroupId = 'c::__fn_pub';
    const layout = setup(c, [], [root.id, fnGroupId]);
    const fnGroup = layout.types.find((t) => t.typeKind === 'function_group');
    const row = fnGroup?.fields.find((f) => f.name === 'top_level');
    expect(fnGroup).toBeDefined();
    expect(row).toBeDefined();
    expect((row as NonNullable<typeof row>).x - (fnGroup as NonNullable<typeof fnGroup>).x).toBe(
      24,
    );
  });

  it('packs real types into short-row pockets beside expanded function groups', () => {
    const longFn = 'a_function_name_long_enough_to_cross_the_type_column';
    const shortFn = 'z';
    const c = crateFacts('c', [
      mod('', [ty('c', '', 'ZAnchor'), ty('c', '', 'ZPocket')], {
        functions: [
          { name: longFn, visibility: 'pub' },
          { name: shortFn, visibility: 'pub' },
        ],
      }),
    ]);
    const root = buildModuleTree(c);
    const fnGroupId = 'c::__fn_pub';
    const layout = setup(c, [], [root.id, fnGroupId]);
    const fnGroup = layout.types.find((t) => t.fullPath === fnGroupId);
    const pocket = layout.types.find((t) => t.label === 'ZPocket');
    const longRow = fnGroup?.fields.find((f) => f.name === longFn);
    const shortRow = fnGroup?.fields.find((f) => f.name === shortFn);
    expect(fnGroup).toBeDefined();
    expect(pocket).toBeDefined();
    expect(longRow).toBeDefined();
    expect(shortRow).toBeDefined();

    const fnGroupTop = (fnGroup as NonNullable<typeof fnGroup>).y - ROW_H / 2;
    const pocketTop = (pocket as NonNullable<typeof pocket>).y - ROW_H / 2;
    expect(pocketTop - fnGroupTop).toBe(ROW_H + FIELD_ROW_H);
    expect((pocket as NonNullable<typeof pocket>).x).toBeLessThan(
      (longRow as NonNullable<typeof longRow>).arrowSourceX,
    );
    expect((shortRow as NonNullable<typeof shortRow>).arrowSourceX).toBeLessThan(
      (pocket as NonNullable<typeof pocket>).x,
    );
  });

  it('packs real types into short-method pockets beside expanded type rows', () => {
    const longMethod = 'a_method_name_long_enough_to_cross_the_next_column';
    const shortMethod = 'z';
    const owner: TypeFacts = {
      ...ty('c', '', 'Owner'),
      methods: [
        { name: longMethod, visibility: 'pub' },
        { name: shortMethod, visibility: 'pub' },
      ],
    };
    const source = ty('c', '', 'Source');
    const firstTarget = ty('c', '', 'FirstTarget');
    const pocketTarget = ty('c', '', 'PocketTarget');
    const c = crateFacts('c', [mod('', [owner, source, firstTarget, pocketTarget])]);
    const root = buildModuleTree(c);
    const layout = setup(
      c,
      [edge('c::Source', 'c::FirstTarget'), edge('c::Source', 'c::PocketTarget')],
      [root.id, 'c::Owner', 'c::Owner::__methods_pub'],
    );
    const ownerBox = layout.types.find((t) => t.fullPath === 'c::Owner');
    const pocket = layout.types.find((t) => t.fullPath === 'c::PocketTarget');
    const longRow = ownerBox?.fields.find((f) => f.name === longMethod);
    const shortRow = ownerBox?.fields.find((f) => f.name === shortMethod);
    expect(ownerBox).toBeDefined();
    expect(pocket).toBeDefined();
    expect(longRow).toBeDefined();
    expect(shortRow).toBeDefined();

    const ownerTop = (ownerBox as NonNullable<typeof ownerBox>).y - ROW_H / 2;
    const pocketTop = (pocket as NonNullable<typeof pocket>).y - ROW_H / 2;
    expect(pocketTop - ownerTop).toBe(ROW_H + 2 * FIELD_ROW_H);
    expect((pocket as NonNullable<typeof pocket>).x).toBeLessThan(
      (longRow as NonNullable<typeof longRow>).arrowSourceX,
    );
    expect((shortRow as NonNullable<typeof shortRow>).arrowSourceX).toBeLessThan(
      (pocket as NonNullable<typeof pocket>).x,
    );
  });

  it('uses uncapped function names for routing spacing without widening the packed box', () => {
    const longFn = 'full_optimization_for_bytecode_size';
    const c = crateFacts('c', [
      mod('', [ty('c', '', 'Target')], { functions: [{ name: longFn, visibility: 'pub' }] }),
    ]);
    const root = buildModuleTree(c);
    const fnGroupId = 'c::__fn_pub';
    const layout = setup(
      c,
      [edge(fnGroupId, 'c::Target', `field ${longFn}`)],
      [root.id, fnGroupId],
    );
    const fnGroup = layout.types.find((t) => t.fullPath === fnGroupId);
    const target = layout.types.find((t) => t.label === 'Target');
    const row = fnGroup?.fields.find((f) => f.name === longFn);
    expect(fnGroup).toBeDefined();
    expect(target).toBeDefined();
    expect(row).toBeDefined();

    expect(
      (fnGroup as NonNullable<typeof fnGroup>).x + (fnGroup as NonNullable<typeof fnGroup>).width,
    ).toBeLessThan((row as NonNullable<typeof row>).arrowSourceX);
    expect((target as NonNullable<typeof target>).x).toBeGreaterThan(
      (row as NonNullable<typeof row>).arrowSourceX,
    );

    const arrow = layout.arrows.find((a) => a.fromFieldName === longFn);
    const firstLane = arrow?.waypoints[1];
    expect(firstLane?.x).toBeGreaterThan((row as NonNullable<typeof row>).arrowSourceX);
  });

  it('flags real types with isGhost=false and ghostTarget=null by default', () => {
    const c = crateFacts('c', [mod('', [ty('c', '', 'Real')])]);
    const root = buildModuleTree(c);
    const layout = setup(c, [], [root.id]);
    const real = layout.types.find((t) => t.label === 'Real');
    expect(real?.isGhost).toBe(false);
    expect(real?.ghostTarget).toBeNull();
  });
});

describe('buildLayout — re-export ghost arrows', () => {
  it('emits a `kind: reexport` arrow from each ghost to its canonical target', () => {
    // Inner module declares Real; outer module re-exports it. Both modules
    // expanded so both ends are in the layout.
    const c = crateFacts('c', [
      mod(''),
      mod('inner', [ty('c', 'inner', 'Real')]),
      mod('outer', [], {
        re_exports: [
          { exposed_name: 'Real', target_path: 'c::inner::Real', kind: 'type', visibility: 'pub' },
        ],
      }),
    ]);
    const root = buildModuleTree(c);
    const layout = setup(c, [], [root.id, 'c::inner', 'c::outer']);
    const reexportArrows = layout.arrows.filter((a) => a.kind === 'reexport');
    expect(reexportArrows).toHaveLength(1);
    expect(reexportArrows[0]?.toTypeId).toBe('c::inner::Real');
    // Source id is the synthetic ghost id (contains __re_) — not the
    // canonical target id.
    expect(reexportArrows[0]?.fromTypeId).toContain('__re_');
  });

  it('marks the ghost TypeBox with isGhost=true and ghostTarget set', () => {
    const c = crateFacts('c', [
      mod(''),
      mod('inner', [ty('c', 'inner', 'Real')]),
      mod('outer', [], {
        re_exports: [
          { exposed_name: 'Real', target_path: 'c::inner::Real', kind: 'type', visibility: 'pub' },
        ],
      }),
    ]);
    const root = buildModuleTree(c);
    const layout = setup(c, [], [root.id, 'c::inner', 'c::outer']);
    const ghost = layout.types.find((t) => t.isGhost);
    expect(ghost).toBeDefined();
    expect(ghost?.ghostTarget).toBe('c::inner::Real');
    expect(ghost?.label).toBe('Real');
  });

  it('does not emit a re-export arrow when the canonical target is not in the layout', () => {
    // outer is expanded (ghost present); inner is collapsed (Real missing).
    const c = crateFacts('c', [
      mod(''),
      mod('inner', [ty('c', 'inner', 'Real')]),
      mod('outer', [], {
        re_exports: [
          { exposed_name: 'Real', target_path: 'c::inner::Real', kind: 'type', visibility: 'pub' },
        ],
      }),
    ]);
    const root = buildModuleTree(c);
    const layout = setup(c, [], [root.id, 'c::outer']); // c::inner NOT expanded
    expect(layout.arrows.filter((a) => a.kind === 'reexport')).toHaveLength(0);
    // The ghost row itself still renders — the user can see "this is
    // re-exported here" even if the target's module is collapsed.
    expect(layout.types.find((t) => t.isGhost)).toBeDefined();
  });

  it('ownership arrows continue to use kind="ownership"', () => {
    // Sanity: existing arrows aren't accidentally tagged as reexport.
    const c = crateFacts('c', [
      mod(''),
      mod('a', [ty('c', 'a', 'A', [{ name: 'b', ty_text: 'B' }]), ty('c', 'a', 'B')]),
    ]);
    const root = buildModuleTree(c);
    const layout = setup(c, [edge('c::a::A', 'c::a::B', 'field b')], [root.id, 'c::a', 'c::a::A']);
    expect(layout.arrows).toHaveLength(1);
    expect(layout.arrows[0]?.kind).toBe('ownership');
  });

  it('ghost arrows are filtered by the optional `ghostArrowsShown` set', () => {
    // Both endpoints visible, two ghosts in the layout. With an explicit
    // shown-set listing only one, only that ghost's arrow renders.
    const c = crateFacts('c', [
      mod(''),
      mod('inner', [ty('c', 'inner', 'A'), ty('c', 'inner', 'B')]),
      mod('outer', [], {
        re_exports: [
          { exposed_name: 'A', target_path: 'c::inner::A', kind: 'type', visibility: 'pub' },
          { exposed_name: 'B', target_path: 'c::inner::B', kind: 'type', visibility: 'pub' },
        ],
      }),
    ]);
    const root = buildModuleTree(c);
    const f = facts(c, []);
    const ownership = buildOwnershipIndex(f, c.name);
    const tm = collectTypeModule(root);
    const drift = computeDrift(ownership, tm);
    const dep = computeOwnershipDepth(ownership, collectIds(root), drift);
    const state = new ViewState([root.id, 'c::inner', 'c::outer']);

    // No ghosts shown: zero ghost arrows in the layout.
    const noneShown = buildLayout({
      staticRoot: root,
      ownership,
      depth: dep,
      drift,
      state,
      ghostArrowsShown: new Set(),
    });
    expect(noneShown.arrows.filter((a) => a.kind === 'reexport')).toHaveLength(0);

    // One ghost in the set: only that one renders.
    const ghostA = noneShown.types.find((t) => t.isGhost && t.label === 'A');
    expect(ghostA).toBeDefined();
    const oneShown = buildLayout({
      staticRoot: root,
      ownership,
      depth: dep,
      drift,
      state,
      ghostArrowsShown: new Set([(ghostA as NonNullable<typeof ghostA>).id]),
    });
    const reexports = oneShown.arrows.filter((a) => a.kind === 'reexport');
    expect(reexports).toHaveLength(1);
    expect(reexports[0]?.toTypeId).toBe('c::inner::A');
  });

  it('ghost rows inherit their canonical target column instead of stacking at col 1', () => {
    // Inner module declares a 2-deep ownership chain Root -> Mid -> Leaf,
    // so Leaf has depth 2. The outer module re-exports Leaf. Without
    // target-depth inheritance the ghost would land at column 1 alongside
    // every other depth-0 type; with inheritance it lines up with Leaf.
    const c = crateFacts('c', [
      mod(''),
      mod('inner', [
        ty('c', 'inner', 'Root', [{ name: 'mid', ty_text: 'Mid' }]),
        ty('c', 'inner', 'Mid', [{ name: 'leaf', ty_text: 'Leaf' }]),
        ty('c', 'inner', 'Leaf'),
      ]),
      mod('outer', [], {
        re_exports: [
          { exposed_name: 'Leaf', target_path: 'c::inner::Leaf', kind: 'type', visibility: 'pub' },
        ],
      }),
    ]);
    const root = buildModuleTree(c);
    const layout = setup(
      c,
      [
        edge('c::inner::Root', 'c::inner::Mid', 'field mid'),
        edge('c::inner::Mid', 'c::inner::Leaf', 'field leaf'),
      ],
      [root.id, 'c::inner', 'c::outer'],
    );
    const leaf = layout.types.find((t) => t.label === 'Leaf' && !t.isGhost);
    const ghost = layout.types.find((t) => t.isGhost);
    expect(leaf).toBeDefined();
    expect(ghost).toBeDefined();
    // The ghost inherits the canonical rank, but rank no longer forces
    // global x alignment across unrelated bands.
    expect(ghost?.col).toBe(leaf?.col);
    expect(ghost?.x).not.toBe(leaf?.x);
  });

  it('rightward same-rank re-export arrows start after the ghost label', () => {
    const c = crateFacts('c', [
      mod(''),
      mod('inner', [
        ty('c', 'inner', 'Root', [{ name: 'real', ty_text: 'Real' }]),
        ty('c', 'inner', 'Real'),
      ]),
      mod('outer', [], {
        re_exports: [
          { exposed_name: 'Real', target_path: 'c::inner::Real', kind: 'type', visibility: 'pub' },
        ],
      }),
    ]);
    const root = buildModuleTree(c);
    const layout = setup(
      c,
      [edge('c::inner::Root', 'c::inner::Real', 'field real')],
      [root.id, 'c::inner', 'c::inner::Root', 'c::outer'],
    );
    const real = layout.types.find((t) => t.label === 'Real' && !t.isGhost);
    const ghost = layout.types.find((t) => t.label === 'Real' && t.isGhost);
    expect(real).toBeDefined();
    expect(ghost).toBeDefined();
    expect(ghost?.col).toBe(real?.col);
    expect((real as NonNullable<typeof real>).x).toBeGreaterThan(
      (ghost as NonNullable<typeof ghost>).x,
    );

    const arrow = layout.arrows.find((a) => a.kind === 'reexport');
    const start = arrow?.waypoints[0];
    expect(start?.x).toBeGreaterThanOrEqual(
      (ghost as NonNullable<typeof ghost>).x + (ghost as NonNullable<typeof ghost>).width,
    );
  });

  it('rightward re-export lanes do not flip the source back to the dot side', () => {
    const c = crateFacts('c', [
      mod(''),
      mod('inner', [
        ty('c', 'inner', 'Root', [{ name: 'real', ty_text: 'Real' }]),
        ty('c', 'inner', 'Real'),
      ]),
      mod('outer', [], {
        re_exports: [
          {
            exposed_name: 'AliasVal',
            target_path: 'c::inner::Real',
            kind: 'type',
            visibility: 'pub',
          },
        ],
      }),
    ]);
    const root = buildModuleTree(c);
    const layout = setup(
      c,
      [edge('c::inner::Root', 'c::inner::Real', 'field real')],
      [root.id, 'c::inner', 'c::inner::Root', 'c::outer'],
    );
    const real = layout.types.find((t) => t.label === 'Real' && !t.isGhost);
    const ghost = layout.types.find((t) => t.label === 'AliasVal' && t.isGhost);
    expect(real).toBeDefined();
    expect(ghost).toBeDefined();
    const ghostRight =
      (ghost as NonNullable<typeof ghost>).x + (ghost as NonNullable<typeof ghost>).width;
    // This is the sensitive case: the canonical target is just to the
    // right of the alias text, but its incoming gutter would be left of
    // the alias's right edge if the lane were not clamped to the source side.
    expect((real as NonNullable<typeof real>).x - 2).toBeGreaterThan(ghostRight);
    expect((real as NonNullable<typeof real>).x - 18).toBeLessThan(ghostRight);

    const arrow = layout.arrows.find((a) => a.kind === 'reexport');
    const start = arrow?.waypoints[0];
    const firstLane = arrow?.waypoints[1];
    expect(start?.x).toBeGreaterThanOrEqual(ghostRight);
    expect(firstLane?.x).toBeGreaterThan(start?.x ?? 0);
  });

  it('same-x re-export arrows leave from the dot side instead of crossing the label', () => {
    const c = crateFacts('c', [
      mod(''),
      mod('inner', [ty('c', 'inner', 'Real')]),
      mod('outer', [], {
        re_exports: [
          { exposed_name: 'Real', target_path: 'c::inner::Real', kind: 'type', visibility: 'pub' },
        ],
      }),
    ]);
    const root = buildModuleTree(c);
    const layout = setup(c, [], [root.id, 'c::inner', 'c::outer']);
    const ghost = layout.types.find((t) => t.label === 'Real' && t.isGhost);
    expect(ghost).toBeDefined();

    const arrow = layout.arrows.find((a) => a.kind === 'reexport');
    const start = arrow?.waypoints[0];
    expect(start?.x).toBeLessThan(
      (ghost as NonNullable<typeof ghost>).x + (ghost as NonNullable<typeof ghost>).width / 2,
    );
  });
});

describe('buildLayout — type method buckets', () => {
  function tyM(
    crate: string,
    modPath: string,
    name: string,
    methods: readonly FnFacts[],
    fields: { name: string; ty_text: string }[] = [],
  ): TypeFacts {
    const full = modPath === '' ? `${crate}::${name}` : `${crate}::${modPath}::${name}`;
    return {
      name,
      full_path: full,
      kind: 'struct',
      visibility: 'pub',
      fields: fields.map((f) => ({ ...f, ownership: 'owned' as const })),
      methods,
    };
  }

  it('expanded type renders one bucket-header row per non-empty visibility, no method rows by default', () => {
    const c = crateFacts('c', [
      mod('', []),
      mod('a', [
        tyM('c', 'a', 'Foo', [
          { name: 'do_thing', visibility: 'pub' },
          { name: 'helper', visibility: 'pub(crate)' },
        ]),
      ]),
    ]);
    const root = buildModuleTree(c);
    const layout = setup(c, [], [root.id, 'c::a', 'c::a::Foo']);
    const foo = layout.types.find((t) => t.label === 'Foo');
    expect(foo?.expanded).toBe(true);
    const buckets = foo?.fields.filter((f) => f.kind === 'method_bucket') ?? [];
    expect(buckets.map((b) => b.name)).toEqual(['pub fn (1)', 'pub(crate) fn (1)']);
    // No method rows yet — buckets are closed.
    expect(foo?.fields.filter((f) => f.kind === 'method')).toHaveLength(0);
  });

  it('expanding a bucket id reveals its method rows below the header', () => {
    const c = crateFacts('c', [
      mod('', []),
      mod('a', [
        tyM('c', 'a', 'Foo', [
          { name: 'do_thing', visibility: 'pub' },
          { name: 'do_other', visibility: 'pub' },
        ]),
      ]),
    ]);
    const root = buildModuleTree(c);
    // Expand the type AND its pub-bucket. The bucket id format is the
    // public contract of methodBucketId(): typeFullPath::__methods_<bucket>.
    const layout = setup(c, [], [root.id, 'c::a', 'c::a::Foo', 'c::a::Foo::__methods_pub']);
    const foo = layout.types.find((t) => t.label === 'Foo');
    const methodRows = foo?.fields.filter((f) => f.kind === 'method') ?? [];
    expect(methodRows.map((m) => m.name)).toEqual(['do_other', 'do_thing']);
  });

  it('a collapsed type renders no bucket headers regardless of method count', () => {
    const c = crateFacts('c', [
      mod('', []),
      mod('a', [tyM('c', 'a', 'Foo', [{ name: 'm', visibility: 'pub' }])]),
    ]);
    const root = buildModuleTree(c);
    const layout = setup(c, [], [root.id, 'c::a']); // type NOT expanded
    const foo = layout.types.find((t) => t.label === 'Foo');
    expect(foo?.expanded).toBe(false);
    expect(foo?.fields).toHaveLength(0);
  });

  it('methodsHidden=true suppresses bucket headers, method rows, and method arrows', () => {
    // Same setup as the slice-2 method-arrow test, but pass
    // methodsHidden through buildLayout. Bucket headers, method rows,
    // and the method-derived arrow should all disappear; the field
    // rendering of the type is unaffected.
    const c = crateFacts('c', [
      mod('', []),
      mod('a', [
        tyM('c', 'a', 'Foo', [{ name: 'consume', visibility: 'pub' }]),
        ty('c', 'a', 'Bar'),
      ]),
    ]);
    const root = buildModuleTree(c);
    const fnEdge: Edge = {
      from: 'c::a::Foo',
      to: 'c::a::Bar',
      kind: 'owns',
      via: 'fn_param',
      origin: 'fn consume param x',
    };
    const f = facts(c, [fnEdge]);
    const ownership = buildOwnershipIndex(f, c.name);
    const tm = collectTypeModule(root);
    const drift = computeDrift(ownership, tm);
    const dep = computeOwnershipDepth(ownership, collectIds(root), drift);
    const state = new ViewState([root.id, 'c::a', 'c::a::Foo', 'c::a::Foo::__methods_pub']);

    const layout = buildLayout({
      staticRoot: root,
      ownership,
      depth: dep,
      drift,
      state,
      methodsHidden: true,
    });
    const foo = layout.types.find((t) => t.label === 'Foo');
    expect(foo?.fields.filter((f) => f.kind === 'method_bucket')).toHaveLength(0);
    expect(foo?.fields.filter((f) => f.kind === 'method')).toHaveLength(0);
    expect(layout.arrows.find((a) => a.kind === 'method')).toBeUndefined();
  });

  it('method rows surface a formatted signature on tyText for the hover-reveal tail', () => {
    // The signature flows: extractor → schema → MethodBucket → layout.
    // Verify each method row's tyText is the Rust-shaped signature
    // string the renderer will fade in past the method name.
    const c = crateFacts('c', [
      mod('', []),
      mod('a', [
        tyM('c', 'a', 'Foo', [
          {
            name: 'consume',
            visibility: 'pub',
            self_kind: 'ref',
            params: [{ name: 'x', ty_text: 'Bar' }],
            return_ty_text: 'Baz',
          },
          {
            name: 'noop',
            visibility: 'pub',
            self_kind: 'ref_mut',
            params: [],
            return_ty_text: '()', // unit — should be elided
          },
          {
            name: 'unsafe_thing',
            visibility: 'pub',
            self_kind: 'none',
            is_unsafe: true,
            params: [{ name: 'p', ty_text: '*const u8' }],
            return_ty_text: 'usize',
          },
        ]),
      ]),
    ]);
    const root = buildModuleTree(c);
    const layout = setup(c, [], [root.id, 'c::a', 'c::a::Foo', 'c::a::Foo::__methods_pub']);
    const foo = layout.types.find((t) => t.label === 'Foo');
    const byName = new Map(
      foo?.fields.filter((f) => f.kind === 'method').map((f) => [f.name, f.tyText]),
    );
    expect(byName.get('consume')).toBe('(&self, x: Bar) -> Baz');
    // Unit return omits the arrow tail.
    expect(byName.get('noop')).toBe('(&mut self)');
    // Modifiers prepend; no receiver since self_kind is 'none'.
    expect(byName.get('unsafe_thing')).toBe('unsafe (p: *const u8) -> usize');
  });

  it('method rows fall back to a bare `()` when the extractor omits signature data', () => {
    // Older facts files don't carry params/return — the row still
    // renders, just with an empty-arglist signature. Doesn't crash.
    const c = crateFacts('c', [
      mod('', []),
      mod('a', [tyM('c', 'a', 'Foo', [{ name: 'm', visibility: 'pub' }])]),
    ]);
    const root = buildModuleTree(c);
    const layout = setup(c, [], [root.id, 'c::a', 'c::a::Foo', 'c::a::Foo::__methods_pub']);
    const m = layout.types.find((t) => t.label === 'Foo')?.fields.find((f) => f.kind === 'method');
    expect(m?.tyText).toBe('()');
  });

  it('method arrows are opt-in via methodArrowsShown — empty set means no method arrows', () => {
    // Bucket expanded, methodTargets populated — but methodArrowsShown
    // is an empty set, so no method arrow should render. Mirrors the
    // production default where opening a bucket reveals method rows
    // without firing the avalanche of dotted arrows from each.
    const c = crateFacts('c', [
      mod('', []),
      mod('a', [
        tyM('c', 'a', 'Foo', [{ name: 'consume', visibility: 'pub' }]),
        ty('c', 'a', 'Bar'),
      ]),
    ]);
    const root = buildModuleTree(c);
    const fnEdge: Edge = {
      from: 'c::a::Foo',
      to: 'c::a::Bar',
      kind: 'owns',
      via: 'fn_param',
      origin: 'fn consume param x',
    };
    const f = facts(c, [fnEdge]);
    const ownership = buildOwnershipIndex(f, c.name);
    const tm = collectTypeModule(root);
    const drift = computeDrift(ownership, tm);
    const dep = computeOwnershipDepth(ownership, collectIds(root), drift);
    const state = new ViewState([root.id, 'c::a', 'c::a::Foo', 'c::a::Foo::__methods_pub']);

    const layout = buildLayout({
      staticRoot: root,
      ownership,
      depth: dep,
      drift,
      state,
      methodArrowsShown: new Set(),
    });
    // Method row still renders (the user can see what methods exist).
    const foo = layout.types.find((t) => t.label === 'Foo');
    expect(
      foo?.fields.find((row) => row.kind === 'method' && row.name === 'consume'),
    ).toBeDefined();
    // But no arrow leaves it.
    expect(layout.arrows.find((a) => a.kind === 'method')).toBeUndefined();
  });

  it('methodArrowsShown allows specific methods through, others stay hidden', () => {
    const c = crateFacts('c', [
      mod('', []),
      mod('a', [
        tyM('c', 'a', 'Foo', [
          { name: 'shown_method', visibility: 'pub' },
          { name: 'hidden_method', visibility: 'pub' },
        ]),
        ty('c', 'a', 'Bar'),
        ty('c', 'a', 'Baz'),
      ]),
    ]);
    const root = buildModuleTree(c);
    const edges: Edge[] = [
      {
        from: 'c::a::Foo',
        to: 'c::a::Bar',
        kind: 'owns',
        via: 'fn_param',
        origin: 'fn shown_method param x',
      },
      {
        from: 'c::a::Foo',
        to: 'c::a::Baz',
        kind: 'owns',
        via: 'fn_param',
        origin: 'fn hidden_method param x',
      },
    ];
    const f = facts(c, edges);
    const ownership = buildOwnershipIndex(f, c.name);
    const tm = collectTypeModule(root);
    const drift = computeDrift(ownership, tm);
    const dep = computeOwnershipDepth(ownership, collectIds(root), drift);
    const state = new ViewState([root.id, 'c::a', 'c::a::Foo', 'c::a::Foo::__methods_pub']);

    const layout = buildLayout({
      staticRoot: root,
      ownership,
      depth: dep,
      drift,
      state,
      methodArrowsShown: new Set(['c::a::Foo\x1Fshown_method']),
    });
    const methodArrows = layout.arrows.filter((a) => a.kind === 'method');
    expect(methodArrows).toHaveLength(1);
    expect(methodArrows[0]?.fromFieldName).toBe('shown_method');
    expect(methodArrows[0]?.toTypeId).toBe('c::a::Bar');
  });

  it('expanded method rows carry targets from methodTargets and produce arrows', () => {
    // Foo has a method `consume` that takes a Bar param. With the
    // method bucket expanded, the method row should have Bar in its
    // targets, and an arrow should leave the method into Bar.
    const c = crateFacts('c', [
      mod('', []),
      mod('a', [
        tyM('c', 'a', 'Foo', [{ name: 'consume', visibility: 'pub' }]),
        ty('c', 'a', 'Bar'),
      ]),
    ]);
    const root = buildModuleTree(c);
    const fnParamEdge: Edge = {
      from: 'c::a::Foo',
      to: 'c::a::Bar',
      kind: 'owns',
      via: 'fn_param',
      origin: 'fn consume param x',
    };
    const layout = setup(
      c,
      [fnParamEdge],
      [root.id, 'c::a', 'c::a::Foo', 'c::a::Foo::__methods_pub'],
    );
    const foo = layout.types.find((t) => t.label === 'Foo');
    const methodRow = foo?.fields.find((f) => f.kind === 'method' && f.name === 'consume');
    expect(methodRow?.targets).toEqual(['c::a::Bar']);
    const methodArrow = layout.arrows.find(
      (a) => a.fromTypeId === 'c::a::Foo' && a.fromFieldName === 'consume',
    );
    expect(methodArrow?.toTypeId).toBe('c::a::Bar');
  });

  it('method rows produce no arrows when their bucket is collapsed', () => {
    // Same data as the previous test but the bucket isn't expanded —
    // the method row doesn't render, so no arrow should leave it.
    const c = crateFacts('c', [
      mod('', []),
      mod('a', [
        tyM('c', 'a', 'Foo', [{ name: 'consume', visibility: 'pub' }]),
        ty('c', 'a', 'Bar'),
      ]),
    ]);
    const root = buildModuleTree(c);
    const fnParamEdge: Edge = {
      from: 'c::a::Foo',
      to: 'c::a::Bar',
      kind: 'owns',
      via: 'fn_param',
      origin: 'fn consume param x',
    };
    const layout = setup(c, [fnParamEdge], [root.id, 'c::a', 'c::a::Foo']);
    const methodArrow = layout.arrows.find(
      (a) => a.fromTypeId === 'c::a::Foo' && a.fromFieldName === 'consume',
    );
    expect(methodArrow).toBeUndefined();
  });

  it('band height grows to accommodate bucket-header + method rows when expanded', () => {
    // Type with no fields, two bucket-headers (pub+priv), pub bucket
    // expanded with one method → expanded type rows = 0 fields + 2
    // bucket headers + 1 method = 3.
    const c = crateFacts('c', [
      mod('', []),
      mod('a', [
        tyM('c', 'a', 'Foo', [
          { name: 'do_thing', visibility: 'pub' },
          { name: 'helper', visibility: 'priv' },
        ]),
      ]),
    ]);
    const root = buildModuleTree(c);
    const layout = setup(c, [], [root.id, 'c::a', 'c::a::Foo', 'c::a::Foo::__methods_pub']);
    const aBand = layout.modules.find((m) => m.label === 'a');
    expect(aBand?.bandHeight).toBe(ROW_H + 3 * FIELD_ROW_H);
  });
});
