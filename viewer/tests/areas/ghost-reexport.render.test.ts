// @vitest-environment jsdom
//
// Tier-1 DOM-binding tests for GROUP J — ghost / re-export ROW rendering &
// affordances in src/view/tree.ts. These render a real `Layout` (built from
// a `pub use` re-export fixture) into a detached <svg> via `renderTree` and
// assert the ghost-specific binding the owning layer (the renderer) is
// responsible for.
//
// Existing coverage NOT duplicated:
//   • selection-focus.spec.ts (Tier-3) — ghost italic marker/label and the
//     real-font click→reveal-arrow flow.
//   • module_tree.test.ts — ghost data synthesis.
//   • ghost-reexport.layout.test.ts (Tier-2) — the violet ARROW geometry.
//
// Oracles owned here:
//   • the expand-hit rect advertises a `pointer` cursor on a ghost (a ghost
//     is clickable even though it has no fields);
//   • hovering a ghost's kind-marker does NOT spawn the owner-count badge
//     (ghosts have no owner set to surface — the badge is real-row only);
//   • a click on the ghost (header expand-hit OR kind-marker) routes to
//     `onFollowGhost(ghostId, ghostTarget)`, never `onToggle`/`onPickOwner`,
//     so a ghost can never be collapsed or owner-picked;
//   • with the debug overlay enabled, hovering a ghost STILL fires the
//     type debug panel (the panel is universal; only the owner badge is
//     suppressed for ghosts).
//
// Only synchronously-bound attributes/handlers are asserted; d3 opacity
// tweens never run under jsdom.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeDrift } from '../../src/analysis/drift.ts';
import type { LayoutInputs } from '../../src/analysis/layout_model.ts';
import type { Layout } from '../../src/analysis/layout_model.ts';
import { type TreeNode, buildModuleTree } from '../../src/analysis/module_tree.ts';
import { buildOwnershipIndex, computeOwnershipDepth } from '../../src/analysis/ownership.ts';
import type { CrateFacts, Facts, ModuleFacts, ReExport, TypeFacts } from '../../src/data/schema.ts';
import { buildLayout } from '../../src/layout/pipeline.ts';
import { ViewState } from '../../src/state/view_state.ts';
import {
  LAYOUT_DEBUG_STORAGE_KEY,
  type TreeRenderOptions,
  renderTree,
} from '../../src/view/tree.ts';
import type { ZoomLayers } from '../../src/view/zoom.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';
const measure = (s: string): number => s.length * 7;

const GHOST = 'c::__re_Engine';
const ENGINE = 'c::inner::Engine';

// ── Fixture: root `pub use inner::Engine` → ghost row at the crate root,
//    canonical `Engine` (with a real owner so the ownership index is
//    non-empty for the REAL row, proving badge-suppression is ghost-specific
//    rather than "no owners anywhere"). ────────────────────────────────────

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

function mod(path: string, types: TypeFacts[] = [], re?: ReExport[]): ModuleFacts {
  const file = path === '' ? 'src/lib.rs' : `src/${path.replace(/::/g, '/')}.rs`;
  const base: ModuleFacts = { path, types, file, functions: [] };
  return re !== undefined ? { ...base, re_exports: re } : base;
}

function ghostFixtureInputs(): LayoutInputs {
  // `App` owns the canonical `inner::Engine` (so Engine has a real owner),
  // and the crate root `pub use`s it (the ghost).
  const crate: CrateFacts = {
    name: 'c',
    modules: Object.fromEntries(
      [
        mod(
          '',
          [ty('c', '', 'App', [{ name: 'engine', ty_text: 'inner::Engine' }])],
          [
            {
              exposed_name: 'Engine',
              target_path: ENGINE,
              kind: 'type',
              visibility: 'pub',
              target_kind: 'struct',
            },
          ],
        ),
        mod('inner', [ty('c', 'inner', 'Engine')]),
      ].map((m) => [m.path, m]),
    ),
  };
  const f: Facts = {
    crates: { c: crate },
    edges: [
      { from: 'c::App', to: ENGINE, kind: 'owns', via: 'struct_field', origin: 'field engine' },
    ],
  };
  const root = buildModuleTree(crate);
  const ownership = buildOwnershipIndex(f);
  const typeModule = new Map<string, string>();
  const collectTypeModule = (n: TreeNode): void => {
    if (n.kind === 'type') typeModule.set(n.fullPath, n.modulePath);
    else for (const c of n.children) collectTypeModule(c);
  };
  collectTypeModule(root);
  const ids: string[] = [];
  const collectIds = (n: TreeNode): void => {
    if (n.kind === 'type') ids.push(n.fullPath);
    else for (const c of n.children) collectIds(c);
  };
  collectIds(root);
  const drift = computeDrift(ownership, typeModule);
  const depth = computeOwnershipDepth(ownership, ids, drift);
  const moduleIds: string[] = [];
  const walkMods = (n: TreeNode): void => {
    if (n.kind === 'module') {
      moduleIds.push(n.id);
      for (const c of n.children) walkMods(c);
    }
  };
  walkMods(root);
  const state = new ViewState(moduleIds);
  return { staticRoot: root, ownership, depth, state, drift, measureText: measure };
}

function makeLayers(): { layers: ZoomLayers; zoom: SVGGElement } {
  const svg = document.createElementNS(SVG_NS, 'svg');
  document.body.appendChild(svg);
  const g = (): SVGGElement => svg.appendChild(document.createElementNS(SVG_NS, 'g'));
  const zoom = g();
  const noop = (): void => {};
  const layers = {
    zoomLayer: zoom,
    frozenLayer: g(),
    stickyLayer: g(),
    getTransform: () => ({ x: 0, y: 0, k: 1 }),
    translateBy: noop,
    translateByScreen: noop,
    visibleYRange: () => ({ min: 0, max: 1000 }),
    centerOnY: noop,
    panYToTop: noop,
    centerOn: noop,
    panTo: noop,
  } as unknown as ZoomLayers;
  return { layers, zoom };
}

interface Calls {
  follow: { ghostId: string; target: string }[];
  toggle: string[];
  toggleMembers: string[];
  pickOwner: string[];
}

function makeOpts(ownership: TreeRenderOptions['ownership'], calls: Calls): TreeRenderOptions {
  const noop = (): void => {};
  return {
    onToggle: (id) => calls.toggle.push(id),
    onScrollToModule: noop,
    onShowCode: noop,
    onToggleTypeMembers: (id) => calls.toggleMembers.push(id),
    onSelectField: noop,
    onToggleSignature: noop,
    onPickOutgoingCall: noop,
    onPickIncomingCaller: noop,
    onPickOwner: (id) => calls.pickOwner.push(id),
    onFollowGhost: (ghostId, target) => calls.follow.push({ ghostId, target }),
    onArrowNavigate: noop,
    specificCallArrowsShown: new Set(),
    selectedFields: new Set(),
    incomingCallTargetsShown: new Set(),
    expandedBucketIds: new Set(),
    selectedArrows: new Set(),
    ownership,
    selectedElementId: null,
    selectedElementKind: null,
  };
}

let layout: Layout;
let calls: Calls;

function renderGhostFixture(): SVGGElement {
  document.body.innerHTML = '';
  const inputs = ghostFixtureInputs();
  layout = buildLayout(inputs);
  calls = { follow: [], toggle: [], toggleMembers: [], pickOwner: [] };
  const made = makeLayers();
  renderTree(made.layers, layout, makeOpts(inputs.ownership, calls));
  return made.zoom;
}

function ghostBox(zoom: SVGGElement): SVGGElement {
  const box = zoom.querySelector(`g.type-box[data-element-id="${GHOST}"]`);
  if (box === null) throw new Error(`ghost box ${GHOST} not rendered`);
  return box as SVGGElement;
}

function realBox(zoom: SVGGElement): SVGGElement {
  const box = zoom.querySelector(`g.type-box[data-element-id="${ENGINE}"]`);
  if (box === null) throw new Error(`real box ${ENGINE} not rendered`);
  return box as SVGGElement;
}

/** Dispatch a plain left click (no meta) on `el`. */
function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

/** Dispatch a mouseenter on `el`. */
function mouseenter(el: Element): void {
  el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
}

/** Minimal in-memory localStorage. This jsdom build doesn't ship a full
 *  Storage; `layoutDebugEnabled()` reads via `localStorage.getItem` inside
 *  a try/catch, so the debug-on test needs a real readable store. */
function installLocalStorage(): void {
  const store = new Map<string, string>();
  const ls: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    removeItem: (k: string) => {
      store.delete(k);
    },
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
  };
  Object.defineProperty(window, 'localStorage', { value: ls, configurable: true });
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true });
}

beforeEach(() => {
  document.body.innerHTML = '';
  installLocalStorage();
});

afterEach(() => {
  document.getElementById('callable-debug')?.remove();
  window.localStorage.clear();
});

describe('GROUP-J-T1 — ghost expand-hit affordance', () => {
  it('advertises a pointer cursor on the ghost expand-hit even though the ghost has no fields', async () => {
    const zoom = renderGhostFixture();
    const ghost = ghostBox(zoom);
    const hit = ghost.querySelector('rect.expand-hit');
    expect(hit).not.toBeNull();
    // tree.ts: cursor = (d.hasFields || d.isGhost) ? 'pointer' : 'default'.
    expect(hit?.getAttribute('cursor')).toBe('pointer');

    // A real fieldless leaf would be 'default' — assert the ghost flag, not
    // a global. The canonical Engine has no fields here, so its expand-hit
    // is the 'default' control case.
    const real = realBox(zoom);
    expect(real.querySelector('rect.expand-hit')?.getAttribute('cursor')).toBe('default');
  });
});

describe('GROUP-J-T1 — ghost click routes to onFollowGhost (never collapse / owner-pick)', () => {
  it('clicking the ghost header expand-hit calls onFollowGhost with (ghostId, target), not onToggle', async () => {
    const zoom = renderGhostFixture();
    const hit = ghostBox(zoom).querySelector('rect.expand-hit');
    expect(hit).not.toBeNull();
    click(hit as Element);

    expect(calls.follow).toEqual([{ ghostId: GHOST, target: ENGINE }]);
    // A ghost must never go through the type-collapse path — that's what
    // "click ghost when expanded does NOT collapse" protects.
    expect(calls.toggle).toEqual([]);
    expect(calls.toggleMembers).toEqual([]);
  });

  it('clicking the ghost kind-marker calls onFollowGhost, not onPickOwner', async () => {
    const zoom = renderGhostFixture();
    const marker = ghostBox(zoom).querySelector('text.kind-marker');
    expect(marker).not.toBeNull();
    click(marker as Element);

    expect(calls.follow).toEqual([{ ghostId: GHOST, target: ENGINE }]);
    expect(calls.pickOwner).toEqual([]);
  });

  it('clicking a REAL type kind-marker calls onPickOwner (control: only ghosts follow)', async () => {
    const zoom = renderGhostFixture();
    const marker = realBox(zoom).querySelector('text.kind-marker');
    click(marker as Element);
    expect(calls.pickOwner).toEqual([ENGINE]);
    expect(calls.follow).toEqual([]);
  });
});

describe('GROUP-J-T1 — ghost kind-marker hover suppresses the owner-count badge', () => {
  it('hovering the ghost marker spawns NO owner-count badge', async () => {
    const zoom = renderGhostFixture();
    const ghost = ghostBox(zoom);
    mouseenter(ghost.querySelector('text.kind-marker') as Element);
    // tree.ts returns early for ghosts before the badge is ever appended.
    expect(ghost.querySelector('text.owner-count-badge')).toBeNull();
  });

  it('hovering a REAL marker DOES spawn the owner-count badge (control)', async () => {
    const zoom = renderGhostFixture();
    const real = realBox(zoom);
    mouseenter(real.querySelector('text.kind-marker') as Element);
    const badge = real.querySelector('text.owner-count-badge');
    expect(badge).not.toBeNull();
    // Engine has exactly one owner (App), so the badge text is "(1)".
    expect(badge?.textContent).toBe('(1)');
  });
});

describe('GROUP-J-T1 — ghost hover still fires the debug panel when enabled', () => {
  it('hovering the ghost marker with debug ON shows the type debug panel (re-export facts)', async () => {
    // Enable the layout debug overlay via the same localStorage key the
    // renderer reads (layoutDebugEnabled()).
    window.localStorage.setItem(LAYOUT_DEBUG_STORAGE_KEY, '1');
    const zoom = renderGhostFixture();
    const ghost = ghostBox(zoom);

    expect(document.getElementById('callable-debug')).toBeNull();
    mouseenter(ghost.querySelector('text.kind-marker') as Element);

    const panel = document.getElementById('callable-debug');
    expect(panel).not.toBeNull();
    // The panel is rendered for the ghost (kicker reads "re-export facts").
    expect(panel?.textContent).toContain('re-export facts');
    // And it is the GHOST's panel (its synthetic path / label), not a stray.
    expect(panel?.textContent).toContain(GHOST);

    // The owner badge stays suppressed even with the panel firing — the two
    // hover effects are independent, and only the badge is ghost-gated.
    expect(ghost.querySelector('text.owner-count-badge')).toBeNull();
  });
});
