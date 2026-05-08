// Medium fixture — ~30 types across several modules, designed to exercise
// dense same-depth bundles and a back-edge (reverse arrow).
//
// Layout:
//   m::Root owns 12 leaves at depth 1 (dense same-depth column).
//   m::Hub  owns 8 separate leaves at depth 1 (independent dense bundle).
//   m::Tail at depth 2 owns m::Root  → back-edge (reverse arrow).
//
// All arrows enter their targets through the same gutter zones, so this
// fixture is the smallest realistic test of channel allocation under
// load.

import type { LayoutInputs } from '../../src/analysis/layout_bak.ts';
import { buildInputs, crateFacts, edge, mod, ty } from './builders.ts';

const ROOT_LEAVES = 12;
const HUB_LEAVES = 8;

export function mediumFixtureInputs(expandedIds: string[] = []): LayoutInputs {
  const rootFields = Array.from({ length: ROOT_LEAVES }, (_, i) => ({
    name: `r${i}`,
    ty_text: `R${i}`,
  }));
  const hubFields = Array.from({ length: HUB_LEAVES }, (_, i) => ({
    name: `h${i}`,
    ty_text: `H${i}`,
  }));
  const rootLeaves = Array.from({ length: ROOT_LEAVES }, (_, i) => ty('c', 'm', `R${i}`));
  const hubLeaves = Array.from({ length: HUB_LEAVES }, (_, i) => ty('c', 'm', `H${i}`));
  const c = crateFacts('c', [
    mod(''),
    mod('m', [
      ty('c', 'm', 'Root', rootFields),
      ty('c', 'm', 'Hub', hubFields),
      ty('c', 'm', 'Tail', [{ name: 'root', ty_text: 'Root' }]),
      ...rootLeaves,
      ...hubLeaves,
    ]),
  ]);
  const edges = [
    ...Array.from({ length: ROOT_LEAVES }, (_, i) =>
      edge('c::m::Root', `c::m::R${i}`, `field r${i}`),
    ),
    ...Array.from({ length: HUB_LEAVES }, (_, i) =>
      edge('c::m::Hub', `c::m::H${i}`, `field h${i}`),
    ),
    edge('c::m::Tail', 'c::m::Root', 'field root'),
  ];
  return buildInputs(c, edges, expandedIds);
}
