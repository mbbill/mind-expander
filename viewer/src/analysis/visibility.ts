// Visibility bucketing — pure data classification of the raw extractor
// visibility tokens into the five display groups used everywhere in the
// viewer. Lives in analysis/ rather than view/ so module_tree.ts can use
// it for synthesising function-group pseudo-types without a circular
// import on the renderer.

export type VisibilityBucket = 'pub' | 'pub_crate' | 'pub_super' | 'pub_in_path' | 'private';

/**
 * Bucket the raw extractor visibility string into one of five display
 * groups. Anything we don't recognise falls through to `private`, since
 * "no clear public reach" is the safe default. Sentinel markers used by
 * the extractor for special cases (e.g. `<orphan-impl>`) should be
 * filtered out by the caller, not bucketed.
 */
export function classifyVisibility(vis: string): VisibilityBucket {
  if (vis === 'pub') return 'pub';
  if (vis === 'pub(crate)') return 'pub_crate';
  if (vis === 'pub(super)') return 'pub_super';
  if (vis === 'priv' || vis === 'pub(self)') return 'private';
  if (vis.startsWith('pub(')) return 'pub_in_path';
  return 'private';
}

/** Display order, most public → most local. Used for sorting the
 *  function-group pseudo-types in the module band. */
export const BUCKET_ORDER: readonly VisibilityBucket[] = [
  'pub',
  'pub_crate',
  'pub_super',
  'pub_in_path',
  'private',
];

/** Label rendered as the function-group's "type name" — e.g. `pub fn`,
 *  `pub(crate) fn`. The trailing " fn" makes it explicit these are
 *  function rows, not types. */
export const BUCKET_LABEL: Readonly<Record<VisibilityBucket, string>> = {
  pub: 'pub fn',
  pub_crate: 'pub(crate) fn',
  pub_super: 'pub(super) fn',
  pub_in_path: 'pub(in path) fn',
  private: 'local fn',
};

/** Representative visibility token for each bucket — used as the synthetic
 *  type's `visibility` field so `colorForVisibility` returns the right
 *  dot colour without any extra branching in the renderer. */
export const BUCKET_VIS_TOKEN: Readonly<Record<VisibilityBucket, string>> = {
  pub: 'pub',
  pub_crate: 'pub(crate)',
  pub_super: 'pub(super)',
  pub_in_path: 'pub(in path)',
  private: 'priv',
};

/** Filter for visibility strings worth rendering. The extractor emits
 *  sentinel markers like `<orphan-impl>` for impl blocks without a clear
 *  owner — those shouldn't pollute any visibility bucket. */
export function isRealVisibility(vis: string): boolean {
  return !vis.startsWith('<');
}
