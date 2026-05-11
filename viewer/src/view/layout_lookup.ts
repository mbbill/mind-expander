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
