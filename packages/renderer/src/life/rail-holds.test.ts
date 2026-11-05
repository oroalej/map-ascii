import { describe, expect, it } from 'vitest';
import { metersPerUnit, tileToLngLat } from '../raster/geometry';
import { activityLevels } from './config';
import { LifeBuilder, LifeLine, type LifeGeometry } from './geometry';
import { RAIL_CROSSING } from './rail-crossings';
import { LifeWorld, TileLife, trainLength, type Mover } from './simulate';
import { worldTiles } from './testing/scenarios';
import { crossingStates } from './train-motion';

const tile = { z: 16, x: 55192, y: 30266 };
const pm = 1 / metersPerUnit(tile);
const CROSS_X = 2048;
const ROAD_Y = 2048;
const cars = ['locomotive', 'coach'] as const;

/** A rail running east, and a road running south over it at `CROSS_X`. */
function crossing(): LifeGeometry {
  const b = new LifeBuilder();
  b.line(
    [
      { x: -200, y: ROAD_Y },
      { x: CROSS_X, y: ROAD_Y },
      { x: 4300, y: ROAD_Y },
    ],
    LifeLine.rail,
  );
  b.line(
    [
      { x: CROSS_X, y: 0 },
      { x: CROSS_X, y: ROAD_Y },
      { x: CROSS_X, y: 4095 },
    ],
    LifeLine.roadMajor,
    12,
  );
  return b.finish();
}

/** A train on the rail above with its head at `x`, in tile units. */
function train(x: number, dir: 1 | -1 = 1, speed = 10): Mover {
  const line = 0;
  return {
    kind: 'train',
    line,
    // Vertices: 0 at the west end, 1 at the road, 2 at the east end.
    from: dir === 1 ? (x < CROSS_X ? 0 : 1) : x > CROSS_X ? 2 : 1,
    dir,
    d: dir === 1 ? (x < CROSS_X ? x + 200 : x - CROSS_X) : x > CROSS_X ? 4300 - x : CROSS_X - x,
    speed: speed * pm,
    v: speed * pm,
    paint: 0,
    lane: 0,
    pause: 0,
    rank: 0,
    x,
    y: ROAD_Y,
    hx: dir,
    hy: 0,
    train: {
      cars: [...cars],
      trail: [x - dir * trainLength(cars) * pm, ROAD_Y],
      edge: false,
      reverse: false,
      stopX: NaN,
      stopY: NaN,
    },
  };
}

/** A car heading south on the road, its center at `y`. */
function car(y: number, speed = 8): Mover {
  return {
    kind: 'vehicle',
    vehicle: 'car',
    line: 1,
    from: y < ROAD_Y ? 3 : 4,
    dir: 1,
    d: y < ROAD_Y ? y : y - ROAD_Y,
    speed: speed * pm,
    v: speed * pm,
    paint: 0,
    lane: 0,
    pause: 0,
    rank: 0,
    x: CROSS_X,
    y,
    hx: 0,
    hy: 1,
  };
}

const setup = (geo = crossing()) => {
  const world = new LifeWorld();
  world.sync([{ key: 'rail', tile, life: geo }]);
  const life = worldTiles(world).get('rail')!;
  life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
  world.visible(18, activityLevels(1), tileToLngLat(tile, { x: CROSS_X, y: ROAD_Y }));
  return { world, life };
};
const place = (life: TileLife, ...movers: Mover[]) =>
  life.movers.splice(0, life.movers.length, ...movers);
const state = (life: TileLife) => {
  crossingStates([life]);
  return life.railCrossings.crossings[0]!;
};

describe('closing a crossing for a train', () => {
  const away = (seconds: number, speed = 10) => CROSS_X - seconds * speed * pm;

  it('closes in time, softly at first and firmly as the train nears', () => {
    const { life } = setup();
    place(life, train(away(RAIL_CROSSING.warnSeconds + 2)));
    expect(state(life).closed).toBe(false);
    place(life, train(away(RAIL_CROSSING.warnSeconds - 1)));
    expect(state(life)).toMatchObject({ closed: true, firm: false });
    place(life, train(away(RAIL_CROSSING.firmSeconds - 1)));
    expect(state(life)).toMatchObject({ closed: true, firm: true });
  });

  it('closes from either direction', () => {
    const { life } = setup();
    place(life, train(CROSS_X + 60 * pm, -1));
    expect(state(life).closed).toBe(true);
    place(life, train(CROSS_X + 150 * pm, -1));
    expect(state(life).closed).toBe(false);
  });

  it('stays closed under the train and opens once its tail clears', () => {
    const { life } = setup();
    const length = trainLength(cars) * pm;
    place(life, train(CROSS_X + length / 2));
    expect(state(life)).toMatchObject({ closed: true, firm: true });
    place(life, train(CROSS_X + length + (RAIL_CROSSING.bodyReach - 1) * pm));
    expect(state(life).closed).toBe(true);
    place(life, train(CROSS_X + length + (RAIL_CROSSING.bodyReach + 1) * pm));
    expect(state(life).closed).toBe(false);
  });

  it('stays open for a train heading away, and opens when none is left', () => {
    const { life } = setup();
    place(life, train(CROSS_X + 200 * pm));
    expect(state(life).closed).toBe(false);
    place(life, train(away(5)));
    expect(state(life).closed).toBe(true);
    place(life);
    expect(state(life).closed).toBe(false);
  });

  it('stays open for a train dwelling clear of it, closed for one standing on it', () => {
    const { life } = setup();
    const dwelling = train(away(5));
    dwelling.pause = 20;
    dwelling.v = 0;
    place(life, dwelling);
    expect(state(life).closed).toBe(false);
    const over = train(CROSS_X + 10 * pm);
    over.pause = 20;
    over.v = 0;
    place(life, over);
    expect(state(life).closed).toBe(true);
  });

  it('ignores the hidden copy of a train waiting at its tile edge', () => {
    const { life } = setup();
    const waiting = train(CROSS_X + 10 * pm);
    waiting.train!.edge = true;
    place(life, waiting);
    expect(state(life).closed).toBe(false);
  });

  it('counts a train in the neighbouring tile', () => {
    const track = (b: LifeBuilder) =>
      b.line(
        [
          { x: -200, y: ROAD_Y },
          { x: 4300, y: ROAD_Y },
        ],
        LifeLine.rail,
      );
    const near = new LifeBuilder();
    track(near);
    near.line(
      [
        { x: 4000, y: 0 },
        { x: 4000, y: 4095 },
      ],
      LifeLine.roadMajor,
      12,
    );
    const far = new LifeBuilder();
    track(far);
    const world = new LifeWorld();
    world.sync([
      { key: 'west', tile, life: near.finish() },
      { key: 'east', tile: { ...tile, x: tile.x + 1 }, life: far.finish() },
    ]);
    const west = worldTiles(world).get('west')!;
    const east = worldTiles(world).get('east')!;
    for (const life of [west, east])
      life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
    // Its head is 60 m east of the crossing, across the tile edge, coming west at 10 m/s.
    const x = 4000 + 60 * pm - 4096;
    const coming = train(x, -1);
    coming.from = 1;
    coming.d = 4300 - x;
    east.movers.push(coming);
    crossingStates([west, east]);
    expect(west.railCrossings.crossings[0]!.closed).toBe(true);
  });

  it('leaves a tile without crossings alone', () => {
    const b = new LifeBuilder();
    b.line(
      [
        { x: 0, y: 500 },
        { x: 4095, y: 500 },
      ],
      LifeLine.roadMinor,
      6,
    );
    const life = new TileLife(tile, b.finish(), 1);
    expect(life.railCrossings.crossings).toEqual([]);
    expect(() => crossingStates([life])).not.toThrow();
  });
});

describe('holding traffic at a closed crossing', () => {
  const run = (world: LifeWorld, seconds: number, each?: () => void) => {
    for (let t = 0; t < seconds; t += 0.1) {
      world.step(0.1, undefined, 18);
      each?.();
    }
  };

  it('queues a vehicle behind the stop until the train has gone', () => {
    const { world, life } = setup();
    const slow = train(CROSS_X - 60 * pm, 1, 5);
    const m = car(ROAD_Y - 80 * pm);
    place(life, slow, m);
    let held = false;
    let furthest = -Infinity;
    run(world, 25, () => {
      const closed = life.railCrossings.crossings[0]!.closed;
      if (closed) furthest = Math.max(furthest, m.y);
      if (closed && (m.v ?? 0) < 0.01) held = true;
    });
    expect(held).toBe(true);
    // While it was shut, the car's nose never passed the stop by more than the tolerance.
    const nose = furthest + 2.2 * pm;
    expect(nose).toBeLessThanOrEqual(ROAD_Y - (RAIL_CROSSING.stopBack - 0.6) * pm);
    run(world, 40);
    expect(life.railCrossings.crossings[0]!.closed).toBe(false);
    expect(m.y).toBeGreaterThan(ROAD_Y);
  });

  it('lets a vehicle already past the stop keep going', () => {
    const { world, life } = setup();
    const m = car(ROAD_Y - 3 * pm);
    place(life, train(CROSS_X - 60 * pm), m);
    const start = m.y;
    run(world, 2);
    expect(m.y).toBeGreaterThan(start + 3 * pm);
  });

  it('lets a vehicle that cannot stop in time run a new closure, not a firm one', () => {
    const { life } = setup();
    place(life, train(CROSS_X - 100 * pm));
    const crossing = state(life);
    expect(crossing).toMatchObject({ closed: true, firm: false });
    const fast = car(ROAD_Y - 10 * pm, 14);
    const soft = { target: fast.speed, cap: Infinity };
    expect(life.railCrossings.vehicleLimit(fast, 0.1, soft)).toBe(false);
    expect(soft.cap).toBe(Infinity);
    crossing.firm = true;
    const firm = { target: fast.speed, cap: Infinity };
    life.railCrossings.vehicleLimit(fast, 0.1, firm);
    expect(firm.cap).toBeLessThan(Infinity);
  });

  it('holds only traffic coming toward the rail', () => {
    const { life } = setup();
    place(life, train(CROSS_X - 60 * pm));
    crossingStates([life]);
    const leaving = car(ROAD_Y + 20 * pm);
    const limit = { target: leaving.speed, cap: Infinity };
    life.railCrossings.vehicleLimit(leaving, 0.1, limit);
    expect(limit.cap).toBe(Infinity);
  });

  it('never slows the train', () => {
    const { world, life } = setup();
    const t = train(CROSS_X - 60 * pm);
    place(life, t, car(ROAD_Y - 40 * pm));
    const before = t.x;
    run(world, 2);
    expect(t.x).toBeGreaterThan(before + 15 * pm);
  });
});
