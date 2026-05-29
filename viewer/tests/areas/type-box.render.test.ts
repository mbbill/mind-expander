// @vitest-environment jsdom
//
// Tier-1 DOM-binding regression tests for the `type-box` area.
//
// These cover the UI/rendering layer: that `renderTree` faithfully binds a
// computed `Layout` to the SVG type-box DOM, trusting the layout contract
// (boxX/boxWidth/boxY/boxHeight) rather than re-measuring with getBBox, and
// wiring the kind-marker / side-bar / ghost affordances the plan specifies.
//
// Harness mirrors tests/render_binding.test.ts: a detached <svg> with three
// stub zoom layers, all `TreeRenderOptions` callbacks as no-ops, a fixed
// measurer. Only attributes set SYNCHRONOUSLY on the d3 enter/merge selection
// are asserted (the opacity tweens never run under jsdom).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { computeDrift } from '../../src/analysis/drift.ts';
import { KIND_MARKER_X, ROW_H, TYPE_LABEL_X } from '../../src/analysis/layout_metrics.ts';
import type { LayoutInputs } from '../../src/analysis/layout_model.ts';
import { type TreeNode, buildModuleTree } from '../../src/analysis/module_tree.ts';
import { buildOwnershipIndex, computeOwnershipDepth } from '../../src/analysis/ownership.ts';
import type {
  CrateFacts,
  Edge,
  Facts,
  FnFacts,
  ModuleFacts,
  ReExport,
  TypeFacts,
  TypeKind,
} from '../../src/data/schema.ts';
import { buildLayout } from '../../src/layout/pipeline.ts';
import { ViewState } from '../../src/state/view_state.ts';
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

const TREE_SRC = readFileSync(resolve(process.cwd(), 'src/view/tree.ts'), 'utf8');
// The renderer's type-box expand-hit constant is set to 20 and must sit past
// the kind marker (14). Pinned at the source rather than imported because
// HEADER_HIT_X is module-private to tree.ts.
const HEADER_HIT_X = 20;

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

function makeOpts(
  ownership: TreeRenderOptions['ownership'],
  extra: Partial<TreeRenderOptions> = {},
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
    ...extra,
  };
}

// --- inline fixture construction (kinds / methods / ghosts / diff) -----

function crate(name: string, modules: ModuleFacts[]): CrateFacts {
  return { name, modules: Object.fromEntries(modules.map((m) => [m.path, m])) };
}

function module(
  path: string,
  types: TypeFacts[],
  opts: { functions?: FnFacts[]; reExports?: ReExport[] } = {},
): ModuleFacts {
  const file = path === '' ? 'src/lib.rs' : `src/${path.replace(/::/g, '/')}.rs`;
  return {
    path,
    types,
    file,
    functions: opts.functions ?? [],
    ...(opts.reExports !== undefined ? { re_exports: opts.reExports } : {}),
  };
}

function typeFacts(
  crateName: string,
  modPath: string,
  name: string,
  opts: {
    kind?: TypeKind;
    visibility?: string;
    fields?: { name: string; ty_text: string }[];
    methods?: FnFacts[];
  } = {},
): TypeFacts {
  const full = modPath === '' ? `${crateName}::${name}` : `${crateName}::${modPath}::${name}`;
  return {
    name,
    full_path: full,
    kind: opts.kind ?? 'struct',
    visibility: opts.visibility ?? 'pub',
    fields: (opts.fields ?? []).map((f) => ({ ...f, ownership: 'owned' as const })),
    ...(opts.methods !== undefined ? { methods: opts.methods } : {}),
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

function collectTypeIds(root: TreeNode): string[] {
  const out: string[] = [];
  const walk = (n: TreeNode): void => {
    if (n.kind === 'type') out.push(n.fullPath);
    else for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
}

function inputsFrom(c: CrateFacts, edges: Edge[], expandedIds: string[]): LayoutInputs {
  const f: Facts = { crates: { [c.name]: c }, edges };
  const root = buildModuleTree(c);
  const ownership = buildOwnershipIndex(f);
  const typeModule = collectTypeModule(root);
  const drift = computeDrift(ownership, typeModule);
  const depth = computeOwnershipDepth(ownership, collectTypeIds(root), drift);
  const state = new ViewState(expandedIds);
  return { staticRoot: root, ownership, depth, state, drift };
}

/** Render a layout into a fresh detached SVG and return its zoom <g>. */
function render(
  inputs: LayoutInputs,
  extraOpts: Partial<TreeRenderOptions> = {},
): { zoom: SVGGElement; layout: ReturnType<typeof buildLayout> } {
  document.body.innerHTML = '';
  const full = { ...inputs, measureText: measure };
  const layout = buildLayout(full);
  const made = makeLayers();
  renderTree(made.layers, layout, makeOpts(inputs.ownership, extraOpts));
  return { zoom: made.zoom, layout };
}

function boxFor(zoom: SVGGElement, fullPath: string): SVGGElement | null {
  return zoom.querySelector<SVGGElement>(
    `g.type-box[data-element-id="${fullPath.replace(/(["\\])/g, '\\$1')}"]`,
  );
}

// ======================================================================
// #11 render/selection-ring-trusts-contract
// ======================================================================
describe('selection ring is derived from the layout contract, not getBBox', () => {
  let zoom: SVGGElement;
  let layout: ReturnType<typeof buildLayout>;
  beforeEach(() => {
    const made = render({ ...smallFixtureInputs(SMALL_EXPANDED) });
    zoom = made.zoom;
    layout = made.layout;
  });

  it('ring rect attrs equal boxX/boxY/boxWidth/boxHeight ± SELECTION_PAD', () => {
    const PAD = 4;
    for (const t of layout.types) {
      const box = boxFor(zoom, t.fullPath);
      expect(box, `box ${t.fullPath}`).not.toBeNull();
      const ring = box?.querySelector<SVGRectElement>('rect.selection-ring');
      expect(ring, `ring ${t.fullPath}`).not.toBeNull();
      if (ring === null || ring === undefined) continue;
      const headerTop = t.y - ROW_H / 2;
      expect(Number(ring.getAttribute('x'))).toBeCloseTo(t.boxX - t.x - PAD, 3);
      expect(Number(ring.getAttribute('y'))).toBeCloseTo(t.boxY - headerTop - PAD, 3);
      expect(Number(ring.getAttribute('width'))).toBeCloseTo(t.boxWidth + PAD * 2, 3);
      expect(Number(ring.getAttribute('height'))).toBeCloseTo(t.boxHeight + PAD * 2, 3);
    }
  });

  it('the selection-ring sizing block does not call getBBox', () => {
    // The design-first fix banned the getBBox hack: the ring trusts the
    // obstacle-block contract. Pin that the ring block reads d.boxX/d.boxWidth
    // and that no getBBox sits between the ring select and its height attr.
    const idx = TREE_SRC.indexOf("select<SVGRectElement>('rect.selection-ring')");
    expect(idx).toBeGreaterThan(-1);
    const block = TREE_SRC.slice(idx, idx + 400);
    expect(block).toContain('d.boxX - d.x');
    expect(block).toContain('d.boxWidth');
    expect(block).not.toContain('getBBox');
  });
});

// ======================================================================
// #12 render/kind-marker-owns-pointer-events
// ======================================================================
describe('kind marker owns its pointer events', () => {
  it('exactly one text.kind-marker per type box with pointer-events=all', () => {
    const { zoom, layout } = render({ ...smallFixtureInputs(SMALL_EXPANDED) });
    for (const t of layout.types) {
      const box = boxFor(zoom, t.fullPath);
      const markers = box?.querySelectorAll('text.kind-marker') ?? [];
      expect(markers.length, `markers on ${t.fullPath}`).toBe(1);
      expect(markers[0]?.getAttribute('pointer-events')).toBe('all');
    }
  });

  it('source wires marker click (owner picker / ghost) and hover (debug)', () => {
    const idx = TREE_SRC.indexOf("select<SVGTextElement>('text.kind-marker')");
    expect(idx).toBeGreaterThan(-1);
    const block = TREE_SRC.slice(idx, idx + 800);
    expect(block).toContain(".on('click'");
    expect(block).toContain('onPickOwner');
    expect(block).toContain(".on('mouseenter'");
  });
});

// ======================================================================
// #13 render/expand-hit-clears-marker
// ======================================================================
describe('expand-hit vs kind marker', () => {
  it('HEADER_HIT_X (20) > KIND_MARKER_X (14): the module-row hit starts past the marker', () => {
    expect(HEADER_HIT_X).toBeGreaterThan(KIND_MARKER_X);
    expect(TREE_SRC).toContain('const HEADER_HIT_X = 20;');
    expect(KIND_MARKER_X).toBe(14);
  });

  // The plan's stated oracle (`rect.expand-hit` x === HEADER_HIT_X) describes
  // the MODULE row's hit rect. For the TYPE box, the renderer instead gives
  // the marker its own events via `pointer-events: all` + paint order (the
  // marker is appended AFTER the expand-hit rect). The plan explicitly
  // rejects asserting paint order as the invariant, and the type-box hit
  // rect is NOT offset to HEADER_HIT_X — so this oracle does not apply to the
  // type box. Covered structurally by #12 (marker owns pointer-events).
  it.skip('type-box expand-hit starts past the marker (N/A: type box uses pointer-events, not HEADER_HIT_X offset)', () => {});
});

// ======================================================================
// #14 render/kind-marker-gap-to-label
// ======================================================================
describe('kind marker sits close to the label', () => {
  it('marker center at KIND_MARKER_X, label at TYPE_LABEL_X, anchor=middle, small gap', () => {
    const { zoom, layout } = render({ ...smallFixtureInputs(SMALL_EXPANDED) });
    const first = layout.types[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const box = boxFor(zoom, first.fullPath);
    const marker = box?.querySelector<SVGTextElement>('text.kind-marker');
    const label = box?.querySelector<SVGTextElement>('text.header-label');
    expect(marker).not.toBeNull();
    expect(label).not.toBeNull();
    expect(Number(marker?.getAttribute('x'))).toBe(KIND_MARKER_X);
    expect(marker?.getAttribute('text-anchor')).toBe('middle');
    expect(Number(label?.getAttribute('x'))).toBe(TYPE_LABEL_X);
    // Gap from the marker's right ink (half a ~13px glyph) to the label is
    // small (the "letter too far from name" complaint wanted ~6px, ≤ ~8px).
    const halfGlyph = 13 / 2;
    const gap = TYPE_LABEL_X - (KIND_MARKER_X + halfGlyph);
    expect(gap).toBeLessThanOrEqual(8);
  });
});

// ======================================================================
// #15 geometry/kind-letter-per-typekind (rendered: kindMarker is private)
// ======================================================================
describe('every TypeKind renders its agreed single-letter marker', () => {
  it('struct/enum/union/trait/type_alias/class/interface/function_group → S/E/U/T/A/C/I/F', () => {
    const c = crate('c', [
      module(
        '',
        [
          typeFacts('c', '', 'St', { kind: 'struct' }),
          typeFacts('c', '', 'En', { kind: 'enum' }),
          typeFacts('c', '', 'Un', { kind: 'union' }),
          typeFacts('c', '', 'Tr', { kind: 'trait' }),
          typeFacts('c', '', 'Al', { kind: 'type_alias' }),
          typeFacts('c', '', 'Cl', { kind: 'class' }),
          typeFacts('c', '', 'In', { kind: 'interface' }),
        ],
        // A free function synthesises the function_group pseudo-type ('F').
        { functions: [{ name: 'freeFn', visibility: 'pub', self_kind: 'none' }] },
      ),
    ]);
    const { zoom, layout } = render(inputsFrom(c, [], ['c']));

    const markerByKind = new Map<TypeKind, string>();
    for (const t of layout.types) {
      const box = boxFor(zoom, t.fullPath);
      const marker = box?.querySelector<SVGTextElement>('text.kind-marker');
      const letter = marker?.textContent ?? '';
      markerByKind.set(t.typeKind, letter);
    }

    expect(markerByKind.get('struct')).toBe('S');
    expect(markerByKind.get('enum')).toBe('E');
    expect(markerByKind.get('union')).toBe('U');
    expect(markerByKind.get('trait')).toBe('T');
    expect(markerByKind.get('type_alias')).toBe('A');
    expect(markerByKind.get('class')).toBe('C');
    expect(markerByKind.get('interface')).toBe('I');
    expect(markerByKind.get('function_group')).toBe('F');

    // Exhaustive + distinct: 8 kinds, 8 single uppercase letters, all unique.
    const letters = [...markerByKind.values()];
    expect(letters.length).toBe(8);
    for (const l of letters) expect(l).toMatch(/^[A-Z]$/);
    expect(new Set(letters).size).toBe(8);
  });
});

// ======================================================================
// #28 render/box-binding-no-drop-dup (same-leaf-name collision)
// ======================================================================
describe('one g.type-box per layout type, no drops/dupes under leaf-name collision', () => {
  it('two types with the same leaf name in different modules both render', () => {
    // `Config` exists in both `a` and `b` — a colliding join key would drop
    // one box. Their full paths differ, so the id-set must contain both.
    const c = crate('c', [
      module('a', [typeFacts('c', 'a', 'Config', { fields: [{ name: 'x', ty_text: 'u8' }] })]),
      module('b', [typeFacts('c', 'b', 'Config', { fields: [{ name: 'y', ty_text: 'u8' }] })]),
    ]);
    const { zoom, layout } = render(
      inputsFrom(c, [], ['c', 'c::a', 'c::b', 'c::a::Config', 'c::b::Config']),
    );

    const renderedIds = Array.from(zoom.querySelectorAll('g.type-box'))
      .map((b) => b.getAttribute('data-element-id'))
      .sort();
    const expectedIds = layout.types.map((t) => t.fullPath).sort();
    expect(renderedIds).toEqual(expectedIds);
    expect(renderedIds).toContain('c::a::Config');
    expect(renderedIds).toContain('c::b::Config');
  });
});

// ======================================================================
// #30 render/signature-rows-keyed-by-parent
// ======================================================================
describe('signature rows are keyed by parent function path (no shared-key collision)', () => {
  it('two functions sharing a param name + return row render distinct DOM rows', () => {
    // A function_group with two free functions, both taking `x: u8` and both
    // returning `u8`. A global `kind:name` join key would collapse the
    // shared `x` and `->` rows to one element each; keying by parent path
    // keeps them distinct.
    const fns: FnFacts[] = [
      {
        name: 'alpha',
        visibility: 'pub',
        self_kind: 'none',
        params: [{ name: 'x', ty_text: 'u8' }],
        return_ty_text: 'u8',
      },
      {
        name: 'beta',
        visibility: 'pub',
        self_kind: 'none',
        params: [{ name: 'x', ty_text: 'u8' }],
        return_ty_text: 'u8',
      },
    ];
    const c = crate('c', [module('', [], { functions: fns })]);
    // Expand the crate, the function group, and both signatures.
    const groupId = 'c::__fn_pub';
    const inputs = inputsFrom(c, [], ['c', groupId, 'sig::c::alpha', 'sig::c::beta']);
    const { zoom, layout } = render(inputs);

    // Locate the function_group box.
    const group = layout.types.find((t) => t.typeKind === 'function_group');
    expect(group, 'function_group present').toBeDefined();
    if (group === undefined) return;
    const sigRows = group.fields.filter((r) => r.kind === 'signature_arg');
    // 2 param rows (x) + 2 return rows (->).
    const paramRows = sigRows.filter((r) => r.name === 'x');
    const returnRows = sigRows.filter((r) => r.name === '->');
    expect(paramRows.length).toBe(2);
    expect(returnRows.length).toBe(2);
    // Each carries its own parent function path.
    expect(new Set(paramRows.map((r) => r.functionFullPath))).toEqual(
      new Set(['c::alpha', 'c::beta']),
    );

    // The DOM must materialise all four signature rows as DISTINCT nodes.
    // The renderer keys signature rows by `${kind}:${functionFullPath}:${name}`,
    // so the two `x` rows and two `->` rows don't collapse onto one element —
    // even though their data-element-id (`${typePath}::${name}`) collides.
    const box = boxFor(zoom, group.fullPath);
    const domSigRows = Array.from(
      box?.querySelectorAll('g.field-row-g[data-element-kind="signature_arg"]') ?? [],
    );
    expect(domSigRows.length).toBe(4);
  });
});

// ======================================================================
// #35 render/ghost-type-italic-marker
// ======================================================================
describe('ghost re-export types render italic; real types render normal', () => {
  it('header-label font-style italic on ghost, normal on real', () => {
    const reExports: ReExport[] = [
      {
        exposed_name: 'ReWidget',
        target_path: 'c::inner::Widget',
        visibility: 'pub',
        kind: 'type',
        target_kind: 'struct',
      },
    ];
    const c = crate('c', [
      module('', [typeFacts('c', '', 'Real', { fields: [{ name: 'f', ty_text: 'u8' }] })], {
        reExports,
      }),
      module('inner', [typeFacts('c', 'inner', 'Widget')]),
    ]);
    const { zoom, layout } = render(inputsFrom(c, [], ['c', 'c::inner']));

    const ghost = layout.types.find((t) => t.isGhost);
    const real = layout.types.find((t) => t.fullPath === 'c::Real');
    expect(ghost, 'ghost present').toBeDefined();
    expect(real, 'real present').toBeDefined();
    if (ghost === undefined || real === undefined) return;

    const ghostLabel = boxFor(zoom, ghost.fullPath)?.querySelector('text.header-label');
    const realLabel = boxFor(zoom, real.fullPath)?.querySelector('text.header-label');
    expect(ghostLabel?.getAttribute('font-style')).toBe('italic');
    expect(realLabel?.getAttribute('font-style')).toBe('normal');
  });
});

// ======================================================================
// #18 geometry/side-bar-header-height-only  (rendered rect heights)
// #19 render/side-bar-on-border-not-overlap-ring
// #20 render/no-body-modified-orange-bar
// ======================================================================
describe('union-diff side bar is header-height only, on the border, add/del/split only', () => {
  // Four types, one per bar state, all expanded so boxHeight > ROW_H — proving
  // the bar does NOT follow boxHeight. Plus a `both` (no bar) type.
  function diffFixture() {
    const c = crate('c', [
      module('', [
        typeFacts('c', '', 'Added', {
          fields: [
            { name: 'a', ty_text: 'u8' },
            { name: 'b', ty_text: 'u8' },
          ],
        }),
        typeFacts('c', '', 'Deleted', {
          fields: [
            { name: 'a', ty_text: 'u8' },
            { name: 'b', ty_text: 'u8' },
          ],
        }),
        typeFacts('c', '', 'Split', {
          fields: [
            { name: 'a', ty_text: 'u8' },
            { name: 'b', ty_text: 'u8' },
          ],
        }),
        typeFacts('c', '', 'Unchanged', {
          fields: [
            { name: 'a', ty_text: 'u8' },
            { name: 'b', ty_text: 'u8' },
          ],
        }),
      ]),
    ]);
    const inputs = inputsFrom(c, [], ['c', 'c::Added', 'c::Deleted', 'c::Split', 'c::Unchanged']);
    const typeBarStateById = new Map<string, 'add' | 'del' | 'split'>([
      ['c::Added', 'add'],
      ['c::Deleted', 'del'],
      ['c::Split', 'split'],
      // Unchanged intentionally absent → no bar.
    ]);
    return { inputs, typeBarStateById };
  }

  function barHeights(
    zoom: SVGGElement,
    fullPath: string,
  ): { top: number; bot: number; topX: number; botX: number } {
    const box = boxFor(zoom, fullPath);
    const top = box?.querySelector<SVGRectElement>('rect.side-bar-top');
    const bot = box?.querySelector<SVGRectElement>('rect.side-bar-bot');
    return {
      top: Number(top?.getAttribute('height') ?? 'NaN'),
      bot: Number(bot?.getAttribute('height') ?? 'NaN'),
      topX: Number(top?.getAttribute('x') ?? 'NaN'),
      botX: Number(bot?.getAttribute('x') ?? 'NaN'),
    };
  }

  it('#18: bar heights are header-height only (ROW_H), split sums to ROW_H, none=0', () => {
    const { inputs, typeBarStateById } = diffFixture();
    const { zoom, layout } = render(inputs, { typeBarStateById });

    // Guard: the diff types are expanded so boxHeight > ROW_H — proving the
    // bar is bound to header height, not boxHeight.
    const added = layout.types.find((t) => t.fullPath === 'c::Added');
    expect(added).toBeDefined();
    expect(added?.boxHeight ?? 0).toBeGreaterThan(ROW_H);

    const add = barHeights(zoom, 'c::Added');
    expect(add.top).toBe(ROW_H);
    expect(add.bot).toBe(0);

    const del = barHeights(zoom, 'c::Deleted');
    expect(del.top).toBe(0);
    expect(del.bot).toBe(ROW_H);

    const split = barHeights(zoom, 'c::Split');
    expect(split.top).toBe(Math.round(ROW_H / 2));
    expect(split.bot).toBe(ROW_H - Math.round(ROW_H / 2));
    expect(split.top + split.bot).toBe(ROW_H);

    const none = barHeights(zoom, 'c::Unchanged');
    expect(none.top).toBe(0);
    expect(none.bot).toBe(0);
  });

  it('#19: bar x === boxX - d.x (on the border, right of the selection ring)', () => {
    const { inputs, typeBarStateById } = diffFixture();
    const { zoom, layout } = render(inputs, { typeBarStateById });
    const PAD = 4;
    for (const id of ['c::Added', 'c::Deleted', 'c::Split']) {
      const t = layout.types.find((ty) => ty.fullPath === id);
      expect(t, id).toBeDefined();
      if (t === undefined) continue;
      const { topX, botX } = barHeights(zoom, id);
      const expectedX = t.boxX - t.x;
      expect(topX).toBeCloseTo(expectedX, 3);
      expect(botX).toBeCloseTo(expectedX, 3);
      // Strictly right of the selection ring's left edge (boxX - d.x - PAD).
      expect(topX).toBeGreaterThan(t.boxX - t.x - PAD);
    }
  });

  it('#19 source: bar x is data-driven in the merged/.each pass, not a static -8', () => {
    // Pin that the bar x comes from d.boxX - d.x in the per-element pass,
    // not a hardcoded negative offset in the enter selection.
    expect(TREE_SRC).toContain('const x = d.boxX - d.x;');
    expect(TREE_SRC).not.toContain("'side-bar-top')\n    .attr('x', '-8'");
    expect(TREE_SRC).not.toMatch(/side-bar-top[\s\S]{0,80}?'x',\s*'-8'/);
  });

  it('#20: bar .each handles only add/del/split (else 0); no orange body_modified bar', () => {
    // A `both`/unchanged type with no bar entry must render zero-height bars.
    const { inputs, typeBarStateById } = diffFixture();
    const { zoom } = render(inputs, { typeBarStateById });
    const none = barHeights(zoom, 'c::Unchanged');
    expect(none.top).toBe(0);
    expect(none.bot).toBe(0);

    // Source: the side-bar .each branches only on add/del/split.
    const eachIdx = TREE_SRC.indexOf('const state = opts.typeBarStateById?.get(d.fullPath);');
    expect(eachIdx).toBeGreaterThan(-1);
    const block = TREE_SRC.slice(eachIdx, eachIdx + 2000);
    expect(block).toContain("state === 'add'");
    expect(block).toContain("state === 'del'");
    expect(block).toContain("state === 'split'");
    expect(block).not.toContain("'body_modified'");
    // No orange fill applied to a side bar.
    expect(block).not.toContain('#f59e0b');
    expect(block).not.toContain('orange');
  });
});
