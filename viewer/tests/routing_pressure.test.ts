import { describe, expect, it } from 'vitest';
import {
  type RoutingChannelKey,
  type RoutingDensityConfig,
  computeRequiredExtraCells,
  computeRoutingPressure,
} from '../src/layout/routing_pressure.ts';

const DENSITY: RoutingDensityConfig = {
  maxArrowsPerCell: {
    forward: 2,
    backward: 4,
  },
};

function afterOrder(afterOrder = 0): RoutingChannelKey {
  return {
    bandId: 'band:a',
    axis: 'x',
    afterOrder,
  };
}

describe('layout routing pressure', () => {
  it('fits two forward arrows in one cell and requests one more for three', () => {
    expect(computeRequiredExtraCells([{ arrowClass: 'forward', count: 2 }], 1, DENSITY)).toBe(0);
    expect(computeRequiredExtraCells([{ arrowClass: 'forward', count: 3 }], 1, DENSITY)).toBe(1);
  });

  it('lets backward arrows use the same pressure path with their denser config', () => {
    expect(computeRequiredExtraCells([{ arrowClass: 'backward', count: 3 }], 1, DENSITY)).toBe(0);
  });

  it('uses the same algorithm for forward and backward classes but different densities', () => {
    const density: RoutingDensityConfig = {
      maxArrowsPerCell: {
        forward: 1,
        backward: 4,
      },
    };

    expect(computeRequiredExtraCells([{ arrowClass: 'forward', count: 2 }], 1, density)).toBe(1);
    expect(computeRequiredExtraCells([{ arrowClass: 'backward', count: 2 }], 1, density)).toBe(0);
  });

  it('sums class-specific cell needs for mixed channels deterministically', () => {
    const pressure = computeRoutingPressure({
      density: DENSITY,
      usages: [
        {
          channel: afterOrder(),
          availableCells: 1,
          arrows: [
            { arrowClass: 'forward', count: 3 },
            { arrowClass: 'backward', count: 5 },
          ],
        },
      ],
    });

    expect(pressure).toEqual([
      {
        bandId: 'band:a',
        axis: 'x',
        afterOrder: 0,
        cells: 3,
      },
    ]);
  });

  it('merges multiple usages for the same channel by max extra cells', () => {
    const pressure = computeRoutingPressure({
      density: DENSITY,
      usages: [
        {
          channel: afterOrder(1),
          availableCells: 1,
          arrows: [{ arrowClass: 'forward', count: 3 }],
        },
        {
          channel: afterOrder(1),
          availableCells: 1,
          arrows: [{ arrowClass: 'forward', count: 5 }],
        },
        {
          channel: afterOrder(1),
          availableCells: 1,
          arrows: [{ arrowClass: 'backward', count: 4 }],
        },
      ],
    });

    expect(pressure).toEqual([
      {
        bandId: 'band:a',
        axis: 'x',
        afterOrder: 1,
        cells: 2,
      },
    ]);
  });

  it('returns gap constraints rather than modifying box clearance', () => {
    const pressure = computeRoutingPressure({
      density: DENSITY,
      usages: [
        {
          channel: { bandId: 'band:a', axis: 'y', betweenRegions: ['left', 'right'] },
          availableCells: 0,
          arrows: [{ arrowClass: 'forward', count: 1 }],
        },
      ],
    });

    expect(pressure).toEqual([
      {
        bandId: 'band:a',
        axis: 'y',
        betweenRegions: ['left', 'right'],
        cells: 1,
      },
    ]);
    expect(pressure[0]).not.toHaveProperty('top');
    expect(pressure[0]).not.toHaveProperty('right');
    expect(pressure[0]).not.toHaveProperty('bottom');
    expect(pressure[0]).not.toHaveProperty('left');
  });

  it('omits zero-arrow demand and rejects invalid densities or cell bounds', () => {
    expect(
      computeRoutingPressure({
        density: DENSITY,
        usages: [{ channel: afterOrder(), availableCells: 0, arrows: [] }],
      }),
    ).toEqual([]);
    expect(
      computeRoutingPressure({
        density: DENSITY,
        usages: [
          {
            channel: afterOrder(),
            availableCells: 0,
            arrows: [{ arrowClass: 'forward', count: 0 }],
          },
        ],
      }),
    ).toEqual([]);

    expect(() =>
      computeRequiredExtraCells([{ arrowClass: 'forward', count: 1 }], 0, {
        maxArrowsPerCell: { forward: 0, backward: 4 },
      }),
    ).toThrow(/positive number/);
    expect(() =>
      computeRequiredExtraCells([{ arrowClass: 'forward', count: 1 }], -1, DENSITY),
    ).toThrow(/non-negative integer/);
    expect(() =>
      computeRequiredExtraCells([{ arrowClass: 'forward', count: -1 }], 0, DENSITY),
    ).toThrow(/non-negative integer/);
    expect(() =>
      computeRoutingPressure({
        density: DENSITY,
        usages: [{ channel: afterOrder(-1), availableCells: 0, arrows: [] }],
      }),
    ).toThrow(/non-negative integer/);
  });
});
