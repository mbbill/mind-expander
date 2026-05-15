import type { Layout } from '../analysis/layout_model.ts';
import type { FieldKeyKind } from './tree.ts';

export interface LayoutPoint {
  readonly x: number;
  readonly y: number;
}

export function lookupLayoutPoint(layout: Layout | null, id: string): LayoutPoint | null {
  if (!layout) return null;
  for (const t of layout.types) {
    if (t.id === id) return { x: t.x, y: t.y };
  }
  for (const m of layout.modules) {
    if (m.id === id) return { x: m.labelX, y: m.y };
  }
  return null;
}

export function lookupMemberRowPoint(
  layout: Layout | null,
  typePath: string,
  fieldName: string,
  kind: FieldKeyKind,
): LayoutPoint | null {
  if (!layout) return null;
  const typeNode = layout.types.find((type) => type.fullPath === typePath);
  if (typeNode === undefined || !typeNode.expanded) return null;
  const row = typeNode.fields.find(
    (candidate) => candidate.kind === kind && candidate.name === fieldName,
  );
  return row === undefined ? null : { x: row.x, y: row.y };
}

/** Resolve a span-index `(elementId, kind)` pair to a navigation point
 *  by scanning every visible row across every type-box. Handles free
 *  functions (whose id has no owning type) the same way as
 *  fields/methods. `kind` disambiguates a struct field from a method
 *  with the same name on the same type — both share the canonical id
 *  but only one row should win. Returns null when nothing in the
 *  current layout matches (e.g. a row not expanded into view). */
export function lookupElementPoint(
  layout: Layout | null,
  elementId: string,
  kind: 'type' | 'field' | 'method' | 'function',
): LayoutPoint | null {
  if (!layout) return null;
  for (const typeNode of layout.types) {
    if (kind === 'type' && typeNode.fullPath === elementId) {
      return { x: typeNode.x, y: typeNode.y };
    }
    if (!typeNode.expanded) continue;
    for (const row of typeNode.fields) {
      if (row.kind === 'method_bucket' || row.kind === 'signature_arg') continue;
      if (kind === 'method' || kind === 'function') {
        if (
          (row.kind === 'method' || row.kind === 'function') &&
          row.functionFullPath === elementId
        ) {
          return { x: row.x, y: row.y };
        }
      } else if (kind === 'field') {
        if (row.kind === 'field' && `${typeNode.fullPath}::${row.name}` === elementId) {
          return { x: row.x, y: row.y };
        }
      }
    }
  }
  return null;
}
