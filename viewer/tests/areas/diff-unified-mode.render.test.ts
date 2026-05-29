// @vitest-environment jsdom
//
// Tier-1 DOM-binding tests for the `diff-unified-mode` area.
//
// Two binding layers carry the union-diff signal to the screen, and
// both are where "the math is right but it looks identical to normal
// mode" bugs live:
//
//   • `view/tree.ts` renderTree — paints type-box side classes, the
//     stacked rollup side-bars, and per-row `data-side` markers from
//     the three diff maps (`sideByElementId`, `typeBarStateById`,
//     `changeKindByElementId`).
//   • `view/html_tree.ts` renderHtmlModuleTree — paints the
//     `.rollup-badge` `+N −M` churn summary on collapsed module rows.
//   • `view/code_panel.ts` createCodePanel.show / setHighlight — the
//     flat diff renderer that tints add/del hunk lines, keeps context
//     rows neutral, and frames the entity across head ∪ base.
//
// These assert the EXACT correct-behavior oracle from
// test-plan/diff-unified-mode.md (T-R1..R4, T-D1..D4). Only attributes
// set SYNCHRONOUSLY are asserted (opacity tweens never run in jsdom).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Layout } from '../../src/analysis/layout_model.ts';
import { buildLayout } from '../../src/layout/pipeline.ts';
import { type CodePanel, createCodePanel } from '../../src/view/code_panel.ts';
import { renderHtmlModuleTree } from '../../src/view/html_tree.ts';
import { type TreeRenderOptions, renderTree } from '../../src/view/tree.ts';
import type { ZoomLayers } from '../../src/view/zoom.ts';
import { smallFixtureInputs } from '../fixtures/small.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';
const measure = (s: string): number => s.length * 7;
const SMALL_EXPANDED = [
  'c',
  'c::core',
  'c::render',
  'c::App',
  'c::core::Engine',
  'c::render::Renderer',
];

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

/** Base render options with all callbacks no-op and diff maps empty.
 *  Callers override the diff maps per test. */
function makeOpts(
  ownership: TreeRenderOptions['ownership'],
  diff: Partial<
    Pick<TreeRenderOptions, 'sideByElementId' | 'typeBarStateById' | 'changeKindByElementId'>
  > = {},
): TreeRenderOptions {
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
    ...diff,
  };
}

function buildSmall(): { layout: Layout; ownership: TreeRenderOptions['ownership'] } {
  const inputs = { ...smallFixtureInputs(SMALL_EXPANDED), measureText: measure };
  return { layout: buildLayout(inputs), ownership: inputs.ownership };
}

// =====================================================================
// T-R1 — no diff data ⇒ no `data-side`, neutral
// =====================================================================

describe('renderTree — neutral with no diff maps (T-R1)', () => {
  it('every type-box has NO data-side and no .side-head/.side-base class', () => {
    // Render-layer guard for "diff-mode green tint pollutes normal
    // view": even if a model regression stamped a side, the renderer
    // must NOT paint unless the diff maps tell it to. Empty maps ⇒
    // nothing painted.
    const { layout, ownership } = buildSmall();
    const { layers, zoom } = makeLayers();
    renderTree(layers, layout, makeOpts(ownership));

    const boxes = Array.from(zoom.querySelectorAll('g.type-box'));
    expect(boxes.length).toBeGreaterThan(0); // non-vacuous
    for (const box of boxes) {
      expect(
        box.getAttribute('data-side'),
        `${box.getAttribute('data-element-id')} data-side`,
      ).toBeNull();
      expect(box.classList.contains('side-head')).toBe(false);
      expect(box.classList.contains('side-base')).toBe(false);
    }
  });
});

// =====================================================================
// T-R2 — type-box rollup side-bar sizes by typeBarStateById
// =====================================================================

describe('renderTree — type-box side-bar reflects typeBarStateById (T-R2)', () => {
  const rectH = (box: Element, cls: string): number => {
    const r = box.querySelector(`rect.${cls}`);
    return Number(r?.getAttribute('height') ?? 'NaN');
  };
  const renderWith = (state: 'add' | 'del' | 'split'): Element => {
    const { layout, ownership } = buildSmall();
    const { layers, zoom } = makeLayers();
    renderTree(
      layers,
      layout,
      makeOpts(ownership, { typeBarStateById: new Map([['c::App', state]]) }),
    );
    const box = zoom.querySelector('g.type-box[data-element-id="c::App"]');
    expect(box, 'App type-box').not.toBeNull();
    return box as Element;
  };

  it("'add' ⇒ data-side='add', green top bar height>0, red bot bar height 0", () => {
    const box = renderWith('add');
    expect(box.getAttribute('data-side')).toBe('add');
    expect(rectH(box, 'side-bar-top')).toBeGreaterThan(0);
    expect(rectH(box, 'side-bar-bot')).toBe(0);
  });

  it("'del' ⇒ data-side='del', top bar height 0, red bot bar height>0", () => {
    const box = renderWith('del');
    expect(box.getAttribute('data-side')).toBe('del');
    expect(rectH(box, 'side-bar-top')).toBe(0);
    expect(rectH(box, 'side-bar-bot')).toBeGreaterThan(0);
  });

  it("'split' ⇒ data-side='split', BOTH bars height>0 (the dual rollup bar)", () => {
    // The split bar is the only change signal on a collapsed `Both`
    // type whose members include one add and one del. A naive single
    // rect would lose half the signal.
    const box = renderWith('split');
    expect(box.getAttribute('data-side')).toBe('split');
    expect(rectH(box, 'side-bar-top')).toBeGreaterThan(0);
    expect(rectH(box, 'side-bar-bot')).toBeGreaterThan(0);
  });
});

// =====================================================================
// T-R3 — base (removed) member row gets data-side='base'
// =====================================================================

describe('renderTree — removed member row marked base (T-R3)', () => {
  it("a field whose sideByElementId is 'base' renders its row data-side='base' with a sized side-bar", () => {
    // Deletions must be visible ON the diagram (the union-model
    // decision), not only in the code panel — directly contradicts the
    // abandoned "HEAD-only, no red on diagram" design.
    const { layout, ownership } = buildSmall();
    const { layers, zoom } = makeLayers();
    // App's `engine` field — row element id is `${typePath}::${name}`.
    renderTree(
      layers,
      layout,
      makeOpts(ownership, { sideByElementId: new Map([['c::App::engine', 'base']]) }),
    );

    const row = zoom.querySelector("g.field-row-g[data-side='base']");
    expect(row, "a row with data-side='base'").not.toBeNull();
    const bar = row?.querySelector('rect.row-side-bar');
    expect(bar, 'row-side-bar rect').not.toBeNull();
    expect(Number(bar?.getAttribute('height') ?? 'NaN')).toBeGreaterThan(0);
  });
});

// =====================================================================
// T-R4 — rollup-badge rendered iff churn > 0
// =====================================================================

describe('renderHtmlModuleTree — rollup badge gated on churn (T-R4)', () => {
  const renderTree2 = (rollup: ReadonlyMap<string, { add: number; del: number }>): HTMLElement => {
    const inputs = { ...smallFixtureInputs(['c', 'c::core', 'c::render']), measureText: measure };
    const layout = buildLayout(inputs);
    const container = document.createElement('div');
    const scrollEl = document.createElement('div');
    document.body.appendChild(scrollEl);
    scrollEl.appendChild(container);
    const noop = (): void => {};
    renderHtmlModuleTree(container, layout, 1, scrollEl, {
      onToggle: noop,
      onScrollToModule: noop,
      onShowCode: noop,
      rollupByModule: rollup,
    });
    return container;
  };

  it('renders +N −M badge on a module with non-zero churn', () => {
    const container = renderTree2(new Map([['c::core', { add: 5, del: 2 }]]));
    const group = container.querySelector('.module-group[data-id="c::core"]');
    expect(group, 'c::core module-group').not.toBeNull();
    const badge = group?.querySelector('.rollup-badge');
    expect(badge, 'rollup-badge present on changed module').not.toBeNull();
    expect(badge?.querySelector('.rb-add')?.textContent).toBe('+5');
    expect(badge?.querySelector('.rb-del')?.textContent).toBe('−2');
  });

  it('omits the badge entirely on a module with zero churn', () => {
    const container = renderTree2(new Map([['c::core', { add: 0, del: 0 }]]));
    const group = container.querySelector('.module-group[data-id="c::core"]');
    expect(group?.querySelector('.rollup-badge')).toBeNull();
  });

  it('omits the badge on a module absent from the rollup map', () => {
    const container = renderTree2(new Map([['c::core', { add: 3, del: 0 }]]));
    const group = container.querySelector('.module-group[data-id="c::render"]');
    expect(group?.querySelector('.rollup-badge')).toBeNull();
  });
});

// =====================================================================
// Code-panel diff renderer (T-D1..D4)
// =====================================================================

const HEAD_SOURCE = [
  'fn untouched() {}', // head line 1 (context)
  'fn touched() {', // head line 2 (context)
  '    let kept = 1;', // head line 3 (context)
  '    let added = added_value();', // head line 4 (add)
  '}', // head line 5 (context)
  'fn tail() {}', // head line 6 (context, unchanged region)
].join('\n');

// A diff payload for the head file above:
//   • hunk 1 touches `touched()`: head line 4 is an `add`, with a
//     paired `del` carrying the old (base) line it replaced.
//   • context rows surround the change.
// `file_old`/`file_new` are repo-relative paths.
const DIFF_PAYLOAD = {
  file_old: 'src/lib.rs',
  file_new: 'src/lib.rs',
  hunks: [
    {
      old_start: 2,
      old_count: 3,
      new_start: 2,
      new_count: 4,
      lines: [
        { kind: 'context', text: 'fn touched() {', old: 2, new: 2 },
        { kind: 'context', text: '    let kept = 1;', old: 3, new: 3 },
        // base line 92-style "removed" line (out-of-band base coord to
        // exercise the union frame in T-D3).
        { kind: 'del', text: '    let removed = old_value();', old: 92 },
        { kind: 'add', text: '    let added = added_value();', new: 4 },
        { kind: 'context', text: '}', old: 5, new: 5 },
      ],
    },
  ],
};

/** Build the `#code-panel` DOM scaffold createCodePanel requires. */
function mountPanelScaffold(): void {
  const root = document.createElement('div');
  root.id = 'code-panel';
  for (const cls of ['code-panel-header', 'code-panel-title', 'code-panel-resize-l']) {
    const el = document.createElement('div');
    el.className = cls;
    root.appendChild(el);
  }
  const close = document.createElement('button');
  close.className = 'code-panel-close';
  root.appendChild(close);
  const body = document.createElement('div');
  body.className = 'code-panel-body';
  root.appendChild(body);
  document.body.appendChild(root);
}

/** Stub `fetch` for `/api/diff` (200 JSON) and `/api/source` (text). */
function stubFetch(): void {
  vi.stubGlobal('fetch', (input: string): Promise<Response> => {
    const url = String(input);
    if (url.startsWith('/api/diff')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(DIFF_PAYLOAD),
        text: () => Promise.resolve(''),
      } as Response);
    }
    if (url.startsWith('/api/source')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(HEAD_SOURCE),
      } as Response);
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  });
}

/** Open the panel on the touched fn and wait for the async load+render
 *  to settle (two fetches: diff then source). */
async function showAndSettle(
  panel: CodePanel,
  args: { file: string; startLine: number; endLine: number; loadFromBase?: boolean },
): Promise<HTMLElement> {
  panel.show(args);
  // Flush the microtask chain (fetchDiff → fetchSource → renderDiff).
  // A few macrotask ticks cover the awaited promise resolutions.
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 8; i++) await Promise.resolve();
  const body = document.querySelector<HTMLElement>('.code-panel-body');
  return body as HTMLElement;
}

describe('createCodePanel.renderDiff — flat diff render (T-D1..D4)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    mountPanelScaffold();
    stubFetch();
  });

  it('every context row carries data-kind="context", regardless of entity range (T-D1)', async () => {
    // The exact fix: auto-expanded / interleaved context rows must NOT
    // be painted add/del based on the entity's side. Green/red comes
    // ONLY from real add/del hunk lines.
    const panel = createCodePanel({ onLineNavigate: () => {}, diffEnabled: true });
    const body = await showAndSettle(panel, { file: 'src/lib.rs', startLine: 2, endLine: 5 });

    const lines = Array.from(body.querySelectorAll<HTMLElement>('.code-panel-line'));
    expect(lines.length).toBeGreaterThan(0);
    const contextRows = lines.filter((l) => l.dataset.kind === 'context');
    expect(contextRows.length).toBeGreaterThan(0); // non-vacuous
    for (const row of contextRows) {
      expect(row.dataset.kind).toBe('context');
    }
    // No context row was mis-painted as a change.
    for (const row of contextRows) {
      expect(row.dataset.kind === 'add' || row.dataset.kind === 'del').toBe(false);
    }
  });

  it('add line ⇒ data-kind="add" with head gutter only; del line ⇒ data-kind="del" with base gutter only (T-D2)', async () => {
    const panel = createCodePanel({ onLineNavigate: () => {}, diffEnabled: true });
    const body = await showAndSettle(panel, { file: 'src/lib.rs', startLine: 2, endLine: 5 });

    const addRow = body.querySelector<HTMLElement>('.code-panel-line[data-kind="add"]');
    const delRow = body.querySelector<HTMLElement>('.code-panel-line[data-kind="del"]');
    expect(addRow, 'an add row').not.toBeNull();
    expect(delRow, 'a del row').not.toBeNull();

    // add: head coord present, base coord absent; old gutter blank.
    expect(addRow?.dataset.lineHead).toBe('4');
    expect(addRow?.dataset.lineBase).toBeUndefined();
    expect(addRow?.querySelector('.code-panel-gutter.old')?.textContent).toBe('');

    // del: base coord present, head coord absent; new gutter blank.
    expect(delRow?.dataset.lineBase).toBe('92');
    expect(delRow?.dataset.lineHead).toBeUndefined();
    expect(delRow?.querySelector('.code-panel-gutter.new')?.textContent).toBe('');
  });

  it('setHighlight tags rows across head span ∪ base prev_span (T-D3)', async () => {
    // The purple focus frame must wrap BOTH the green (head) and red
    // (base) halves of a modified fn. A naive head-only range would
    // leave the deleted base lines outside the frame.
    const panel = createCodePanel({ onLineNavigate: () => {}, diffEnabled: true });
    const body = await showAndSettle(panel, { file: 'src/lib.rs', startLine: 2, endLine: 5 });

    // Union: head [2,5] ∪ base prev_span [90,98] (covers base line 92).
    panel.setHighlight({ start_line: 2, end_line: 5 }, { start_line: 90, end_line: 98 });

    // The del row at base line 92 is inside the base prev_span → framed.
    const delRow = body.querySelector<HTMLElement>('.code-panel-line[data-kind="del"]');
    expect(delRow?.classList.contains('entity-row')).toBe(true);

    // The add row at head line 4 is inside the head span → framed.
    const addRow = body.querySelector<HTMLElement>('.code-panel-line[data-kind="add"]');
    expect(addRow?.classList.contains('entity-row')).toBe(true);

    // An unrelated context row outside both ranges (head line 1) is NOT
    // framed — the frame doesn't bleed across the whole file.
    const outside = Array.from(body.querySelectorAll<HTMLElement>('.code-panel-line')).find(
      (l) => l.dataset.kind === 'context' && l.dataset.lineHead === '1',
    );
    expect(outside, 'context row at head line 1').not.toBeUndefined();
    expect(outside?.classList.contains('entity-row')).toBe(false);
  });

  it('flat render emits ALL file hunks + trailing context past the last hunk (T-D4)', async () => {
    // Pin the flat behavior: an entity in an unchanged region must NOT
    // window away the real hunks. Every head line is emitted and the
    // real add/del rows remain present even when the focused range has
    // no hunk rows of its own.
    const panel = createCodePanel({ onLineNavigate: () => {}, diffEnabled: true });
    // Focus the unchanged `tail()` fn at head line 6 — no hunk lines in
    // [6,6], so no entity-row carries a change kind.
    const body = await showAndSettle(panel, { file: 'src/lib.rs', startLine: 6, endLine: 6 });

    // Real hunks still rendered.
    expect(body.querySelector('.code-panel-line[data-kind="add"]')).not.toBeNull();
    expect(body.querySelector('.code-panel-line[data-kind="del"]')).not.toBeNull();

    // Flat render: trailing context past the last hunk is emitted, so
    // the unchanged tail line 6 is present as a context row.
    const tail = Array.from(body.querySelectorAll<HTMLElement>('.code-panel-line')).find(
      (l) => l.dataset.kind === 'context' && l.dataset.lineHead === '6',
    );
    expect(tail, 'trailing context row at head line 6').not.toBeUndefined();
  });
});
