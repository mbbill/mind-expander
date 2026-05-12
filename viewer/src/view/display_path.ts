// Crate-prefix helpers for popup labels (call-target picker, arrow
// disambig, owners overlay). The rule across all popups is the same:
// when an entry's crate matches the dialog's anchor crate, the crate
// name is redundant — strip it. When the entry lives in a DIFFERENT
// crate, keep the crate name so the cross-crate reference is explicit.
//
// Owned here so every popup applies the rule identically and any new
// popup has one place to call into.

/** Crate name of a fully-qualified path — the first `::` segment.
 *  Returns '' for paths with no `::` (shouldn't happen for real types
 *  but defends against synthetic ids). */
export function cratePrefixOf(fullPath: string): string {
  return fullPath.split('::', 1)[0] ?? '';
}

/** Strip a leading `${contextCrate}::` from a display path. Returns the
 *  path unchanged when it lives in a different crate. Returns '' if the
 *  display path is exactly the crate name (no other segments). */
export function stripCratePrefix(displayPath: string, contextCrate: string): string {
  if (contextCrate === '') return displayPath;
  if (displayPath === contextCrate) return '';
  const prefix = `${contextCrate}::`;
  return displayPath.startsWith(prefix) ? displayPath.slice(prefix.length) : displayPath;
}
