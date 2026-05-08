import { describe, expect, it } from 'vitest';
import {
  type RoutingChannelObstacle,
  type RoutingChannelOptions,
  type RoutingChannelRequest,
  buildRoutingObstacleIndex,
  planRoutingChannel,
} from '../src/layout2/routing_channels.ts';

const OPTIONS: RoutingChannelOptions = {
  gridCellSize: 10,
  laneStep: 20,
  maxScan: 2,
  preferredLaneX: 50,
};

function obstacle(
  typeId: string,
  x: number,
  y: number,
  width: number,
  height: number,
): RoutingChannelObstacle {
  return {
    typeId,
    fragmentId: `${typeId}:fragment`,
    x,
    y,
    width,
    height,
  };
}

function request(
  obstacles: readonly RoutingChannelObstacle[] = [],
  options: RoutingChannelOptions = OPTIONS,
): RoutingChannelRequest {
  return {
    source: { x: 0, y: 0 },
    target: { x: 100, y: 60 },
    sourceTypeId: 'source',
    targetTypeId: 'target',
    obstacles,
    options,
  };
}

describe('planRoutingChannel', () => {
  it('uses the preferred one-lane route when no obstacle blocks it', () => {
    const plan = planRoutingChannel(request());

    expect(plan.waypoints).toEqual([
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 60 },
      { x: 100, y: 60 },
    ]);
    expect(plan.metadata).toMatchObject({
      clear: true,
      blocked: false,
      overflowed: false,
      fallback: false,
      strategy: 'direct',
      laneX: 50,
      blockages: [],
    });
  });

  it('scans outward on the lane grid when the initial vertical segment is blocked', () => {
    const plan = planRoutingChannel(request([obstacle('middle', 45, 10, 10, 40)]));

    expect(plan.waypoints).toEqual([
      { x: 0, y: 0 },
      { x: 70, y: 0 },
      { x: 70, y: 60 },
      { x: 100, y: 60 },
    ]);
    expect(plan.metadata).toMatchObject({
      clear: true,
      strategy: 'lane-scan',
      laneX: 70,
      blockages: [],
    });
  });

  it('keeps indexed obstacle queries equivalent to the plain obstacle list', () => {
    const obstacles = [
      obstacle('far-left', -400, -200, 20, 500),
      obstacle('middle', 45, 10, 10, 40),
      obstacle('far-right', 500, -200, 20, 500),
    ];
    const plain = planRoutingChannel(request(obstacles));
    const indexed = planRoutingChannel({
      ...request(obstacles),
      obstacleIndex: buildRoutingObstacleIndex(obstacles, 32),
    });

    expect(indexed).toEqual(plain);
  });

  it('uses a horizontal bypass lane when source and target horizontals stay blocked', () => {
    const plan = planRoutingChannel(
      request([obstacle('source-wall', 20, -5, 60, 15), obstacle('target-wall', 20, 55, 60, 15)], {
        ...OPTIONS,
        maxScan: 2,
      }),
    );

    expect(plan.waypoints).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: -30 },
      { x: 90, y: -30 },
      { x: 90, y: 60 },
      { x: 100, y: 60 },
    ]);
    expect(plan.metadata).toMatchObject({
      clear: true,
      strategy: 'bypass',
      laneX: 10,
      lane2X: 90,
      bypassY: -30,
      blockages: [],
    });
  });

  it('uses a vertical-blocker bypass when every scanned direct lane is blocked', () => {
    const plan = planRoutingChannel({
      ...request(
        [
          obstacle('upper-preferred', 45, 20, 10, 10),
          obstacle('lower-right', 65, 70, 10, 10),
          obstacle('upper-left', 25, 20, 10, 10),
        ],
        { ...OPTIONS, maxScan: 1 },
      ),
      target: { x: 100, y: 100 },
    });

    expect(plan.waypoints).toEqual([
      { x: 0, y: 0 },
      { x: 70, y: 0 },
      { x: 70, y: 50 },
      { x: 50, y: 50 },
      { x: 50, y: 100 },
      { x: 100, y: 100 },
    ]);
    expect(plan.metadata).toMatchObject({
      clear: true,
      strategy: 'bypass',
      laneX: 70,
      lane2X: 50,
      bypassY: 50,
      blockages: [],
    });
  });

  it('keeps vertical-blocker bypass selection deterministic with multiple blockers', () => {
    const blocked: RoutingChannelRequest = {
      ...request(
        [
          obstacle('lower-right', 65, 70, 10, 10),
          obstacle('upper-preferred', 45, 20, 10, 10),
          obstacle('upper-left', 25, 20, 10, 10),
        ],
        { ...OPTIONS, maxScan: 1 },
      ),
      target: { x: 100, y: 100 },
    };

    const first = planRoutingChannel(blocked);
    const second = planRoutingChannel(blocked);

    expect(first).toEqual(second);
    expect(first.metadata).toMatchObject({
      clear: true,
      strategy: 'bypass',
      laneX: 70,
      lane2X: 50,
      bypassY: 50,
    });
  });

  it('ignores source and target endpoint obstacles but not unrelated obstacles', () => {
    const endpointObstacles = [
      obstacle('source', -10, -10, 20, 20),
      obstacle('target', 90, 50, 20, 20),
    ];
    const throughEndpoints = planRoutingChannel(
      request(endpointObstacles, { ...OPTIONS, maxScan: 0 }),
    );

    expect(throughEndpoints.metadata.clear).toBe(true);
    expect(throughEndpoints.metadata.blockages).toEqual([]);

    const blockedByUnrelated = planRoutingChannel(
      request([...endpointObstacles, obstacle('unrelated', 45, 10, 10, 40)], {
        ...OPTIONS,
        maxScan: 0,
      }),
    );

    expect(blockedByUnrelated.metadata).toMatchObject({
      clear: false,
      blocked: true,
      fallback: true,
      overflowed: true,
      strategy: 'fallback',
    });
    expect(blockedByUnrelated.metadata.blockages).toEqual([
      {
        segmentIndex: 1,
        orientation: 'vertical',
        obstacleTypeId: 'unrelated',
        obstacleFragmentId: 'unrelated:fragment',
      },
    ]);
  });

  it('returns deterministic fallback metadata when every scanned route is blocked', () => {
    const blocked = request([obstacle('wall', -100, -100, 300, 300)], {
      ...OPTIONS,
      maxScan: 1,
    });

    const first = planRoutingChannel(blocked);
    const second = planRoutingChannel(blocked);

    expect(first).toEqual(second);
    expect(first.waypoints).toEqual([
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 60 },
      { x: 100, y: 60 },
    ]);
    expect(first.metadata).toMatchObject({
      clear: false,
      blocked: true,
      fallback: true,
      overflowed: true,
      strategy: 'fallback',
      laneX: 50,
    });
    expect(first.metadata.blockages.map((blockage) => blockage.orientation)).toEqual([
      'horizontal',
      'vertical',
      'horizontal',
    ]);
  });
});
