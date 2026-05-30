// @vitest-environment jsdom
//
// Tier-1 DOM-binding tests for GROUP F — Selection / member interactions.
//
// SCOPE (and how this differs from `selection-focus.render.test.ts`):
//   • That sibling file covers the HOST-PUSHED selection channel
//     (`selectedElementId` / `selectedElementKind`) that the code panel
//     drives: the type ring, `.selected`, and the `.selected-member`
//     band geometry.
//   • THIS file covers the DIAGRAM-OWNED member selection channel
//     (`opts.selectedFields`, keyed by `fieldKey(typePath, name, kind)`)
//     that a click on a field name toggles. The renderer reads that set
//     to BOLD (font-weight 600) the selected member rows and to derive
//     the union of `selectedArrows` highlighted. These are distinct
//     observable bindings, so there is no overlap with the sibling file.
//
// The decisive (id, kind) disambiguation oracle: a struct field `store`
// and an inherent method `store()` share the canonical id `c::App::store`,
// but their `fieldKey`s differ in the KIND segment. Selecting the field
// must bold ONLY the field row; selecting the method must bold ONLY the
// method row. A name-only key would mis-bold both — the recurring
// selection bug this guards.
//
// Only attributes set synchronously on the d3 enter/merged selection are
// asserted (font-weight, classes, `d`); opacity tweens never run under
// jsdom.

import { beforeEach, describe, expect, it } from 'vitest';
import type { LayoutInputs } from '../../src/analysis/layout_model.ts';
import type { Layout } from '../../src/analysis/layout_model.ts';
import { methodBucketId } from '../../src/analysis/module_tree.ts';
import { buildLayout } from '../../src/layout/pipeline.ts';
import {
  type TreeRenderOptions,
  directArrowsFromMany,
  fieldKey,
  renderTree,
} from '../../src/view/tree.ts';
import type { ZoomLayers } from '../../src/view/zoom.ts';
import { buildInputs, crateFacts, mod, ty } from '../fixtures/builders.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';
const measure = (s: string): number => s.length * 7;

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
  over: Partial<TreeRenderOptions> = {},
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
    ...over,
  };
}

// `App` owns Engine + Renderer (two struct fields that emit ownership
// arrows) AND has an inherent method `store()` that COLLIDES with a
// struct field `store`. The method bucket is pre-expanded so both the
// field row and the method row materialise. This single fixture exercises
// every GROUP F member-selection oracle: independent multi-field select,
// (id,kind) disambiguation, and type-vs-member separation.
const APP = 'c::App';
const FIELD_ENGINE = 'engine';
const FIELD_RENDERER = 'renderer';
const COLLIDE = 'store';

function selectionInputs(): LayoutInputs {
  const appType = {
    ...ty('c', '', 'App', [
      { name: FIELD_ENGINE, ty_text: 'core::Engine' },
      { name: FIELD_RENDERER, ty_text: 'core::Renderer' },
      { name: COLLIDE, ty_text: 'core::Store' },
    ]),
    methods: [{ name: COLLIDE, visibility: 'pub', self_kind: 'ref' as const }],
  };
  const c = crateFacts('c', [
    mod('', [appType]),
    mod('core', [ty('c', 'core', 'Engine'), ty('c', 'core', 'Renderer'), ty('c', 'core', 'Store')]),
  ]);
  // Field ownership edges so a member selection has a real arrow to union.
  const edges = [
    {
      from: APP,
      to: 'c::core::Engine',
      kind: 'owns' as const,
      via: 'struct_field' as const,
      origin: `field ${FIELD_ENGINE}`,
    },
    {
      from: APP,
      to: 'c::core::Renderer',
      kind: 'owns' as const,
      via: 'struct_field' as const,
      origin: `field ${FIELD_RENDERER}`,
    },
    {
      from: APP,
      to: 'c::core::Store',
      kind: 'owns' as const,
      via: 'struct_field' as const,
      origin: `field ${COLLIDE}`,
    },
  ];
  return buildInputs(c, edges, ['c', 'c::core', APP, methodBucketId(APP, 'pub')]);
}

let layout: Layout;
let currentLayers: ZoomLayers;
let currentOwnership: TreeRenderOptions['ownership'];

function render(over: Partial<TreeRenderOptions> = {}): SVGGElement {
  document.body.innerHTML = '';
  const inputs = { ...selectionInputs(), measureText: measure };
  layout = buildLayout(inputs);
  currentOwnership = inputs.ownership;
  const made = makeLayers();
  currentLayers = made.layers;
  renderTree(made.layers, layout, makeOpts(inputs.ownership, over));
  return made.zoom;
}

/** Re-render onto the SAME layers + SAME `layout` so arrow OBJECT IDENTITY
 *  is preserved — `selectedArrows.has(a)` is an identity check, so a fresh
 *  `buildLayout` would produce different arrow objects and never match. */
function rerender(zoom: SVGGElement, over: Partial<TreeRenderOptions>): SVGGElement {
  renderTree(currentLayers, layout, makeOpts(currentOwnership, over));
  return zoom;
}

/** The `data-element-kind`s of the SELECTABLE member rows (fields +
 *  methods) inside App's box that render bold (font-weight 600). The
 *  `method_bucket` header is excluded: it is ALWAYS 600 by design (it is a
 *  header, not a selection), so including it would mask the signal we
 *  actually test — which member rows the `selectedFields` set promoted. */
function boldRowKinds(zoom: SVGGElement): string[] {
  const box = zoom.querySelector(`g.type-box[data-element-id="${APP}"]`);
  if (box === null) return [];
  return Array.from(box.querySelectorAll('g.field-row-g'))
    .filter((g) => {
      const kind = g.getAttribute('data-element-kind') ?? '';
      if (kind === 'method_bucket') return false;
      const t = g.querySelector('text.field-row');
      return t?.getAttribute('font-weight') === '600';
    })
    .map((g) => g.getAttribute('data-element-kind') ?? '');
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('the fixture renders both the field and the colliding method row', () => {
  it('App materialises a `store` field row AND a `store` method row', () => {
    const zoom = render();
    const box = zoom.querySelector(`g.type-box[data-element-id="${APP}"]`);
    expect(box).not.toBeNull();
    const rows = Array.from(box?.querySelectorAll('g.field-row-g') ?? []);
    const fieldRow = rows.find(
      (g) =>
        g.getAttribute('data-element-kind') === 'field' &&
        g.getAttribute('data-element-id') === `${APP}::${COLLIDE}`,
    );
    const methodRow = rows.find(
      (g) =>
        g.getAttribute('data-element-kind') === 'method' &&
        g.getAttribute('data-element-id') === `${APP}::${COLLIDE}`,
    );
    // Both rows share the canonical id but differ in kind — the exact
    // collision the (id,kind) matcher must keep apart.
    expect(fieldRow, 'field `store` row present').not.toBeUndefined();
    expect(methodRow, 'method `store()` row present').not.toBeUndefined();
  });
});

describe('selectedFields drives font-weight=600 on exactly the selected member row', () => {
  it('no selection → no member row is bold (method-bucket header excluded)', () => {
    const zoom = render({ selectedFields: new Set() });
    // The bucket header is ALWAYS 600 (it is a header, not a selection),
    // so assert no *member* (field/method) row is bold.
    expect(boldRowKinds(zoom)).toEqual([]);
  });

  it('selecting the `engine` field bolds only that field row', () => {
    const zoom = render({
      selectedFields: new Set([fieldKey(APP, FIELD_ENGINE, 'field')]),
    });
    const engineRow = zoom.querySelector(
      `g.field-row-g[data-element-id="${APP}::${FIELD_ENGINE}"] text.field-row`,
    );
    const rendererRow = zoom.querySelector(
      `g.field-row-g[data-element-id="${APP}::${FIELD_RENDERER}"] text.field-row`,
    );
    expect(engineRow?.getAttribute('font-weight')).toBe('600');
    expect(rendererRow?.getAttribute('font-weight')).toBe('400');
    expect(boldRowKinds(zoom)).toEqual(['field']);
  });
});

describe('(id, kind) disambiguation in the selectedFields keyspace', () => {
  it('selecting the FIELD `store` bolds the field row, never the method `store()`', () => {
    const zoom = render({
      selectedFields: new Set([fieldKey(APP, COLLIDE, 'field')]),
    });
    const fieldText = zoom.querySelector(
      `g.field-row-g[data-element-kind="field"][data-element-id="${APP}::${COLLIDE}"] text.field-row`,
    );
    const methodText = zoom.querySelector(
      `g.field-row-g[data-element-kind="method"][data-element-id="${APP}::${COLLIDE}"] text.field-row`,
    );
    expect(fieldText?.getAttribute('font-weight')).toBe('600');
    expect(methodText?.getAttribute('font-weight')).toBe('400');
    expect(boldRowKinds(zoom)).toEqual(['field']);
  });

  it('selecting the METHOD `store()` bolds the method row, never the field `store`', () => {
    const zoom = render({
      selectedFields: new Set([fieldKey(APP, COLLIDE, 'method')]),
    });
    const fieldText = zoom.querySelector(
      `g.field-row-g[data-element-kind="field"][data-element-id="${APP}::${COLLIDE}"] text.field-row`,
    );
    const methodText = zoom.querySelector(
      `g.field-row-g[data-element-kind="method"][data-element-id="${APP}::${COLLIDE}"] text.field-row`,
    );
    expect(methodText?.getAttribute('font-weight')).toBe('600');
    expect(fieldText?.getAttribute('font-weight')).toBe('400');
    expect(boldRowKinds(zoom)).toEqual(['method']);
  });
});

describe('multiple selected fields each bold independently (union)', () => {
  it('two selected fields on the same type both render bold', () => {
    const zoom = render({
      selectedFields: new Set([
        fieldKey(APP, FIELD_ENGINE, 'field'),
        fieldKey(APP, FIELD_RENDERER, 'field'),
      ]),
    });
    const engineW = zoom
      .querySelector(`g.field-row-g[data-element-id="${APP}::${FIELD_ENGINE}"] text.field-row`)
      ?.getAttribute('font-weight');
    const rendererW = zoom
      .querySelector(`g.field-row-g[data-element-id="${APP}::${FIELD_RENDERER}"] text.field-row`)
      ?.getAttribute('font-weight');
    expect(engineW).toBe('600');
    expect(rendererW).toBe('600');
    // The unrelated `store` field stays regular.
    const storeW = zoom
      .querySelector(
        `g.field-row-g[data-element-kind="field"][data-element-id="${APP}::${COLLIDE}"] text.field-row`,
      )
      ?.getAttribute('font-weight');
    expect(storeW).toBe('400');
  });
});

describe('type selection (selectedElementId/kind=type) is separate from member selection', () => {
  it('selecting App as a TYPE lights its ring but bolds NO member row', () => {
    const zoom = render({ selectedElementId: APP, selectedElementKind: 'type' });
    // The type-box carries `.selected` (host-pushed channel).
    const box = zoom.querySelector(`g.type-box[data-element-id="${APP}"]`);
    expect(box?.classList.contains('selected')).toBe(true);
    // But no individual member row is bolded — `selectedFields` is empty
    // and a type-kind host selection must not promote any row.
    expect(boldRowKinds(zoom)).toEqual([]);
    // …and no row carries `.selected-member` either.
    expect(zoom.querySelectorAll('g.field-row-g.selected-member').length).toBe(0);
  });

  it('a member selection and a type selection can coexist without conflict', () => {
    const zoom = render({
      selectedElementId: APP,
      selectedElementKind: 'type',
      selectedFields: new Set([fieldKey(APP, FIELD_ENGINE, 'field')]),
    });
    const box = zoom.querySelector(`g.type-box[data-element-id="${APP}"]`);
    // Ring is from the host-pushed type selection.
    expect(box?.classList.contains('selected')).toBe(true);
    // Bold is from the diagram-owned field selection — only the engine row.
    expect(boldRowKinds(zoom)).toEqual(['field']);
  });
});

describe('directArrowsFromMany unions the direct arrows of selected fields by (id,kind)', () => {
  it('a single selected field resolves exactly its own ownership arrow', () => {
    render();
    const arrows = directArrowsFromMany(layout, [
      { typePath: APP, fieldName: FIELD_ENGINE, kind: 'field' },
    ]);
    const tos = [...arrows].map((a) => a.toTypeId);
    expect(tos).toEqual(['c::core::Engine']);
  });

  it('two selected fields union to both of their distinct arrows', () => {
    render();
    const arrows = directArrowsFromMany(layout, [
      { typePath: APP, fieldName: FIELD_ENGINE, kind: 'field' },
      { typePath: APP, fieldName: FIELD_RENDERER, kind: 'field' },
    ]);
    const tos = [...arrows].map((a) => a.toTypeId).sort();
    expect(tos).toEqual(['c::core::Engine', 'c::core::Renderer']);
  });

  it('selecting the FIELD `store` resolves the field arrow, not a method-kind arrow', () => {
    render();
    // The field arrow exists (struct_field origin); a method-kind lookup
    // for the same name must NOT pick it up.
    const fieldArrows = directArrowsFromMany(layout, [
      { typePath: APP, fieldName: COLLIDE, kind: 'field' },
    ]);
    expect([...fieldArrows].map((a) => a.toTypeId)).toEqual(['c::core::Store']);
    const methodArrows = directArrowsFromMany(layout, [
      { typePath: APP, fieldName: COLLIDE, kind: 'method' },
    ]);
    // The method has no outgoing ownership arrow, so the (id,kind) match
    // returns the empty set rather than borrowing the field's arrow.
    expect(methodArrows.size).toBe(0);
  });
});

describe('selectedArrows binding paints .highlighted on exactly the unioned arrows', () => {
  it('renders highlighted on the selected field arrow and nothing else', () => {
    // Render once, resolve the arrow set against THAT layout, then re-render
    // onto the same layout (preserving arrow object identity) with the set
    // as `selectedArrows` — mirrors how main.ts feeds the union back through
    // TreeRenderOptions.
    const zoom = render();
    const selectedArrows = directArrowsFromMany(layout, [
      { typePath: APP, fieldName: FIELD_ENGINE, kind: 'field' },
    ]);
    rerender(zoom, { selectedArrows });
    const highlighted = Array.from(zoom.querySelectorAll('g.arrow path.visible.highlighted'));
    // Exactly one arrow is highlighted, and it targets Engine.
    expect(highlighted.length).toBe(1);
    const to = highlighted[0]?.closest('g.arrow')?.getAttribute('data-arrow-to');
    expect(to).toBe('c::core::Engine');
  });
});
