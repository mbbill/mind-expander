// Directory tree derived from the set of source files we've indexed.
//
// The viewer doesn't have real filesystem access — we only know about
// files referenced by `mod.file` in the extracted facts. That's still
// enough to render a VS Code-style breadcrumb in the code panel: split
// the open file's path into segments and let the user click any
// segment to see what siblings/children live at that depth.
//
// Building the tree at facts-load time lets every later lookup
// (`childrenOf`, `displaySegmentsFor`) be cheap and synchronous.

export interface FileTreeNode {
  /** Basename for display. Root node uses the last segment of
   *  `displayRootPath`, but the title bar typically renders segments
   *  starting one level below the root. */
  readonly name: string;
  /** Absolute path of this entry — for files, the path you'd hand to
   *  `/api/source`; for directories, the parent of `children`. */
  readonly absolutePath: string;
  readonly isFile: boolean;
  readonly children: readonly FileTreeNode[];
}

export interface FileTree {
  readonly root: FileTreeNode;
  /** Display-trim prefix. Display paths in the breadcrumb are derived
   *  by stripping this from each absolute path. Always ends with `/`
   *  (or the platform separator). */
  readonly displayRootPath: string;
  /** Quick lookup: directory absolute path → its node. Files aren't
   *  indexed here since their parent's `children` carries them. */
  readonly directoryByPath: ReadonlyMap<string, FileTreeNode>;
}

export interface DisplaySegment {
  readonly name: string;
  /** Absolute path of this segment, joined from root down to here.
   *  Trailing slash for directories; no trailing slash for files. */
  readonly cumulativePath: string;
  readonly isFile: boolean;
}

/** Build the tree from a list of absolute file paths. Order and
 *  duplicates don't matter — duplicates collapse, and children are
 *  sorted (directories first, then files; both alphabetically). */
export function buildFileTree(filePaths: readonly string[]): FileTree {
  const cleaned = Array.from(new Set(filePaths.filter((p) => p.length > 0))).sort();
  if (cleaned.length === 0) {
    const root: FileTreeNode = {
      name: '',
      absolutePath: '',
      isFile: false,
      children: [],
    };
    return { root, displayRootPath: '', directoryByPath: new Map() };
  }

  const displayRootPath = commonDirectoryPrefix(cleaned);

  // Build by inserting each path one segment at a time.
  const rootChildren: NodeBuilder[] = [];
  const directories = new Map<string, NodeBuilder>();
  for (const filePath of cleaned) {
    const rel = filePath.startsWith(displayRootPath)
      ? filePath.slice(displayRootPath.length)
      : filePath;
    const parts = rel.split('/').filter((p) => p.length > 0);
    let parent: NodeBuilder | { children: NodeBuilder[] } = { children: rootChildren };
    let cumulative = displayRootPath;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part === undefined) continue;
      const isLast = i === parts.length - 1;
      cumulative = cumulative + part + (isLast ? '' : '/');
      let child: NodeBuilder | undefined = parent.children.find((c) => c.name === part);
      if (child === undefined) {
        child = {
          name: part,
          absolutePath: cumulative,
          isFile: isLast,
          children: [],
        };
        parent.children.push(child);
        if (!isLast) directories.set(cumulative, child);
      }
      parent = child;
    }
  }

  const sortChildren = (node: NodeBuilder | { children: NodeBuilder[] }): void => {
    node.children.sort((a, b) => {
      if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
    for (const c of node.children) sortChildren(c);
  };
  sortChildren({ children: rootChildren });

  const root: FileTreeNode = {
    name: basename(displayRootPath) || displayRootPath,
    absolutePath: displayRootPath,
    isFile: false,
    children: rootChildren,
  };
  const directoryByPath = new Map<string, FileTreeNode>();
  directoryByPath.set(displayRootPath, root);
  for (const [path, dir] of directories) directoryByPath.set(path, dir);
  return { root, displayRootPath, directoryByPath };
}

/** Children of the directory at `dirPath`. Returns `[]` when the
 *  directory isn't in the tree (e.g. typo in the absolute path). */
export function childrenOf(
  tree: FileTree,
  dirPath: string,
): readonly FileTreeNode[] {
  const normalized = dirPath.endsWith('/') ? dirPath : `${dirPath}/`;
  return (
    tree.directoryByPath.get(normalized)?.children ??
    tree.directoryByPath.get(dirPath)?.children ??
    []
  );
}

/** Breadcrumb segments for an absolute file path. Output is rooted at
 *  the tree's display root: e.g. with `displayRootPath` =
 *  `/Users/me/workspace/` and `absolutePath` =
 *  `/Users/me/workspace/foo/bar/baz.rs`, the segments are
 *  `[foo/, bar/, baz.rs]`. */
export function displaySegmentsFor(
  tree: FileTree,
  absolutePath: string,
): readonly DisplaySegment[] {
  const rel = absolutePath.startsWith(tree.displayRootPath)
    ? absolutePath.slice(tree.displayRootPath.length)
    : absolutePath;
  const parts = rel.split('/').filter((p) => p.length > 0);
  const out: DisplaySegment[] = [];
  let cumulative = tree.displayRootPath;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === undefined) continue;
    const isLast = i === parts.length - 1;
    cumulative = cumulative + part + (isLast ? '' : '/');
    out.push({ name: part, cumulativePath: cumulative, isFile: isLast });
  }
  return out;
}

interface NodeBuilder {
  name: string;
  absolutePath: string;
  isFile: boolean;
  children: NodeBuilder[];
}

function commonDirectoryPrefix(paths: readonly string[]): string {
  if (paths.length === 0) return '';
  const first = paths[0];
  if (first === undefined) return '';
  let prefix = first;
  for (const p of paths) {
    while (!p.startsWith(prefix)) {
      const lastSep = prefix.lastIndexOf('/', prefix.length - 2);
      if (lastSep < 0) return '/';
      prefix = prefix.slice(0, lastSep + 1);
      if (prefix === '') return '/';
    }
  }
  // Trim back to the last `/` so the prefix ends on a directory
  // boundary. Without this, two paths that share a long filename
  // prefix would otherwise produce a partial-name "directory".
  const lastSep = prefix.lastIndexOf('/');
  if (lastSep < 0) return '';
  return prefix.slice(0, lastSep + 1);
}

function basename(path: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
  const lastSep = trimmed.lastIndexOf('/');
  return lastSep < 0 ? trimmed : trimmed.slice(lastSep + 1);
}
