// @vitest-environment jsdom
//
// Tier-1 DOM-binding tests for the LIVE module column (`renderHtmlModuleTree`)
// and the band-background SVG layer (`renderBandBackgrounds` via `renderTree`).
//
// The pure layout pipeline is covered by the node-env Tier-2 file. This file
// covers the OTHER half: that the renderer faithfully binds a computed Layout
// to the DOM — the "math is right but it renders wrong" bug class for the
// module tree (sticky top/height/z, chevron, data attrs, rollup, indent guide,
// click routing). It mirrors render_binding.test.ts: build a real layout, mount
// it under jsdom, assert the resulting elements/attributes synchronously.
//
// Tier-3 behaviors (scale-with-zoom occlusion, fade tracking real scroll, z-order
// elementFromPoint, scroll-to landing) are deferred — they need a real browser.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeDrift } from '../../src/analysis/drift.ts';
import { ROW_H } from '../../src/analysis/layout_metrics.ts';
import type { Layout, LayoutInputs } from '../../src/analysis/layout_model.ts';
import {
  type TreeNode,
  WORKSPACE_ROOT_ID,
  buildModuleTree,
  buildWorkspaceTree,
} from '../../src/analysis/module_tree.ts';
import { buildOwnershipIndex, computeOwnershipDepth } from '../../src/analysis/ownership.ts';
import type { CrateFacts, Facts, Language, ModuleFacts, TypeFacts } from '../../src/data/schema.ts';
import { buildLayout } from '../../src/layout/pipeline.ts';
import { ViewState } from '../../src/state/view_state.ts';
import { type HtmlModuleTreeOptions, renderHtmlModuleTree } from '../../src/view/html_tree.ts';
import { playTreeFlip, snapshotTreeState } from '../../src/view/html_tree_anim.ts';
import { type TreeRenderOptions, renderTree } from '../../src/view/tree.ts';
import type { ZoomLayers } from '../../src/view/zoom.ts';

const measure = (s: string): number => s.length * 7;
const SVG_NS = 'http://www.w3.org/2000/svg';

// --- fact builders (NEW; do not edit shared fixtures) -----------------------
function ty(
  crate: string,
  modPath: string,
  name: string,
  kind: TypeFacts['kind'] = 'struct',
): TypeFacts {
  const full = modPath === '' ? `${crate}::${name}` : `${crate}::${modPath}::${name}`;
  return { name, full_path: full, kind, visibility: 'pub', fields: [] };
}
function mod(path: string, types: TypeFacts[] = [], file?: string): ModuleFacts {
  return {
    path,
    types,
    file: file ?? (path === '' ? 'src/lib.rs' : `src/${path.replace(/::/g, '/')}.rs`),
    functions: [],
  };
}
function crateOf(name: string, modules: ModuleFacts[], language?: Language): CrateFacts {
  const base = { name, modules: Object.fromEntries(modules.map((m) => [m.path, m])) };
  return language !== undefined ? { ...base, language } : base;
}

function workspaceInputs(facts: Facts, expandedIds: string[]): LayoutInputs {
  const root = buildWorkspaceTree(facts);
  const ownership = buildOwnershipIndex(facts);
  const drift = computeDrift(ownership, collectTypeModule(root));
  const depth = computeOwnershipDepth(ownership, collectIds(root), drift);
  return {
    staticRoot: root,
    ownership,
    depth,
    state: new ViewState(expandedIds),
    drift,
    measureText: measure,
  };
}
function crateInputs(crate: CrateFacts, expandedIds: string[]): LayoutInputs {
  const facts: Facts = { crates: { [crate.name]: crate }, edges: [] };
  const root = buildModuleTree(crate);
  const ownership = buildOwnershipIndex(facts);
  const drift = computeDrift(ownership, collectTypeModule(root));
  const depth = computeOwnershipDepth(ownership, collectIds(root), drift);
  return {
    staticRoot: root,
    ownership,
    depth,
    state: new ViewState(expandedIds),
    drift,
    measureText: measure,
  };
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

// Deep nested rust workspace: crate c with c::a, c::a::b, c::a::b::c so headers
// reach depth 3 (z-index / sticky-top depth assertions need >1 depth).
function deepRustWorkspace(): { facts: Facts; expanded: string[] } {
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
  return { facts, expanded: [WORKSPACE_ROOT_ID, 'c', 'c::a', 'c::a::b', 'c::a::b::c'] };
}

function tsWorkspace(): { facts: Facts; expanded: string[] } {
  const facts: Facts = {
    crates: {
      ts: crateOf(
        'ts',
        [mod(''), mod('a', [], '/s/band_layout.ts'), mod('dir::leaf', [], '/s/dir/leaf.ts')],
        'typescript',
      ),
    },
    edges: [],
  };
  return { facts, expanded: [WORKSPACE_ROOT_ID, 'ts', 'ts::a', 'ts::dir', 'ts::dir::leaf'] };
}

// --- DOM harness ------------------------------------------------------------
interface Mounted {
  readonly container: HTMLElement;
  readonly scrollEl: HTMLElement;
  readonly layout: Layout;
  readonly opts: HtmlModuleTreeOptions;
}

function noopOpts(over: Partial<HtmlModuleTreeOptions> = {}): HtmlModuleTreeOptions {
  const noop = (): void => {};
  return { onToggle: noop, onScrollToModule: noop, onShowCode: noop, ...over };
}

function mount(inputs: LayoutInputs, k = 1, opts: HtmlModuleTreeOptions = noopOpts()): Mounted {
  const layout = buildLayout(inputs);
  const scrollEl = document.createElement('div');
  const container = document.createElement('div');
  scrollEl.appendChild(container);
  document.body.appendChild(scrollEl);
  renderHtmlModuleTree(container, layout, k, scrollEl, opts);
  return { container, scrollEl, layout, opts };
}

function groupById(container: HTMLElement, id: string): HTMLElement {
  const g = container.querySelector<HTMLElement>(`.module-group[data-id="${cssEsc(id)}"]`);
  if (g === null) throw new Error(`no module-group for ${id}`);
  return g;
}
function headerOf(group: HTMLElement): HTMLElement {
  // jsdom's querySelector ignores `:scope >`, so pick the direct child header.
  const h = Array.from(group.children).find((c) => c.classList.contains('module-header')) as
    | HTMLElement
    | undefined;
  if (h === undefined) throw new Error('no header');
  return h;
}
function cssEsc(s: string): string {
  return s.replace(/(["\\])/g, '\\$1');
}
const px = (v: string): number => Number.parseFloat(v.replace('px', ''));

beforeEach(() => {
  document.body.innerHTML = '';
});

// =============================================================================
// Tier 1 — renderHtmlModuleTree binding (MT-H*)
// =============================================================================

describe('renderHtmlModuleTree binding (MT-H)', () => {
  it('MT-H01: one .module-group[data-id] per layout module, no dupes/drops', () => {
    const { facts, expanded } = deepRustWorkspace();
    const { container, layout } = mount(workspaceInputs(facts, expanded));
    const rendered = Array.from(container.querySelectorAll<HTMLElement>('.module-group')).map(
      (g) => g.dataset.id,
    );
    expect(rendered.length).toBe(layout.modules.length);
    expect(new Set(rendered)).toEqual(new Set(layout.modules.map((m) => m.id)));
  });

  it('MT-H02: header top=moduleStickyTopPx, height=ROW_H*k, width=hitWidth*k (scales with k)', () => {
    const { facts, expanded } = deepRustWorkspace();
    const k = 2;
    const { container, layout } = mount(workspaceInputs(facts, expanded), k);
    for (const m of layout.modules) {
      const header = headerOf(groupById(container, m.id));
      expect(px(header.style.top)).toBeCloseTo(m.modDepth * ROW_H * k, 5);
      expect(px(header.style.height)).toBeCloseTo(ROW_H * k, 5);
      expect(px(header.style.width)).toBeCloseTo(m.hitWidth * k, 5);
    }
    // depth-0 crate sits at the viewport top.
    expect(px(headerOf(groupById(container, 'c')).style.top)).toBe(0);
  });

  it('MT-H03: header z-index = 1000 - modDepth (shallower paints on top)', () => {
    const { facts, expanded } = deepRustWorkspace();
    const { container, layout } = mount(workspaceInputs(facts, expanded));
    for (const m of layout.modules) {
      const header = headerOf(groupById(container, m.id));
      expect(header.style.zIndex).toBe(String(1000 - m.modDepth));
    }
    // Concrete: crate (depth 0) z 1000 > c::a::b (depth 2) z 998.
    expect(headerOf(groupById(container, 'c')).style.zIndex).toBe('1000');
    expect(headerOf(groupById(container, 'c::a::b')).style.zIndex).toBe('998');
  });

  it('MT-H04: expanded chevron transform = translateX(2*k) then rotate(90deg); leaf chevron .empty', () => {
    const { facts, expanded } = deepRustWorkspace();
    const k = 2;
    const { container } = mount(workspaceInputs(facts, expanded), k);
    // c::a has children and is expanded.
    const chevron = groupById(container, 'c::a').querySelector<HTMLElement>('.module-chevron');
    expect(chevron?.classList.contains('collapse')).toBe(true);
    const t = chevron?.style.transform ?? '';
    expect(t).toContain(`translateX(${2 * k}px)`);
    expect(t).toContain('rotate(90deg)');
    // translate is written LEFT of rotate so it applies in the post-rotation frame.
    expect(t.indexOf('translateX')).toBeLessThan(t.indexOf('rotate'));
    // c::a::b::c has a type child but is itself a module WITH children (the type),
    // so use the type-less... actually a::b::c has children. Pick a leaf module:
    // none here is childless; assert the empty class via a leaf in a flat crate.
    const flat = mount(crateInputs(crateOf('f', [mod(''), mod('leaf', [])]), ['f', 'f::leaf']));
    const leafChev = groupById(flat.container, 'f::leaf').querySelector<HTMLElement>(
      '.module-chevron',
    );
    expect(leafChev?.classList.contains('empty')).toBe(true);
  });

  it('MT-H05: data-leaf + data-crate-lang set from model (TS real file vs synth dir vs Rust)', () => {
    const { facts, expanded } = tsWorkspace();
    const { container } = mount(workspaceInputs(facts, expanded));
    const real = groupById(container, 'ts::a');
    expect(real.dataset.leaf).toBe('true');
    expect(real.dataset.crateLang).toBe('typescript');
    const synthDir = groupById(container, 'ts::dir');
    expect(synthDir.dataset.leaf).toBe('false');
    expect(synthDir.dataset.crateLang).toBe('typescript');
    // Rust crate rows carry the rust language.
    const rust = deepRustWorkspace();
    const r = mount(workspaceInputs(rust.facts, rust.expanded));
    expect(groupById(r.container, 'c::a').dataset.crateLang).toBe('rust');
  });

  it('MT-H06: indent-guide vars only on expanded-with-children groups', () => {
    const { facts, expanded } = deepRustWorkspace();
    const k = 2;
    const { container } = mount(workspaceInputs(facts, expanded), k);
    const parent = groupById(container, 'c::a'); // expanded + has children
    expect(parent.classList.contains('is-expanded')).toBe(true);
    // --guide-x positions the indent line under the chevron column; it is set
    // once at render and not touched by scroll-visibility, so assert it exactly.
    expect(px(parent.style.getPropertyValue('--guide-x'))).toBeCloseTo(7 * k, 5);
    // --guide-top is set to ROW_H*k+2 at render, then clamped by
    // installScrollVisibility against the sticky stack (Tier-3 owns the exact
    // clamped value, which needs real rects). Here just assert it's present
    // and positive — only expanded-with-children groups get it at all.
    expect(px(parent.style.getPropertyValue('--guide-top'))).toBeGreaterThan(0);

    // A leaf module (no children) gets neither class nor vars.
    const flat = mount(crateInputs(crateOf('f', [mod(''), mod('leaf', [])]), ['f', 'f::leaf']), k);
    const leaf = groupById(flat.container, 'f::leaf');
    expect(leaf.classList.contains('is-expanded')).toBe(false);
    expect(leaf.style.getPropertyValue('--guide-x')).toBe('');
  });

  it('MT-H07: rollup badge renders +N/−M only when non-zero, uses − (U+2212)', () => {
    const { facts, expanded } = deepRustWorkspace();
    const rollupByModule = new Map([
      ['c', { add: 3, del: 0 }],
      ['c::a', { add: 0, del: 0 }],
      ['c::a::b', { add: 2, del: 5 }],
    ]);
    const { container } = mount(workspaceInputs(facts, expanded), 1, noopOpts({ rollupByModule }));
    // Scope to each group's OWN header so a descendant's badge doesn't leak in.
    // (jsdom's querySelector ignores the `:scope >` combinator, so walk the
    // header's direct children instead of relying on a scoped selector.)
    const ownBadge = (id: string): Element | null => {
      const header = headerOf(groupById(container, id));
      return Array.from(header.children).find((c) => c.classList.contains('rollup-badge')) ?? null;
    };
    const cBadge = ownBadge('c');
    expect(cBadge?.querySelector('.rb-add')?.textContent).toBe('+3');
    expect(cBadge?.querySelector('.rb-del')).toBeNull(); // del 0 → no rb-del
    // {0,0} → no badge at all on c::a's own header.
    expect(ownBadge('c::a')).toBeNull();
    // mixed uses the minus sign U+2212, not ASCII hyphen.
    const mixed = ownBadge('c::a::b')?.querySelector('.rb-del');
    expect(mixed?.textContent).toBe('−5');
    expect(mixed?.textContent).not.toBe('-5');
  });

  it('MT-H08: side classes applied for base/head, NOT both', () => {
    const { facts, expanded } = deepRustWorkspace();
    const sideByModule = new Map([
      ['c', 'head' as const],
      ['c::a', 'base' as const],
      ['c::a::b', 'both' as const],
    ]);
    const { container } = mount(workspaceInputs(facts, expanded), 1, noopOpts({ sideByModule }));
    expect(groupById(container, 'c').classList.contains('side-head')).toBe(true);
    expect(groupById(container, 'c::a').classList.contains('side-base')).toBe(true);
    const both = groupById(container, 'c::a::b');
    expect(both.classList.contains('side-both')).toBe(false);
    expect(both.classList.contains('side-base')).toBe(false);
    expect(both.classList.contains('side-head')).toBe(false);
  });

  it('MT-H09: chip text is the model label verbatim (incl. .ts), nothing appended', () => {
    const { facts, expanded } = tsWorkspace();
    const { container, layout } = mount(workspaceInputs(facts, expanded));
    for (const m of layout.modules) {
      const chip = groupById(container, m.id).querySelector('.module-chip');
      expect(chip?.textContent).toBe(m.label);
    }
    // The TS leaf label carries its extension verbatim — renderer adds no .ts.
    expect(groupById(container, 'ts::a').querySelector('.module-chip')?.textContent).toBe(
      'band_layout.ts',
    );
  });

  it('MT-H10: renderer emits no chip background/border/left-bar element', () => {
    const { facts, expanded } = deepRustWorkspace();
    const { container } = mount(workspaceInputs(facts, expanded));
    const chip = groupById(container, 'c').querySelector<HTMLElement>('.module-chip');
    expect(chip).not.toBeNull();
    // No inline background/border painted by the renderer (legibility via halo).
    expect(chip?.style.background).toBe('');
    expect(chip?.style.backgroundColor).toBe('');
    expect(chip?.style.border).toBe('');
    // No dedicated side-bar element inside the header (the old green/frozen bar).
    const header = headerOf(groupById(container, 'c'));
    expect(header.querySelector('.side-bar, .left-bar, .module-bar')).toBeNull();
    // Header children are exactly the chevron + chip (no rollup/side bar here,
    // and crucially no dedicated structural left-bar element). The chevron may
    // carry a state modifier class (expand/collapse), so match base classes.
    const baseClasses = Array.from(header.children).map((c) => c.classList[0]);
    expect(baseClasses).toEqual(['module-chevron', 'module-chip']);
  });
});

// =============================================================================
// Tier 1 — click routing (MT-CLK*)
// =============================================================================

describe('renderHtmlModuleTree click routing (MT-CLK)', () => {
  function clickHeader(header: HTMLElement, init: MouseEventInit = {}): void {
    header.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
  }

  it('MT-CLK01: stuck row → onScrollToModule; un-stuck row → onToggle', () => {
    const { facts, expanded } = deepRustWorkspace();
    const onToggle = vi.fn();
    const onScrollToModule = vi.fn();
    const k = 1;
    const { container, scrollEl, layout } = mount(
      workspaceInputs(facts, expanded),
      k,
      noopOpts({ onToggle, onScrollToModule }),
    );
    const deep = layout.modules.find((m) => m.id === 'c::a::b::c');
    if (deep === undefined) throw new Error('no deep row');
    // naturalTopInContent = clientHeight + m.y*k. Make scrollTop large enough
    // that natural < scrollTop + stickyTop(depth) → STUCK.
    Object.defineProperty(scrollEl, 'clientHeight', { value: 0, configurable: true });
    scrollEl.scrollTop = deep.y * k + 1000; // well past → stuck
    clickHeader(headerOf(groupById(container, deep.id)));
    expect(onScrollToModule).toHaveBeenCalledWith('c::a::b::c');
    expect(onToggle).not.toHaveBeenCalled();

    // Un-stuck: scrollTop below the row's natural top → toggle.
    onScrollToModule.mockClear();
    onToggle.mockClear();
    scrollEl.scrollTop = 0;
    clickHeader(headerOf(groupById(container, deep.id)));
    expect(onToggle).toHaveBeenCalledWith('c::a::b::c');
    expect(onScrollToModule).not.toHaveBeenCalled();
  });

  it('MT-CLK02: cmd/ctrl+click → onShowCode, never toggle/scroll', () => {
    const { facts, expanded } = deepRustWorkspace();
    const onToggle = vi.fn();
    const onScrollToModule = vi.fn();
    const onShowCode = vi.fn();
    const { container } = mount(
      workspaceInputs(facts, expanded),
      1,
      noopOpts({ onToggle, onScrollToModule, onShowCode }),
    );
    const header = headerOf(groupById(container, 'c::a'));
    clickHeader(header, { metaKey: true });
    expect(onShowCode).toHaveBeenCalledWith('c::a');
    clickHeader(header, { ctrlKey: true });
    expect(onShowCode).toHaveBeenCalledTimes(2);
    expect(onToggle).not.toHaveBeenCalled();
    expect(onScrollToModule).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Tier 1 — FLIP animation classification (MT-FLIP*)
// =============================================================================

describe('FLIP animation (MT-FLIP)', () => {
  // jsdom has no Element.animate by default; capture calls with a stub so the
  // classification (which keyframes go to persisting/entering, which ghost
  // groups fade out) can be asserted without a real animation engine.
  function stubAnimate(): Map<HTMLElement, Keyframe[][]> {
    const calls = new Map<HTMLElement, Keyframe[][]>();
    const fake = function (this: HTMLElement, frames: Keyframe[]): Animation {
      const list = calls.get(this) ?? [];
      list.push(frames);
      calls.set(this, list);
      // Minimal Animation surface playTreeFlip touches: addEventListener('finish')
      // and remove on cleanup. No real timing needed under the stub.
      return {
        addEventListener: (): void => {},
        finish: (): void => {},
      } as unknown as Animation;
    };
    // biome-ignore lint/suspicious/noExplicitAny: jsdom stub
    (HTMLElement.prototype as any).animate = fake;
    return calls;
  }

  // jsdom's getBoundingClientRect returns all-zero rects, so a persisting
  // node never has a measurable dx/dy and the FLIP `translate` branch is
  // skipped (Math.abs(dx)<0.5 → continue). We therefore can't positively
  // assert a translate keyframe under jsdom; that needs a real browser
  // (Tier-3). What we CAN assert as a true oracle is the *classification
  // boundary*: an entering live node gets an opacity 0→1 keyframe, a
  // persisting live node does NOT (it must never be misclassified as
  // entering), and exiting nodes fade out only in the ghost.

  it('MT-FLIP01a: entering nodes fade opacity 0→1; persisting node is not misclassified as entering', () => {
    const calls = stubAnimate();
    const inputs = crateInputs(
      crateOf('c', [mod(''), mod('a', [ty('c', 'a', 'X')]), mod('b', [])]),
      ['c'], // crate root expanded? no — start with children collapsed
    );
    const state = inputs.state;
    state.collapse('c'); // ensure c::a / c::b are NOT present initially
    const scrollEl = document.createElement('div');
    const container = document.createElement('div');
    scrollEl.appendChild(container);
    document.body.appendChild(scrollEl);

    // Initial render: only `c` visible (children collapsed).
    renderHtmlModuleTree(container, buildLayout(inputs), 1, scrollEl, noopOpts());
    const snap = snapshotTreeState(container);
    // Expand so c::a / c::b ENTER the live tree.
    state.expand('c');
    renderHtmlModuleTree(container, buildLayout(inputs), 1, scrollEl, noopOpts());
    playTreeFlip(container, snap, { durationMs: 10 });

    const liveA = container.querySelector<HTMLElement>('.module-group[data-id="c::a"]');
    const liveC = container.querySelector<HTMLElement>('.module-group[data-id="c"]');
    if (liveA === null || liveC === null) throw new Error('expected c and c::a live');
    const isOpacityFade = (frames: Keyframe[][]): boolean =>
      frames.some((f) => f[0]?.opacity === 0 && f[1]?.opacity === 1);
    // Entering node `c::a` (id absent from the snapshot) → opacity 0→1.
    expect(isOpacityFade(calls.get(liveA) ?? [])).toBe(true);
    // Persisting node `c` (id present in snapshot) must NOT get an enter fade.
    expect(isOpacityFade(calls.get(liveC) ?? [])).toBe(false);
    // Nothing exited → no ghost mounted.
    expect(scrollEl.querySelector('[data-tree-ghost]')).toBeNull();
  });

  it('MT-FLIP01b: exiting nodes fade out in the ghost; persisting node hidden in the ghost', () => {
    const calls = stubAnimate();
    const inputs = crateInputs(
      crateOf('c', [mod(''), mod('a', [ty('c', 'a', 'X')]), mod('b', [])]),
      ['c', 'c::a', 'c::b'],
    );
    const state = inputs.state;
    const scrollEl = document.createElement('div');
    const container = document.createElement('div');
    scrollEl.appendChild(container);
    document.body.appendChild(scrollEl);

    // Initial render: c, c::a, c::b all visible.
    renderHtmlModuleTree(container, buildLayout(inputs), 1, scrollEl, noopOpts());
    // Snapshot BEFORE mutating, then collapse the crate root so a::/b:: vanish.
    const snap = snapshotTreeState(container);
    state.collapse('c');
    renderHtmlModuleTree(container, buildLayout(inputs), 1, scrollEl, noopOpts());
    playTreeFlip(container, snap, { durationMs: 10 });

    const ghost = scrollEl.querySelector<HTMLElement>('[data-tree-ghost]');
    expect(ghost).not.toBeNull();
    // The ghost as a whole animates opacity 1→0 (exit fade).
    const ghostFrames = calls.get(ghost as HTMLElement) ?? [];
    expect(ghostFrames.some((f) => f[0]?.opacity === 1 && f[1]?.opacity === 0)).toBe(true);
    // Exiting groups are kept visible in the ghost; persisting ones hidden.
    const ghostA = ghost?.querySelector<HTMLElement>('.module-group[data-id="c::a"]');
    expect(ghostA?.style.display).not.toBe('none');
    const ghostC = ghost?.querySelector<HTMLElement>('.module-group[data-id="c"]');
    expect(ghostC?.style.display).toBe('none');
  });

  it('MT-FLIP02: snapshotTreeState removes stale ghosts (no accumulation), clone has no handlers', () => {
    const onToggle = vi.fn();
    const inputs = crateInputs(crateOf('c', [mod(''), mod('a', [])]), ['c', 'c::a']);
    const scrollEl = document.createElement('div');
    const container = document.createElement('div');
    scrollEl.appendChild(container);
    document.body.appendChild(scrollEl);
    renderHtmlModuleTree(container, buildLayout(inputs), 1, scrollEl, noopOpts({ onToggle }));

    // Mount two ghosts back-to-back; the second snapshot must purge the first.
    const s1 = snapshotTreeState(container);
    scrollEl.appendChild(s1.ghost);
    s1.ghost.setAttribute('data-tree-ghost', '1');
    const s2 = snapshotTreeState(container);
    scrollEl.appendChild(s2.ghost);
    const ghosts = scrollEl.querySelectorAll('[data-tree-ghost]');
    expect(ghosts.length).toBe(1);

    // Cloned header has no click handler — clicking it must not invoke onToggle.
    const clonedHeader = s2.ghost.querySelector<HTMLElement>('.module-header');
    clonedHeader?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onToggle).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Tier 1 — renderBandBackgrounds SVG (MT-BG*)
// =============================================================================

function makeLayers(): { layers: ZoomLayers; zoom: SVGGElement; sticky: SVGGElement } {
  const svg = document.createElementNS(SVG_NS, 'svg');
  document.body.appendChild(svg);
  const g = (): SVGGElement => svg.appendChild(document.createElementNS(SVG_NS, 'g'));
  const zoom = g();
  const sticky = g();
  const noop = (): void => {};
  const layers = {
    zoomLayer: zoom,
    frozenLayer: g(),
    stickyLayer: sticky,
    getTransform: () => ({ x: 0, y: 0, k: 1 }),
    translateBy: noop,
    translateByScreen: noop,
    visibleYRange: () => ({ min: 0, max: 1000 }),
    centerOnY: noop,
    panYToTop: noop,
    centerOn: noop,
    panTo: noop,
  } as unknown as ZoomLayers;
  return { layers, zoom, sticky };
}

function svgRenderOpts(ownership: TreeRenderOptions['ownership']): TreeRenderOptions {
  const noop = (): void => {};
  return {
    onToggle: noop,
    onScrollToModule: noop,
    onShowCode: noop,
    onToggleTypeMembers: noop,
    onSelectField: noop,
    onToggleSignature: noop,
    onPickOutgoingCall: noop,
    onPickIncomingCaller: noop,
    onPickOwner: noop,
    onFollowGhost: noop,
    onArrowNavigate: noop,
    specificCallArrowsShown: new Set(),
    selectedFields: new Set(),
    incomingCallTargetsShown: new Set(),
    expandedBucketIds: new Set(),
    selectedArrows: new Set(),
    ownership,
    selectedElementId: null,
    selectedElementKind: null,
  } as unknown as TreeRenderOptions;
}

const COLOR_BAND_BG_CRATE = '#ffffff';

describe('renderBandBackgrounds SVG (MT-BG)', () => {
  // Multi-crate so several depth-0 crate bands exist plus submodules.
  function multiCrateInputsAndLayout(): { inputs: LayoutInputs; layout: Layout } {
    const facts: Facts = {
      crates: {
        a: crateOf('a', [mod('', [ty('a', '', 'A')]), mod('sub', [ty('a', 'sub', 'S')])]),
        b: crateOf('b', [mod('', [ty('b', '', 'B')])]),
        d: crateOf('d', [mod('', [ty('d', '', 'D')])]),
      },
      edges: [],
    };
    const inputs = workspaceInputs(facts, [WORKSPACE_ROOT_ID, 'a', 'a::sub', 'b', 'd']);
    return { inputs, layout: buildLayout(inputs) };
  }

  it('MT-BG01: every modDepth-0 band rect fill = crate white; submodule stripe phase resets per crate', () => {
    const { inputs, layout } = multiCrateInputsAndLayout();
    const { layers, zoom } = makeLayers();
    renderTree(layers, layout, svgRenderOpts(inputs.ownership));
    const fills = zoom.querySelector('g.band-bg-fills');
    const rects = Array.from(fills?.querySelectorAll('rect') ?? []);
    // Map crate-tier (depth 0) module ids → expect a white rect at its y.
    const crateRows = layout.modules.filter((m) => m.modDepth === 0);
    for (const m of crateRows) {
      const rect = rects.find((r) => Number(r.getAttribute('y')) === m.y);
      expect(rect, `crate band rect for ${m.id}`).not.toBeUndefined();
      expect(rect?.getAttribute('fill')).toBe(COLOR_BAND_BG_CRATE);
    }
    // a::sub is the FIRST submodule under crate a → un-tinted (phase reset means
    // the first submodule after a crate is never striped). So no fill rect at
    // a::sub's y.
    const sub = layout.modules.find((m) => m.id === 'a::sub');
    if (sub !== undefined) {
      const subRect = rects.find((r) => Number(r.getAttribute('y')) === sub.y);
      expect(subRect).toBeUndefined();
    }
  });

  it('MT-BG02: divider rects appear ONLY between adjacent crate bands, keyed on lower band id', () => {
    const { inputs, layout } = multiCrateInputsAndLayout();
    const { layers, zoom } = makeLayers();
    renderTree(layers, layout, svgRenderOpts(inputs.ownership));
    const dividers = Array.from(
      zoom.querySelector('g.band-dividers')?.querySelectorAll('rect') ?? [],
    );
    // Count adjacent crate-crate pairs in band order: only b→d (a::sub sits
    // between a and b). Exactly one divider, positioned at d's y.
    let adjacentCratePairs = 0;
    const rows = layout.modules;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i - 1]?.modDepth === 0 && rows[i]?.modDepth === 0) adjacentCratePairs++;
    }
    expect(dividers.length).toBe(adjacentCratePairs);
    expect(dividers.length).toBe(1);
    const d = rows.find((m) => m.id === 'd');
    expect(Number(dividers[0]?.getAttribute('y'))).toBe(d?.y);
  });

  it('MT-BG03: dead SVG module-row path is not rendered by renderTree', () => {
    const { inputs, layout } = multiCrateInputsAndLayout();
    const { layers, zoom, sticky } = makeLayers();
    renderTree(layers, layout, svgRenderOpts(inputs.ownership));
    // The HTML overlay is the sole module-row renderer; the SVG must not paint
    // module rows or a simulated sticky breadcrumb.
    expect(zoom.querySelectorAll('g.module-row').length).toBe(0);
    expect(sticky.querySelectorAll('rect.sticky-bg').length).toBe(0);
    expect(sticky.querySelectorAll('.module-row').length).toBe(0);
  });
});
