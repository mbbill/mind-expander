// Pure transform: a single crate's facts → a hierarchical tree of modules
// with types as leaves. No DOM, no D3, no view state — view-state machinery
// keys off the stable `id` field of each node.

import type {
  CrateFacts,
  Facts,
  FieldFacts,
  FnFacts,
  Language,
  ReExport,
  TypeKind,
} from '../data/schema.ts';
import {
  BUCKET_LABEL,
  BUCKET_ORDER,
  BUCKET_VIS_TOKEN,
  type VisibilityBucket,
  classifyVisibility,
  isRealVisibility,
} from './visibility.ts';

export type TreeNode = ModuleNode | TypeNode;

/** How a module maps to source files, which decides its tree label and
 *  folder/file icon. Derived purely from `ModuleFacts.file` + the module's
 *  children — see `assignFileRoles`.
 *   - `crate-root`  the package as a whole (lib.rs/main.rs/index.ts). Bare
 *                   crate-name label, no file/folder icon.
 *   - `dir`         a directory module: backed by `mod.rs`, or backed by a
 *                   `name.rs` that ALSO has submodules (the Rust-2018 sibling
 *                   form), or a synthesized path intermediate. Folder icon,
 *                   bare directory-name label.
 *   - `leaf-file`   a module that is just one file with no submodules. File
 *                   icon, label is the filename incl. extension (`a.rs`).
 *   - `inline`      a Rust `mod foo { ... }` with no file of its own — the
 *                   extractor stamps it with the parent's file, so it shares
 *                   a filename with its parent/siblings. Distinct icon; label
 *                   shows `name (parentfile)` to disambiguate. */
export type FileRole = 'crate-root' | 'dir' | 'leaf-file' | 'inline';

export interface ModuleNode {
  readonly kind: 'module';
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly children: readonly TreeNode[];
  /** True when this node came from `crate.modules` — i.e. an actual
   *  source file the extractor parsed. False for synthesized
   *  intermediates that exist only to bridge gaps in the module path
   *  hierarchy. For Rust this distinction is mostly decorative; the
   *  TS renderer uses it to draw folder vs file icons since TS
   *  module path = file path. */
  readonly isLeaf: boolean;
  /** Display role derived from the module's file shape + children. Drives
   *  the tree label and the folder/file icon. Orthogonal to `isLeaf`: a
   *  `dir` can be either a real module (its own mod.rs/name.rs) or a
   *  synthesized intermediate — `isLeaf` keeps that "real file" bit. */
  readonly fileRole: FileRole;
  /** Source language of the crate this module belongs to. Stamped on
   *  every descendant during tree build so the renderer doesn't have
   *  to walk back to the crate-root to know which language to use.
   *  The workspace root carries `'rust'` as a harmless placeholder
   *  since nothing renders folder/file icons on it. */
  readonly language: Language;
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
  /** Module-level free functions when this node is a synthesized
   *  `function_group`. Kept as `FnFacts` so module functions and type member
   *  functions flow through the same callable-row layout path. Empty for
   *  real types and ghosts. */
  readonly functions: readonly FunctionRowFacts[];
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

export function methodBucketId(typeFullPath: string, bucket: VisibilityBucket): string {
  return `${typeFullPath}::__methods_${bucket}`;
}

export interface FunctionRowFacts {
  readonly fullPath: string;
  readonly fn: FnFacts;
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

  // Crate language is stamped on every descendant of this tree so
  // the renderer doesn't have to walk back to the crate-root to ask.
  // Defaults to 'rust' for older JSON dumps that pre-date the
  // language field (it was added when TS support landed).
  const crateLanguage: Language = crate.language ?? 'rust';

  type Scratch = {
    kind: 'module';
    id: string;
    label: string;
    path: string;
    children: TreeNode[];
    isLeaf: boolean;
    fileRole: FileRole;
    /** Absolute source file from `ModuleFacts.file`. Empty for synthesized
     *  path intermediates that never appeared in `crate.modules`. Used by
     *  the role post-pass (filename → label, parent-file match → inline). */
    file: string;
    language: Language;
  };

  const root: Scratch = {
    kind: 'module',
    id: idForModule(crate.name, ''),
    label: crate.name,
    path: '',
    children: [],
    // The crate-root node represents the package as a whole, not a
    // file — render it as a container.
    isLeaf: false,
    fileRole: 'crate-root',
    file: '',
    language: crateLanguage,
  };
  const byPath = new Map<string, Scratch>([['', root]]);

  // Build the prefix chain for every module path. Synthetic intermediates
  // (not in `crate.modules` themselves) default to folder-style labels since
  // their existence implies they hold submodules. The `isLeaf` flag starts
  // false here; the explicit-modules loop below flips it to true on any
  // path that actually appears in `crate.modules`.
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
      isLeaf: false,
      // Provisional; overwritten by assignFileRoles once the tree (and
      // each node's `file`) is fully built.
      fileRole: 'dir',
      file: '',
      language: crateLanguage,
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
    // Record the backing source file so `assignFileRoles` can derive the
    // label (filename) and detect inline modules (file shared with parent).
    node.file = m.file;
    // This module path appeared in `crate.modules` — mark the node
    // as a real source file (vs. a synthesized intermediate). Drives the
    // "real vs synthesized" distinction independent of fileRole.
    //
    // EXCEPT the crate root (`m.path === ''`): the always-present root
    // entry (lib.rs / index.ts) must NOT flip the root to a leaf — the
    // root represents the package as a whole and stays a container
    // (`isLeaf=false`, set at construction).
    if (m.path !== '') node.isLeaf = true;
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
        functions: [],
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

  // Now that every node carries its `file` and its full child set, derive
  // the display role + label. Must run BEFORE the child sort, which orders
  // sibling modules by their (now final) label.
  assignFileRoles(root, null);

  for (const node of byPath.values()) {
    node.children.sort(compareTreeNodes);
  }

  return root as ModuleNode;
}

/** Mutable view of a module node during the build, before it's frozen into
 *  the readonly `ModuleNode`. Only the fields `assignFileRoles` touches. */
interface MutableModule {
  readonly kind: 'module';
  readonly path: string;
  label: string;
  readonly file: string;
  fileRole: FileRole;
  readonly children: readonly TreeNode[];
}

/** Matches a file path ending in `mod.<ext>` (`.../foo/mod.rs`) — the Rust
 *  directory-module convention. The module name comes from the parent dir,
 *  not the filename, so such modules render as folders named after the dir. */
const MOD_FILE_RE = /(?:^|[/\\])mod\.[^./\\]+$/;

/** Derive each module's display role + label from its backing file and its
 *  children, in one post-order-independent walk. See `FileRole`.
 *
 *  The rule (Rust and TS share it; only Rust produces the inline case):
 *   - crate root → `crate-root`, keep the crate-name label.
 *   - file === parent's file → `inline` (a `mod foo {}` with no file of its
 *     own); label `name (parentfile)` since the bare filename is ambiguous.
 *   - `mod.rs`-backed, OR has child modules (the `name.rs` + `name/` sibling
 *     form), OR a synthesized intermediate → `dir`; bare directory-name label.
 *   - otherwise a single file with no submodules → `leaf-file`; label is the
 *     filename incl. extension.
 *
 *  "Has child modules" is what unifies `foo/mod.rs` and `foo.rs`+`foo/`: both
 *  are directory modules and render identically; only the file Cmd+click
 *  opens differs (handled server-side by id, not by this label). */
function assignFileRoles(node: MutableModule, parent: MutableModule | null): void {
  if (node.path === '') {
    node.fileRole = 'crate-root';
  } else {
    const seg = node.path.split('::').pop() ?? node.path;
    const hasChildModule = node.children.some((c) => c.kind === 'module');
    const base = leafBasename(node.file);
    if (parent !== null && node.file !== '' && node.file === parent.file) {
      node.fileRole = 'inline';
      const parentBase = leafBasename(parent.file);
      node.label = parentBase !== null ? `${seg} (${parentBase})` : seg;
    } else if (MOD_FILE_RE.test(node.file) || hasChildModule) {
      node.fileRole = 'dir';
      node.label = seg;
    } else if (base !== null) {
      node.fileRole = 'leaf-file';
      node.label = base;
    } else {
      // No file and no children — degenerate; treat as a bare container.
      node.fileRole = 'dir';
      node.label = seg;
    }
  }
  for (const child of node.children) {
    if (child.kind === 'module') {
      assignFileRoles(child as unknown as MutableModule, node);
    }
  }
}

/** Synthetic id used as the root of a multi-crate workspace tree. Not a
 *  real Rust path — the renderer skips painting this node and treats each
 *  child crate-root as a top-level module. */
export const WORKSPACE_ROOT_ID = '<workspace>';

/**
 * Build a single tree over all crates in `facts`. Each crate's tree (the
 * one produced by `buildModuleTree`) becomes a child of a virtual workspace
 * root. The workspace root itself is rendered invisibly — its presence is
 * a structural convenience so the rest of the layout/render pipeline
 * (which expects exactly one root) keeps working unchanged. Crate names
 * end up acting as top-level "module" labels in the rendered tree.
 *
 * Crate children are ordered alphabetically by crate name for stable
 * layout across reloads. Topological dep-order would be more meaningful
 * for layered architectures, but it requires a dep graph that the
 * extractor doesn't currently emit — alphabetical keeps determinism
 * without that data.
 */
export function buildWorkspaceTree(facts: Facts, options: BuildOptions = {}): ModuleNode {
  const crateNames = Object.keys(facts.crates).sort();
  const children = crateNames.map((name) => {
    const crate = facts.crates[name];
    if (crate === undefined) throw new Error(`Crate ${name} listed but missing in facts.crates`);
    return buildModuleTree(crate, options);
  });
  return {
    kind: 'module',
    id: WORKSPACE_ROOT_ID,
    label: WORKSPACE_ROOT_ID,
    path: '',
    children,
    // The synthetic workspace root holds crates, not modules from a
    // single source file — render as a container if it were ever
    // rendered (the layout currently skips painting it).
    isLeaf: false,
    fileRole: 'dir',
    // The language field is denormalized down from each crate; the
    // workspace root itself spans multiple languages in a polyglot
    // repo, so picking one would lie. The renderer never reads the
    // workspace root's language, so 'rust' is just a placeholder.
    language: 'rust',
  };
}

/**
 * Build synthetic `TypeNode`s — one per non-empty visibility bucket — to
 * represent the module's free functions. Each pseudo-type carries the
 * original `FnFacts` rows so module functions and type member functions share
 * one callable-row contract in layout/rendering.
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
      fields: [],
      functions: fns.map((fn) => ({ fullPath: `${moduleId}::${fn.name}`, fn })),
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
    if (re.kind !== 'type') continue; // function re-exports are not modeled yet
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
      functions: [],
      methodBuckets: [],
      isGhost: true,
      ghostTarget: re.target_path,
    });
  }
  return out;
}

/** Module paths whose layout is dropped by the default `buildModuleTree`
 *  options. Exported so external consumers (e.g. the rollup walk that
 *  derives `+N -M` badges from raw facts) can apply the same filter and
 *  stay consistent with the rendered tree. */
export function hasTestsSegment(path: string): boolean {
  return path.split('::').includes('tests');
}

/** Module id used as the stable key for the layout's module rows and
 *  as a prefix for function-group pseudo-types. Exported so callers
 *  building rollups outside the layout pipeline can derive the same
 *  id without duplicating the rule. */
export function idForModule(crateName: string, path: string): string {
  return path === '' ? crateName : `${crateName}::${path}`;
}

/** Last `/`-separated segment of an absolute path, returned with its
 *  extension intact (e.g. `band_layout.ts`, `view_state.tsx`). Returns
 *  null for paths that don't have a meaningful basename — used by
 *  `buildModuleTree` to label TS leaf modules from their actual
 *  filename instead of the extension-stripped module path. */
function leafBasename(file: string): string | null {
  if (file === '') return null;
  // Handle both POSIX and Windows separators defensively. Most paths
  // in practice come from `std::path::Path::display` on macOS / Linux
  // so the `/` branch dominates.
  const slash = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  const tail = slash >= 0 ? file.slice(slash + 1) : file;
  return tail === '' ? null : tail;
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
