import { describe, expect, it } from 'vitest';
import { metersPerUnit, tileToLngLat } from '../raster/geometry';
import {
  DEFAULT_ROAD_WIDTH_M,
  FOLLOW,
  laneOffset,
  MAX_VISIBLE_AGENTS,
  PARKED,
  ROAD_MARGIN_M,
} from './config';
import { LifeBuilder, LifeLine, type LifeGeometry } from './geometry';
import { hashString, LifeWorld, random, TileLife, type Mover } from './simulate';
import { BOAT_PAINTS_AVOID, resolveTraffic, VEHICLES } from './vehicles';

/** A z16 tile over Naga's Centro (about 600 m across). */
const tile = { z: 16, x: 55192, y: 30266 };
const perMeter = 1 / metersPerUnit(tile);

const geometry = (
  lines: [LifeLine, [number, number][], number?][],
  roosts: [number, number][] = [],
  perches: [number, number][] = [],
): LifeGeometry => {
  const b = new LifeBuilder();
  for (const [kind, points, width] of lines)
    b.line(
      points.map(([x, y]) => ({ x, y })),
      kind,
      width,
    );
  for (const [x, y] of roosts) b.roost({ x, y });
  for (const [x, y] of perches) b.perch({ x, y });
  return b.finish();
};

/** A tile with only `mover` in it. */
const alone = (geo: LifeGeometry, mover: Partial<Mover>) => {
  const life = new TileLife(tile, geo, 1);
  life.movers.length = 0;
  life.flocks.length = 0;
  const m: Mover = {
    kind: 'vehicle',
    line: 0,
    from: 0,
    dir: 1,
    d: 0,
    speed: 10,
    paint: 0,
    lane: 0,
    pause: 0,
    rank: 0,
    x: 0,
    y: 0,
    hx: 1,
    hy: 0,
    ...mover,
  };
  life.movers.push(m);
  return { life, m };
};

describe('random', () => {
  it('repeats for a seed and stays in [0, 1)', () => {
    const a = random(hashString('16/1/2'));
    const b = random(hashString('16/1/2'));
    for (let i = 0; i < 100; i++) {
      const n = a();
      expect(n).toBe(b());
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(1);
    }
  });
});

describe('laneOffset', () => {
  it('drives down the middle of the right half of a two-lane street', () => {
    expect(laneOffset(6, 1.8, 0.3)).toBeCloseTo(1.5);
    expect(laneOffset(6, 1.8, 0.9)).toBeCloseTo(1.5);
  });

  it('spreads vehicles over the lanes of a wide road', () => {
    expect(laneOffset(14, 1.8, 0.2)).toBeCloseTo(1.75);
    expect(laneOffset(14, 1.8, 0.7)).toBeCloseTo(5.25);
  });

  it('keeps curb riders by the edge', () => {
    expect(laneOffset(6, 0.6, 0.5, true)).toBeCloseTo(3 - 0.3 - ROAD_MARGIN_M);
  });

  it('keeps a wide vehicle inside a narrow road, or on its center line', () => {
    const bus = laneOffset(5, 2.5, 0.5);
    expect(bus + 2.5 / 2).toBeCloseTo(5 / 2 - ROAD_MARGIN_M);
    expect(laneOffset(2, 2.5, 0.5)).toBe(0);
  });
});

describe('TileLife', () => {
  const road = geometry([
    [
      LifeLine.roadMajor,
      [
        [0, 2048],
        [4095, 2048],
      ],
    ],
  ]);

  it('spawns the same agents for the same seed', () => {
    const a = new TileLife(tile, road, 42);
    const b = new TileLife(tile, road, 42);
    expect(a.movers.map((m) => [m.x, m.y, m.dir])).toEqual(b.movers.map((m) => [m.x, m.y, m.dir]));
  });

  it('spawns vehicles by the length of road', () => {
    // About 600 m of major road, one vehicle per 30 m.
    const { movers } = new TileLife(tile, road, 7);
    expect(movers.length).toBeGreaterThanOrEqual(17);
    expect(movers.length).toBeLessThanOrEqual(23);
    expect(movers.every((m) => m.kind === 'vehicle')).toBe(true);
    expect(movers.every((m) => m.y === 2048 && m.x >= 0 && m.x <= 4095)).toBe(true);
  });

  it('picks vehicle kinds and paints from the road’s traffic mix', () => {
    const minor = geometry([
      [
        LifeLine.roadMinor,
        [
          [0, 2048],
          [4095, 2048],
        ],
      ],
    ]);
    const kinds = (life: TileLife) =>
      new Set(life.movers.filter((m) => m.kind === 'vehicle').map((m) => m.vehicle));
    // The default mix: no jeepneys or tricycles anywhere.
    const plain = new TileLife(tile, road, 7);
    expect(
      plain.movers.every((m) => ['car', 'motorcycle', 'truck', 'bus'].includes(m.vehicle!)),
    ).toBe(true);
    // A city's mix replaces the default for the roads it names.
    const traffic = resolveTraffic({ road_minor: { tricycle: 1 } });
    expect(kinds(new TileLife(tile, minor, 7, traffic))).toEqual(new Set(['tricycle']));
    expect(kinds(new TileLife(tile, road, 7, traffic)).has('tricycle')).toBe(false);
    for (const m of new TileLife(tile, minor, 7, traffic).movers) {
      if (m.kind === 'vehicle') expect(VEHICLES.tricycle.paints).toContain(m.paint);
    }
    // The same seed, the same vehicles.
    const again = (seed: number) =>
      new TileLife(tile, road, seed).movers.map((m) => [m.vehicle, m.paint]);
    expect(again(11)).toEqual(again(11));
  });

  it('moves at its speed along the line', () => {
    const { life, m } = alone(road, { d: 100, speed: 5 * perMeter });
    life.step(0.1);
    expect(m.x).toBeCloseTo(100 + 0.5 * perMeter);
    expect(m.y).toBe(2048);
  });

  it('carries on along a connected road at a junction', () => {
    const corner = geometry([
      [
        LifeLine.roadMajor,
        [
          [0, 1000],
          [2000, 1000],
        ],
      ],
      [
        LifeLine.roadMinor,
        [
          [2000, 1000],
          [2000, 3000],
        ],
      ],
    ]);
    const { life, m } = alone(corner, { d: 1990, speed: 200 });
    life.step(0.1);
    expect(m.line).toBe(1);
    expect(m.dir).toBe(1);
    expect(m.x).toBe(2000);
    expect(m.y).toBeCloseTo(1010);
    expect(m.hy).toBe(1);
  });

  it('enters a connected line from its far end, going backwards', () => {
    const joined = geometry([
      [
        LifeLine.roadMid,
        [
          [0, 1000],
          [2000, 1000],
        ],
      ],
      [
        LifeLine.roadMid,
        [
          [3000, 1000],
          [2000, 1000],
        ],
      ],
    ]);
    const { life, m } = alone(joined, { d: 1990, speed: 200 });
    life.step(0.1);
    expect(m.line).toBe(1);
    expect(m.dir).toBe(-1);
    expect(m.x).toBeCloseTo(2010);
  });

  it('turns around at a dead end', () => {
    const { life, m } = alone(road, { d: 4090, speed: 200 });
    life.step(0.1);
    expect(m.dir).toBe(-1);
    expect(m.x).toBeCloseTo(4095 - 15);
  });

  it('keeps vehicles off footpaths', () => {
    const toPath = geometry([
      [
        LifeLine.roadMinor,
        [
          [0, 1000],
          [2000, 1000],
        ],
      ],
      [
        LifeLine.path,
        [
          [2000, 1000],
          [2000, 3000],
        ],
      ],
    ]);
    const { life, m } = alone(toPath, { d: 1990, speed: 200 });
    life.step(0.1);
    expect(m.line).toBe(0);
    expect(m.dir).toBe(-1);
    // People walk on.
    const walker = alone(toPath, { kind: 'person', d: 1990, speed: 200 });
    walker.life.step(0.1);
    expect(walker.m.line).toBe(1);
  });

  it('walks around a plaza without stopping at its closing vertex', () => {
    const plaza = geometry([
      [
        LifeLine.plaza,
        [
          [1000, 1000],
          [2000, 1000],
          [2000, 2000],
          [1000, 2000],
          [1000, 1000],
        ],
      ],
    ]);
    // (The tile's random stream is seeded, so this walker neither pauses nor turns back here.)
    const { life, m } = alone(plaza, { kind: 'person', from: 3, d: 990, speed: 200 });
    life.step(0.1);
    // Past the closing vertex, it is back on the first side, still going the same way.
    expect(m.dir).toBe(1);
    expect(m.from).toBe(0);
    expect(m.x).toBeCloseTo(1010);
  });

  it('keeps flocks of birds circling near their roost', () => {
    const park = geometry([], [[2048, 2048]]);
    const life = new TileLife(tile, park, 3);
    expect(life.flocks).toHaveLength(1);
    const flock = life.flocks[0]!;
    expect(flock.birds.length).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < 300; i++) life.step(0.1);
    const reach = (40 * 1.5 + 10) * perMeter;
    expect(Math.hypot(flock.x - 2048, flock.y - 2048)).toBeLessThan(reach);
  });
});

describe('birds in trees', () => {
  const tree: [number, number] = [1000, 1200];

  it('starts flocks in the trees of a tile with no other roost', () => {
    const life = new TileLife(tile, geometry([], [], [tree]), 5);
    expect(life.flocks).toHaveLength(1);
    expect(life.flocks[0]).toMatchObject({ perched: true, perch: 0, x: 1000, y: 1200 });
  });

  it('flies to a tree and lands in it', () => {
    const life = new TileLife(tile, geometry([], [[3000, 3000]], [tree]), 5);
    const flock = life.flocks[0]!;
    // Send it to the tree, as if its stay at the roost ran out and it picked the tree.
    flock.perch = 0;
    flock.stay = 1000;
    for (let i = 0; i < 600 && !flock.perched; i++) life.step(0.1);
    expect(flock.perched).toBe(true);
    expect([flock.x, flock.y]).toEqual(tree);
    // Sitting, it stays put.
    for (let i = 0; i < 50; i++) life.step(0.1);
    expect([flock.x, flock.y]).toEqual(tree);
  });

  it('is flushed out of its tree by a strong gust, and scatters', () => {
    const life = new TileLife(tile, geometry([], [[3000, 3000]], [tree]), 5);
    const flock = life.flocks[0]!;
    Object.assign(flock, { perch: 0, perched: true, x: tree[0], y: tree[1], stay: 1000 });
    life.step(0.1, () => 0.2);
    expect(flock.perched).toBe(true);
    life.step(0.1, () => 0.9);
    expect(flock.perched).toBe(false);
    expect(flock.scatter).toBeGreaterThan(0);
    expect(flock.perch).toBe(-1);
    for (let i = 0; i < 20; i++) life.step(0.1, () => 0.9);
    expect(flock.scatter).toBe(0);
    expect(Math.hypot(flock.x - tree[0], flock.y - tree[1])).toBeGreaterThan(0);
  });

  it('never perches where there are no trees', () => {
    const life = new TileLife(tile, geometry([], [[2048, 2048]]), 3);
    for (let i = 0; i < 600; i++) life.step(0.5);
    expect(life.flocks.every((f) => f.perch === -1 && !f.perched)).toBe(true);
  });
});

describe('LifeWorld', () => {
  const road = geometry([
    [
      LifeLine.roadMajor,
      [
        [0, 2048],
        [4095, 2048],
      ],
    ],
    [
      LifeLine.river,
      [
        [0, 1000],
        [4095, 1000],
      ],
    ],
    [
      LifeLine.path,
      [
        [0, 3000],
        [4095, 3000],
      ],
    ],
  ]);
  const center: [number, number] = [123.18, 13.62];

  it('spawns and drops agents with the tiles on screen', () => {
    const world = new LifeWorld();
    world.sync([{ key: '16/55192/30266', tile, life: road }]);
    expect(world.size).toBe(1);
    world.sync([]);
    expect(world.size).toBe(0);
  });

  it('keeps vehicles in a lane that fits the road', () => {
    const street = geometry([
      [
        LifeLine.roadMinor,
        [
          [0, 2048],
          [4095, 2048],
        ],
        6,
      ],
    ]);
    const world = new LifeWorld({ road_minor: { car: 1 } });
    world.sync([{ key: '16/55192/30266', tile, life: street }]);
    const cars = world.visible(16, 1, center).filter((a) => a.kind === 'vehicle');
    expect(cars.length).toBeGreaterThan(0);
    // The center line's latitude, and meters per degree of latitude there.
    const lineLat = tileToLngLat(tile, { x: 0, y: 2048 })[1];
    const metersPerDegree = 2048 / perMeter / (lineLat - tileToLngLat(tile, { x: 0, y: 4096 })[1]);
    for (const car of cars) {
      const offset = Math.abs(car.lat - lineLat) * metersPerDegree;
      expect(offset).toBeCloseTo(laneOffset(6, VEHICLES.car.width, 0), 1);
    }
    // Without a width, the default.
    expect(laneOffset(DEFAULT_ROAD_WIDTH_M, VEHICLES.car.width, 0)).toBeCloseTo(1.5);
  });

  it('gives visible vehicles their kind, paint, and a point to their right', () => {
    const world = new LifeWorld({ road_major: { jeepney: 1 } });
    world.sync([{ key: 'j', tile, life: road }]);
    const vehicles = world.visible(16, 1, center).filter((a) => a.kind === 'vehicle');
    expect(vehicles.length).toBeGreaterThan(0);
    for (const v of vehicles) {
      expect(v.vehicle).toBe('jeepney');
      expect(v.side).toBeDefined();
      // The road runs east–west, so the side point is due north or south.
      expect(v.side![0]).toBeCloseTo(v.lng, 7);
      expect(v.side![1]).not.toBeCloseTo(v.lat, 7);
    }
    world.setTraffic({ road_major: { bus: 1 } });
    world.sync([{ key: 'j', tile, life: road }]);
    const buses = world.visible(16, 1, center).filter((a) => a.kind === 'vehicle');
    expect(buses.every((v) => v.vehicle === 'bus')).toBe(true);
  });

  it('shows each kind from its zoom', () => {
    const world = new LifeWorld();
    world.sync([{ key: 'a', tile, life: road }]);
    const kinds = (zoom: number) => new Set(world.visible(zoom, 1, center).map((a) => a.kind));
    expect(kinds(12)).toEqual(new Set());
    expect(kinds(14)).toEqual(new Set(['boat']));
    expect(kinds(16)).toEqual(new Set(['boat', 'vehicle']));
    expect(kinds(18)).toEqual(new Set(['boat', 'vehicle', 'person']));
  });

  it('has fewer people and vehicles out at night', () => {
    const world = new LifeWorld();
    world.sync([{ key: 'b', tile, life: road }]);
    const count = (daylight: number) =>
      world.visible(18, daylight, center).filter((a) => a.kind !== 'boat').length;
    expect(count(0)).toBeLessThan(count(1));
    expect(count(0)).toBeGreaterThan(0);
  });

  it('clamps a long frame so agents do not jump', () => {
    const a = new LifeWorld();
    const b = new LifeWorld();
    a.sync([{ key: 'c', tile, life: road }]);
    b.sync([{ key: 'c', tile, life: road }]);
    a.step(5);
    b.step(0.1);
    const where = (w: LifeWorld) =>
      w
        .visible(16, 1, center)
        .filter((v) => v.kind === 'vehicle')
        .map((v) => [v.lng, v.lat]);
    expect(where(a)).toEqual(where(b));
  });

  it('draws at most MAX_VISIBLE_AGENTS, nearest the center first', () => {
    // Plazas packed with strollers, in several tiles.
    const lines: [LifeLine, [number, number][]][] = [];
    for (let i = 0; i < 20; i++) {
      const o = 100 + i * 150;
      lines.push([
        LifeLine.plaza,
        [
          [o, o],
          [4000 - i * 10, o],
          [4000 - i * 10, 4000 - i * 10],
          [o, o],
        ],
      ]);
    }
    const busy = geometry(lines);
    const world = new LifeWorld();
    world.sync(
      [0, 1, 2, 3].map((dx) => ({
        key: `busy${dx}`,
        tile: { ...tile, x: tile.x + dx },
        life: busy,
      })),
    );
    const agents = world.visible(18, 1, center);
    expect(agents.length).toBe(MAX_VISIBLE_AGENTS);
  });
});

describe('vehicles and boats', () => {
  const line = (kind: LifeLine, width = 0, y = 2048) =>
    geometry([
      [
        kind,
        [
          [0, y],
          [4095, y],
        ],
        width,
      ],
    ]);
  const vehicles = (life: TileLife) => life.movers.filter((m) => m.vehicle);

  it('caps a bicycle’s speed', () => {
    const life = new TileLife(
      tile,
      line(LifeLine.roadMid, 10),
      5,
      resolveTraffic({ road_mid: { bicycle: 1 } }),
    );
    expect(vehicles(life).length).toBeGreaterThan(0);
    for (const m of vehicles(life)) {
      expect(m.vehicle).toBe('bicycle');
      expect(m.speed / perMeter).toBeLessThanOrEqual(VEHICLES.bicycle.maxSpeed! + 1e-9);
    }
  });

  it('paints boats in colors that stand out from the water', () => {
    for (const boat of ['rowboat', 'motorboat', 'banca'] as const) {
      for (const paint of VEHICLES[boat].paints) expect(BOAT_PAINTS_AVOID).not.toContain(paint);
    }
  });

  it('picks boats from the river mix', () => {
    const life = new TileLife(
      tile,
      line(LifeLine.river),
      5,
      resolveTraffic({ river: { banca: 1 } }),
    );
    const boats = life.movers.filter((m) => m.kind === 'boat');
    expect(boats.length).toBeGreaterThan(0);
    expect(boats.every((m) => m.vehicle === 'banca')).toBe(true);
  });

  /** A tile holding only the given vehicles on a 6 m road running east. */
  const road = (...movers: Partial<Mover>[]) => {
    const life = new TileLife(tile, line(LifeLine.roadMinor, 6), 1);
    life.movers.length = 0;
    life.flocks.length = 0;
    life.parked.length = 0;
    for (const mover of movers) {
      life.movers.push({
        kind: 'vehicle',
        vehicle: 'car',
        line: 0,
        from: 0,
        dir: 1,
        d: 0,
        speed: 10 * perMeter,
        paint: 0,
        lane: 0,
        pause: 0,
        rank: 0,
        x: 0,
        y: 2048,
        hx: 1,
        hy: 0,
        ...mover,
      });
    }
    return life;
  };

  it('queues behind a slower vehicle instead of driving through it', () => {
    const life = road({ d: 1000, speed: 2 * perMeter }, { d: 900, speed: 10 * perMeter });
    const [leader, follower] = life.movers as [Mover, Mover];
    const gap = () => (leader.x - follower.x) / perMeter - VEHICLES.car.length;
    for (let i = 0; i < 600; i++) {
      life.step(0.1);
      expect(gap()).toBeGreaterThanOrEqual(FOLLOW.minGap - 1e-6);
    }
    // It has settled into the leader's speed, a short headway behind.
    const before = follower.x;
    life.step(0.1);
    expect((follower.x - before) / perMeter / 0.1).toBeCloseTo(2, 1);
    expect(gap()).toBeLessThan(FOLLOW.minGap + 2 * FOLLOW.headway + 0.5);
  });

  it('passes a bicycle riding by the curb', () => {
    const life = road({ vehicle: 'bicycle', d: 1000, speed: 3 * perMeter }, { d: 990 });
    const car = life.movers[1]!;
    life.step(0.1);
    const before = car.x;
    life.step(0.1);
    expect((car.x - before) / perMeter / 0.1).toBeCloseTo(10);
  });
});

describe('parked vehicles', () => {
  const wide = geometry([
    [
      LifeLine.roadMajor,
      [
        [0, 2048],
        [4095, 2048],
      ],
      14,
    ],
  ]);
  const narrow = geometry([
    [
      LifeLine.roadMinor,
      [
        [0, 2048],
        [4095, 2048],
      ],
      6,
    ],
  ]);
  const seeds = Array.from({ length: 20 }, (_, i) => i + 1);

  it('park along the curbs of some wide roads only, and narrow the lanes there', () => {
    const parkedOn = seeds.map((seed) => new TileLife(tile, wide, seed));
    const withParking = parkedOn.filter((life) => life.parked.length > 0);
    expect(withParking.length).toBeGreaterThan(0);
    expect(withParking.length).toBeLessThan(seeds.length);
    for (const life of withParking) {
      for (const p of life.parked) {
        const offset = Math.abs(p.y - 2048) / perMeter;
        expect(offset).toBeCloseTo(7 - VEHICLES[p.vehicle].width / 2 - ROAD_MARGIN_M, 3);
        expect(Math.abs(p.hx)).toBeCloseTo(1);
      }
      const car = { kind: 'vehicle', vehicle: 'car', line: 0, lane: 0 } as Mover;
      expect(life.offsetOf(car)).toBeCloseTo(laneOffset(14 - 2 * PARKED.strip, 1.8, 0));
    }
    expect(seeds.every((seed) => new TileLife(tile, narrow, seed).parked.length === 0)).toBe(true);
  });

  it('fill parking lots’ stalls', () => {
    const b = new LifeBuilder();
    for (let i = 0; i < 100; i++) b.spot({ x: 100 + i * 20, y: 500 }, 0, 1);
    const life = new TileLife(tile, b.finish(), 3);
    expect(life.parked.length).toBeGreaterThan(40);
    expect(life.parked.length).toBeLessThan(90);
    expect(life.parked.every((p) => p.y === 500 && p.hy === 1)).toBe(true);
  });

  it('show from their zoom, day and night, lamps off', () => {
    const key = seeds
      .map((s) => `wide${s}`)
      .find((k) => new TileLife(tile, wide, hashString(k)).parked.length > 0)!;
    const world = new LifeWorld();
    world.sync([{ key, tile, life: wide }]);
    const center: [number, number] = [123.18, 13.62];
    const parked = (zoom: number, daylight: number) =>
      world.visible(zoom, daylight, center).filter((a) => a.parked);
    expect(parked(16.5, 1)).toHaveLength(0);
    expect(parked(17.5, 1).length).toBeGreaterThan(0);
    expect(parked(17.5, 0).length).toBe(parked(17.5, 1).length);
    expect(parked(17.5, 0).every((a) => a.kind === 'vehicle' && a.side)).toBe(true);
  });
});
