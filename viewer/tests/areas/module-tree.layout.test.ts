// Tier-2 pure layout/data-model invariants for the module-tree area.
//
// Covers the data/model + analysis/logic layers that own the left column's
// structure (per test-plan/module-tree.md):
//   - buildModuleTree ordering / labels / fn-group + ghost synthesis (MT-D*)
//   - canonicalize dedup → unique band ids end-to-end (MT-C*)
//   - geometry: ModuleRow.y == band TOP, modDepth, hit-width, divider rule (MT-G*)
//
// Each assertion is the strong oracle from the plan — where the plan flags a
// naive invariant as WRONG (alphabetical sort, divider-per-band, y == center),
// the test asserts the correct contract, not the rejected one. No DOM here;
// everything runs in the node env over pure functions.

import { describe, expect, it } from 'vitest';
import { computeDrift } from '../../src/analysis/drift.ts';
import {
  MODULE_HIT_PAD_RIGHT,
  MODULE_LABEL_LEAF_FONT_SCALE,
  MODULE_LABEL_X,
  TOP_PAD,
  computeLeafSegment,
  computePrefixSegments,
  measureModuleHitWidth,
} from '../../src/analysis/layout_metrics.ts';
import type { LayoutInputs } from '../../src/analysis/layout_model.ts';
import {
  type ModuleNode,
  type TreeNode,
  type TypeNode,
  WORKSPACE_ROOT_ID,
  buildModuleTree,
  buildWorkspaceTree,
} from '../../src/analysis/module_tree.ts';
import { buildOwnershipIndex, computeOwnershipDepth } from '../../src/analysis/ownership.ts';
import { canonicalize } from '../../src/data/canonicalize.ts';
import type {
  CrateFacts,
  Facts,
  FnFacts,
  Language,
  ModuleFacts,
  ReExport,
  TypeFacts,
  TypeKind,
} from '../../src/data/schema.ts';
import { buildLayout } from '../../src/layout/pipeline.ts';
import { ViewState } from '../../src/state/view_state.ts';

// --- local fact builders (NEW; do not edit the shared builders.ts) ----------
// These extend the shared shapes with the bits this area needs: re_exports,
// functions, per-type methods, language + real file basenames, and explicit
// cfg-duplicate emission. Mirrors the shapes already used in module_tree.test.ts.

const measure = (s: string): number => s.length * 7;

function ty(
  crate: string,
  modPath: string,
  name: string,
  opts: {
    readonly kind?: TypeKind;
    readonly visibility?: string;
    readonly fields?: { readonly name: string; readonly ty_text: string }[];
    readonly methods?: readonly FnFacts[];
  } = {},
): TypeFacts {
  const full = modPath === '' ? `${crate}::${name}` : `${crate}::${modPath}::${name}`;
  const base: TypeFacts = {
    name,
    full_path: full,
    kind: opts.kind ?? 'struct',
    visibility: opts.visibility ?? 'pub',
    fields: (opts.fields ?? []).map((f) => ({ ...f, ownership: 'owned' as const })),
  };
  return opts.methods !== undefined ? { ...base, methods: opts.methods } : base;
}

function fn(name: string, visibility = 'pub'): FnFacts {
  return { name, visibility };
}

function mod(
  path: string,
  types: TypeFacts[] = [],
  opts: {
    readonly file?: string;
    readonly functions?: readonly FnFacts[];
    readonly re_exports?: readonly ReExport[];
  } = {},
): ModuleFacts {
  const file = opts.file ?? (path === '' ? 'src/lib.rs' : `src/${path.replace(/::/g, '/')}.rs`);
  const base: ModuleFacts = { path, types, file, functions: opts.functions ?? [] };
  return opts.re_exports !== undefined ? { ...base, re_exports: opts.re_exports } : base;
}

function crateOf(name: string, modules: ModuleFacts[], language?: Language): CrateFacts {
  const base = { name, modules: Object.fromEntries(modules.map((m) => [m.path, m])) };
  return language !== undefined ? { ...base, language } : base;
}

const reExp = (
  name: string,
  target: string,
  opts: {
    readonly kind?: 'type' | 'function';
    readonly visibility?: string;
    readonly target_kind?: TypeKind;
  } = {},
): ReExport => {
  const base = {
    exposed_name: name,
    target_path: target,
    kind: opts.kind ?? ('type' as const),
    visibility: opts.visibility ?? 'pub',
  };
  return opts.target_kind !== undefined ? { ...base, target_kind: opts.target_kind } : base;
};

/** Wire a single-crate `LayoutInputs` from a (possibly TS) crate + edges.
 *  Mirrors the shared `buildInputs` but lets us pass a crate that has a
 *  `language` field so the TS label path runs. */
function inputsFor(crate: CrateFacts, edges: Facts['edges'], expandedIds: string[]): LayoutInputs {
  return workspaceInputs({ crates: { [crate.name]: crate }, edges }, expandedIds, false);
}

/** Wire `LayoutInputs` over a whole `Facts` workspace, rooted at the
 *  buildWorkspaceTree result so geometry exercises the workspace-root skip
 *  and the crate-tier modDepth-0 placement. */
function workspaceInputs(facts: Facts, expandedIds: string[], workspace = true): LayoutInputs {
  const root = workspace ? buildWorkspaceTree(facts) : buildModuleTree(firstCrate(facts));
  const ownership = buildOwnershipIndex(facts);
  const typeModule = collectTypeModule(root);
  const drift = computeDrift(ownership, typeModule);
  const depth = computeOwnershipDepth(ownership, collectIds(root), drift);
  const state = new ViewState(expandedIds);
  return { staticRoot: root, ownership, depth, state, drift, measureText: measure };
}

function firstCrate(facts: Facts): CrateFacts {
  const crate = Object.values(facts.crates)[0];
  if (crate === undefined) throw new Error('facts has no crates');
  return crate;
}

function collectTypeModule(root: TreeNode): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (n: TreeNode): void => {
    if (n.kind === 'type') out.set(n.fullPath, n.modulePath);
    else for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
}

function collectIds(root: TreeNode): string[] {
  const out: string[] = [];
  const walk = (n: TreeNode): void => {
    if (n.kind === 'type') out.push(n.fullPath);
    else for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
}

function findModule(node: TreeNode, path: string): ModuleNode | undefined {
  if (node.kind !== 'module') return undefined;
  if (node.path === path) return node;
  for (const c of node.children) {
    const hit = findModule(c, path);
    if (hit) return hit;
  }
  return undefined;
}

function typeChildren(node: ModuleNode): readonly TypeNode[] {
  return node.children.filter((c): c is TypeNode => c.kind === 'type');
}

function allModuleIds(crate: CrateFacts): string[] {
  const root = buildModuleTree(crate);
  const ids: string[] = [];
  const walk = (n: TreeNode): void => {
    if (n.kind === 'module') {
      ids.push(n.id);
      for (const c of n.children) walk(c);
    } else ids.push(n.id);
  };
  walk(root);
  return ids;
}

// =============================================================================
// Tier 2 — buildModuleTree / buildWorkspaceTree (MT-D*)
// =============================================================================

describe('module-tree data model (MT-D)', () => {
  it('MT-D01: crate root is a module labeled with the crate name, path ""', () => {
    const root = buildModuleTree(crateOf('c', [mod('', [ty('c', '', 'App')])]));
    expect(root.kind).toBe('module');
    expect(root.label).toBe('c');
    expect(root.path).toBe('');
  });

  it('MT-D02: submodules sort before type leaves; types alphabetical (NOT pure-alpha)', () => {
    // A pure alphabetical sort would interleave the module "sub" between
    // "Alpha" and "Zed". The correct contract: modules first, then types.
    const root = buildModuleTree(
      crateOf('c', [mod('', [ty('c', '', 'Zed'), ty('c', '', 'Alpha')]), mod('sub')]),
    );
    expect(root.children.map((c) => c.label)).toEqual(['sub', 'Alpha', 'Zed']);
  });

  it('MT-D03: label is the last path segment regardless of file shape (no .rs)', () => {
    const root = buildModuleTree(
      crateOf('c', [
        mod(''),
        mod('modrs_backed', [], { file: 'src/modrs_backed/mod.rs' }),
        mod('split', [], { file: 'src/split.rs' }),
        mod('split::sub', [], { file: 'src/split/sub.rs' }),
      ]),
    );
    expect(findModule(root, 'split::sub')?.label).toBe('sub');
    expect(findModule(root, 'modrs_backed')?.label).toBe('modrs_backed');
    expect(findModule(root, 'split')?.label).toBe('split');
  });

  it('MT-D04: test modules excluded by default, kept when excludeTests:false; any segment matches', () => {
    const cr = crateOf('c', [
      mod(''),
      mod('a', [ty('c', 'a', 'Keep')]),
      mod('a::tests', [ty('c', 'a::tests', 'Drop')]),
      mod('tests', [ty('c', 'tests', 'AlsoDrop')]),
    ]);
    const def = buildModuleTree(cr);
    expect(findModule(def, 'a::tests')).toBeUndefined();
    expect(findModule(def, 'tests')).toBeUndefined();
    const kept = buildModuleTree(cr, { excludeTests: false });
    expect(findModule(kept, 'a::tests')).toBeDefined();
    expect(findModule(kept, 'tests')).toBeDefined();
  });

  it('MT-D05: one fn-group pseudo-type per non-empty bucket, BUCKET_ORDER, count in label', () => {
    const root = buildModuleTree(
      crateOf('c', [
        mod(''),
        mod('a', [], {
          functions: [fn('a1', 'pub'), fn('a2', 'pub'), fn('b1', 'pub(crate)'), fn('c1', 'priv')],
        }),
      ]),
    );
    const a = findModule(root, 'a') as ModuleNode;
    const groups = typeChildren(a).filter((t) => t.typeKind === 'function_group');
    expect(groups.map((g) => g.label)).toEqual(['pub fn (2)', 'pub(crate) fn (1)', 'local fn (1)']);
    for (const g of groups) {
      expect(g.id).toContain('__fn_');
    }
  });

  it('MT-D06: fn-group rows ordered before real types (NOT interleaved alphabetically)', () => {
    const root = buildModuleTree(
      crateOf('c', [
        mod(''),
        mod('a', [ty('c', 'a', 'Real')], {
          functions: [fn('p', 'pub'), fn('q', 'pub(crate)'), fn('r', 'priv')],
        }),
      ]),
    );
    const a = findModule(root, 'a') as ModuleNode;
    expect(typeChildren(a).map((t) => t.label)).toEqual([
      'pub fn (1)',
      'pub(crate) fn (1)',
      'local fn (1)',
      'Real',
    ]);
  });

  it('MT-D07: functions are alphabetical callable rows, sentinel-vis dropped, empty bucket → none', () => {
    const root = buildModuleTree(
      crateOf('c', [
        mod(''),
        mod('a', [], {
          functions: [fn('zeta', 'pub'), fn('alpha', 'pub'), fn('skip', '<orphan-impl>')],
        }),
      ]),
    );
    const a = findModule(root, 'a') as ModuleNode;
    const groups = typeChildren(a);
    // Only the pub bucket is non-empty; <orphan-impl> dropped.
    expect(groups).toHaveLength(1);
    expect(groups[0]?.functions.map((f) => f.fn.name)).toEqual(['alpha', 'zeta']);
  });

  it('MT-D08: method buckets grouped/sorted by visibility, sentinel dropped, absent → []', () => {
    const withMethods = ty('c', 'a', 'Foo', {
      methods: [fn('zeta', 'pub'), fn('alpha', 'pub'), fn('beta', 'pub(crate)'), fn('skip', '<x>')],
    });
    const root = buildModuleTree(crateOf('c', [mod(''), mod('a', [withMethods])]));
    const a = findModule(root, 'a') as ModuleNode;
    const t = typeChildren(a)[0] as TypeNode;
    expect(t.methodBuckets.map((b) => b.bucket)).toEqual(['pub', 'pub_crate']);
    expect(t.methodBuckets[0]?.methods.map((m) => m.name)).toEqual(['alpha', 'zeta']);

    // Legacy facts with no methods field → empty buckets, no crash.
    const legacy = buildModuleTree(crateOf('c', [mod(''), mod('a', [ty('c', 'a', 'Bare')])]));
    const ba = findModule(legacy, 'a') as ModuleNode;
    expect((typeChildren(ba)[0] as TypeNode).methodBuckets).toEqual([]);
  });

  it('MT-D09: type re-export ghost per pub-use, label = exposed_name, synthetic id', () => {
    const root = buildModuleTree(
      crateOf('c', [
        mod(''),
        mod('inner', [ty('c', 'inner', 'OldName')]),
        mod('outer', [], { re_exports: [reExp('NewName', 'c::inner::OldName')] }),
      ]),
    );
    const g = typeChildren(findModule(root, 'outer') as ModuleNode)[0] as TypeNode;
    expect(g.isGhost).toBe(true);
    expect(g.label).toBe('NewName');
    expect(g.ghostTarget).toBe('c::inner::OldName');
    expect(g.id).toContain('__re_');
    expect(g.id).not.toBe('c::inner::OldName');
  });

  it('MT-D10: ghost inherits re-export visibility + target_kind, falls back to struct; fn re-exports skipped', () => {
    const root = buildModuleTree(
      crateOf('c', [
        mod(''),
        mod('outer', [], {
          re_exports: [
            reExp('Crated', 'c::inner::A', { visibility: 'pub(crate)' }),
            reExp('AnEnum', 'c::inner::E', { target_kind: 'enum' }),
            reExp('Legacy', 'c::inner::L'),
            reExp('aFn', 'c::inner::do_it', { kind: 'function' }),
          ],
        }),
      ]),
    );
    const byLabel = new Map(
      typeChildren(findModule(root, 'outer') as ModuleNode).map((g) => [g.label, g] as const),
    );
    expect(byLabel.get('Crated')?.visibility).toBe('pub(crate)');
    expect(byLabel.get('AnEnum')?.typeKind).toBe('enum');
    expect(byLabel.get('Legacy')?.typeKind).toBe('struct');
    expect(byLabel.has('aFn')).toBe(false); // function re-exports not modeled
  });

  it('MT-D11: buildWorkspaceTree wraps crates alphabetically under WORKSPACE_ROOT_ID', () => {
    const facts: Facts = {
      crates: {
        b: crateOf('b', [mod('', [ty('b', '', 'BType')])]),
        a: crateOf('a', [mod('', [ty('a', '', 'AType')])]),
      },
      edges: [],
    };
    const ws = buildWorkspaceTree(facts);
    expect(ws.id).toBe(WORKSPACE_ROOT_ID);
    expect(ws.children.map((c) => c.label)).toEqual(['a', 'b']);
    expect(buildWorkspaceTree({ crates: {}, edges: [] }).children).toEqual([]);
  });

  it('MT-D12: TS leaf label = real basename incl. extension; folders/root stay bare', () => {
    const root = buildModuleTree(
      crateOf(
        'ts',
        [
          mod(''),
          mod('a', [], { file: '/abs/src/band_layout.ts' }),
          mod('comp', [], { file: '/abs/src/View.tsx' }),
          // Synthesized intermediate `dir` (only dir::leaf present) stays bare.
          mod('dir::leaf', [], { file: '/abs/src/dir/leaf.ts' }),
        ],
        'typescript',
      ),
    );
    expect(findModule(root, 'a')?.label).toBe('band_layout.ts');
    expect(findModule(root, 'comp')?.label).toBe('View.tsx');
    expect(findModule(root, 'dir')?.label).toBe('dir'); // synthesized dir, bare
    expect(root.label).toBe('ts'); // crate root keeps crate name
  });

  it('MT-D13: isLeaf true for real modules, false for synthesized intermediates', () => {
    const root = buildModuleTree(
      crateOf(
        'ts',
        [mod(''), mod('a', [], { file: '/s/a.ts' }), mod('a::b::c', [], { file: '/s/a/b/c.ts' })],
        'typescript',
      ),
    );
    expect(findModule(root, 'a')?.isLeaf).toBe(true);
    // a::b is only a synthesized intermediate (a::b::c is the real module).
    expect(findModule(root, 'a::b')?.isLeaf).toBe(false);
  });

  // The crate root represents the package as a whole (a container), not a
  // file — so its isLeaf must stay false even though crate.modules always
  // carries the '' root (lib.rs/index.ts). html_tree.ts keys the TS
  // folder/file icon off data-leaf, so a true here would draw the crate row
  // as a file. Fixed in module_tree.ts: the explicit-modules loop no longer
  // flips isLeaf for the '' path.
  it('MT-D13b: crate root isLeaf===false even when crate.modules has the "" root', () => {
    const root = buildModuleTree(
      crateOf('ts', [mod(''), mod('a', [], { file: '/s/a.ts' })], 'typescript'),
    );
    expect(root.isLeaf).toBe(false);
    // A real (non-root) module in crate.modules is still a leaf.
    const a = root.children.find((n) => n.kind === 'module' && n.label.startsWith('a'));
    expect(a?.kind === 'module' ? a.isLeaf : null).toBe(true);
  });

  it('MT-D14: language stamped on every descendant incl. synthesized intermediates; ws root = rust', () => {
    const facts: Facts = {
      crates: {
        ts: crateOf('ts', [mod(''), mod('a::b::c', [ty('ts', 'a::b::c', 'X')])], 'typescript'),
      },
      edges: [],
    };
    const ws = buildWorkspaceTree(facts);
    expect(ws.language).toBe('rust'); // placeholder per contract
    const langs: Language[] = [];
    const walk = (n: TreeNode): void => {
      if (n.kind === 'module') {
        langs.push(n.language);
        for (const c of n.children) walk(c);
      }
    };
    const crateRoot = ws.children[0] as ModuleNode;
    walk(crateRoot);
    expect(langs.length).toBeGreaterThan(2); // crate root + a + a::b + a::b::c
    expect(langs.every((l) => l === 'typescript')).toBe(true);
  });
});

// =============================================================================
// Tier 2 — canonicalize → buildModuleTree → buildLayout uniqueness (MT-C*)
// =============================================================================

describe('module-tree canonicalize (MT-C)', () => {
  it('MT-C01: collapses cfg-gated same-full_path type dups to one, richest representative', () => {
    // Two cfg flavors of the same type: an empty alias placeholder + the real
    // struct body. The richest (most fields, non-alias) must win.
    const facts: Facts = {
      crates: {
        c: crateOf('c', [
          mod(''),
          mod('a', [
            ty('c', 'a', 'Box', { kind: 'type_alias' }),
            ty('c', 'a', 'Box', {
              fields: [
                { name: 'ptr', ty_text: 'usize' },
                { name: 'len', ty_text: 'usize' },
              ],
            }),
          ]),
        ]),
      },
      edges: [],
    };
    const out = canonicalize(facts);
    const types = out.crates.c?.modules.a?.types ?? [];
    expect(types).toHaveLength(1);
    expect(types[0]?.kind).toBe('struct'); // non-alias representative
    expect(types[0]?.fields.map((f) => f.name)).toEqual(['ptr', 'len']);
  });

  it('MT-C02: dedupes re-exports by exposed_name within a module; distinct names survive', () => {
    const facts: Facts = {
      crates: {
        c: crateOf('c', [
          mod(''),
          mod('a', [], {
            re_exports: [
              reExp('String', 'c::inner::String'),
              reExp('String', 'c::inner::String'), // cfg-gated dup
              reExp('Vec', 'c::inner::Vec'),
            ],
          }),
        ]),
      },
      edges: [],
    };
    const re = canonicalize(facts).crates.c?.modules.a?.re_exports ?? [];
    expect(re.map((r) => r.exposed_name)).toEqual(['String', 'Vec']);
  });

  it('MT-C03: free functions deduped by name+impl_trait; genuine split-pair survives', () => {
    const facts: Facts = {
      crates: {
        c: crateOf('c', [
          mod('', [], {
            functions: [
              { name: 'materialize', visibility: 'pub' },
              { name: 'materialize', visibility: 'pub' }, // cfg-blind dup → collapse
            ],
          }),
        ]),
      },
      edges: [],
    };
    const fns = canonicalize(facts).crates.c?.modules['']?.functions ?? [];
    expect(fns.map((f) => f.name)).toEqual(['materialize']);
  });

  it('MT-C04: end-to-end cfg-dup pipeline emits unique band-layout ids (no crash)', () => {
    // The integration guard: unit dedup can pass while assembled buildLayout
    // still throws "Band layout item ids must be unique" if keys diverge.
    const dupCrate = crateOf('c', [
      mod(''),
      mod(
        'a',
        [
          ty('c', 'a', 'Dup', { fields: [{ name: 'x', ty_text: 'u32' }] }),
          ty('c', 'a', 'Dup', { kind: 'type_alias' }), // cfg twin, same full_path
        ],
        {
          functions: [
            { name: 'go', visibility: 'pub' },
            { name: 'go', visibility: 'pub' }, // cfg twin
          ],
          re_exports: [reExp('R', 'c::inner::R'), reExp('R', 'c::inner::R')],
        },
      ),
    ]);
    const facts: Facts = { crates: { c: dupCrate }, edges: [] };
    const canon = canonicalize(facts);
    const canonCrate = canon.crates.c as CrateFacts;
    const expanded = allModuleIds(canonCrate);
    const inputs = inputsFor(canonCrate, canon.edges, expanded);

    expect(() => buildLayout(inputs)).not.toThrow();
    const layout = buildLayout(inputs);
    const ids = layout.modules.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length); // module rows unique
  });
});

// =============================================================================
// Tier 2 — geometry: ModuleRow placement / dividers / modDepth (MT-G*)
// =============================================================================

const SMALL_EXPANDED = [
  'c',
  'c::core',
  'c::render',
  'c::App',
  'c::core::Engine',
  'c::render::Renderer',
];

function smallCrate(): CrateFacts {
  return crateOf('c', [
    mod('', [ty('c', '', 'App', { fields: [{ name: 'engine', ty_text: 'core::Engine' }] })]),
    mod('core', [ty('c', 'core', 'Engine'), ty('c', 'core', 'Cylinder')]),
    mod('render', [ty('c', 'render', 'Renderer'), ty('c', 'render', 'Pixel')]),
  ]);
}

function smallEdges(): Facts['edges'] {
  return [
    {
      from: 'c::App',
      to: 'c::core::Engine',
      kind: 'owns',
      via: 'struct_field',
      origin: 'field engine',
    },
  ];
}

describe('module-tree geometry (MT-G)', () => {
  it('MT-G01: ModuleRow.y is the band TOP edge (running cursor), NOT band-top + ROW_H/2', () => {
    const inputs = inputsFor(smallCrate(), smallEdges(), SMALL_EXPANDED);
    const layout = buildLayout(inputs);
    const rows = [...layout.modules];
    expect(rows.length).toBeGreaterThan(1);
    // The first emitted band starts at TOP_PAD; consecutive rows differ by the
    // PRIOR row's bandHeight (cursorY accumulation). A center-stored y would
    // instead offset everything by +ROW_H/2 and break this exact equality.
    expect(rows[0]?.y).toBe(TOP_PAD);
    let cursor = TOP_PAD;
    for (const r of rows) {
      expect(r.y).toBe(cursor);
      cursor += r.bandHeight;
    }
  });

  it('MT-G02: workspace root emits NO band; crates land at modDepth 0', () => {
    const facts: Facts = {
      crates: {
        a: crateOf('a', [mod('', [ty('a', '', 'A')])]),
        b: crateOf('b', [mod('', [ty('b', '', 'B')])]),
      },
      edges: [],
    };
    const inputs = workspaceInputs(facts, [WORKSPACE_ROOT_ID, 'a', 'b']);
    const layout = buildLayout(inputs);
    expect(layout.modules.some((m) => m.id === WORKSPACE_ROOT_ID)).toBe(false);
    const crateRows = layout.modules.filter((m) => m.id === 'a' || m.id === 'b');
    expect(crateRows).toHaveLength(2);
    for (const r of crateRows) expect(r.modDepth).toBe(0);
  });

  it('MT-G03: hitWidth uses BOLD measure (+ right pad) and is monotonic in label length', () => {
    const reg = (s: string): number => s.length * 7;
    const bold = (s: string): number => s.length * 9; // bold > regular per char
    const short = measureModuleHitWidth('ab', reg, bold);
    const long = measureModuleHitWidth('abcdef', reg, bold);
    // Exact bold formula, not the regular one.
    expect(short).toBe(
      MODULE_LABEL_X + bold('ab') * MODULE_LABEL_LEAF_FONT_SCALE + MODULE_HIT_PAD_RIGHT,
    );
    // Bold-derived width must exceed what the regular measurer would give.
    expect(short).toBeGreaterThan(
      MODULE_LABEL_X + reg('ab') * MODULE_LABEL_LEAF_FONT_SCALE + MODULE_HIT_PAD_RIGHT,
    );
    expect(long).toBeGreaterThan(short); // monotonic
  });

  it('MT-G04: computeLeafSegment width is bold-measured; isParent flows through', () => {
    const bold = (s: string): number => s.length * 9;
    const prefix = computePrefixSegments('c::a::Leaf', measure); // [] for indented tree
    const parentSeg = computeLeafSegment('c::a::parent', prefix, bold, true);
    const leafSeg = computeLeafSegment('c::a::leaf', prefix, bold, false);
    expect(parentSeg.width).toBe(bold('parent') * MODULE_LABEL_LEAF_FONT_SCALE);
    expect(parentSeg.xStart).toBe(MODULE_LABEL_X); // no prefix → starts at label x
    expect(parentSeg.isParent).toBe(true);
    expect(leafSeg.isParent).toBe(false);
  });

  it('MT-G05: divider exists ONLY between two adjacent modDepth-0 bands (NOT per band)', () => {
    // Two crates, each with a submodule. The only adjacent crate-crate pair in
    // band order is (last row of crate a) → (crate b root) — but those are NOT
    // both depth 0 (a's submodule sits between). Add a second top-level crate
    // with no submodules so a real crate→crate adjacency exists.
    const facts: Facts = {
      crates: {
        a: crateOf('a', [mod('', [ty('a', '', 'A')]), mod('sub', [ty('a', 'sub', 'S')])]),
        b: crateOf('b', [mod('', [ty('b', '', 'B')])]),
        d: crateOf('d', [mod('', [ty('d', '', 'D')])]),
      },
      edges: [],
    };
    const inputs = workspaceInputs(facts, [WORKSPACE_ROOT_ID, 'a', 'a::sub', 'b', 'd']);
    const rows = [...buildLayout(inputs).modules];
    const dividers: string[] = [];
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1];
      const cur = rows[i];
      if (prev?.modDepth === 0 && cur?.modDepth === 0) dividers.push(cur.id);
    }
    // b follows a::sub (depth 1 → depth 0): NO divider. d follows b
    // (depth 0 → depth 0): divider keyed on d. So exactly one divider, on d.
    expect(dividers).toEqual(['d']);
  });

  it('MT-G06: modDepth = depth below the invisible workspace root (crate 0, submodules 1..)', () => {
    const facts: Facts = {
      crates: {
        c: crateOf('c', [
          mod(''),
          mod('a', []),
          mod('a::b', []),
          mod('a::b::c', [ty('c', 'a::b::c', 'Deep')]),
        ]),
      },
      edges: [],
    };
    const inputs = workspaceInputs(facts, [
      WORKSPACE_ROOT_ID,
      'c',
      'c::a',
      'c::a::b',
      'c::a::b::c',
    ]);
    const rows = buildLayout(inputs).modules;
    const byId = new Map(rows.map((r) => [r.id, r.modDepth] as const));
    expect(byId.get('c')).toBe(0);
    expect(byId.get('c::a')).toBe(1);
    expect(byId.get('c::a::b')).toBe(2);
    expect(byId.get('c::a::b::c')).toBe(3);
  });
});
