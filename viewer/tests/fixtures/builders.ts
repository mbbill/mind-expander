// Programmatic fact builders for layout2 tests. Mirrors the helpers
// embedded in tests/layout.test.ts (which can't be imported because
// they're scoped to that file). Centralised here so every fixture
// constructs Facts the same way.

import { computeDrift } from '../../src/analysis/drift.ts';
import type { LayoutInputs } from '../../src/analysis/layout_bak.ts';
import { type TreeNode, buildModuleTree } from '../../src/analysis/module_tree.ts';
import { buildOwnershipIndex, computeOwnershipDepth } from '../../src/analysis/ownership.ts';
import type { CrateFacts, Edge, Facts, ModuleFacts, TypeFacts } from '../../src/data/schema.ts';
import { ViewState } from '../../src/state/view_state.ts';

export function ty(
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

export function mod(path: string, types: TypeFacts[] = []): ModuleFacts {
  const file = path === '' ? 'src/lib.rs' : `src/${path.replace(/::/g, '/')}.rs`;
  return { path, types, file, functions: [] };
}

export function crateFacts(name: string, modules: ModuleFacts[]): CrateFacts {
  return { name, modules: Object.fromEntries(modules.map((m) => [m.path, m])) };
}

export function edge(from: string, to: string, origin = 'field x'): Edge {
  return { from, to, kind: 'owns', via: 'struct_field', origin };
}

export function facts(crate: CrateFacts, edges: Edge[]): Facts {
  return { crates: { [crate.name]: crate }, edges };
}

/** Build a `LayoutInputs` from a crate + edges + initially-expanded ids.
 *  Intentionally identical to the setup used in tests/layout.test.ts so
 *  layout2 tests are directly comparable to v1 tests. */
export function buildInputs(crate: CrateFacts, edges: Edge[], expandedIds: string[]): LayoutInputs {
  const f = facts(crate, edges);
  const root = buildModuleTree(crate);
  const ownership = buildOwnershipIndex(f, crate.name);
  const typeModule = collectTypeModule(root);
  const drift = computeDrift(ownership, typeModule);
  const depth = computeOwnershipDepth(ownership, collectIds(root), drift);
  const state = new ViewState(expandedIds);
  return { staticRoot: root, ownership, depth, state, drift };
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
