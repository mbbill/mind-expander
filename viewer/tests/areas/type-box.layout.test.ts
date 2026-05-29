// Tier-2 layout/model invariants for the `type-box` area.
//
// Pure, node-env tests over the analysis + layout layers that OWN type-box
// geometry and member classification, asserting the precise correct-behavior
// oracle from test-plan/type-box.md. These are the layers where the bug
// actually lives — the renderer must trust the contract these produce.
//
//   - borrow flavor classification (data/model: borrow_flavor.ts).
//   - drift-dot left-port clearance, first-row y offset, locality-glyph
//     width reservation, bold bucket-header width, selection-block extent,
//     column stride, global x-start (analysis/logic: geometry.ts via the
//     public computeGeometry / buildLayout output).
//   - bucket-label TS-vs-Rust wording, TS-method-no-self-row, self-row
//     placement (analysis/logic, observed through method_bucket / signature
//     rows in the layout output).
//   - positive box size across all type kinds (cross-cutting golden invariant).
//   - source/CSS pins for the borrow-shared color regression and the red
//     removed-text / chip halo CSS (UI/rendering constants pinned at their
//     definition site, since the regression was a constant value).
//
// Geometry helpers (buildRowSpecs/positionRows/bucketHeaderText/…) are not
// exported, so each test reaches them through the public producers:
// `computeGeometry` (PositionedType.visibleRows + globalXStart/columnStride)
// and `buildLayout` (TypeBox.boxX/boxWidth + FieldRow rows).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { borrowFlavor } from '../../src/analysis/borrow_flavor.ts';
import { buildFunctionCallIndex } from '../../src/analysis/calls.ts';
import { computeDrift } from '../../src/analysis/drift.ts';
import {
  DRIFT_DOT_OFFSET,
  DRIFT_DOT_PORT_GAP,
  DRIFT_DOT_RADIUS,
  FIELD_ROW_H,
  KIND_MARKER_X,
  MIN_TYPE_BOX_W,
  ROW_H,
  TYPE_X_GAP,
  measureTypeHeaderMetrics,
} from '../../src/analysis/layout_metrics.ts';
import type { LayoutInputs } from '../../src/analysis/layout_model.ts';
import { type TreeNode, buildModuleTree } from '../../src/analysis/module_tree.ts';
import { buildOwnershipIndex, computeOwnershipDepth } from '../../src/analysis/ownership.ts';
import { methodId } from '../../src/data/ids.ts';
import type {
  CrateFacts,
  Edge,
  Facts,
  FnFacts,
  ModuleFacts,
  TypeFacts,
  TypeKind,
} from '../../src/data/schema.ts';
import { computeGeometry } from '../../src/layout/geometry.ts';
import { buildLayout } from '../../src/layout/pipeline.ts';
import { ViewState } from '../../src/state/view_state.ts';
import { smallFixtureInputs } from '../fixtures/small.ts';

// Fixed-width measurer so geometry is deterministic and independent of real
// font metrics (those belong to the Tier-3 browser tests). Matches the
// convention in golden_layout.test.ts / render_binding.test.ts.
const measure = (s: string): number => s.length * 7;
const EPS = 0.5;

// --- inline fixture construction --------------------------------------
//
// The shared builders only emit plain `struct` types with owned fields and
// no methods. type-box tests need kinds, methods (with self_kind/visibility/
// params/return), drift, and a calls index — so they build TypeFacts/FnFacts
// literally here and run them through the same index pipeline buildInputs uses.

function crate(name: string, modules: ModuleFacts[]): CrateFacts {
  return { name, modules: Object.fromEntries(modules.map((m) => [m.path, m])) };
}

function module(path: string, types: TypeFacts[], functions: FnFacts[] = []): ModuleFacts {
  const file = path === '' ? 'src/lib.rs' : `src/${path.replace(/::/g, '/')}.rs`;
  return { path, types, file, functions };
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

/** Build LayoutInputs from raw facts + expanded ids. Mirrors the shared
 *  `buildInputs` pipeline so the same indexes back the geometry. */
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

function method(
  name: string,
  opts: {
    visibility?: string;
    self_kind?: FnFacts['self_kind'];
    params?: { name: string; ty_text: string }[];
    return_ty_text?: string;
  } = {},
): FnFacts {
  return {
    name,
    visibility: opts.visibility ?? 'pub',
    ...(opts.self_kind !== undefined ? { self_kind: opts.self_kind } : {}),
    ...(opts.params !== undefined ? { params: opts.params } : {}),
    ...(opts.return_ty_text !== undefined ? { return_ty_text: opts.return_ty_text } : {}),
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
    fields: (opts.fields ?? []).map((fld) => ({ ...fld, ownership: 'owned' as const })),
    ...(opts.methods !== undefined ? { methods: opts.methods } : {}),
  };
}

function geometryFor(inputs: LayoutInputs) {
  return computeGeometry({ ...inputs, measureText: measure });
}

function layoutFor(inputs: LayoutInputs, measureBoldText?: (s: string) => number) {
  return buildLayout({
    ...inputs,
    measureText: measure,
    ...(measureBoldText !== undefined ? { measureBoldText } : {}),
  });
}

const TREE_SRC = readFileSync(new URL('../../src/view/tree.ts', import.meta.url), 'utf8');
const INDEX_HTML = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

// CSS comments inside rule bodies can contain `}` (e.g. a comment quoting
// `#tree text { stroke: white }`), which would prematurely terminate a
// naive `[^}]*` body match. Strip comments first so the rule body is intact.
const INDEX_HTML_NO_COMMENTS = INDEX_HTML.replace(/\/\*[\s\S]*?\*\//g, '');

/** Extract a CSS rule body by selector. Returns '' when the selector is
 *  absent. Operates on comment-stripped CSS so rule bodies are intact. */
function cssRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(INDEX_HTML_NO_COMMENTS);
  return match?.[1] ?? '';
}

// ======================================================================
// #1 borrow-flavor/raw-nested-and-boundary
// ======================================================================
describe('borrow flavor: raw pointers, nested wrappers, keyword boundary', () => {
  // Only the TOP-LEVEL outermost type drives the flavor. A flattening
  // classifier (or a substring `*mut` match) produces noise.
  it.each([
    ['*const T', 'raw'],
    ['*mut T', 'raw'],
    ['  *mut T', 'raw'], // leading whitespace from the extractor still classifies
    ['Vec<&T>', 'move'], // nested borrow inside an owned wrapper is a move
    ['Vec<*mut T>', 'move'], // nested raw pointer is still an owned wrapper
    ['Box<*const u8>', 'move'],
    ['*constant', 'move'], // word-boundary: `*constant` is not the `const` keyword
    ['*mutability', 'move'], // word-boundary: `*mutability` is not the `mut` keyword
  ] as const)('borrowFlavor(%j) === %j', (input, expected) => {
    expect(borrowFlavor(input)).toBe(expected);
  });
});

// ======================================================================
// #2 borrow-flavor/shared-distinct-from-move (+ #3 member-color pin)
// ======================================================================
describe('borrow flavor colors are perceptually distinct categories', () => {
  // The four flavor colors are pinned at their definition site in tree.ts
  // (the constants are not exported). The shared regression was a CONSTANT
  // value (slate-600 #475569, a mere lightness shift of the default name
  // color), so we pin the fixed orange value and prove it is in the orange
  // family by channel decomposition — not just "shared !== default", which
  // the buggy slate-600 would also satisfy.
  const COLORS = {
    move: '#64748b',
    shared: '#c2410c',
    mut: '#7c3aed',
    raw: '#dc2626',
  } as const;

  it('pins all four flavor color constants in tree.ts', () => {
    expect(TREE_SRC).toContain("COLOR_BORROW_SHARED = '#c2410c'");
    expect(TREE_SRC).toContain("COLOR_BORROW_MUT = '#7c3aed'");
    expect(TREE_SRC).toContain("COLOR_BORROW_RAW = '#dc2626'");
    // move reuses the neutral default name color rather than a literal hex.
    expect(TREE_SRC).toContain('COLOR_BORROW_MOVE = COLOR_FIELD_TY');
    expect(TREE_SRC).toContain("COLOR_FIELD_TY = '#64748b'");
  });

  it('all four flavor colors are pairwise distinct', () => {
    const values = Object.values(COLORS);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });

  it('shared differs from the default field-name color by HUE, not lightness', () => {
    // Default field-name color (#334155, slate-700). The OLD buggy shared
    // value (#475569, slate-600) was a pure lightness shift of this — same
    // hue family — so asserting only "shared !== default" would pass for the
    // bug. Require shared to be in the orange family: R > G > B and a large
    // R-B spread, encoding "distinct category, not slightly different text".
    const [r, g, b] = hexChannels(COLORS.shared);
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
    expect(r - b).toBeGreaterThan(120);

    // The old slate-600 bug value must NOT appear as the shared constant.
    expect(TREE_SRC).not.toContain("COLOR_BORROW_SHARED = '#475569'");
  });

  // #3: the renderer wires shared → orange (#c2410c), never slate-600.
  it('renderer resolves shared to orange via borrowFlavorColor, never slate-600', () => {
    expect(TREE_SRC).toContain('#c2410c');
    // The regression was the shared CONSTANT being slate-600; pin the
    // negative at the definition site rather than a blanket hex search
    // (slate-600 may legitimately appear elsewhere in the renderer).
    expect(TREE_SRC).not.toContain("COLOR_BORROW_SHARED = '#475569'");
    expect(TREE_SRC).toContain('borrowFlavorColor');
  });
});

function hexChannels(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    Number.parseInt(h.slice(0, 2), 16),
    Number.parseInt(h.slice(2, 4), 16),
    Number.parseInt(h.slice(4, 6), 16),
  ];
}

// ======================================================================
// #5 render/drift-dot-radius-offset (constants)
// ======================================================================
describe('drift dot is small and close to the name (pinned constants)', () => {
  it('DRIFT_DOT_RADIUS === 2.5 and DRIFT_DOT_OFFSET === 7', () => {
    expect(DRIFT_DOT_RADIUS).toBe(2.5);
    expect(DRIFT_DOT_OFFSET).toBe(7);
  });
});

// ======================================================================
// #4 geometry/drift-dot-port-clears-dot
// ======================================================================
describe('drift dot: only drifted field rows shift leftPortX past the dot', () => {
  // Owner lives in a submodule and owns Target which lives at the crate
  // root. Target's only owner is in `sub`, so its owners' LCA = `sub`;
  // Target's own module ('') is an ANCESTOR of the LCA → drift_above. The
  // owner's field row therefore carries a non-canonical memberDriftClass
  // and paints a dot, so its leftPortX is pushed past the dot. A canonical
  // field (Owner.localField → Plain in the same module, at_lca) keeps
  // leftPortX === x.
  function driftFixture(): LayoutInputs {
    const c = crate('c', [
      module('', [typeFacts('c', '', 'Target')]),
      module('sub', [
        typeFacts('c', 'sub', 'Owner', {
          fields: [
            { name: 'drifted', ty_text: 'Target' },
            { name: 'local', ty_text: 'Plain' },
          ],
        }),
        typeFacts('c', 'sub', 'Plain'),
      ]),
    ]);
    const edges: Edge[] = [
      {
        from: 'c::sub::Owner',
        to: 'c::Target',
        kind: 'owns',
        via: 'struct_field',
        origin: 'field drifted',
      },
      {
        from: 'c::sub::Owner',
        to: 'c::sub::Plain',
        kind: 'owns',
        via: 'struct_field',
        origin: 'field local',
      },
    ];
    return inputsFrom(c, edges, ['c', 'c::sub', 'c::sub::Owner']);
  }

  it('drifted field row port clears the dot; canonical field port stays at x', () => {
    const geom = geometryFor(driftFixture());
    const owner = geom.types.find((t) => t.node.fullPath === 'c::sub::Owner');
    expect(owner, 'Owner type laid out').toBeDefined();
    const drifted = owner?.visibleRows.find((r) => r.name === 'drifted');
    const local = owner?.visibleRows.find((r) => r.name === 'local');
    expect(drifted, 'drifted field row').toBeDefined();
    expect(local, 'local field row').toBeDefined();

    // Guard: the fixture must actually produce a non-canonical drift on the
    // drifted row, otherwise the leftPortX assertion would pass vacuously.
    expect(drifted?.memberDriftClass).toBe('drift_above');

    if (drifted === undefined || local === undefined) return;
    expect(drifted.leftPortX).toBeCloseTo(
      drifted.x - (DRIFT_DOT_OFFSET + DRIFT_DOT_RADIUS + DRIFT_DOT_PORT_GAP),
      5,
    );
    // Canonical row's port is NOT shifted — a naive "always offset" would
    // detach every row's port from the box.
    expect(local.leftPortX).toBeCloseTo(local.x, 5);
  });
});

// ======================================================================
// #8 geometry/first-field-y-offset
// ======================================================================
describe('first member row sits exactly half-header + half-row below the header', () => {
  it('firstRow.y - headerY === ROW_H/2 + FIELD_ROW_H/2 and rows step by FIELD_ROW_H', () => {
    // small App has two fields (engine, renderer), expanded.
    const inputs = smallFixtureInputs(['c', 'c::App']);
    const geom = geometryFor(inputs);
    const app = geom.types.find((t) => t.node.fullPath === 'c::App');
    expect(app, 'App laid out').toBeDefined();
    const rows = app?.visibleRows ?? [];
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const first = rows[0];
    const second = rows[1];
    if (first === undefined || second === undefined || app === undefined) return;

    const headerY = app.y;
    // Exact arithmetic — a buggy `t.y + 1.5*FIELD_ROW_H` is 5px off and a
    // weak `y > headerY` would pass for it.
    expect(first.y - headerY).toBeCloseTo(ROW_H / 2 + FIELD_ROW_H / 2, 5);
    expect(second.y - first.y).toBeCloseTo(FIELD_ROW_H, 5);
  });
});

// ======================================================================
// #6 geometry/row-width-reserves-locality-glyph
// ======================================================================
describe('callable row reserves space for the `→` locality glyph inside the box', () => {
  // A single-method type whose method has an outgoing call. The method row
  // is the widest row, so its reserved glyph space must be covered by the
  // type box's right edge — otherwise the arrow exit (`arrowSourceX`) falls
  // OUTSIDE the box (the historical bug).
  function callsFixture(): LayoutInputs {
    const caller = method('run', { self_kind: 'ref' });
    const callee = method('tick', { self_kind: 'ref' });
    const c = crate('c', [
      module('', [
        typeFacts('c', '', 'Engine', { methods: [caller] }),
        typeFacts('c', '', 'Clock', { methods: [callee] }),
      ]),
    ]);
    const root = buildModuleTree(c);
    // Calls index records Engine::run -> Clock::tick so the run row has an
    // outgoing call and therefore draws (and reserves space for) the glyph.
    const factsForIndex: Facts = {
      crates: { c },
      edges: [],
      call_edges: [
        {
          caller: methodId('c::Engine', caller),
          callee: methodId('c::Clock', callee),
          kind: 'method',
          resolution: 'exact',
          origin: `fn ${caller.name} call`,
        },
      ],
    };
    const ownership = buildOwnershipIndex(factsForIndex);
    const typeModule = collectTypeModule(root);
    const drift = computeDrift(ownership, typeModule);
    const depth = computeOwnershipDepth(ownership, collectTypeIds(root), drift);
    const state = new ViewState([
      'c',
      'c::Engine',
      'c::Clock',
      'c::Engine::__methods_pub',
      'c::Clock::__methods_pub',
    ]);
    return {
      staticRoot: root,
      ownership,
      depth,
      state,
      drift,
      calls: buildFunctionCallIndex(factsForIndex, root),
    };
  }

  it('method row reserves the glyph and arrowSourceX stays inside boxX+boxWidth', () => {
    const inputs = callsFixture();
    const layout = layoutFor(inputs);
    const engine = layout.types.find((t) => t.fullPath === 'c::Engine');
    expect(engine, 'Engine laid out').toBeDefined();
    const runRow = engine?.fields.find((r) => r.name === 'run' && r.kind === 'method');
    expect(runRow, 'run method row').toBeDefined();
    if (engine === undefined || runRow === undefined) return;

    // Guard: the row actually has an outgoing call and reserves glyph space.
    expect(runRow.hasOutgoingCalls).toBe(true);
    expect(runRow.localityGlyphX).toBeDefined();
    // The reserved suffix is non-zero: arrowSourceX is strictly past the
    // name + trailing gap (a name-only measurer would land at the name end).
    const nameEnd = runRow.x + runRow.textWidth;
    expect(runRow.arrowSourceX).toBeGreaterThan(nameEnd);

    // The box right edge must contain the reserved glyph / arrow exit. A
    // `measuredRowWidth` that ignored the glyph would leave arrowSourceX
    // OUTSIDE the box.
    expect(runRow.arrowSourceX).toBeLessThanOrEqual(engine.boxX + engine.boxWidth + EPS);
  });
});

// ======================================================================
// #9 geometry/bucket-header-bold-width
// ======================================================================
describe('method-bucket header row is measured with the BOLD measurer', () => {
  // A struct with one pub method → exactly one bucket header row ("pub fn (1)").
  // Build it twice with the same regular measurer but bold = 1x vs bold = 2x;
  // the type-box width must GROW under bold = 2x, proving the bucket header
  // path consumes the bold measurer (the bold-overflow fix). A naive single-
  // measurer test could not distinguish.
  function bucketFixture(): LayoutInputs {
    const c = crate('c', [
      module('', [
        typeFacts('c', '', 'Engine', { methods: [method('tick', { self_kind: 'ref' })] }),
      ]),
    ]);
    return inputsFrom(c, [], ['c', 'c::Engine']);
  }

  it('box width grows when only the bold measurer grows (bucket header path)', () => {
    const inputs = bucketFixture();
    const bold1 = layoutFor(inputs, (s) => measure(s)); // bold == regular
    const bold2 = layoutFor(inputs, (s) => measure(s) * 2); // bold == 2x regular
    const e1 = bold1.types.find((t) => t.fullPath === 'c::Engine');
    const e2 = bold2.types.find((t) => t.fullPath === 'c::Engine');
    expect(e1, 'Engine bold=1x').toBeDefined();
    expect(e2, 'Engine bold=2x').toBeDefined();
    if (e1 === undefined || e2 === undefined) return;

    // Guard: there is a bucket header row to widen.
    const bucket = e1.fields.find((r) => r.kind === 'method_bucket');
    expect(bucket, 'pub-fn bucket header row').toBeDefined();
    expect(bucket?.name).toContain('pub fn');

    expect(e2.boxWidth).toBeGreaterThan(e1.boxWidth);
  });
});

// ======================================================================
// #10 geometry/selection-ring-symmetric
// ======================================================================
describe('selection block hugs the visible ink: left edge is the marker inset', () => {
  // boxX must start at the visible ink (the kind marker), NOT at the type's
  // local x=0 dead space. The WRONG naive invariant is "boxX === t.x"; the
  // box starts slightly right of t.x by ~the marker inset, and its right
  // edge must cover the widest (bold) bucket-header row.
  function ringFixture(): LayoutInputs {
    const c = crate('c', [
      module('', [
        typeFacts('c', '', 'S', {
          fields: [{ name: 'a', ty_text: 'u8' }],
          methods: [method('configureEverythingNow', { self_kind: 'ref' })],
        }),
      ]),
    ]);
    return inputsFrom(c, [], ['c', 'c::S']);
  }

  it('boxX is within [t.x, t.x + KIND_MARKER_X+ε] and right edge covers widest row', () => {
    const layout = layoutFor(ringFixture(), (s) => measure(s) * 1.2);
    const s = layout.types.find((t) => t.fullPath === 'c::S');
    expect(s, 'S laid out').toBeDefined();
    if (s === undefined) return;

    const leftGap = s.boxX - s.x;
    expect(leftGap).toBeGreaterThanOrEqual(-EPS);
    expect(leftGap).toBeLessThanOrEqual(KIND_MARKER_X + 1);

    // Right edge must contain every visible row's rendered INK (name end).
    // The reserved `→` routing suffix beyond the name is covered separately
    // by the locality-glyph test (#6).
    const boxRight = s.boxX + s.boxWidth;
    for (const row of s.fields) {
      const inkRight = row.x + row.textWidth;
      expect(inkRight, `${row.name} ink within box`).toBeLessThanOrEqual(boxRight + EPS);
    }
    // Guard: the widest visible ink is the bold bucket header row, proving
    // the box accounts for the bold-measured header (not just field names).
    const bucket = s.fields.find((r) => r.kind === 'method_bucket');
    expect(bucket, 'bold bucket header row present').toBeDefined();
  });
});

// ======================================================================
// #17 geometry/type-label-right-of-module-pane
// ======================================================================
describe('type pane origin clears the widest visible module label', () => {
  // A long-named nested module that is expanded; the type pane (globalXStart)
  // must start right of the rendered module chip so type labels are never
  // truncated against the frozen module pane. Every type x must be >=
  // globalXStart.
  function longPathFixture(): LayoutInputs {
    const c = crate('c', [
      module('really_long_module_name_here', [
        typeFacts('c', 'really_long_module_name_here', 'Widget', {
          fields: [{ name: 'f', ty_text: 'u8' }],
        }),
      ]),
    ]);
    return inputsFrom(c, [], ['c', 'c::really_long_module_name_here']);
  }

  it('globalXStart leaves the long module label visible; all types start >= it', () => {
    const geom = geometryFor(longPathFixture());
    // The type pane must clear the deepest visible module chip. Using a
    // collapsed-pane fixture (short labels) for comparison would not stress
    // this; the long label forces globalXStart to grow.
    const longLabelWidth = measure('really_long_module_name_here');
    const shortGeom = geometryFor(
      inputsFrom(crate('c', [module('m', [typeFacts('c', 'm', 'W')])]), [], ['c', 'c::m']),
    );
    expect(longLabelWidth).toBeGreaterThan(measure('m'));
    expect(geom.globalXStart).toBeGreaterThan(shortGeom.globalXStart);

    for (const t of geom.types) {
      expect(t.x, `${t.node.fullPath} x >= globalXStart`).toBeGreaterThanOrEqual(
        geom.globalXStart - EPS,
      );
    }
  });
});

// ======================================================================
// #34 geometry/column-stride-fits-header
// ======================================================================
describe('column stride is at least the widest header label + gap (and >= COL_W)', () => {
  function longLabelFixture(): LayoutInputs {
    const c = crate('c', [
      module('', [
        typeFacts('c', '', 'AVeryLongTypeNameThatExceedsTheDefaultColumnWidthByALot', {
          fields: [{ name: 'f', ty_text: 'u8' }],
        }),
      ]),
    ]);
    return inputsFrom(c, [], ['c']);
  }

  it('columnStride >= header width + TYPE_X_GAP for the longest label', () => {
    const inputs = longLabelFixture();
    const geom = geometryFor(inputs);
    const label = 'AVeryLongTypeNameThatExceedsTheDefaultColumnWidthByALot';
    // The type has detail rows (a field) → header has an expand arrow.
    const headerWidth = measureTypeHeaderMetrics(label, true, measure).width;
    expect(geom.columnStride).toBeGreaterThanOrEqual(headerWidth + TYPE_X_GAP - EPS);
    // And never below the floor.
    expect(geom.columnStride).toBeGreaterThanOrEqual(240); // COL_W
  });
});

// ======================================================================
// #23 geometry/bucket-label-ts-vs-rust
// ======================================================================
describe('bucket header label uses TS wording for class/interface, Rust for struct', () => {
  // bucketHeaderText is internal; observed via the method_bucket row's name
  // in the layout output. Class/interface parents → "methods" / "protected
  // methods" / "private methods"; struct parent → "pub fn" / "pub(super) fn"
  // / "local fn".
  function bucketLabelFixture(parentKind: TypeKind): LayoutInputs {
    const methods = [
      method('pubM', { visibility: 'pub', self_kind: 'none' }),
      method('protM', { visibility: 'pub(super)', self_kind: 'none' }),
      method('privM', { visibility: 'priv', self_kind: 'none' }),
    ];
    const c = crate('c', [module('', [typeFacts('c', '', 'X', { kind: parentKind, methods })])]);
    return inputsFrom(c, [], ['c', 'c::X']);
  }

  function bucketNames(parentKind: TypeKind): string[] {
    const layout = layoutFor(bucketLabelFixture(parentKind));
    const x = layout.types.find((t) => t.fullPath === 'c::X');
    return (x?.fields ?? []).filter((r) => r.kind === 'method_bucket').map((r) => r.name);
  }

  it('class member buckets use TS wording', () => {
    const names = bucketNames('class');
    expect(names).toContain('methods (1)');
    expect(names).toContain('protected methods (1)');
    expect(names).toContain('private methods (1)');
  });

  it('interface member buckets use TS wording', () => {
    const names = bucketNames('interface');
    expect(names).toContain('methods (1)');
  });

  it('struct member buckets use Rust wording', () => {
    const names = bucketNames('struct');
    expect(names).toContain('pub fn (1)');
    expect(names).toContain('pub(super) fn (1)');
    expect(names).toContain('local fn (1)');
  });
});

// ======================================================================
// #24 geometry/ts-method-no-self-row  &  #31 self-row-only-in-signature
// ======================================================================
describe('self receiver row appears only in the expanded signature, per self_kind', () => {
  // One method per self_kind on a struct; the bucket and signatures all
  // expanded. The receiver row is the FIRST signature row and matches the
  // self_kind; `none` (TS-style) emits no receiver row at all. The collapsed
  // member rows (bucket headers / method names) never contain a self row.
  function selfFixture(): LayoutInputs {
    const methods = [
      method('byRef', { self_kind: 'ref' }),
      method('byRefMut', { self_kind: 'ref_mut' }),
      method('byValue', { self_kind: 'by_value' }),
      method('noSelf', { self_kind: 'none' }),
    ];
    const c = crate('c', [module('', [typeFacts('c', '', 'X', { methods })])]);
    const expanded = [
      'c',
      'c::X',
      'c::X::__methods_pub',
      'sig::c::X::byRef',
      'sig::c::X::byRefMut',
      'sig::c::X::byValue',
      'sig::c::X::noSelf',
    ];
    return inputsFrom(c, [], expanded);
  }

  /** Signature rows belonging to the method whose name is `methodName`,
   *  in order. Signature rows carry `functionFullPath === <method id>`. */
  function signatureRowNames(
    layout: ReturnType<typeof buildLayout>,
    methodFullPath: string,
  ): string[] {
    const x = layout.types.find((t) => t.fullPath === 'c::X');
    return (x?.fields ?? [])
      .filter((r) => r.kind === 'signature_arg' && r.functionFullPath === methodFullPath)
      .map((r) => r.name);
  }

  it('ref/ref_mut/by_value receivers head the signature; none emits no receiver', () => {
    const layout = layoutFor(selfFixture());
    expect(signatureRowNames(layout, 'c::X::byRef')[0]).toBe('&self');
    expect(signatureRowNames(layout, 'c::X::byRefMut')[0]).toBe('&mut self');
    expect(signatureRowNames(layout, 'c::X::byValue')[0]).toBe('self');

    const noSelfRows = signatureRowNames(layout, 'c::X::noSelf');
    expect(noSelfRows).not.toContain('self');
    expect(noSelfRows).not.toContain('&self');
    expect(noSelfRows).not.toContain('&mut self');
  });

  it('collapsed member rows (buckets/methods) never carry a self receiver row', () => {
    const layout = layoutFor(selfFixture());
    const x = layout.types.find((t) => t.fullPath === 'c::X');
    const nonSig = (x?.fields ?? []).filter((r) => r.kind !== 'signature_arg');
    for (const r of nonSig) {
      expect(['self', '&self', '&mut self']).not.toContain(r.name);
    }
  });
});

// ======================================================================
// #29 geometry/positive-box-size-all-kinds
// ======================================================================
describe('every type box has positive size across all kinds (incl. empty types)', () => {
  // Extends the golden invariant (which only uses structs) to one type of
  // every kind, including empty types (no fields/methods) and a
  // function_group. A zero-area box is the "not showing" bug; an empty
  // trait/interface must still get MIN_TYPE_BOX_W.
  function allKindsFixture(): LayoutInputs {
    const c = crate('c', [
      module(
        '',
        [
          typeFacts('c', '', 'St', { kind: 'struct', fields: [{ name: 'f', ty_text: 'u8' }] }),
          typeFacts('c', '', 'En', { kind: 'enum' }),
          typeFacts('c', '', 'Un', { kind: 'union' }),
          typeFacts('c', '', 'Tr', { kind: 'trait' }), // empty trait
          typeFacts('c', '', 'Al', { kind: 'type_alias' }),
          typeFacts('c', '', 'Cl', {
            kind: 'class',
            methods: [method('m', { self_kind: 'none' })],
          }),
          typeFacts('c', '', 'In', { kind: 'interface' }), // empty interface
        ],
        // A module-level free function synthesises a `function_group` pseudo-type.
        [method('freeFn', { self_kind: 'none' })],
      ),
    ]);
    // Expand the crate + every type so collapsed AND expanded coexist.
    return inputsFrom(c, [], ['c', 'c::St', 'c::Cl']);
  }

  it('width/height/boxWidth/boxHeight are positive and coords finite', () => {
    const layout = layoutFor(allKindsFixture());
    // Guard: all kinds present (function_group is synthesised, so >= 8).
    const kinds = new Set(layout.types.map((t) => t.typeKind));
    expect(kinds.has('function_group')).toBe(true);
    expect(layout.types.length).toBeGreaterThanOrEqual(8);

    for (const t of layout.types) {
      expect(t.width, `${t.id} width`).toBeGreaterThan(0);
      expect(t.height, `${t.id} height`).toBeGreaterThan(0);
      expect(t.boxWidth, `${t.id} boxWidth`).toBeGreaterThan(0);
      expect(t.boxHeight, `${t.id} boxHeight`).toBeGreaterThan(0);
      // Empty types still reach the minimum box width.
      expect(t.width, `${t.id} >= MIN_TYPE_BOX_W`).toBeGreaterThanOrEqual(MIN_TYPE_BOX_W - EPS);
      for (const v of [t.x, t.y, t.boxX, t.boxY, t.boxWidth, t.boxHeight]) {
        expect(Number.isFinite(v), `${t.id} finite coords`).toBe(true);
      }
    }
  });
});

// ======================================================================
// #21 render/red-removed-text-no-halo (CSS pin)  &  #22 chip-text-no-shadow
// ======================================================================
describe('removed-text halo override and chip text-shadow (CSS pins)', () => {
  it('removed field-row red text drops the halo with a #tree-prefixed rule', () => {
    // A bare `.side-base { stroke:none }` (specificity 10) loses to
    // `#tree text { stroke: white }` (101); the override must be #tree-prefixed.
    const rule = cssRule("#tree g.field-row-g[data-side='base'] text.field-row");
    expect(rule).toContain('stroke: none');
    expect(rule).toContain('line-through');
    // The global halo for non-red text still exists.
    expect(cssRule('#tree text')).toContain('stroke: white');
    // The removed type-box label also drops the halo, #tree-prefixed.
    expect(cssRule('#tree g.type-box.side-base text.header-label')).toContain('stroke: none');
  });

  it('rollup chip digits render crisp with text-shadow: none', () => {
    expect(cssRule('#html-modules .module-header .rollup-badge')).toContain('text-shadow: none');
  });
});
