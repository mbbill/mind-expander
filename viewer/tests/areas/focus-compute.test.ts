// Tier-2 layout invariants for GROUP G — Focus mode (F) filtering.
//
// Focus mode is a LAYOUT-INPUT FILTER, not an opacity dim: when engaged,
// `buildLayout` receives a `focusModules` set and drops every module band
// (and therefore every type box) whose id is not in that set, while keeping
// the relevant subtree fully rendered. Toggling focus OFF passes
// `focusModules = undefined`, which restores all bands. (See
// src/layout/geometry.ts `collectVisibleModuleBands`: the early-return
// `if (focusModules !== undefined && !focusModules.has(node.id)) return []`.)
//
// The focus SET itself is produced by `computeFocus` in main.ts. That
// function is not exported, but its contract is the exported, pure
// `ancestorModuleIds(typePath)` (src/view/type_expansion.ts) closed over the
// WORKSPACE_ROOT_ID plus the ancestors of every expanded type and of every
// one-step field-arrow target. This test derives the focus set the SAME way
// the source does, feeds it through the real `buildLayout`, and asserts the
// observable layout result — so the oracle is the shipped filter contract,
// not a re-implementation of the renderer.
//
// Fixture: a multi-LEVEL module tree (crate → app, crate → engine::core,
// crate → engine::aux, crate → unrelated::widgets) so focus has real depth
// to keep (engine::core ancestors) and a real sibling subtree to drop
// (unrelated::widgets, plus engine::aux which is off the relevance path).

import { describe, expect, it } from 'vitest';
import type { Layout } from '../../src/analysis/layout_model.ts';
import { WORKSPACE_ROOT_ID } from '../../src/analysis/module_tree.ts';
import type { CrateFacts } from '../../src/data/schema.ts';
import { buildLayout } from '../../src/layout/pipeline.ts';
import { ancestorModuleIds } from '../../src/view/type_expansion.ts';
import { buildInputs, crateFacts, edge, mod, ty } from '../fixtures/builders.ts';

const measure = (s: string): number => s.length * 7;

const CRATE = 'mlc'; // multi-level crate

// Type ids in the fixture.
const APP = `${CRATE}::App`;
const ENGINE = `${CRATE}::engine::core::Engine`;
const PISTON = `${CRATE}::engine::core::Piston`;
const COOLANT = `${CRATE}::engine::aux::Coolant`;
const WIDGET = `${CRATE}::unrelated::widgets::Widget`;

/** Multi-level crate:
 *   App (root) owns engine::core::Engine.
 *   engine::core::Engine owns engine::core::Piston.
 *   engine::aux::Coolant is an isolated type in a SIBLING submodule of
 *     engine::core — off the relevance path of a core selection.
 *   unrelated::widgets::Widget is an isolated type in a different top-level
 *     submodule branch — also off the relevance path. */
function buildCrate(): CrateFacts {
  return crateFacts(CRATE, [
    mod('', [ty(CRATE, '', 'App', [{ name: 'engine', ty_text: 'engine::core::Engine' }])]),
    mod('engine::core', [
      ty(CRATE, 'engine::core', 'Engine', [{ name: 'piston', ty_text: 'Piston' }]),
      ty(CRATE, 'engine::core', 'Piston', [{ name: 'bore', ty_text: 'u32' }]),
    ]),
    mod('engine::aux', [ty(CRATE, 'engine::aux', 'Coolant', [{ name: 'temp', ty_text: 'u32' }])]),
    mod('unrelated::widgets', [
      ty(CRATE, 'unrelated::widgets', 'Widget', [{ name: 'id', ty_text: 'u32' }]),
    ]),
  ]);
}

// Ownership edges: App.engine → Engine, Engine.piston → Piston.
const EDGES = [edge(APP, ENGINE, 'field engine'), edge(ENGINE, PISTON, 'field piston')];

// Modules a fully-rendered (non-focus) tree expands so EVERY type box is
// present. Includes the synthesized `engine` and `unrelated` intermediates.
const ALL_EXPANDED = [
  CRATE,
  `${CRATE}::engine`,
  `${CRATE}::engine::core`,
  `${CRATE}::engine::aux`,
  `${CRATE}::unrelated`,
  `${CRATE}::unrelated::widgets`,
  APP,
  ENGINE,
];

function layoutWith(focusModules: ReadonlySet<string> | undefined): Layout {
  const inputs = buildInputs(buildCrate(), EDGES, ALL_EXPANDED);
  // Spread focusModules only when present so the OFF case passes the property
  // as genuinely absent (exactOptionalPropertyTypes), matching how main.ts
  // omits focusModules when focus mode is off.
  return buildLayout({
    ...inputs,
    ...(focusModules !== undefined ? { focusModules } : {}),
    measureText: measure,
  });
}

/**
 * Replicate `computeFocus(ctx).modules` for the pure case the catalog
 * targets: a single expanded type (`Engine`) whose ONE field arrow points
 * at `Piston`. Per the source the set is the workspace root, plus the
 * ancestor modules of the expanded type, plus the ancestor modules of each
 * one-step field-arrow target of that expanded type.
 */
function focusSetForEngineExpanded(): Set<string> {
  const modules = new Set<string>([WORKSPACE_ROOT_ID]);
  for (const m of ancestorModuleIds(ENGINE)) modules.add(m);
  // Engine.piston → Piston (same module here, but derived the source's way).
  for (const m of ancestorModuleIds(PISTON)) modules.add(m);
  return modules;
}

function moduleIds(layout: Layout): Set<string> {
  return new Set(layout.modules.map((m) => m.id));
}

function typeIds(layout: Layout): Set<string> {
  return new Set(layout.types.map((t) => t.id));
}

describe('FOCUS-G-T2 — focusModules drops non-relevant module bands, keeps the relevant subtree', () => {
  it('OFF (focusModules=undefined): every module band and type box renders', () => {
    const layout = layoutWith(undefined);
    const mods = moduleIds(layout);
    const types = typeIds(layout);

    // All real + synthesized module bands present.
    expect(mods).toContain(CRATE);
    expect(mods).toContain(`${CRATE}::engine`);
    expect(mods).toContain(`${CRATE}::engine::core`);
    expect(mods).toContain(`${CRATE}::engine::aux`);
    expect(mods).toContain(`${CRATE}::unrelated`);
    expect(mods).toContain(`${CRATE}::unrelated::widgets`);

    // Every type box renders (none filtered).
    expect(types).toContain(APP);
    expect(types).toContain(ENGINE);
    expect(types).toContain(PISTON);
    expect(types).toContain(COOLANT);
    expect(types).toContain(WIDGET);
  });

  it('ON: focus set keeps relevant ancestor bands, drops the off-path sibling branches', () => {
    const focus = focusSetForEngineExpanded();
    const layout = layoutWith(focus);
    const mods = moduleIds(layout);
    const types = typeIds(layout);

    // Relevant ancestors of the expanded Engine (and its Piston target) stay.
    expect(mods).toContain(CRATE);
    expect(mods).toContain(`${CRATE}::engine`);
    expect(mods).toContain(`${CRATE}::engine::core`);

    // Off-path sibling submodule of engine::core is dropped — it is not in
    // the focus set, so its band never enters the layout.
    expect(mods).not.toContain(`${CRATE}::engine::aux`);
    // The whole `unrelated` branch is dropped (parent and leaf).
    expect(mods).not.toContain(`${CRATE}::unrelated`);
    expect(mods).not.toContain(`${CRATE}::unrelated::widgets`);

    // Type boxes follow their bands: relevant types render, dropped-band
    // types are gone entirely (not merely dimmed).
    expect(types).toContain(ENGINE);
    expect(types).toContain(PISTON);
    expect(types).not.toContain(COOLANT);
    expect(types).not.toContain(WIDGET);
  });

  it('a band absent from the focus set drops even when ViewState still has it expanded', () => {
    // ViewState keeps every branch expanded (ALL_EXPANDED). The ONLY reason
    // the off-path bands disappear under focus is the focusModules filter —
    // proving focus is a non-destructive layout-input filter layered over an
    // unchanged expansion state, so toggling OFF (next test) restores them.
    const focus = focusSetForEngineExpanded();
    const onMods = moduleIds(layoutWith(focus));
    expect(onMods.has(`${CRATE}::engine::aux`)).toBe(false);
    expect(onMods.has(`${CRATE}::unrelated::widgets`)).toBe(false);
  });

  it('OFF after ON restores the dropped bands — the filter is fully reversible against the same ViewState', () => {
    const focus = focusSetForEngineExpanded();
    const onMods = moduleIds(layoutWith(focus));
    expect(onMods.has(`${CRATE}::unrelated::widgets`)).toBe(false);

    // Same expansion state, focusModules cleared: dropped bands return.
    const offMods = moduleIds(layoutWith(undefined));
    expect(offMods.has(`${CRATE}::engine::aux`)).toBe(true);
    expect(offMods.has(`${CRATE}::unrelated::widgets`)).toBe(true);
    expect(offMods.has(`${CRATE}::unrelated`)).toBe(true);
  });

  it('the workspace root is always in the focus set so crate-level labels survive', () => {
    // computeFocus seeds the set with WORKSPACE_ROOT_ID unconditionally; the
    // crate band (a child of the workspace root) must therefore render even
    // when only a deep type is relevant.
    const focus = focusSetForEngineExpanded();
    expect(focus.has(WORKSPACE_ROOT_ID)).toBe(true);
    expect(moduleIds(layoutWith(focus))).toContain(CRATE);
  });
});
