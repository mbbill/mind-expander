import {
  type Clearance,
  type GridRect,
  type GridSpec,
  type LayoutBox,
  ZERO_CLEARANCE,
  layoutBox,
  snapPxRectToGrid,
} from './grid.ts';

export type LayoutBoxFragmentKind = 'main' | 'body' | 'split-row';

export interface MeasuredBoxPart {
  readonly measuredWidthPx: number;
  readonly measuredHeightPx: number;
}

export interface MeasuredLayoutRow extends MeasuredBoxPart {
  readonly id: string;
  readonly name: string;
}

export interface MeasuredLayoutObject {
  readonly objectId: string;
  readonly name: string;
  readonly header: MeasuredBoxPart;
  readonly rows: readonly MeasuredLayoutRow[];
  readonly grid: GridSpec;
  readonly clearance?: LayoutBoxFragmentClearance;
  readonly splitStrategy?: LayoutBoxSplitStrategy;
}

export interface LayoutBoxFragmentClearance {
  readonly main?: Clearance;
  readonly body?: Clearance;
  readonly splitRow?: Clearance;
}

export interface LayoutBoxSplitStrategyInput {
  readonly objectId: string;
  readonly name: string;
  readonly header: MeasuredBoxPart;
  readonly rows: readonly MeasuredLayoutRow[];
}

export type LayoutBoxSplitStrategy = (input: LayoutBoxSplitStrategyInput) => readonly string[];

export interface LayoutBoxFragments {
  readonly ownerId: string;
  readonly ownerName: string;
  readonly fragments: readonly LayoutBoxFragment[];
}

export interface LayoutBoxFragment extends LayoutBox {
  readonly ownerId: string;
  readonly ownerName: string;
  /**
   * Owner-local fragment key. This is intentionally not a graph/node id:
   * `ownerId + fragmentIndex/kind` preserves visual identity while giving
   * placement, collision, and routing code a stable handle for each box.
   */
  readonly fragmentId: string;
  readonly fragmentIndex: number;
  readonly kind: LayoutBoxFragmentKind;
  readonly rowIds: readonly string[];
  readonly measuredWidthPx: number;
  readonly measuredHeightPx: number;
  readonly requestedClearance: Clearance;
}

export const DEFAULT_LONG_ROW_SPLIT_MIN_WIDTH_PX = 360;
export const DEFAULT_LONG_ROW_SPLIT_MEDIAN_RATIO = 1.8;

export function buildLayoutBoxFragments(input: MeasuredLayoutObject): LayoutBoxFragments {
  assertNonNegativeMeasurement(input.header, 'header');
  assertUniqueRowIds(input.rows);
  for (const row of input.rows) {
    assertNonNegativeMeasurement(row, `row ${row.id}`);
  }

  const strategy = input.splitStrategy ?? choosePlaceholderLongRowSplits;
  const splitRowIds = normalizeSplitRowIds(strategy(strategyInput(input)), input.rows);
  const mainClearance = input.clearance?.main ?? ZERO_CLEARANCE;
  const bodyClearance = input.clearance?.body ?? mainClearance;
  const splitRowClearance = input.clearance?.splitRow ?? ZERO_CLEARANCE;
  const fragments: LayoutBoxFragment[] = [];
  let nextLocalGridRow = 0;
  let headerPending = true;
  let pendingNormalRows: MeasuredLayoutRow[] = [];

  const pushFragment = (
    kind: LayoutBoxFragmentKind,
    rows: readonly MeasuredLayoutRow[],
    measured: MeasuredBoxPart,
    clearance: Clearance,
  ): void => {
    const fragment = makeFragment({
      ownerId: input.objectId,
      ownerName: input.name,
      fragmentIndex: fragments.length,
      kind,
      rowIds: rows.map((row) => row.id),
      measuredWidthPx: measured.measuredWidthPx,
      measuredHeightPx: measured.measuredHeightPx,
      localGridRow: nextLocalGridRow,
      grid: input.grid,
      clearance,
    });
    fragments.push(fragment);
    nextLocalGridRow += fragment.own.rows;
  };

  const flushNormalFragment = (): void => {
    if (!headerPending && pendingNormalRows.length === 0) {
      return;
    }

    const kind = headerPending ? 'main' : 'body';
    const measured = measureNormalFragment(headerPending ? input.header : null, pendingNormalRows);
    pushFragment(
      kind,
      pendingNormalRows,
      measured,
      kind === 'main' ? mainClearance : bodyClearance,
    );
    pendingNormalRows = [];
    headerPending = false;
  };

  for (const row of input.rows) {
    if (!splitRowIds.has(row.id)) {
      pendingNormalRows.push(row);
      continue;
    }

    flushNormalFragment();
    pushFragment('split-row', [row], row, splitRowClearance);
  }

  flushNormalFragment();

  return {
    ownerId: input.objectId,
    ownerName: input.name,
    fragments,
  };
}

export function choosePlaceholderLongRowSplits(
  input: LayoutBoxSplitStrategyInput,
): readonly string[] {
  const normalCandidateWidths = input.rows
    .map((row) => row.measuredWidthPx)
    .filter((width) => width < DEFAULT_LONG_ROW_SPLIT_MIN_WIDTH_PX);
  const baselineWidth = Math.max(median(normalCandidateWidths) ?? input.header.measuredWidthPx, 1);

  // Placeholder policy for the staged refactor: split only rows that are both
  // absolutely wide and wide relative to the currently normal-looking rows.
  // Keeping this behind a strategy lets later tuning change the threshold
  // without changing the measurement-to-fragment contract.
  return input.rows
    .filter(
      (row) =>
        row.measuredWidthPx >= DEFAULT_LONG_ROW_SPLIT_MIN_WIDTH_PX &&
        row.measuredWidthPx >= baselineWidth * DEFAULT_LONG_ROW_SPLIT_MEDIAN_RATIO,
    )
    .map((row) => row.id);
}

interface FragmentInput {
  readonly ownerId: string;
  readonly ownerName: string;
  readonly fragmentIndex: number;
  readonly kind: LayoutBoxFragmentKind;
  readonly rowIds: readonly string[];
  readonly measuredWidthPx: number;
  readonly measuredHeightPx: number;
  readonly localGridRow: number;
  readonly grid: GridSpec;
  readonly clearance: Clearance;
}

function makeFragment(input: FragmentInput): LayoutBoxFragment {
  const snapped = snapMeasuredSizeToGrid(input.measuredWidthPx, input.measuredHeightPx, input.grid);
  const own: GridRect = {
    ...snapped,
    row: input.localGridRow,
  };
  const box = layoutBox(own, input.clearance);

  return {
    ownerId: input.ownerId,
    ownerName: input.ownerName,
    fragmentId: `${input.fragmentIndex}:${input.kind}`,
    fragmentIndex: input.fragmentIndex,
    kind: input.kind,
    rowIds: input.rowIds,
    measuredWidthPx: input.measuredWidthPx,
    measuredHeightPx: input.measuredHeightPx,
    requestedClearance: input.clearance,
    own: box.own,
    clearance: box.clearance,
  };
}

function measureNormalFragment(
  header: MeasuredBoxPart | null,
  rows: readonly MeasuredLayoutRow[],
): MeasuredBoxPart {
  let measuredWidthPx = header?.measuredWidthPx ?? 0;
  let measuredHeightPx = header?.measuredHeightPx ?? 0;

  for (const row of rows) {
    measuredWidthPx = Math.max(measuredWidthPx, row.measuredWidthPx);
    measuredHeightPx += row.measuredHeightPx;
  }

  return {
    measuredWidthPx,
    measuredHeightPx,
  };
}

function snapMeasuredSizeToGrid(width: number, height: number, grid: GridSpec): GridRect {
  return snapPxRectToGrid({ x: 0, y: 0, width, height }, grid);
}

function strategyInput(input: MeasuredLayoutObject): LayoutBoxSplitStrategyInput {
  return {
    objectId: input.objectId,
    name: input.name,
    header: input.header,
    rows: input.rows,
  };
}

function normalizeSplitRowIds(
  splitIds: readonly string[],
  rows: readonly MeasuredLayoutRow[],
): ReadonlySet<string> {
  const rowIds = new Set(rows.map((row) => row.id));
  const normalized = new Set<string>();

  for (const id of splitIds) {
    if (!rowIds.has(id)) {
      throw new Error(`Layout box split strategy returned unknown row id: ${id}`);
    }
    if (normalized.has(id)) {
      throw new Error(`Layout box split strategy returned duplicate row id: ${id}`);
    }
    normalized.add(id);
  }

  return normalized;
}

function assertUniqueRowIds(rows: readonly MeasuredLayoutRow[]): void {
  const ids = new Set<string>();
  for (const row of rows) {
    if (ids.has(row.id)) {
      throw new Error(`Measured layout rows must have unique ids: ${row.id}`);
    }
    ids.add(row.id);
  }
}

function assertNonNegativeMeasurement(part: MeasuredBoxPart, label: string): void {
  if (part.measuredWidthPx < 0 || part.measuredHeightPx < 0) {
    throw new Error(`Measured ${label} dimensions must be non-negative.`);
  }
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid];
  if (upper === undefined) {
    return null;
  }
  if (sorted.length % 2 === 1) {
    return upper;
  }

  const lower = sorted[mid - 1];
  return lower === undefined ? upper : (lower + upper) / 2;
}
