// Span indexes built from facts.
//
//   • forward (elementId, kind → SpanRecord): "where does this entity
//     live?" A `SpanRecord` carries the canonical `span` (head file for
//     present-in-head entities; base file for Base-only deleted ones)
//     plus an optional `prev_span` for Modified entities (the base
//     location, used to draw the union focus frame in the code panel).
//     One record per `(id, kind)` pair — no side disambiguation in the
//     lookup key. Used by Cmd+click in the diagram.
//   • byFileHead / byFileBase (file → [IndexedSpan ranges]): "which
//     element defines line N in head / base coordinates?" Used by
//     clicks inside the code panel. Modified entities appear in BOTH
//     reverse indexes (head span in byFileHead, prev_span in byFileBase)
//     so a click on either a red base-only line or a green head-only
//     line resolves to the same entity id.
//
// In single-snapshot mode (no `--at base..HEAD`), every entity is
// `Side::Head`, byFileBase is empty, and `prev_span` is never set.

import { classifyVisibility } from '../analysis/visibility.ts';
import { fieldId, methodId } from './ids.ts';
import type { ChangeKind, Facts, Side, Span } from './schema.ts';

/** Kind of source-language element a span describes. Rust allows a
 *  field and a method on the same type to share a name (`Store::module`
 *  as both a struct field and an `impl fn module(&self)`), so the
 *  `(elementId, kind)` pair is what uniquely identifies an element —
 *  not the id alone. `module` covers Cmd+clicking a module label in
 *  the tree: the span resolves to the module's source file (whatever
 *  the extractor put in `mod.file`, e.g. `foo.rs` or `foo/mod.rs`),
 *  with line 1 as a "scroll to top" anchor since the extractor doesn't
 *  emit a tighter span for the module itself. */
export type ElementKind = 'module' | 'type' | 'field' | 'method' | 'function';

/** What `lookupSpan` returns. `span` is the canonical location of the
 *  entity (head for present-in-head; base for deleted-only). `prev_span`
 *  is set only when `side === 'modified'` and carries the base location
 *  for the union frame. `side` tells callers how to render the entity's
 *  row (red / green / both-modified-dual-bar / no bar). */
export interface SpanRecord {
  readonly span: Span;
  readonly prev_span?: Span;
  readonly side: Side;
  /** Sub-classification of a Modified entity. `undefined` for
   *  Base/Head/Both. */
  readonly change_kind?: ChangeKind;
}

export interface IndexedSpan {
  readonly elementId: string;
  readonly kind: ElementKind;
  readonly side: Side;
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface SpanIndex {
  /** `(elementId, kind) → SpanRecord`. One record per entity. */
  readonly forward: ReadonlyMap<string, ReadonlyMap<ElementKind, SpanRecord>>;
  /** Head-coords reverse index: head workspace path → IndexedSpan[]. */
  readonly byFileHead: ReadonlyMap<string, readonly IndexedSpan[]>;
  /** Base-coords reverse index: base workspace path → IndexedSpan[]. */
  readonly byFileBase: ReadonlyMap<string, readonly IndexedSpan[]>;
  /** Set of fullPaths that are types (struct/enum/union/trait/alias). */
  readonly types: ReadonlySet<string>;
  /** For every (id, kind), the diagram type-box id whose expansion
   *  state controls that element's visibility. Free functions live in
   *  `function_group` pseudo-types; methods/fields in their owning
   *  type. */
  readonly containingTypeBoxId: ReadonlyMap<string, ReadonlyMap<ElementKind, string>>;
  /** Reverse lookup: absolute source-file path → moduleId. Lets the
   *  code panel's breadcrumb open a file as a module (so the diagram
   *  side also updates). Keys include both head and base workspace
   *  paths so a base-only file resolves too. */
  readonly moduleByFile: ReadonlyMap<string, string>;
}

/** Fetch the `SpanRecord` for `(id, kind)`. Returns null when the
 *  element wasn't indexed. */
export function lookupSpan(
  index: SpanIndex,
  id: string,
  kind: ElementKind,
): SpanRecord | null {
  const inner = index.forward.get(id);
  if (inner === undefined) return null;
  return inner.get(kind) ?? null;
}

/** Containing type-box id for `(id, kind)`. */
export function containingTypeBoxIdFor(
  index: SpanIndex,
  id: string,
  kind: ElementKind,
): string | null {
  const inner = index.containingTypeBoxId.get(id);
  if (inner === undefined) return null;
  return inner.get(kind) ?? null;
}

export function buildSpanIndex(facts: Facts): SpanIndex {
  const forward = new Map<string, Map<ElementKind, SpanRecord>>();
  const byFileHead = new Map<string, IndexedSpan[]>();
  const byFileBase = new Map<string, IndexedSpan[]>();
  const types = new Set<string>();
  const containingTypeBoxId = new Map<string, Map<ElementKind, string>>();
  const moduleByFile = new Map<string, string>();

  const setForward = (
    id: string,
    kind: ElementKind,
    side: Side,
    span: Span,
    prev_span: Span | undefined,
    change_kind: ChangeKind | undefined,
  ): void => {
    let inner = forward.get(id);
    if (inner === undefined) {
      inner = new Map();
      forward.set(id, inner);
    }
    const record: SpanRecord = {
      span,
      side,
      ...(prev_span !== undefined ? { prev_span } : {}),
      ...(change_kind !== undefined ? { change_kind } : {}),
    };
    inner.set(kind, record);
  };
  const setContainer = (
    id: string,
    kind: ElementKind,
    containerId: string,
  ): void => {
    let inner = containingTypeBoxId.get(id);
    if (inner === undefined) {
      inner = new Map();
      containingTypeBoxId.set(id, inner);
    }
    inner.set(kind, containerId);
  };
  // Reverse-index decisions:
  //   side='head'     → byFileHead only
  //   side='base'     → byFileBase only
  //   side='both'     → both (same span in both coord systems —
  //                     context rows carry both lineHead and lineBase)
  //   side='modified' → byFileHead via `span`, byFileBase via `prev_span`
  const appendByFile = (
    elementId: string,
    kind: ElementKind,
    side: Side,
    span: Span,
    prev_span: Span | undefined,
  ): void => {
    const headEntry: IndexedSpan = {
      elementId,
      kind,
      side,
      file: span.file,
      startLine: span.start_line,
      endLine: span.end_line,
    };
    const pushTo = (
      map: Map<string, IndexedSpan[]>,
      entry: IndexedSpan,
    ): void => {
      let list = map.get(entry.file);
      if (list === undefined) {
        list = [];
        map.set(entry.file, list);
      }
      list.push(entry);
    };
    if (side === 'base') {
      pushTo(byFileBase, headEntry);
      return;
    }
    if (side === 'head') {
      pushTo(byFileHead, headEntry);
      return;
    }
    if (side === 'both') {
      pushTo(byFileHead, headEntry);
      pushTo(byFileBase, headEntry);
      return;
    }
    // Modified: head span goes to head index; base span (prev_span)
    // goes to base index. Same elementId in both.
    pushTo(byFileHead, headEntry);
    if (prev_span !== undefined) {
      pushTo(byFileBase, {
        elementId,
        kind,
        side,
        file: prev_span.file,
        startLine: prev_span.start_line,
        endLine: prev_span.end_line,
      });
    }
  };

  const sideOf = (raw?: Side): Side => raw ?? 'head';

  for (const crate of Object.values(facts.crates)) {
    for (const mod of Object.values(crate.modules)) {
      const fallback: Span = { file: mod.file, start_line: 1, end_line: 1 };
      const modSide = sideOf(mod.side);
      // Module-level entry: lets Cmd+click on a module label in the
      // tree open its source file.
      const moduleId =
        mod.path === '' ? crate.name : `${crate.name}::${mod.path}`;
      setForward(moduleId, 'module', modSide, fallback, undefined, undefined);
      setContainer(moduleId, 'module', moduleId);
      if (!moduleByFile.has(mod.file)) moduleByFile.set(mod.file, moduleId);
      for (const t of mod.types) {
        const tSide = sideOf(t.side);
        const tSpan = t.span ?? fallback;
        const tPrev = t.prev_span;
        types.add(t.full_path);
        setForward(t.full_path, 'type', tSide, tSpan, tPrev, t.change_kind);
        setContainer(t.full_path, 'type', t.full_path);
        if (t.span !== undefined) {
          appendByFile(t.full_path, 'type', tSide, t.span, tPrev);
        }
        for (const f of t.fields) {
          const fSide = sideOf(f.side);
          const id = fieldId(t.full_path, f.name);
          setForward(id, 'field', fSide, f.span ?? tSpan, f.prev_span, f.change_kind);
          setContainer(id, 'field', t.full_path);
          if (f.span !== undefined) {
            appendByFile(id, 'field', fSide, f.span, f.prev_span);
          }
        }
        if (t.methods !== undefined) {
          for (const m of t.methods) {
            const mSide = sideOf(m.side);
            const id = methodId(t.full_path, m);
            setForward(id, 'method', mSide, m.span ?? tSpan, m.prev_span, m.change_kind);
            setContainer(id, 'method', t.full_path);
            if (m.span !== undefined) {
              appendByFile(id, 'method', mSide, m.span, m.prev_span);
            }
          }
        }
      }
      for (const fn of mod.functions) {
        const fnSide = sideOf(fn.side);
        const modPath = mod.path === '' ? '' : `::${mod.path}`;
        const modId = `${crate.name}${modPath}`;
        const id = `${modId}::${fn.name}`;
        setForward(id, 'function', fnSide, fn.span ?? fallback, fn.prev_span, fn.change_kind);
        // Free functions live in `function_group` pseudo-types (one
        // per visibility bucket per module). The id formula is owned
        // by `module_tree.ts:239`; we mirror it here.
        setContainer(
          id,
          'function',
          `${modId}::__fn_${classifyVisibility(fn.visibility)}`,
        );
        if (fn.span !== undefined) {
          appendByFile(id, 'function', fnSide, fn.span, fn.prev_span);
        }
      }
    }
  }

  const sortList = (list: IndexedSpan[]): void => {
    list.sort((a, b) => {
      if (a.startLine !== b.startLine) return a.startLine - b.startLine;
      return (a.endLine - a.startLine) - (b.endLine - b.startLine);
    });
  };
  for (const list of byFileHead.values()) sortList(list);
  for (const list of byFileBase.values()) sortList(list);

  return {
    forward,
    byFileHead,
    byFileBase,
    types,
    containingTypeBoxId,
    moduleByFile,
  };
}

/** Find the DEEPEST (smallest-range) element whose span contains
 *  `line` in `file` on a specific `side`. Returns null when no
 *  element covers the line. Returns the full IndexedSpan so callers
 *  know which kind + side the line resolved to. */
export function findElementAtLine(
  index: SpanIndex,
  file: string,
  line: number,
  side: Side,
): IndexedSpan | null {
  const map = side === 'base' ? index.byFileBase : index.byFileHead;
  const list = map.get(file);
  if (list === undefined) return null;
  let best: IndexedSpan | null = null;
  for (const s of list) {
    if (s.startLine > line) break; // sorted by startLine ascending
    if (s.endLine < line) continue;
    if (best === null || s.endLine - s.startLine < best.endLine - best.startLine) {
      best = s;
    }
  }
  return best;
}
