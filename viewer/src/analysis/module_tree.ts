// Pure transform: a single crate's facts → a hierarchical tree of modules
// with types as leaves. No DOM, no D3, no view state — view-state machinery
// keys off the stable `id` field of each node.

import type { CrateFacts, FieldFacts, FnFacts, ReExport, TypeKind } from '../data/schema.ts';
import {
  BUCKET_LABEL,
  BUCKET_ORDER,
  BUCKET_VIS_TOKEN,
  type VisibilityBucket,
  classifyVisibility,
  isRealVisibility,
} from './visibility.ts';

export type TreeNode = ModuleNode | TypeNode;

export interface ModuleNode {
  readonly kind: 'module';
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly children: readonly TreeNode[];
}

export interface TypeNode {
  readonly kind: 'type';
  readonly id: string;
  readonly label: string;
  readonly typeKind: TypeKind;
  /** Raw extractor visibility token (`"pub"`, `"pub(crate)"`, …, `"priv"`). */
  readonly visibility: string;
  readonly fullPath: string;
  readonly modulePath: string;
  readonly fields: readonly FieldFacts[];
  /** Methods on this type, bucketed by visibility and sorted by name
   *  within each bucket. The layout renders one foldable bucket header
   *  row per non-empty bucket; user clicks a bucket header to reveal
   *  its method rows. Empty for ghost rows / function-group pseudo-
   *  types / older facts files without methods. */
  readonly methodBuckets: readonly MethodBucket[];
  /** True for synthesized ghost re-export nodes. The renderer styles them
   *  distinctly (hollow ring + italic) and the layout draws a violet
   *  arrow back to the canonical source. */
  readonly isGhost?: boolean;
  /** Canonical full path to the original definition this ghost targets.
   *  Set only when `isGhost` is true. */
  readonly ghostTarget?: string;
}

/** Per-visibility method group on a type. The layout uses
 *  `${typeFullPath}::__methods_${bucket}` as the bucket's expansion id
 *  so its open/closed state lives in the same `ViewState` set as
 *  modules and types. */
export interface MethodBucket {
  readonly bucket: VisibilityBucket;
  readonly methods: readonly FnFacts[];
}

export interface BuildOptions {
  /** Drop any module whose path contains a `tests` segment. Default: true. */
  readonly excludeTests?: boolean;
}

export function buildModuleTree(crate: CrateFacts, options: BuildOptions = {}): ModuleNode {
  const excludeTests = options.excludeTests ?? true;

  const modules = Object.values(crate.modules).filter(
    (m) => !excludeTests || !hasTestsSegment(m.path),
  );

  type Scratch = {
    kind: 'module';
    id: string;
    label: string;
    path: string;
    children: TreeNode[];
  };

  const root: Scratch = {
    kind: 'module',
    id: idForModule(crate.name, ''),
    label: crate.name,
    path: '',
    children: [],
  };
  const byPath = new Map<string, Scratch>([['', root]]);

  // Build the prefix chain for every module path. Synthetic intermediates
  // (not in `crate.modules` themselves) default to folder-style labels since
  // their existence implies they hold submodules. Recursion is bounded by max
  // path depth, which is small in practice.
  const ensureChain = (path: string): Scratch => {
    const cached = byPath.get(path);
    if (cached) return cached;
    const segments = path.split('::');
    const parentPath = segments.slice(0, -1).join('::');
    const parent = ensureChain(parentPath);
    const lastSegment = segments[segments.length - 1] ?? path;
    const node: Scratch = {
      kind: 'module',
      id: idForModule(crate.name, path),
      label: lastSegment,
      path,
      children: [],
    };
    parent.children.push(node);
    byPath.set(path, node);
    return node;
  };

  // Labels are pure module names (last path segment). The crate root keeps
  // the bare crate name. We deliberately don't synthesize filesystem-style
  // labels (`name.rs`, etc.) — the pane is a Rust module hierarchy, not a
  // file tree, and rendering it as such avoids the "looks like files but
  // isn't" confusion. The renderer formats every row as `parent::path::leaf`
  // with the parent prefix dimmed/smaller to make module-ness explicit.
  for (const m of modules) {
    const node = m.path === '' ? root : ensureChain(m.path);
    // Synthetic function-group pseudo-types come FIRST so they appear at
    // the top of the module's column when the band sorts kind-aware.
    for (const groupNode of synthesiseFunctionGroups(crate.name, m.path, m.functions)) {
      node.children.push(groupNode);
    }
    for (const t of m.types) {
      node.children.push({
        kind: 'type',
        id: t.full_path,
        label: t.name,
        typeKind: t.kind,
        visibility: t.visibility,
        fullPath: t.full_path,
        modulePath: m.path,
        fields: t.fields,
        methodBuckets: bucketMethods(t.methods ?? []),
      });
    }
    // Type re-exports (ghosts). Function re-exports are deferred for v1 —
    // they'll later get their own ghost rows inside the appropriate
    // function-group bucket.
    for (const ghostNode of synthesiseTypeReExportGhosts(crate.name, m.path, m.re_exports)) {
      node.children.push(ghostNode);
    }
  }

  for (const node of byPath.values()) {
    node.children.sort(compareTreeNodes);
  }

  return root as ModuleNode;
}

/**
 * Build synthetic `TypeNode`s — one per non-empty visibility bucket — to
 * represent the module's free functions. Each pseudo-type carries the
 * function names as its `fields`, so existing renderer/expansion machinery
 * works unchanged.
 *
 * Empty buckets are skipped (so we don't render rows for visibility levels
 * that have no functions). Functions whose visibility is a sentinel like
 * `<orphan-impl>` are filtered out entirely.
 */
function synthesiseFunctionGroups(
  crateName: string,
  modulePath: string,
  functions: readonly FnFacts[],
): TypeNode[] {
  if (functions.length === 0) return [];
  const buckets = new Map<VisibilityBucket, FnFacts[]>();
  for (const fn of functions) {
    if (!isRealVisibility(fn.visibility)) continue;
    const b = classifyVisibility(fn.visibility);
    let list = buckets.get(b);
    if (!list) {
      list = [];
      buckets.set(b, list);
    }
    list.push(fn);
  }
  const out: TypeNode[] = [];
  for (const bucket of BUCKET_ORDER) {
    const fns = buckets.get(bucket);
    if (!fns || fns.length === 0) continue;
    fns.sort((a, b) => a.name.localeCompare(b.name));
    const moduleId = idForModule(crateName, modulePath);
    out.push({
      kind: 'type',
      // Synthetic id — won't collide with any real type id since real
      // ids never contain `__fn_`.
      id: `${moduleId}::__fn_${bucket}`,
      label: `${BUCKET_LABEL[bucket]} (${fns.length})`,
      typeKind: 'function_group',
      visibility: BUCKET_VIS_TOKEN[bucket],
      fullPath: `${moduleId}::__fn_${bucket}`,
      modulePath,
      // Each function becomes a "field" — name only, no targets. The
      // renderer treats these like regular field rows.
      fields: fns.map((fn): FieldFacts => ({ name: fn.name, ty_text: '', ownership: 'primitive' })),
      methodBuckets: [],
    });
  }
  return out;
}

/** Bucket a type's methods by visibility, drop sentinel-vis items, and
 *  sort each bucket's contents alphabetically. Returns only the buckets
 *  that have at least one method, in the canonical `BUCKET_ORDER`. */
function bucketMethods(methods: readonly FnFacts[]): MethodBucket[] {
  if (methods.length === 0) return [];
  const map = new Map<VisibilityBucket, FnFacts[]>();
  for (const fn of methods) {
    if (!isRealVisibility(fn.visibility)) continue;
    const b = classifyVisibility(fn.visibility);
    let list = map.get(b);
    if (!list) {
      list = [];
      map.set(b, list);
    }
    list.push(fn);
  }
  const out: MethodBucket[] = [];
  for (const bucket of BUCKET_ORDER) {
    const fns = map.get(bucket);
    if (!fns || fns.length === 0) continue;
    fns.sort((a, b) => a.name.localeCompare(b.name));
    out.push({ bucket, methods: fns });
  }
  return out;
}

/**
 * Build ghost `TypeNode`s for type-kind re-exports. Each ghost lives in
 * the re-exporting module, carries its own visibility (the `pub use`
 * statement's), and remembers the canonical target so the layout can
 * draw an arrow back to it. We keep ghosts lightweight: empty `fields`,
 * no participation in the ownership graph — they don't pull arrows other
 * than the single ghost-arrow to their source.
 */
function synthesiseTypeReExportGhosts(
  crateName: string,
  modulePath: string,
  reExports: readonly ReExport[] | undefined,
): TypeNode[] {
  if (!reExports || reExports.length === 0) return [];
  const out: TypeNode[] = [];
  for (const re of reExports) {
    if (re.kind !== 'type') continue; // function re-exports deferred to v2
    if (!isRealVisibility(re.visibility)) continue;
    const moduleId = idForModule(crateName, modulePath);
    // Synthetic id keeps ghosts distinct from the canonical type node
    // (which lives in its own module). Using `__re_` so it can never
    // collide with any real type id.
    const ghostId = `${moduleId}::__re_${re.exposed_name}`;
    out.push({
      kind: 'type',
      id: ghostId,
      label: re.exposed_name,
      // Inherit the canonical's kind from the extractor when present,
      // so ghost rows show the right S/E/U/T/A marker. Older facts
      // files (or future variants we haven't taught the extractor
      // about) fall back to 'struct' — the ghost row still renders;
      // it just gets the struct marker instead of the precise one.
      // The renderer additionally discriminates ghost rows via
      // `isGhost` (italic + hollow ring).
      typeKind: re.target_kind ?? 'struct',
      visibility: re.visibility,
      fullPath: ghostId,
      modulePath,
      fields: [],
      methodBuckets: [],
      isGhost: true,
      ghostTarget: re.target_path,
    });
  }
  return out;
}

function hasTestsSegment(path: string): boolean {
  return path.split('::').includes('tests');
}

function idForModule(crateName: string, path: string): string {
  return path === '' ? crateName : `${crateName}::${path}`;
}

// Order within a module's children:
//   1. Submodules (so structural levels stay above leaves).
//   2. Function-group pseudo-types (sorted by visibility — `pub fn (N)` first,
//      `local fn (N)` last; the BUCKET_ORDER sequence is enforced via the
//      synthesizer pushing in order, plus this comparator's tie-break).
//   3. Real types (alphabetical).
function compareTreeNodes(a: TreeNode, b: TreeNode): number {
  if (a.kind !== b.kind) return a.kind === 'module' ? -1 : 1;
  if (a.kind === 'type' && b.kind === 'type') {
    const aFn = a.typeKind === 'function_group';
    const bFn = b.typeKind === 'function_group';
    if (aFn !== bFn) return aFn ? -1 : 1;
    if (aFn && bFn) {
      // Both are function-group pseudo-types; preserve BUCKET_ORDER by
      // comparing positions in that ordering. The synthesizer already
      // pushes them in order, but a stable sort key is safer.
      const ai = BUCKET_ORDER.indexOf(classifyVisibility(a.visibility));
      const bi = BUCKET_ORDER.indexOf(classifyVisibility(b.visibility));
      return ai - bi;
    }
  }
  return a.label.localeCompare(b.label);
}
