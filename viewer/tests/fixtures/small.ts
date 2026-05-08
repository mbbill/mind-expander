// Small fixture — 5 types across 3 modules, all canonical (no drift).
//
//   c::App  owns  c::core::Engine     owns  c::core::Cylinder
//          owns  c::render::Renderer  owns  c::render::Pixel
//
// LCA placements:
//   - App      → root, no owners, at_lca.
//   - Engine   → in core; owners' LCA = root; depth diff 1 → within_budget.
//   - Renderer → mirrors Engine.
//   - Cylinder → owners' LCA = core; lives in core → at_lca.
//   - Pixel    → mirrors Cylinder.
//
// Exercises: forward arrows, hierarchical module placement, branching at
// the root, two parallel chains.

import type { LayoutInputs } from '../../src/analysis/layout_model.ts';
import { buildInputs, crateFacts, edge, mod, ty } from './builders.ts';

export function smallFixtureInputs(expandedIds: string[] = []): LayoutInputs {
  const c = crateFacts('c', [
    mod('', [
      ty('c', '', 'App', [
        { name: 'engine', ty_text: 'core::Engine' },
        { name: 'renderer', ty_text: 'render::Renderer' },
      ]),
    ]),
    mod('core', [
      ty('c', 'core', 'Engine', [{ name: 'cyl', ty_text: 'Cylinder' }]),
      ty('c', 'core', 'Cylinder'),
    ]),
    mod('render', [
      ty('c', 'render', 'Renderer', [{ name: 'pix', ty_text: 'Pixel' }]),
      ty('c', 'render', 'Pixel'),
    ]),
  ]);
  const edges = [
    edge('c::App', 'c::core::Engine', 'field engine'),
    edge('c::App', 'c::render::Renderer', 'field renderer'),
    edge('c::core::Engine', 'c::core::Cylinder', 'field cyl'),
    edge('c::render::Renderer', 'c::render::Pixel', 'field pix'),
  ];
  return buildInputs(c, edges, expandedIds);
}
