// View-side expansion state, keyed by stable node id (module: `crate::path`,
// type: full_path). Domain objects in analysis/ stay immutable; this is the
// only mutable companion the renderer consults.

export class ViewState {
  private readonly expanded: Set<string>;

  constructor(initiallyExpanded: Iterable<string> = []) {
    this.expanded = new Set(initiallyExpanded);
  }

  isExpanded(id: string): boolean {
    return this.expanded.has(id);
  }

  toggle(id: string): void {
    if (this.expanded.has(id)) {
      this.expanded.delete(id);
    } else {
      this.expanded.add(id);
    }
  }

  expand(id: string): void {
    this.expanded.add(id);
  }

  collapse(id: string): void {
    this.expanded.delete(id);
  }

  /** Iterate ids that are currently expanded, in insertion order. */
  expandedIds(): IterableIterator<string> {
    return this.expanded.values();
  }

  /** Wipe all expansion state. Caller is responsible for re-expanding any
   *  ids that should remain (e.g. the crate root). */
  clear(): void {
    this.expanded.clear();
  }
}
