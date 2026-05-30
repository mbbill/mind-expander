import { describe, expect, it } from 'vitest';
import {
  type ModuleNode,
  type TreeNode,
  type TypeNode,
  WORKSPACE_ROOT_ID,
  buildModuleTree,
  buildWorkspaceTree,
} from '../src/analysis/module_tree.ts';
import type {
  CrateFacts,
  Facts,
  FnFacts,
  ModuleFacts,
  ReExport,
  TypeFacts,
  TypeKind,
} from '../src/data/schema.ts';

function ty(
  crate: string,
  modPath: string,
  name: string,
  kind: TypeKind = 'struct',
  visibility = 'pub',
): TypeFacts {
  const full = modPath === '' ? `${crate}::${name}` : `${crate}::${modPath}::${name}`;
  return { name, full_path: full, kind, visibility, fields: [] };
}

function fn(name: string, visibility = 'pub'): FnFacts {
  return { name, visibility };
}

function mod(
  path: string,
  types: TypeFacts[] = [],
  options: {
    readonly file?: string;
    readonly functions?: readonly FnFacts[];
    readonly re_exports?: readonly ReExport[];
  } = {},
): ModuleFacts {
  const base: ModuleFacts = {
    path,
    types,
    file: options.file ?? defaultFile(path),
    functions: options.functions ?? [],
  };
  return options.re_exports !== undefined ? { ...base, re_exports: options.re_exports } : base;
}

function defaultFile(path: string): string {
  return path === '' ? 'src/lib.rs' : `src/${path.replace(/::/g, '/')}.rs`;
}

function crateOf(name: string, modules: ModuleFacts[]): CrateFacts {
  return {
    name,
    modules: Object.fromEntries(modules.map((m) => [m.path, m])),
  };
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

function childLabels(node: ModuleNode): string[] {
  return node.children.map((c) => c.label);
}

describe('buildModuleTree', () => {
  it('returns a single root node labeled with the crate name', () => {
    const root = buildModuleTree(crateOf('c', [mod('')]));
    expect(root.kind).toBe('module');
    expect(root.label).toBe('c');
    expect(root.path).toBe('');
  });

  it('attaches types under the module that owns them', () => {
    const root = buildModuleTree(
      crateOf('c', [
        mod(''),
        mod('a', [ty('c', 'a', 'Foo', 'struct'), ty('c', 'a', 'Bar', 'enum')]),
      ]),
    );
    const a = findModule(root, 'a');
    expect(a).toBeDefined();
    expect(childLabels(a as ModuleNode)).toEqual(['Bar', 'Foo']);
  });

  it('builds parent module nodes for nested paths', () => {
    const root = buildModuleTree(
      crateOf('c', [mod(''), mod('a::b::c', [ty('c', 'a::b::c', 'X')])]),
    );
    // `a` and `a::b` are directory modules (they have submodules) → bare
    // folder names. `a::b::c` is a leaf file → filename with extension.
    expect(findModule(root, 'a')?.label).toBe('a');
    expect(findModule(root, 'a::b')?.label).toBe('b');
    const abc = findModule(root, 'a::b::c');
    expect(abc?.label).toBe('c.rs');
    expect(childLabels(abc as ModuleNode)).toEqual(['X']);
  });

  it('label follows file shape: leaf → name.rs, directory module → bare name', () => {
    // Leaf .rs files show the filename; directory modules (mod.rs-backed,
    // or a leaf .rs that ALSO has submodules) show the bare directory name.
    const root = buildModuleTree(
      crateOf('c', [
        mod(''),
        mod('modrs_backed', [], { file: 'src/modrs_backed/mod.rs' }),
        mod('leaf', [], { file: 'src/leaf.rs' }),
        mod('split', [], { file: 'src/split.rs' }),
        mod('split::sub', [], { file: 'src/split/sub.rs' }),
      ]),
    );
    expect(findModule(root, 'modrs_backed')?.label).toBe('modrs_backed'); // mod.rs → dir
    expect(findModule(root, 'leaf')?.label).toBe('leaf.rs'); // leaf file
    expect(findModule(root, 'split')?.label).toBe('split'); // has submodule → dir
    expect(findModule(root, 'split::sub')?.label).toBe('sub.rs'); // leaf file
  });

  it('places submodules before type leaves at the same level', () => {
    const root = buildModuleTree(crateOf('c', [mod('', [ty('c', '', 'TypeAtRoot')]), mod('sub')]));
    // `sub` is a leaf .rs file → `sub.rs`; still sorts before the type leaf.
    expect(childLabels(root)).toEqual(['sub.rs', 'TypeAtRoot']);
  });

  it('excludes test modules by default', () => {
    const root = buildModuleTree(
      crateOf('c', [
        mod(''),
        mod('a', [ty('c', 'a', 'Keep')]),
        mod('a::tests', [ty('c', 'a::tests', 'Drop')]),
        mod('tests', [ty('c', 'tests', 'AlsoDrop')]),
      ]),
    );
    expect(findModule(root, 'a::tests')).toBeUndefined();
    expect(findModule(root, 'tests')).toBeUndefined();
    expect(childLabels(findModule(root, 'a') as ModuleNode)).toEqual(['Keep']);
  });

  it('preserves test modules when excludeTests is false', () => {
    const root = buildModuleTree(crateOf('c', [mod(''), mod('tests', [ty('c', 'tests', 'T')])]), {
      excludeTests: false,
    });
    expect(findModule(root, 'tests')).toBeDefined();
  });

  it('issues stable IDs derived from the crate name', () => {
    const root = buildModuleTree(
      crateOf('crate-x', [mod(''), mod('a', [ty('crate-x', 'a', 'Foo')])]),
    );
    expect(root.id).toBe('crate-x');
    const a = findModule(root, 'a');
    expect(a?.id).toBe('crate-x::a');
    expect(a?.children[0]?.id).toBe('crate-x::a::Foo');
  });
});

function typeChildren(node: ModuleNode): readonly TypeNode[] {
  return node.children.filter((c): c is TypeNode => c.kind === 'type');
}

describe('buildModuleTree — type method buckets', () => {
  function tyWithMethods(
    crate: string,
    modPath: string,
    name: string,
    methods: FnFacts[],
    kind: TypeKind = 'struct',
  ): TypeFacts {
    const full = modPath === '' ? `${crate}::${name}` : `${crate}::${modPath}::${name}`;
    return { name, full_path: full, kind, visibility: 'pub', fields: [], methods };
  }

  it('groups methods by visibility, sorts each bucket, and follows BUCKET_ORDER', () => {
    const root = buildModuleTree(
      crateOf('c', [
        mod(''),
        mod('a', [
          tyWithMethods('c', 'a', 'Foo', [
            fn('zeta', 'pub'),
            fn('alpha', 'pub'),
            fn('beta', 'pub(crate)'),
            fn('gamma', 'priv'),
          ]),
        ]),
      ]),
    );
    const a = findModule(root, 'a');
    const t = typeChildren(a as ModuleNode)[0] as TypeNode;
    expect(t.methodBuckets.map((b) => b.bucket)).toEqual(['pub', 'pub_crate', 'private']);
    expect(t.methodBuckets[0]?.methods.map((m) => m.name)).toEqual(['alpha', 'zeta']);
    expect(t.methodBuckets[1]?.methods.map((m) => m.name)).toEqual(['beta']);
    expect(t.methodBuckets[2]?.methods.map((m) => m.name)).toEqual(['gamma']);
  });

  it('drops methods with sentinel visibility tokens', () => {
    const root = buildModuleTree(
      crateOf('c', [
        mod(''),
        mod('a', [
          tyWithMethods('c', 'a', 'Foo', [fn('keep', 'pub'), fn('skip', '<orphan-impl>')]),
        ]),
      ]),
    );
    const a = findModule(root, 'a');
    const t = typeChildren(a as ModuleNode)[0] as TypeNode;
    expect(t.methodBuckets).toHaveLength(1);
    expect(t.methodBuckets[0]?.methods.map((m) => m.name)).toEqual(['keep']);
  });

  it('emits no buckets when the type has no real-visibility methods', () => {
    const root = buildModuleTree(
      crateOf('c', [
        mod(''),
        mod('a', [tyWithMethods('c', 'a', 'Foo', [fn('x', '<orphan-impl>')])]),
      ]),
    );
    const a = findModule(root, 'a');
    const t = typeChildren(a as ModuleNode)[0] as TypeNode;
    expect(t.methodBuckets).toEqual([]);
  });

  it('treats absent methods (legacy facts) as no buckets', () => {
    // TypeFacts.methods is optional in the schema; types without it
    // should land here with empty buckets, not crash.
    const root = buildModuleTree(
      crateOf('c', [mod(''), mod('a', [ty('c', 'a', 'Foo', 'struct')])]),
    );
    const a = findModule(root, 'a');
    const t = typeChildren(a as ModuleNode)[0] as TypeNode;
    expect(t.methodBuckets).toEqual([]);
  });
});

describe('buildModuleTree — function group synthesis', () => {
  it('groups free functions into one pseudo-type per non-empty visibility bucket', () => {
    const root = buildModuleTree(
      crateOf('c', [
        mod(''),
        mod('a', [], {
          functions: [
            fn('alpha', 'pub'),
            fn('beta', 'pub(crate)'),
            fn('gamma', 'pub'),
            fn('delta', 'priv'),
          ],
        }),
      ]),
    );
    const a = findModule(root, 'a');
    const groups = typeChildren(a as ModuleNode).filter((t) => t.typeKind === 'function_group');
    // Three buckets used (pub, pub(crate), priv); pub(super) and pub(in path) absent.
    expect(groups.map((g) => g.label).sort()).toEqual(
      ['local fn (1)', 'pub fn (2)', 'pub(crate) fn (1)'].sort(),
    );
  });

  it('orders function groups before real types and follows BUCKET_ORDER (most public first)', () => {
    const root = buildModuleTree(
      crateOf('c', [
        mod(''),
        mod('a', [ty('c', 'a', 'Real')], {
          functions: [fn('p', 'pub'), fn('q', 'pub(crate)'), fn('r', 'priv')],
        }),
      ]),
    );
    const a = findModule(root, 'a');
    const labels = typeChildren(a as ModuleNode).map((t) => t.label);
    // pub fn → pub(crate) fn → local fn → real types alphabetical
    expect(labels).toEqual(['pub fn (1)', 'pub(crate) fn (1)', 'local fn (1)', 'Real']);
  });

  it('encodes the bucket name and count as the pseudo-type label and `function_group` typeKind', () => {
    const root = buildModuleTree(
      crateOf('c', [mod(''), mod('a', [], { functions: [fn('one', 'pub')] })]),
    );
    const a = findModule(root, 'a');
    const groups = typeChildren(a as ModuleNode);
    expect(groups).toHaveLength(1);
    const g = groups[0] as TypeNode;
    expect(g.typeKind).toBe('function_group');
    expect(g.label).toBe('pub fn (1)');
    expect(g.visibility).toBe('pub');
  });

  it('exposes module functions as callable rows, alphabetical by name', () => {
    const root = buildModuleTree(
      crateOf('c', [mod(''), mod('a', [], { functions: [fn('zeta'), fn('alpha')] })]),
    );
    const a = findModule(root, 'a');
    const g = typeChildren(a as ModuleNode)[0] as TypeNode;
    expect(g.fields).toEqual([]);
    expect(g.functions.map((f) => [f.fullPath, f.fn.name])).toEqual([
      ['c::a::alpha', 'alpha'],
      ['c::a::zeta', 'zeta'],
    ]);
  });

  it('skips functions with sentinel visibility tokens like `<orphan-impl>`', () => {
    const root = buildModuleTree(
      crateOf('c', [
        mod(''),
        mod('a', [], { functions: [fn('keep', 'pub'), fn('skip', '<orphan-impl>')] }),
      ]),
    );
    const a = findModule(root, 'a');
    const g = typeChildren(a as ModuleNode)[0] as TypeNode;
    expect(g.functions.map((f) => f.fn.name)).toEqual(['keep']);
  });

  it('emits no function-group rows when the module has no real-visibility functions', () => {
    const root = buildModuleTree(
      crateOf('c', [mod(''), mod('a', [], { functions: [fn('skip', '<orphan-impl>')] })]),
    );
    const a = findModule(root, 'a');
    expect(typeChildren(a as ModuleNode)).toEqual([]);
  });

  it('uses synthetic ids that cannot collide with real type ids', () => {
    const root = buildModuleTree(
      crateOf('c', [mod(''), mod('a', [], { functions: [fn('one', 'pub')] })]),
    );
    const a = findModule(root, 'a');
    const g = typeChildren(a as ModuleNode)[0] as TypeNode;
    // Synthetic marker `__fn_` keeps these distinct from any real type
    // path the extractor could ever emit.
    expect(g.id).toContain('__fn_');
    expect(g.fullPath).toContain('__fn_');
  });
});

describe('buildModuleTree — type re-export ghosts', () => {
  const reExp = (
    name: string,
    target: string,
    kind: 'type' | 'function' = 'type',
    visibility = 'pub',
    target_kind?: ReExport['target_kind'],
  ): ReExport =>
    target_kind === undefined
      ? { exposed_name: name, target_path: target, kind, visibility }
      : { exposed_name: name, target_path: target, kind, visibility, target_kind };

  it('synthesizes a ghost TypeNode for each pub-use type re-export', () => {
    const root = buildModuleTree(
      crateOf('c', [
        mod(''),
        mod('inner', [ty('c', 'inner', 'Real')]),
        mod('outer', [], { re_exports: [reExp('Real', 'c::inner::Real')] }),
      ]),
    );
    const outer = findModule(root, 'outer');
    const ghosts = typeChildren(outer as ModuleNode);
    expect(ghosts).toHaveLength(1);
    const g = ghosts[0] as TypeNode;
    expect(g.label).toBe('Real');
    expect(g.isGhost).toBe(true);
    expect(g.ghostTarget).toBe('c::inner::Real');
  });

  it('honors `as Renamed` — exposed_name drives the ghost label, not the target', () => {
    const root = buildModuleTree(
      crateOf('c', [
        mod(''),
        mod('inner', [ty('c', 'inner', 'OldName')]),
        mod('outer', [], { re_exports: [reExp('NewName', 'c::inner::OldName')] }),
      ]),
    );
    const outer = findModule(root, 'outer');
    const g = typeChildren(outer as ModuleNode)[0] as TypeNode;
    expect(g.label).toBe('NewName');
    expect(g.ghostTarget).toBe('c::inner::OldName');
  });

  it('skips function re-exports until they are modeled', () => {
    const root = buildModuleTree(
      crateOf('c', [
        mod(''),
        mod('outer', [], {
          re_exports: [
            reExp('TypeRe', 'c::inner::Type', 'type'),
            reExp('fnRe', 'c::inner::do_thing', 'function'),
          ],
        }),
      ]),
    );
    const outer = findModule(root, 'outer');
    const ghosts = typeChildren(outer as ModuleNode);
    expect(ghosts.map((g) => g.label)).toEqual(['TypeRe']);
  });

  it('skips re-exports whose visibility is a sentinel token', () => {
    const root = buildModuleTree(
      crateOf('c', [
        mod(''),
        mod('outer', [], {
          re_exports: [
            reExp('Keep', 'c::inner::Real', 'type', 'pub'),
            reExp('Skip', 'c::inner::Real', 'type', '<orphan-impl>'),
          ],
        }),
      ]),
    );
    const outer = findModule(root, 'outer');
    expect(typeChildren(outer as ModuleNode).map((g) => g.label)).toEqual(['Keep']);
  });

  it('emits no ghosts when re_exports is undefined or empty', () => {
    // Old facts files without re-export tracking shouldn't produce ghosts —
    // the feature must be inert.
    const root = buildModuleTree(crateOf('c', [mod(''), mod('a', [ty('c', 'a', 'Real')])]));
    const a = findModule(root, 'a');
    const all = typeChildren(a as ModuleNode);
    for (const t of all) {
      expect(t.isGhost ?? false).toBe(false);
    }
  });

  it('ghost id is synthetic and cannot collide with a real type id', () => {
    const root = buildModuleTree(
      crateOf('c', [mod(''), mod('outer', [], { re_exports: [reExp('Real', 'c::inner::Real')] })]),
    );
    const outer = findModule(root, 'outer');
    const g = typeChildren(outer as ModuleNode)[0] as TypeNode;
    expect(g.id).toContain('__re_');
    // The ghost id must not match the canonical target path (would collide
    // with the real node).
    expect(g.id).not.toBe('c::inner::Real');
  });

  it('ghost carries the re-export visibility, not the target type visibility', () => {
    // `pub(crate) use foo::Bar` → ghost is pub(crate) regardless of how Bar
    // is declared in its origin module.
    const root = buildModuleTree(
      crateOf('c', [
        mod(''),
        mod('inner', [ty('c', 'inner', 'Real', 'struct', 'pub')]),
        mod('outer', [], {
          re_exports: [reExp('Real', 'c::inner::Real', 'type', 'pub(crate)')],
        }),
      ]),
    );
    const outer = findModule(root, 'outer');
    const g = typeChildren(outer as ModuleNode)[0] as TypeNode;
    expect(g.visibility).toBe('pub(crate)');
  });

  it('ghost typeKind inherits from re.target_kind when the extractor provides it', () => {
    // The extractor stamps the canonical's kind onto the ReExport so
    // ghost rows render the right S/E/U/T/A marker. The synthesiser
    // must propagate it to the TypeNode's typeKind.
    const root = buildModuleTree(
      crateOf('c', [
        mod(''),
        mod('outer', [], {
          re_exports: [
            reExp('Re_Enum', 'c::inner::E', 'type', 'pub', 'enum'),
            reExp('Re_Trait', 'c::inner::T', 'type', 'pub', 'trait'),
            reExp('Re_Alias', 'c::inner::A', 'type', 'pub', 'type_alias'),
          ],
        }),
      ]),
    );
    const outer = findModule(root, 'outer');
    const byLabel = new Map(typeChildren(outer as ModuleNode).map((g) => [g.label, g] as const));
    expect(byLabel.get('Re_Enum')?.typeKind).toBe('enum');
    expect(byLabel.get('Re_Trait')?.typeKind).toBe('trait');
    expect(byLabel.get('Re_Alias')?.typeKind).toBe('type_alias');
  });

  it('ghost typeKind falls back to "struct" when target_kind is absent (legacy facts)', () => {
    // Old facts.json files predate the target_kind field; ghosts still
    // need to render with *something*. 'struct' is the safe default
    // since most re-exports target structs.
    const root = buildModuleTree(
      crateOf('c', [mod(''), mod('outer', [], { re_exports: [reExp('Foo', 'c::inner::Foo')] })]),
    );
    const outer = findModule(root, 'outer');
    const g = typeChildren(outer as ModuleNode)[0] as TypeNode;
    expect(g.typeKind).toBe('struct');
  });
});

describe('buildWorkspaceTree', () => {
  it('wraps each crate tree under a virtual workspace root', () => {
    const facts: Facts = {
      crates: {
        b: crateOf('b', [mod('', [ty('b', '', 'BType')])]),
        a: crateOf('a', [mod('', [ty('a', '', 'AType')])]),
      },
      edges: [],
    };
    const ws = buildWorkspaceTree(facts);
    expect(ws.id).toBe(WORKSPACE_ROOT_ID);
    // Crates ordered alphabetically — stable across reloads even if the
    // JSON object key order is unspecified.
    expect(ws.children.map((c) => (c.kind === 'module' ? c.label : c.id))).toEqual(['a', 'b']);
  });

  it('preserves crate-level structure: a crate child IS a buildModuleTree result', () => {
    const facts: Facts = {
      crates: {
        c: crateOf('c', [mod('', [ty('c', '', 'Root')]), mod('inner', [ty('c', 'inner', 'I')])]),
      },
      edges: [],
    };
    const ws = buildWorkspaceTree(facts);
    expect(ws.children).toHaveLength(1);
    const crateRoot = ws.children[0];
    if (crateRoot?.kind !== 'module') throw new Error('expected module');
    expect(crateRoot.label).toBe('c');
    expect(findModule(crateRoot, 'inner')).toBeDefined();
  });

  it('returns an empty workspace tree when facts has no crates', () => {
    const ws = buildWorkspaceTree({ crates: {}, edges: [] });
    expect(ws.id).toBe(WORKSPACE_ROOT_ID);
    expect(ws.children).toEqual([]);
  });
});
