// Span indexes built from facts.
//
//   • forward (elementId → Span): "what source range defines this thing?"
//     Used by Cmd+click in the diagram to scroll the code panel.
//   • reverse (file → [Span ranges]): "which element is at this line?"
//     Used by click-in-code-panel to navigate the diagram.
//
// The extractor optionally emits per-item spans. When it doesn\'t
// (older facts files, or until the Rust side ships span emission),
// every type/field/method falls back to its module\'s file with line 1
// so Cmd+click still opens the right file even though it can\'t
// highlight the exact lines yet.

import { classifyVisibility } from '../analysis/visibility.ts';
import type { Facts, Span } from './schema.ts';

/** Kind of source-language element a span describes. Rust allows a
 *  field and a method on the same type to share a name (`Store::module`
 *  as both a struct field and an `impl fn module(&self)`), so the
 *  `(elementId, kind)` pair is what uniquely identifies an element —
 *  not the id alone. */
export type ElementKind = 'type' | 'field' | 'method' | 'function';

export interface IndexedSpan {
  readonly elementId: string;
  readonly kind: ElementKind;
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface SpanIndex {
  /** Look up the span for an element. Keyed by (id, kind) so a struct
   *  field and a like-named method on the same type don't collide on
   *  the shared id. Use `lookupSpan` instead of poking the map
   *  directly — it walks both kinds when only the id is known. */
  readonly forward: ReadonlyMap<string, ReadonlyMap<ElementKind, Span>>;
  readonly byFile: ReadonlyMap<string, readonly IndexedSpan[]>;
  /** Set of fullPaths that are types (struct/enum/union/trait/alias). */
  readonly types: ReadonlySet<string>;
  /** For every (id, kind) pair, the diagram type-box id whose
   *  expansion state controls that element's visibility. Free
   *  functions live in `function_group` pseudo-types; methods/fields
   *  in their owning type. Used by the host to expand the right
   *  container before navigating. */
  readonly containingTypeBoxId: ReadonlyMap<string, ReadonlyMap<ElementKind, string>>;
}

/** Convenience: fetch the span for `(id, kind)`. Returns null when the
 *  element wasn't indexed (e.g., span omitted by the extractor). */
export function lookupSpan(
  index: SpanIndex,
  id: string,
  kind: ElementKind,
): Span | null {
  return index.forward.get(id)?.get(kind) ?? null;
}

/** Convenience: containing type-box id for `(id, kind)`. */
export function containingTypeBoxIdFor(
  index: SpanIndex,
  id: string,
  kind: ElementKind,
): string | null {
  return index.containingTypeBoxId.get(id)?.get(kind) ?? null;
}

export function buildSpanIndex(facts: Facts): SpanIndex {
  const forward = new Map<string, Map<ElementKind, Span>>();
  const byFile = new Map<string, IndexedSpan[]>();
  const types = new Set<string>();
  const containingTypeBoxId = new Map<string, Map<ElementKind, string>>();

  const setForward = (id: string, kind: ElementKind, span: Span): void => {
    let inner = forward.get(id);
    if (inner === undefined) {
      inner = new Map();
      forward.set(id, inner);
    }
    inner.set(kind, span);
  };
  const setContainer = (id: string, kind: ElementKind, containerId: string): void => {
    let inner = containingTypeBoxId.get(id);
    if (inner === undefined) {
      inner = new Map();
      containingTypeBoxId.set(id, inner);
    }
    inner.set(kind, containerId);
  };
  const appendToFile = (entry: IndexedSpan): void => {
    let list = byFile.get(entry.file);
    if (list === undefined) {
      list = [];
      byFile.set(entry.file, list);
    }
    list.push(entry);
  };

  for (const crate of Object.values(facts.crates)) {
    for (const mod of Object.values(crate.modules)) {
      const fallback: Span = { file: mod.file, start_line: 1, end_line: 1 };
      for (const t of mod.types) {
        const tSpan = t.span ?? fallback;
        types.add(t.full_path);
        setForward(t.full_path, 'type', tSpan);
        setContainer(t.full_path, 'type', t.full_path);
        if (t.span !== undefined) {
          appendToFile({
            elementId: t.full_path,
            kind: 'type',
            file: t.span.file,
            startLine: t.span.start_line,
            endLine: t.span.end_line,
          });
        }
        for (const f of t.fields) {
          const id = `${t.full_path}::${f.name}`;
          setForward(id, 'field', f.span ?? tSpan);
          setContainer(id, 'field', t.full_path);
          if (f.span !== undefined) {
            appendToFile({
              elementId: id,
              kind: 'field',
              file: f.span.file,
              startLine: f.span.start_line,
              endLine: f.span.end_line,
            });
          }
        }
        if (t.methods !== undefined) {
          for (const m of t.methods) {
            const id = `${t.full_path}::${m.name}`;
            setForward(id, 'method', m.span ?? tSpan);
            setContainer(id, 'method', t.full_path);
            if (m.span !== undefined) {
              appendToFile({
                elementId: id,
                kind: 'method',
                file: m.span.file,
                startLine: m.span.start_line,
                endLine: m.span.end_line,
              });
            }
          }
        }
      }
      for (const fn of mod.functions) {
        const modPath = mod.path === '' ? '' : `::${mod.path}`;
        const moduleId = `${crate.name}${modPath}`;
        const id = `${moduleId}::${fn.name}`;
        setForward(id, 'function', fn.span ?? fallback);
        // Free functions live in `function_group` pseudo-types (one
        // per visibility bucket per module). The id formula is owned
        // by `module_tree.ts:239`; we mirror it here so the host
        // knows which pseudo-type to expand without having to walk
        // the module tree at click time.
        setContainer(
          id,
          'function',
          `${moduleId}::__fn_${classifyVisibility(fn.visibility)}`,
        );
        if (fn.span !== undefined) {
          appendToFile({
            elementId: id,
            kind: 'function',
            file: fn.span.file,
            startLine: fn.span.start_line,
            endLine: fn.span.end_line,
          });
        }
      }
    }
  }

  // Sort each file\'s spans by start line. Deepest-first when ties.
  for (const list of byFile.values()) {
    list.sort((a, b) => {
      if (a.startLine !== b.startLine) return a.startLine - b.startLine;
      return (a.endLine - a.startLine) - (b.endLine - b.startLine);
    });
  }

  return { forward, byFile, types, containingTypeBoxId };
}

/** Find the DEEPEST (smallest-range) element whose span contains
 *  `line` in `file`. Returns null when no element covers the line —
 *  caller can treat as "click landed in whitespace, don't navigate".
 *  Returns the full IndexedSpan so callers know whether the line
 *  landed in a field, method, free function, or type — `Store::module`
 *  the field and `Store::module` the method share an id, so id alone
 *  is not enough to disambiguate. */
export function findElementAtLine(
  index: SpanIndex,
  file: string,
  line: number,
): IndexedSpan | null {
  const list = index.byFile.get(file);
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
