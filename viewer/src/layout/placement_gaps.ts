export type PlacementGapAxis = 'x' | 'y';

interface PlacementGapBase {
  readonly bandId: string;
  readonly axis: PlacementGapAxis;
}

export interface AfterOrderPlacementGapKey extends PlacementGapBase {
  readonly afterOrder: number;
}

export interface BetweenRegionsPlacementGapKey extends PlacementGapBase {
  readonly betweenRegions: readonly [string, string];
}

export type ExtraGap =
  | (AfterOrderPlacementGapKey & { readonly cells: number })
  | (BetweenRegionsPlacementGapKey & { readonly cells: number });
