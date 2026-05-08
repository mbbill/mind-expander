// Routing pressure is the bounded feedback contract from routing to placement:
// it can ask for extra grid gap cells on a channel, but it must not mutate box
// clearance, move boxes, or change logical ordering.
export const ARROW_CLASSES = ['forward', 'backward'] as const;

export type ArrowClass = (typeof ARROW_CLASSES)[number];
export type RoutingGapAxis = 'x' | 'y';

interface RoutingChannelBase {
  readonly bandId: string;
  readonly axis: RoutingGapAxis;
}

export interface AfterOrderRoutingChannelKey extends RoutingChannelBase {
  readonly afterOrder: number;
  readonly betweenRegions?: never;
}

export interface BetweenRegionsRoutingChannelKey extends RoutingChannelBase {
  readonly betweenRegions: readonly [string, string];
  readonly afterOrder?: never;
}

export type RoutingChannelKey = AfterOrderRoutingChannelKey | BetweenRegionsRoutingChannelKey;

export type ExtraGap =
  | (AfterOrderRoutingChannelKey & { readonly cells: number })
  | (BetweenRegionsRoutingChannelKey & { readonly cells: number });

export interface RoutingArrowDemand {
  readonly arrowClass: ArrowClass;
  readonly count: number;
}

export interface RoutingDensityConfig {
  readonly maxArrowsPerCell: Readonly<Record<ArrowClass, number>>;
}

export interface RoutingChannelUsage {
  readonly channel: RoutingChannelKey;
  readonly availableCells: number;
  readonly arrows: readonly RoutingArrowDemand[];
}

export interface RoutingPressureInput {
  readonly usages: readonly RoutingChannelUsage[];
  readonly density: RoutingDensityConfig;
}

interface GapAccumulator {
  readonly keyId: string;
  readonly channel: RoutingChannelKey;
  cells: number;
}

export function computeRequiredExtraCells(
  arrows: readonly RoutingArrowDemand[],
  availableCells: number,
  density: RoutingDensityConfig,
): number {
  assertDensityConfig(density);
  assertNonNegativeInteger(availableCells, 'Available routing gap cells');

  return computeRequiredExtraCellsWithValidatedDensity(arrows, availableCells, density);
}

export function computeRoutingPressure(input: RoutingPressureInput): readonly ExtraGap[] {
  assertDensityConfig(input.density);

  const byChannel = new Map<string, GapAccumulator>();

  for (const usage of input.usages) {
    assertRoutingChannelKey(usage.channel);
    assertNonNegativeInteger(usage.availableCells, 'Available routing gap cells');

    const extraCells = computeRequiredExtraCellsWithValidatedDensity(
      usage.arrows,
      usage.availableCells,
      input.density,
    );
    if (extraCells === 0) {
      continue;
    }

    const keyId = routingChannelKeyId(usage.channel);
    const existing = byChannel.get(keyId);
    if (existing === undefined) {
      byChannel.set(keyId, { keyId, channel: usage.channel, cells: extraCells });
      continue;
    }
    existing.cells = Math.max(existing.cells, extraCells);
  }

  return [...byChannel.values()]
    .sort((a, b) => a.keyId.localeCompare(b.keyId))
    .map(({ channel, cells }) => withCells(channel, cells));
}

function computeRequiredExtraCellsWithValidatedDensity(
  arrows: readonly RoutingArrowDemand[],
  availableCells: number,
  density: RoutingDensityConfig,
): number {
  const requiredCells = computeRequiredCells(arrows, density);

  return Math.max(0, requiredCells - availableCells);
}

function computeRequiredCells(
  arrows: readonly RoutingArrowDemand[],
  density: RoutingDensityConfig,
): number {
  const countsByClass = new Map<ArrowClass, number>();

  for (const arrow of arrows) {
    assertArrowClass(arrow.arrowClass);
    assertNonNegativeInteger(arrow.count, 'Routing arrow count');
    countsByClass.set(arrow.arrowClass, (countsByClass.get(arrow.arrowClass) ?? 0) + arrow.count);
  }

  let requiredCells = 0;
  for (const arrowClass of ARROW_CLASSES) {
    const count = countsByClass.get(arrowClass) ?? 0;
    if (count === 0) {
      continue;
    }

    // Mixed channels reserve each arrow class against its own density, then
    // sum the cell needs. This keeps backward-arrow compression from reducing
    // forward-arrow clarity while still using one algorithm for both classes.
    requiredCells += Math.ceil(count / density.maxArrowsPerCell[arrowClass]);
  }

  return requiredCells;
}

function withCells(channel: RoutingChannelKey, cells: number): ExtraGap {
  assertNonNegativeInteger(cells, 'Routing extra gap cells');

  if ('afterOrder' in channel) {
    return {
      bandId: channel.bandId,
      axis: channel.axis,
      afterOrder: channel.afterOrder,
      cells,
    };
  }

  return {
    bandId: channel.bandId,
    axis: channel.axis,
    betweenRegions: channel.betweenRegions,
    cells,
  };
}

function routingChannelKeyId(channel: RoutingChannelKey): string {
  if ('afterOrder' in channel) {
    return JSON.stringify(['after', channel.bandId, channel.axis, channel.afterOrder]);
  }

  return JSON.stringify([
    'between',
    channel.bandId,
    channel.axis,
    channel.betweenRegions[0],
    channel.betweenRegions[1],
  ]);
}

function assertDensityConfig(density: RoutingDensityConfig): void {
  for (const arrowClass of ARROW_CLASSES) {
    const maxArrowsPerCell = density.maxArrowsPerCell[arrowClass];
    if (!Number.isFinite(maxArrowsPerCell) || maxArrowsPerCell <= 0) {
      throw new Error(`Routing density for ${arrowClass} arrows must be a positive number.`);
    }
  }
}

function assertRoutingChannelKey(channel: RoutingChannelKey): void {
  if (channel.bandId.length === 0) {
    throw new Error('Routing channel band id must be non-empty.');
  }
  if (channel.axis !== 'x' && channel.axis !== 'y') {
    throw new Error('Routing channel axis must be x or y.');
  }

  const hasAfterOrder = 'afterOrder' in channel;
  const hasBetweenRegions = 'betweenRegions' in channel;
  if (hasAfterOrder === hasBetweenRegions) {
    throw new Error('Routing channel must identify exactly one gap.');
  }

  if (hasAfterOrder) {
    assertNonNegativeInteger(channel.afterOrder, 'Routing channel afterOrder');
    return;
  }

  const [leftRegion, rightRegion] = channel.betweenRegions;
  if (leftRegion.length === 0 || rightRegion.length === 0 || leftRegion === rightRegion) {
    throw new Error('Routing channel betweenRegions must identify two distinct regions.');
  }
}

function assertArrowClass(arrowClass: ArrowClass): void {
  if (arrowClass !== 'forward' && arrowClass !== 'backward') {
    throw new Error('Routing arrow class must be forward or backward.');
  }
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
}
