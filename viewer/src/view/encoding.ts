// Visual encoding for type/function dots. Colour signals VISIBILITY
// (who can see this) rather than `kind` (struct/enum/...) — most types
// are structs so kind-coloring was wasted bandwidth, and visibility is
// a meaningful axis that unifies types and functions.

import { type VisibilityBucket, classifyVisibility } from '../analysis/visibility.ts';

const VISIBILITY_COLOR: Readonly<Record<VisibilityBucket, string>> = {
  pub: '#ef4444', // red-500 — fully exposed, "loud" warning hue
  pub_crate: '#22c55e', // green-500 — visible within the crate
  pub_super: '#3b82f6', // blue-500 — parent module
  pub_in_path: '#f97316', // orange-500 — pub(in some::path), unusual
  private: '#94a3b8', // slate-400 — module-local, mutest
};

const FALLBACK = '#94a3b8';

export function colorForVisibility(vis: string): string {
  return VISIBILITY_COLOR[classifyVisibility(vis)] ?? FALLBACK;
}
