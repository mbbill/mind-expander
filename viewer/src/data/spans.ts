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

export interface IndexedSpan {
  readonly elementId: string;
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface SpanIndex {
  readonly forward: ReadonlyMap<string, Span>;
  readonly byFile: ReadonlyMap<string, readonly IndexedSpan[]>;
  /** Set of fullPaths that are types (struct/enum/union/trait/alias).
   *  Used to walk an element id back to its owning type, which is
   *  necessary when a field name itself contains `::` (e.g. an enum
   *  variant payload field encoded as `Variant::field`). */
  readonly types: ReadonlySet<string>;
  /** Set of element ids that are callables (methods on a type, or
   *  free functions). Used to decide whether selecting a member
   *  should auto-expand its parent type's callable buckets — fields
   *  are already visible whenever the type itself is expanded. */
  readonly callables: ReadonlySet<string>;
  /** For every element id, the diagram type-box id whose expansion
   *  state controls that element's visibility:
   *    - Method T::m → T (and a method-bucket inside T needs expanding)
   *    - Field T::f → T
   *    - Free function M::f → the function_group pseudo-type
   *      `${M}::__fn_${visibilityBucket}` that holds it
   *    - Type T → T (self)
   *  The host uses this map to decide what to expand before scrolling
   *  the diagram to a clicked code line — without it, free functions
   *  whose function_group is collapsed can never be located in the
   *  layout. Mirrors module_tree.ts's `__fn_${bucket}` id formula. */
  readonly containingTypeBoxId: ReadonlyMap<string, string>;
}

export function buildSpanIndex(facts: Facts): SpanIndex {
  const forward = new Map<string, Span>();
  const byFile = new Map<string, IndexedSpan[]>();
  const types = new Set<string>();
  const callables = new Set<string>();
  const containingTypeBoxId = new Map<string, string>();
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
        forward.set(t.full_path, tSpan);
        // Self-reference: a type "contains" itself for expansion
        // purposes. Lets the host treat all element ids uniformly.
        containingTypeBoxId.set(t.full_path, t.full_path);
        if (t.span !== undefined) {
          appendToFile({
            elementId: t.full_path,
            file: t.span.file,
            startLine: t.span.start_line,
            endLine: t.span.end_line,
          });
        }
        for (const f of t.fields) {
          const id = `${t.full_path}::${f.name}`;
          forward.set(id, f.span ?? tSpan);
          containingTypeBoxId.set(id, t.full_path);
          if (f.span !== undefined) {
            appendToFile({
              elementId: id,
              file: f.span.file,
              startLine: f.span.start_line,
              endLine: f.span.end_line,
            });
          }
        }
        if (t.methods !== undefined) {
          for (const m of t.methods) {
            const id = `${t.full_path}::${m.name}`;
            callables.add(id);
            forward.set(id, m.span ?? tSpan);
            containingTypeBoxId.set(id, t.full_path);
            if (m.span !== undefined) {
              appendToFile({
                elementId: id,
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
        callables.add(id);
        forward.set(id, fn.span ?? fallback);
        // Free functions live in `function_group` pseudo-types
        // (one per visibility bucket per module). The id formula is
        // owned by `module_tree.ts:239`; we mirror it here so the
        // host knows which pseudo-type to expand without having to
        // walk the module tree at click time.
        containingTypeBoxId.set(id, `${moduleId}::__fn_${classifyVisibility(fn.visibility)}`);
        if (fn.span !== undefined) {
          appendToFile({
            elementId: id,
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

  return { forward, byFile, types, callables, containingTypeBoxId };
}

/** Find the DEEPEST (smallest-range) element whose span contains
 *  `line` in `file`. Returns null when no element covers the line —
 *  caller can treat as "click landed in whitespace, don\'t navigate". */
export function findElementAtLine(
  index: SpanIndex,
  file: string,
  line: number,
): string | null {
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
  return best?.elementId ?? null;
}
