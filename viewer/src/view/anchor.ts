export interface AnchorPoint {
  readonly x: number;
  readonly y: number;
}

export interface AnchorTranslation {
  readonly dx: number;
  readonly dy: number;
}

export function anchorTranslation(
  before: AnchorPoint | null,
  after: AnchorPoint | null,
): AnchorTranslation | null {
  if (before === null || after === null) return null;

  // Expansion can move a block in either axis. Keep the inspected point at
  // the same screen position by translating by the full inverse delta, not
  // just the vertical band-height delta.
  return {
    dx: before.x - after.x,
    dy: before.y - after.y,
  };
}
