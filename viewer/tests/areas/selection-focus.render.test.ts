// @vitest-environment jsdom
//
// Tier-1 DOM-binding tests for the `selection-focus` area. These render a
// real `Layout` into a detached <svg> via `renderTree` and assert that the
// selection INDICATORS (type ring, member band) and the navigation identity
// attributes bind to the layout's OWN geometry — the "looks wrong on screen
// but the math is right" half of the feature.
//
// Key oracles (see test-plan/selection-focus.md):
//   • the ring/band are sized to the OBSTACLE BLOCK (boxX/boxY/boxWidth/
//     boxHeight), never the header `d.width` (a header-sized ring clips wide
//     rows — the historical bug);
//   • exactly the selected type-box carries `.selected`;
//   • the member band is inset MARK_VERTICAL_INSET=5px so it stays inside its
//     own row;
//   • every arrow group writes BOTH endpoint-identity attrs the nav layer
//     reads.
//
// Only attributes set synchronously on the d3 enter/merged selection are
// asserted (transforms, rect attrs, data-attrs); opacity tweens never run
// under jsdom.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { LayoutInputs } from '../../src/analysis/layout_model.ts';
import { type Layout, ROW_H } from '../../src/analysis/layout_model.ts';
import { methodBucketId } from '../../src/analysis/module_tree.ts';
import { buildLayout } from '../../src/layout/pipeline.ts';
import { type TreeRenderOptions, renderTree } from '../../src/view/tree.ts';
import type { ZoomLayers } from '../../src/view/zoom.ts';
import { buildInputs, crateFacts, edge, mod, ty } from '../fixtures/builders.ts';
import { smallFixtureInputs } from '../fixtures/small.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';
const measure = (s: string): number => s.length * 7;
const SELECTION_PAD = 4; // tree.ts:1618
const MARK_VERTICAL_INSET = 5; // tree.ts:2081

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

function makeOpts(
  ownership: TreeRenderOptions['ownership'],
  selectedElementId: string | null = null,
  selectedElementKind: TreeRenderOptions['selectedElementKind'] = null,
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
    selectedElementId,
    selectedElementKind,
  };
}

let layout: Layout;

function render(
  selId: string | null,
  selKind: TreeRenderOptions['selectedElementKind'],
): SVGGElement {
  return renderInputs(smallFixtureInputs(SMALL_EXPANDED), selId, selKind);
}

/** Render an arbitrary `LayoutInputs` (so a test can use a fixture whose
 *  obstacle block is strictly wider than the header, or one with a method
 *  bucket expanded) and capture the built layout in the module-global. */
function renderInputs(
  baseInputs: LayoutInputs,
  selId: string | null,
  selKind: TreeRenderOptions['selectedElementKind'],
): SVGGElement {
  document.body.innerHTML = '';
  const inputs = { ...baseInputs, measureText: measure };
  layout = buildLayout(inputs);
  const made = makeLayers();
  renderTree(made.layers, layout, makeOpts(inputs.ownership, selId, selKind));
  return made.zoom;
}

// A type whose field name is wider than its header label but still UNDER the
// long-row split threshold (DEFAULT_LONG_ROW_SPLIT_MIN_WIDTH_PX = 360px under
// `measure = len*7`), so the wide row is MERGED into the obstacle block and
// `boxWidth` is STRICTLY greater than the header `width` (instead of being
// split off into a protrusion, which would leave the block at header width).
// With the small fixture every box is header-width (boxWidth === width), so a
// ring/band sized to `d.width` would look identical and the "not header
// width" guard would be vacuous. This row forces the two strictly apart.
// 30 chars → ~250px measured row width: > header (96), < 360 split threshold.
const WIDE_FIELD = 'wide_field_padded_to_30_chars_';
function wideRowInputs(): LayoutInputs {
  const c = crateFacts('c', [
    mod('', [
      ty('c', '', 'App', [
        { name: WIDE_FIELD, ty_text: 'core::Engine' },
        { name: 'x', ty_text: 'core::Other' },
      ]),
    ]),
    mod('core', [ty('c', 'core', 'Engine'), ty('c', 'core', 'Other')]),
  ]);
  const edges = [
    edge('c::App', 'c::core::Engine', `field ${WIDE_FIELD}`),
    edge('c::App', 'c::core::Other', 'field x'),
  ];
  return buildInputs(c, edges, ['c', 'c::core', 'c::App']);
}

// `App` carries a struct field `store` AND a method `store()` — the exact
// Rust shape (a field and an inherent method sharing a name) that the
// `(id, kind)` selection matcher must disambiguate. The method bucket is
// expanded so the method row is materialised alongside the field row.
function fieldAndMethodSameNameInputs(): LayoutInputs {
  const appType = {
    ...ty('c', '', 'App', [{ name: 'store', ty_text: 'core::Engine' }]),
    methods: [{ name: 'store', visibility: 'pub', self_kind: 'ref' as const }],
  };
  const c = crateFacts('c', [mod('', [appType]), mod('core', [ty('c', 'core', 'Engine')])]);
  const edges = [edge('c::App', 'c::core::Engine', 'field store')];
  return buildInputs(c, edges, ['c', 'c::core', 'c::App', methodBucketId('c::App', 'pub')]);
}

function typeById(id: string): Layout['types'][number] {
  const t = layout.types.find((x) => x.fullPath === id);
  if (t === undefined) throw new Error(`no type ${id} in layout`);
  return t;
}

const num = (el: Element | null, attr: string): number =>
  Number(el?.getAttribute(attr) ?? Number.NaN);

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('SF-T1-13 — selection ring is sized to the obstacle block, not header width', () => {
  it('ring width/height/x/y derive from box* (+/- PAD), not d.width', () => {
    // Select `App`, whose long-field obstacle block is STRICTLY wider than
    // its header label. A ring sized to `d.width` would clip the wide row;
    // sizing to `boxWidth` is what we assert here.
    const zoom = renderInputs(wideRowInputs(), 'c::App', 'type');
    const box = zoom.querySelector('g.type-box.selected');
    expect(box?.getAttribute('data-element-id')).toBe('c::App');
    const ring = box?.querySelector('rect.selection-ring') ?? null;
    expect(ring).not.toBeNull();

    const t = typeById('c::App');
    // The ring is in the type-box's LOCAL frame: the group is translated to
    // (d.x, d.y - ROW_H/2), so the ring's local x = boxX - d.x - PAD, etc.
    const headerTop = t.y - ROW_H / 2;
    expect(num(ring, 'width')).toBeCloseTo(t.boxWidth + SELECTION_PAD * 2, 1);
    expect(num(ring, 'height')).toBeCloseTo(t.boxHeight + SELECTION_PAD * 2, 1);
    expect(num(ring, 'x')).toBeCloseTo(t.boxX - t.x - SELECTION_PAD, 1);
    expect(num(ring, 'y')).toBeCloseTo(t.boxY - headerTop - SELECTION_PAD, 1);

    // Load-bearing guard: the obstacle block is STRICTLY wider than the
    // header here, so a ring sized to `d.width` would be measurably narrower
    // than the block. The ring must cover the wider extent, not the header.
    expect(t.boxWidth).toBeGreaterThan(t.width);
    expect(num(ring, 'width')).toBeGreaterThan(t.width + SELECTION_PAD * 2);
  });
});

describe('SF-T1-14 — exactly the selected type-box carries .selected', () => {
  it('only the matching type id is .selected; siblings are not', () => {
    const zoom = render('c::core::Engine', 'type');
    const selected = Array.from(zoom.querySelectorAll('g.type-box.selected'));
    expect(selected.length).toBe(1);
    expect(selected[0]?.getAttribute('data-element-id')).toBe('c::core::Engine');

    // Every other rendered type-box must be unselected.
    const all = Array.from(zoom.querySelectorAll('g.type-box'));
    expect(all.length).toBeGreaterThan(1);
    for (const b of all) {
      const isEngine = b.getAttribute('data-element-id') === 'c::core::Engine';
      expect(b.classList.contains('selected')).toBe(isEngine);
    }
  });
});

describe('SF-T1-16 — member band vertical inset keeps it inside its own row', () => {
  it('member-bg height === ROW_H - 2*INSET and top offset === +INSET from row top', () => {
    // Select the `engine` field on App (App has fields engine + renderer).
    const zoom = render('c::App::engine', 'field');
    const selectedRow = zoom.querySelector('g.field-row-g.selected-member');
    expect(selectedRow, 'the engine field row is .selected-member').not.toBeNull();

    const band = selectedRow?.querySelector('rect.member-bg') ?? null;
    expect(band).not.toBeNull();
    // Inset top+bottom so the band doesn't bleed into neighbouring rows.
    expect(num(band, 'height')).toBeCloseTo(ROW_H - MARK_VERTICAL_INSET * 2, 1);
  });

  it('lights ONLY the selected field row, not the sibling field', () => {
    const zoom = render('c::App::engine', 'field');
    const lit = Array.from(zoom.querySelectorAll('g.field-row-g.selected-member'));
    // App has exactly one matching field row (engine); renderer must not light.
    expect(lit.length).toBe(1);
  });
});

describe('SF-T1-17 — member band spans the full obstacle width, not the header width', () => {
  it('member-bg width === d.boxWidth and x === boxX - d.x', () => {
    // Select the narrow sibling field `x` on a type whose OTHER field is
    // very long. The band under `x` must still span the full obstacle block
    // (so the highlight reads as the whole box), not the header width.
    const zoom = renderInputs(wideRowInputs(), 'c::App::x', 'field');
    const appBox = zoom.querySelector('g.type-box[data-element-id="c::App"]');
    const band = appBox?.querySelector('g.field-row-g.selected-member rect.member-bg') ?? null;
    expect(band).not.toBeNull();

    const t = typeById('c::App');
    expect(num(band, 'width')).toBeCloseTo(t.boxWidth, 1);
    expect(num(band, 'x')).toBeCloseTo(t.boxX - t.x, 1);
    // Load-bearing guard: the obstacle block is STRICTLY wider than the
    // header, so a band sized to `d.width` would clip the wide sibling row.
    expect(t.boxWidth).toBeGreaterThan(t.width);
    expect(num(band, 'width')).toBeGreaterThan(t.width);
  });
});

describe('SF-T1-15 — member band lights only the row matching (id, kind), not the same-name twin', () => {
  // `App` has a struct field `store` AND a method `store()`. They share the
  // canonical id `c::App::store`; only the row whose KIND matches the
  // selection may light. A name-only matcher would light both — the exact
  // recurring selection bug this guards.
  function selectedKinds(zoom: SVGGElement): string[] {
    return Array.from(zoom.querySelectorAll('g.field-row-g.selected-member')).map(
      (el) => el.getAttribute('data-element-kind') ?? '',
    );
  }

  it('selecting the FIELD lights exactly the field row, not the method row', () => {
    const zoom = renderInputs(fieldAndMethodSameNameInputs(), 'c::App::store', 'field');
    expect(selectedKinds(zoom)).toEqual(['field']);
  });

  it('selecting the METHOD lights exactly the method row, not the field row', () => {
    const zoom = renderInputs(fieldAndMethodSameNameInputs(), 'c::App::store', 'method');
    expect(selectedKinds(zoom)).toEqual(['method']);
  });

  it('both rows are actually present (the fixture is not vacuous)', () => {
    const zoom = renderInputs(fieldAndMethodSameNameInputs(), null, null);
    const kinds = Array.from(zoom.querySelectorAll('g.type-box[data-element-id="c::App"] g.field-row-g'))
      .map((el) => el.getAttribute('data-element-kind') ?? '');
    expect(kinds).toContain('field');
    expect(kinds).toContain('method');
  });
});

describe('SF-T1-26 — arrow groups write both endpoint-identity attrs the nav layer reads', () => {
  it('every g.arrow carries non-empty data-arrow-from AND data-arrow-to', () => {
    const zoom = render(null, null);
    const arrows = Array.from(zoom.querySelectorAll('g.arrow'));
    expect(arrows.length).toBe(layout.arrows.length);
    expect(arrows.length).toBeGreaterThan(0);
    for (const g of arrows) {
      const from = g.getAttribute('data-arrow-from');
      const to = g.getAttribute('data-arrow-to');
      expect(from !== null && from.length > 0, 'data-arrow-from non-empty').toBe(true);
      expect(to !== null && to.length > 0, 'data-arrow-to non-empty').toBe(true);
    }
  });
});

describe('SF-T1-19 / SF-T1-21 — selection-indicator CSS colors (index.html string)', () => {
  // vitest runs from the `viewer/` package root; resolve index.html from
  // there. (`import.meta.url` is not a file URL under the jsdom environment.)
  const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

  it('SF-T1-19: .type-box.selected .selection-ring stroke is purple-500 #a855f7, not #9333ea', () => {
    const m = /\.type-box\.selected\s+\.selection-ring\s*\{([^}]*)\}/.exec(html);
    expect(m, 'selection-ring selected rule present').not.toBeNull();
    const body = m?.[1] ?? '';
    expect(/stroke:\s*#a855f7/i.test(body)).toBe(true);
    // The over-saturated purple-600 must not be the active stroke value.
    expect(/stroke:\s*#9333ea/i.test(body)).toBe(false);
  });

  it('SF-T1-21: code-panel entity-row paints the left bar #a855f7; no full-row #e3edfd bg remains', () => {
    const m = /\.code-panel-line\.entity-row\s*\{([^}]*)\}/.exec(html);
    expect(m, 'entity-row rule present').not.toBeNull();
    expect(/border-left-color:\s*#a855f7/i.test(m?.[1] ?? '')).toBe(true);
    // The old full-row blue background that clashed with diff tints is gone.
    expect(/#e3edfd/i.test(html)).toBe(false);
  });
});
