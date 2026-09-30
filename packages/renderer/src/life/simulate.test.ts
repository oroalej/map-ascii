import type { PlaceKind } from '@atlas/shared';
import { describe, expect, it, vi } from 'vitest';
import { metersPerUnit, tileToLngLat } from '../raster/geometry';
import {
  activityLevels,
  type AgentKind,
  DEFAULT_ROAD_WIDTH_M,
  MAX_TILE_GATHERERS,
  PLACES,
  FOLLOW,
  laneOffset,
  MAX_VISIBLE_AGENTS,
  PARKED,
  ROAD_MARGIN_M,
  UMBRELLA,
  VENDORS,
} from './config';
import { BirdPose, Habitat } from './birds';
import { DOG_PAINTS } from './dogs';
import { LifeBuilder, LifeLine, type LifeGeometry } from './geometry';
import {
  alongTrail,
  cutTrail,
  hashString,
  LifeWorld,
  random,
  TileLife,
  trainCars,
  trainLength,
  type Mover,
  type Train,
} from './simulate';
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

describe('inactive walkers', () => {
  for (const kind of ['person', 'dog', 'cat'] as const)
    it(`freezes an inactive ${kind} without clearance work and resumes when active`, () => {
      const { life, m } = alone(
        geometry([
          [
            LifeLine.path,
            [
              [0, 1000],
              [4096, 1000],
            ],
            2,
          ],
        ]),
        { kind, x: 1000, y: 1000, d: 1000, speed: perMeter, rank: 0.9, pause: 1 },
      );
      const guard = vi.fn(() => true);
      const before = structuredClone(m);
      for (let i = 0; i < 20; i++)
        life.step(
          0.1,
          undefined,
          undefined,
          undefined,
          {
            rain: 0,
            levels: { ...activityLevels(1), [kind]: 0.1 },
          },
          guard,
        );
      expect(m).toEqual(before);
      expect(guard).not.toHaveBeenCalled();

      for (let i = 0; i < 20; i++)
        life.step(
          0.1,
          undefined,
          undefined,
          undefined,
          {
            rain: 0,
            levels: { ...activityLevels(1), [kind]: 1 },
          },
          guard,
        );
      expect(m.d).toBeGreaterThan(before.d);
      expect(guard).toHaveBeenCalled();
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

  it('uses one-way spawn flow without consuming additional random draws', () => {
    const { oneway: _unused, ...legacy } = road;
    const a = new TileLife(tile, legacy, 42);
    const b = new TileLife(tile, { ...road, oneway: Int8Array.of(-1) }, 42);
    const draws = (life: TileLife) =>
      life.movers.map((m) => [m.vehicle, m.speed, m.paint, m.lane, m.rank, m.d, m.routing]);
    expect(draws(b)).toEqual(draws(a));
    expect(b.movers.every((m) => m.dir === -1)).toBe(true);
    expect(b.parked).toEqual(a.parked);
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
    // One flock by day (bats, if any, come out at night).
    const day = life.flocks.filter((f) => f.species !== 'bat');
    expect(day).toHaveLength(1);
    const flock = day[0]!;
    expect(flock.birds.length).toBeGreaterThanOrEqual(2);
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

  it('picks each flock’s species by its roost, and egrets never land in trees', () => {
    const b = new LifeBuilder();
    b.roost({ x: 2048, y: 2048 }, Habitat.water);
    b.perch({ x: tree[0], y: tree[1] });
    const species = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      const life = new TileLife(tile, b.finish(), seed);
      for (const f of life.flocks) species.add(f.species);
      const egrets = life.flocks.filter((f) => f.species === 'egret');
      for (let i = 0; i < 200; i++) life.step(0.5);
      expect(egrets.every((f) => !f.perched)).toBe(true);
    }
    expect(species.has('egret')).toBe(true);
    // Trees alone never draw egrets.
    for (let seed = 1; seed <= 40; seed++) {
      const life = new TileLife(tile, geometry([], [], [tree]), seed);
      expect(life.flocks.some((f) => f.species === 'egret')).toBe(false);
    }
  });

  it('shows birds with their species, pose, and heading', () => {
    const world = new LifeWorld();
    world.sync([{ key: '16/55192/30266', tile, life: geometry([], [[2048, 2048]], [tree]) }]);
    world.step(0.1);
    const birds = world.visible(18, 1, tileToLngLat(tile, { x: 2048, y: 2048 }));
    const shown = birds.filter((a) => a.kind === 'bird');
    expect(shown.length).toBeGreaterThan(0);
    for (const b of shown) {
      expect(b.bird).toBeDefined();
      expect(b.ahead).toBeDefined();
      expect([BirdPose.spread, BirdPose.raised, BirdPose.perched]).toContain(b.bird!.pose);
    }
  });

  it('never perches where there are no trees', () => {
    const life = new TileLife(tile, geometry([], [[2048, 2048]]), 3);
    for (let i = 0; i < 600; i++) life.step(0.5);
    expect(life.flocks.every((f) => f.perch === -1 && !f.perched)).toBe(true);
  });
});

describe('birds and the world', () => {
  const park: [number, number] = [2048, 2048];
  const tree: [number, number] = [1000, 1200];
  /** A tile with one day flock of `species` over a park (and a tree, with `trees`), no bats. */
  const withFlock = (species: 'pigeon' | 'maya' | 'egret', trees = false) => {
    const life = new TileLife(tile, geometry([], [park], trees ? [tree] : []), 3);
    life.movers.length = 0;
    life.flocks.splice(1);
    const flock = life.flocks[0]!;
    Object.assign(flock, { species, perch: -1, perched: false, landing: false, landed: false });
    return { life, flock };
  };
  const onlyBirds = (kind: AgentKind) => kind === 'bird';
  const person = (x: number, y: number, rank = 0): Mover => ({
    kind: 'person',
    line: 0,
    from: 0,
    dir: 1,
    d: 0,
    speed: 1,
    paint: 0,
    lane: 0,
    pause: 0,
    rank,
    x,
    y,
    hx: 1,
    hy: 0,
  });

  it('lands pigeons on the ground, and flushes them when someone walks by', () => {
    const { life, flock } = withFlock('pigeon');
    Object.assign(flock, { landed: true, x: park[0], y: park[1], stay: 1000 });
    const levels = activityLevels(1);
    life.step(0.1, undefined, onlyBirds, undefined, { levels, rain: 0 });
    expect(flock.landed).toBe(true);
    // Someone out of sight (ranked out) doesn't count.
    life.movers.push(person(park[0] + perMeter, park[1], 0.99));
    life.step(0.1, undefined, onlyBirds, undefined, {
      levels: { ...levels, person: 0.5 },
      rain: 0,
    });
    expect(flock.landed).toBe(true);
    // One walking past does.
    life.movers.push(person(park[0] + 2 * perMeter, park[1]));
    life.step(0.1, undefined, onlyBirds, undefined, { levels, rain: 0 });
    expect(flock.landed).toBe(false);
    expect(flock.scatter).toBeGreaterThan(0);
  });

  it('sends flocks that perch to the trees in the rain, and keeps them there', () => {
    const { life, flock } = withFlock('maya', true);
    const env = { rain: 1 };
    for (let i = 0; i < 600 && !flock.perched; i++) {
      life.step(0.1, undefined, onlyBirds, undefined, env);
    }
    expect(flock.perched).toBe(true);
    expect([flock.x, flock.y]).toEqual(tree);
    // Its stay runs out, but it sits out the rain.
    flock.stay = 0;
    for (let i = 0; i < 50; i++) life.step(0.1, undefined, onlyBirds, undefined, env);
    expect(flock.perched).toBe(true);
  });

  it('drifts circling flocks downwind', () => {
    const meanX = (wind?: { dir: [number, number]; strength: number }) => {
      const { life, flock } = withFlock('egret');
      flock.stay = 1e6;
      let sum = 0;
      for (let i = 0; i < 1200; i++) {
        life.step(0.05, undefined, onlyBirds, undefined, { rain: 0, wind });
        if (i >= 600) sum += flock.x;
      }
      return sum / 600;
    };
    const drift = (meanX({ dir: [1, 0], strength: 1 }) - meanX()) / perMeter;
    expect(drift).toBeGreaterThan(5);
  });

  it('brings bats out at night only', () => {
    // A tile that has bats.
    let seed = 1;
    while (
      !new TileLife(tile, geometry([], [park], [tree]), hashString(`${seed}`)).flocks.some(
        (f) => f.species === 'bat',
      )
    ) {
      seed++;
    }
    const world = new LifeWorld();
    world.sync([{ key: `${seed}`, tile, life: geometry([], [park], [tree]) }]);
    const at = tileToLngLat(tile, { x: park[0], y: park[1] });
    const bats = (daylight: number) =>
      world.visible(18, daylight, at).filter((a) => a.bird?.species === 'bat').length;
    expect(bats(0)).toBeGreaterThan(0);
    expect(bats(1)).toBe(0);
    for (let i = 0; i < 200; i++) world.step(0.5);
    expect(bats(0)).toBeGreaterThan(0);
  });
});

describe('street dogs', () => {
  const street = geometry([
    [
      LifeLine.path,
      [
        [0, 2048],
        [4095, 2048],
      ],
    ],
  ]);

  it('roam walking paths in their coats, sniffing and turning', () => {
    const life = new TileLife(tile, street, 11);
    life.scenes.sites.length = 0;
    const dogs = life.movers.filter((m) => m.kind === 'dog');
    expect(dogs.length).toBeGreaterThan(0);
    for (const d of dogs) expect(DOG_PAINTS).toContain(d.paint);
    const start = dogs.map((d) => d.x);
    let paused = false;
    for (let i = 0; i < 600; i++) {
      life.step(0.1);
      if (dogs.some((d) => d.pause > 0)) paused = true;
    }
    expect(paused).toBe(true);
    expect(dogs.some((d, i) => d.x !== start[i])).toBe(true);
    for (const d of dogs) expect(d.y).toBeCloseTo(2048, 0);
  });

  it('show from street zoom, with a heading and a stride', () => {
    const world = new LifeWorld();
    world.sync([{ key: 'd', tile, life: street }]);
    const at = tileToLngLat(tile, { x: 2048, y: 2048 });
    const dogs = world.visible(18, 1, at).filter((a) => a.kind === 'dog');
    expect(dogs.length).toBeGreaterThan(0);
    for (const d of dogs) {
      expect(d.ahead).toBeDefined();
      expect([0, 1]).toContain(d.flap);
    }
    expect(world.visible(16, 1, at).some((a) => a.kind === 'dog')).toBe(false);
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
    expect(kinds(18)).toEqual(new Set(['boat', 'vehicle', 'person', 'dog', 'cat']));
  });

  it('has fewer people and vehicles out at night', () => {
    const world = new LifeWorld();
    world.sync([{ key: 'b', tile, life: road }]);
    const count = (daylight: number) =>
      world.visible(18, daylight, center).filter((a) => a.kind !== 'boat').length;
    expect(count(0)).toBeLessThan(count(1));
    expect(count(0)).toBeGreaterThan(0);
  });

  it('follows the daily rhythm: more out in the morning rush than in the small hours', () => {
    const world = new LifeWorld();
    world.sync([{ key: 'b', tile, life: road }]);
    const count = (hour: number) =>
      world
        .visible(18, activityLevels(1, { minutes: hour * 60, weekday: 1 }), center)
        .filter((a) => a.kind !== 'boat').length;
    expect(count(3)).toBeLessThan(count(8));
    expect(count(3)).toBeGreaterThan(0);
    // A city's own rhythm replaces the default (street dogs roam at any hour).
    const empty = { rhythm: { vehicle: [[0, 0]], person: [[0, 0]] } as const, source: 'test' };
    const none = world.visible(
      18,
      activityLevels(1, { minutes: 480, weekday: 1, life: empty }),
      center,
    );
    expect(none.filter((a) => !['boat', 'dog', 'cat'].includes(a.kind))).toHaveLength(0);
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

  it('leaves out agents outside the view', () => {
    const world = new LifeWorld();
    world.sync([{ key: 'v', tile, life: road }]);
    const all = world.visible(18, 1, center).filter((a) => a.kind !== 'train');
    expect(all.length).toBeGreaterThan(0);
    // The tile's western half only (a view, with no margin to speak of at this size).
    const [west, north] = tileToLngLat(tile, { x: 0, y: 0 });
    const [east, south] = tileToLngLat(tile, { x: 1024, y: 4096 });
    const inHalf = world
      .visible(18, 1, center, undefined, [west, south, east, north])
      .filter((a) => a.kind !== 'train');
    expect(inHalf.length).toBeGreaterThan(0);
    expect(inHalf.length).toBeLessThan(all.length);
    const [edge] = tileToLngLat(tile, { x: 1024 + 31 * perMeter, y: 0 });
    expect(inHalf.every((a) => a.lng <= edge)).toBe(true);
    // Far away: none.
    expect(
      world.visible(18, 1, center, undefined, [0, 0, 1, 1]).filter((a) => a.kind !== 'train'),
    ).toHaveLength(0);
  });

  it("doesn't move the kinds that don't show at the zoom", () => {
    const world = new LifeWorld();
    world.sync([{ key: 'z', tile, life: road }]);
    const where = () =>
      world
        .visible(18, 1, center)
        .filter((a) => a.kind === 'vehicle' && !a.parked)
        .map((a) => a.lng);
    const before = where();
    expect(before.length).toBeGreaterThan(0);
    for (let i = 0; i < 10; i++) world.step(0.1, undefined, 14); // vehicles show from 15
    expect(where()).toEqual(before);
    for (let i = 0; i < 10; i++) world.step(0.1, undefined, 16);
    expect(where()).not.toEqual(before);
  });

  it('moves only the agents near the view', () => {
    const world = new LifeWorld();
    world.sync([{ key: 'n', tile, life: road }]);
    const vehicles = () =>
      world.visible(18, 1, center).filter((a) => a.kind === 'vehicle' && !a.parked);
    const before = vehicles();
    // The tile's western tenth: 100 m of margin reaches ~0.2 of the way across.
    const [west, north] = tileToLngLat(tile, { x: 0, y: 0 });
    const [east, south] = tileToLngLat(tile, { x: 400, y: 4096 });
    const [reach] = tileToLngLat(tile, { x: 400 + 110 * perMeter, y: 0 });
    const far = before.filter((a) => a.lng > reach + 0.0005);
    expect(far.length).toBeGreaterThan(0);
    for (let i = 0; i < 10; i++) world.step(0.1, undefined, 16, [west, south, east, north]);
    const after = vehicles();
    // Far off, each is still where it was; nearer, some have moved on.
    const at = new Set(after.map((a) => `${a.lng},${a.lat}`));
    expect(far.every((a) => at.has(`${a.lng},${a.lat}`))).toBe(true);
    const near = before.filter((a) => a.lng < east);
    if (near.length > 0) expect(near.some((a) => !at.has(`${a.lng},${a.lat}`))).toBe(true);
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

  it('accelerates from rest and records only clearance-accepted path distance', () => {
    const life = road({ v: 0 });
    const m = life.movers[0]!;
    for (let i = 0; i < 50; i++) {
      const previous = m.v!;
      life.step(0.1);
      expect(m.v! - previous).toBeLessThanOrEqual(2 * perMeter * 0.1 + 1e-9);
    }
    expect(m.v! / perMeter).toBeCloseTo(10);
    const before = m.d;
    let tries = 0;
    life.step(0.1, undefined, undefined, undefined, undefined, () => ++tries === 3);
    expect(m.v! / perMeter).toBeCloseTo(2.5);
    expect(m.v!).toBeCloseTo((m.d - before) / 0.1);
    life.step(0.1, undefined, undefined, undefined, undefined, () => false);
    expect(m.v).toBe(0);
  });

  it('ignores inactive leaders using each craft kind activity', () => {
    const life = road({ d: 30, rank: 0.9, speed: 0 }, { d: 0 });
    life.step(0.1, undefined, undefined, undefined, {
      rain: 0,
      levels: { ...activityLevels(1), vehicle: 0.5 },
    });
    expect(life.movers[1]!.v! / perMeter).toBeCloseTo(10);
    expect(life.movers[0]!.d).toBe(30);
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

describe('trains', () => {
  const rail = (...lines: [number, number][][]) =>
    geometry(lines.map((points) => [LifeLine.rail, points] as [LifeLine, [number, number][]]));
  const newTrain = (): Train => ({
    cars: ['locomotive', 'coach', 'coach'],
    trail: [],
    reverse: false,
    edge: false,
    stopX: NaN,
    stopY: NaN,
  });
  const onTrack = (geo: LifeGeometry, mover: Partial<Mover>) =>
    alone(geo, { kind: 'train', speed: 20 * perMeter, train: newTrain(), ...mover });
  const run = (life: TileLife, seconds: number) => {
    for (let t = 0; t < seconds; t += 0.1) life.step(0.1);
  };

  it('spawn on track only, sparsely, a locomotive leading its coaches', () => {
    const geo = geometry([
      [
        LifeLine.rail,
        [
          [0, 1000],
          [4095, 1000],
        ],
      ],
      [
        LifeLine.roadMajor,
        [
          [0, 3000],
          [4095, 3000],
        ],
      ],
    ]);
    let trains = 0;
    for (let seed = 1; seed <= 40; seed++) {
      for (const m of new TileLife(tile, geo, seed).movers) {
        if (m.kind === 'train') {
          trains++;
          expect(m.line).toBe(0);
          expect(m.train!.cars[0]).toBe('locomotive');
          expect(m.train!.cars.slice(1).every((car) => car === 'coach')).toBe(true);
          expect(m.train!.cars.length).toBeGreaterThanOrEqual(3);
          expect(m.train!.cars.length).toBeLessThanOrEqual(5);
        } else {
          expect(m.line).toBe(1);
        }
      }
    }
    // About 600 m of track, one train per 3 km: about one tile in five has one.
    expect(trains).toBeGreaterThan(2);
    expect(trains).toBeLessThan(20);
  });

  it('keeps to the straightest track at a junction', () => {
    const junction = rail(
      [
        [0, 2000],
        [2000, 2000],
      ],
      [
        [2000, 2000],
        [2600, 3000],
      ],
      [
        [2000, 2000],
        [3000, 2050],
      ],
    );
    for (let i = 0; i < 5; i++) {
      const { life, m } = onTrack(junction, { d: 1990, speed: 200 });
      life.step(0.1);
      expect(m.line).toBe(2);
    }
  });

  it('waits at the end of the track, then heads back the way it came', () => {
    const spur = rail([
      [0, 2048],
      [2048, 2048],
    ]);
    const { life, m } = onTrack(spur, { d: 1000 });
    for (let t = 0; t < 60 && m.pause <= 0; t += 0.1) life.step(0.1);
    expect(m.pause).toBeGreaterThan(0);
    expect(m.x).toBeCloseTo(2048);
    run(life, m.pause + 0.2);
    expect(m.dir).toBe(-1);
    expect(m.x).toBeLessThan(2048 - trainLength(m.train!.cars) * perMeter + 1);
  });

  it('stops at a station each time it passes', () => {
    const b = new LifeBuilder();
    // The track ends inside the tile, where trains wait and head back.
    b.line(
      [
        { x: 500, y: 2048 },
        { x: 3500, y: 2048 },
      ],
      LifeLine.rail,
    );
    b.station({ x: 2048, y: 2080 });
    const { life, m } = onTrack(b.finish(), { d: 1000 });
    let stops = 0;
    for (let t = 0; t < 150; t += 0.1) {
      const moving = m.pause <= 0;
      life.step(0.1);
      // Waits at the end of the track aren't station stops.
      if (moving && m.pause > 0 && !m.train!.reverse) {
        stops++;
        expect(Math.abs(m.x - 2048)).toBeLessThan(25 * perMeter);
      }
    }
    // There, and again on its way back.
    expect(stops).toBe(2);
  });

  it('draws its cars along the track behind it, round a curve', () => {
    const bend = rail([
      [500, 1000],
      [2000, 1000],
      [2000, 3000],
    ]);
    const { life, m } = onTrack(bend, { d: 1500 - 30 * perMeter });
    // Round the corner, and 40 m down the other side.
    run(life, 70 / 20);
    const cars = trainCars(life, m);
    expect(cars.map((car) => car.vehicle)).toEqual(['locomotive', 'coach', 'coach']);
    const heading = (car: (typeof cars)[number]): [number, number] => [
      car.ahead![0] - car.lng,
      car.ahead![1] - car.lat,
    ];
    const [lx, ly] = heading(cars[0]!);
    const [tx, ty] = heading(cars[2]!);
    // The locomotive heads south (tile y down), the last coach still east.
    expect(Math.abs(lx)).toBeLessThan(Math.abs(ly));
    expect(ly).toBeLessThan(0);
    expect(Math.abs(ty)).toBeLessThan(Math.abs(tx));
    expect(tx).toBeGreaterThan(0);
  });
});

describe('standby trains', () => {
  const siding = (points: [number, number][]) => geometry([[LifeLine.siding, points]]);
  const standbyOf = (geo: LifeGeometry) => new TileLife(tile, geo, 3).standby;

  it('stand on each siding, locomotive first, along the track', () => {
    // About 150 m of siding, running east.
    const cars = standbyOf(
      siding([
        [1000, 2048],
        [1000 + 150 * perMeter, 2048],
      ]),
    );
    expect(cars[0]!.vehicle).toBe('locomotive');
    expect(cars.length).toBeGreaterThanOrEqual(2);
    expect(cars.slice(1).every((car) => car.vehicle === 'coach')).toBe(true);
    expect(cars.every((car) => car.y === 2048 && Math.abs(car.hx) === 1)).toBe(true);
    // In from the switch, and one after another along the siding.
    expect(cars[0]!.x).toBeGreaterThan(1000 + 15 * perMeter);
    for (let i = 1; i < cars.length; i++) expect(cars[i]!.x).toBeGreaterThan(cars[i - 1]!.x);
    expect(new Set(cars.map((car) => car.paint)).size).toBe(1);
  });

  it('keep still, and never run trains onto a siding', () => {
    const geo = siding([
      [1000, 2048],
      [1000 + 150 * perMeter, 2048],
    ]);
    const life = new TileLife(tile, geo, 3);
    const before = life.standby.map((car) => [car.x, car.y]);
    for (let t = 0; t < 30; t += 0.1) life.step(0.1);
    expect(life.standby.map((car) => [car.x, car.y])).toEqual(before);
    expect(life.movers.some((m) => m.kind === 'train')).toBe(false);
  });

  it('leave out a siding too short for a locomotive, or owned by the next tile', () => {
    expect(
      standbyOf(
        siding([
          [1000, 2048],
          [1000 + 40 * perMeter, 2048],
        ]),
      ),
    ).toEqual([]);
    expect(
      standbyOf(
        siding([
          [-60, 2048],
          [-60 + 150 * perMeter, 2048],
        ]),
      ),
    ).toEqual([]);
  });

  it('are drawn as parked trains, lamps off', () => {
    const world = new LifeWorld();
    world.sync([
      {
        key: '16/55192/30266',
        tile,
        life: siding([
          [1000, 2048],
          [1000 + 150 * perMeter, 2048],
        ]),
      },
    ]);
    const agents = world.visible(15, 0, tileToLngLat(tile, { x: 2048, y: 2048 }));
    const trains = agents.filter((a) => a.kind === 'train');
    expect(trains.length).toBeGreaterThanOrEqual(2);
    expect(trains.every((a) => a.parked)).toBe(true);
    expect(world.visible(13, 1, [0, 0]).some((a) => a.kind === 'train')).toBe(false);
  });

  it('a running train keeps to the running line where a siding branches off', () => {
    const junction = geometry([
      [
        LifeLine.rail,
        [
          [0, 2000],
          [2000, 2000],
        ],
      ],
      [
        LifeLine.siding,
        [
          [2000, 2000],
          [3000, 2000],
        ],
      ],
      [
        LifeLine.rail,
        [
          [2000, 2000],
          [2600, 3000],
        ],
      ],
    ]);
    const { life, m } = alone(junction, {
      kind: 'train',
      d: 1990,
      speed: 200,
      train: {
        cars: ['locomotive'],
        trail: [],
        reverse: false,
        edge: false,
        stopX: NaN,
        stopY: NaN,
      },
    });
    life.step(0.1);
    expect(m.line).toBe(2);
  });
});

describe('trains crossing tiles', () => {
  const west = { z: 16, x: 55192, y: 30266 };
  const east = { ...west, x: west.x + 1 };
  // One straight line of track, each tile holding its own copy out into its buffer.
  const line = (x0: number, x1: number) =>
    geometry([
      [
        LifeLine.rail,
        [
          [x0, 2048],
          [x1, 2048],
        ],
      ],
    ]);
  const lifeTile = (tile: typeof west, geo: LifeGeometry) => ({
    key: `${tile.z}/${tile.x}/${tile.y}`,
    tile,
    life: geo,
  });
  const trainIn = (world: LifeWorld, key: string) =>
    (world as unknown as { tiles: Map<string, TileLife> }).tiles
      .get(key)!
      .movers.filter((m) => m.kind === 'train');
  const setUp = (withEast: boolean) => {
    const world = new LifeWorld();
    world.sync([
      lifeTile(west, line(-80, 4176)),
      ...(withEast ? [lifeTile(east, line(-80, 4176))] : []),
    ]);
    const tiles = (world as unknown as { tiles: Map<string, TileLife> }).tiles;
    for (const life of tiles.values()) life.movers.length = 0;
    const westLife = tiles.get('16/55192/30266')!;
    const m: Mover = {
      kind: 'train',
      line: 0,
      from: 0,
      dir: 1,
      d: 3700,
      speed: 20 * perMeter,
      paint: 0,
      lane: 0,
      pause: 0,
      rank: 0,
      x: 0,
      y: 0,
      hx: 1,
      hy: 0,
      train: {
        cars: ['locomotive', 'coach'],
        trail: [],
        reverse: false,
        edge: false,
        stopX: NaN,
        stopY: NaN,
      },
    };
    westLife.movers.push(m);
    return { world, m };
  };

  it('run on out of the view (they cross tiles, so they never wait)', () => {
    const { world, m } = setUp(false);
    const x = m.x;
    for (let i = 0; i < 5; i++) world.step(0.1, undefined, 16, [0, 0, 0.001, 0.001]);
    expect(m.x).not.toBe(x);
  });

  it('run on into the next tile, the same way, cars behind', () => {
    const { world, m } = setUp(true);
    let lastX = -Infinity;
    for (let t = 0; t < 20; t += 0.1) {
      world.step(0.1);
      // Never seen heading back west in the tile it came from.
      if (trainIn(world, '16/55192/30266').includes(m)) {
        expect(m.x).toBeGreaterThanOrEqual(lastX);
        lastX = m.x;
      }
    }
    expect(trainIn(world, '16/55192/30266')).not.toContain(m);
    expect(trainIn(world, '16/55193/30266')).toContain(m);
    expect(m.dir).toBe(1);
    expect(m.x).toBeGreaterThan(0);
    // 400 m on from 67 m short of the seam.
    expect(m.x).toBeCloseTo(3620 + 400 * perMeter - 4096, -1);
    expect(m.train!.trail[0]!).toBeLessThan(m.x);
  });

  it('leave the map where no tile is loaded, instead of turning back', () => {
    const { world, m } = setUp(false);
    let lastX = -Infinity;
    for (let t = 0; t < 20; t += 0.1) {
      world.step(0.1);
      if (trainIn(world, '16/55192/30266').includes(m)) {
        expect(m.x).toBeGreaterThanOrEqual(lastX);
        lastX = m.x;
      }
    }
    expect(trainIn(world, '16/55192/30266')).not.toContain(m);
  });
});

describe('people', () => {
  const across = (kind: LifeLine, width?: number, markets: [number, number][] = []) => {
    const b = new LifeBuilder();
    b.line(
      [
        { x: 0, y: 2048 },
        { x: 4095, y: 2048 },
      ],
      kind,
      width,
    );
    for (const [x, y] of markets) b.market({ x, y });
    return b.finish();
  };
  const center: [number, number] = [123.18, 13.62];

  it('walk alone or in groups of up to four, led by an adult, some with children', () => {
    const life = new TileLife(tile, across(LifeLine.path), 7);
    const groups = life.movers.filter((m) => m.kind === 'person').map((m) => m.group!);
    const sizes = groups.map((g) => g.length);
    expect(sizes).toContain(1);
    expect(Math.max(...sizes)).toBeGreaterThan(1);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(4);
    for (const g of groups) expect(g[0]!.figure).toBe('adult');
    expect(groups.flat().some((w) => w.figure === 'child')).toBe(true);
    expect(new Set(groups.flat().map((w) => w.shirt)).size).toBeGreaterThan(3);
  });

  it('look the same for the same seed, on a stream of their own', () => {
    const a = new TileLife(tile, across(LifeLine.path), 7);
    const b = new TileLife(tile, across(LifeLine.path), 7);
    expect(a.movers.map((m) => m.group)).toEqual(b.movers.map((m) => m.group));
    expect(a.stalls).toEqual(b.stalls);
    // Where everyone starts doesn't depend on how they look.
    const where = (life: TileLife) => life.movers.map((m) => [m.x, m.y, m.dir, m.rank]);
    const plain = new TileLife(tile, across(LifeLine.path), 7);
    for (const m of plain.movers) delete m.group;
    expect(where(plain)).toEqual(where(a));
  });

  it('step as they walk', () => {
    const world = new LifeWorld();
    world.sync([{ key: 'p', tile, life: across(LifeLine.path) }]);
    const flaps = () =>
      world
        .visible(18, 1, center)
        .filter((a) => a.people)
        .map((a) => a.people![0]!.flap);
    const before = flaps();
    for (let i = 0; i < 10; i++) world.step(0.1);
    const after = flaps();
    expect(before.length).toBeGreaterThan(0);
    expect(after.some((f, i) => f !== before[i])).toBe(true);
  });

  it('open umbrellas in the rain and under a high sun', () => {
    const world = new LifeWorld();
    world.sync([{ key: 'u', tile, life: across(LifeLine.path) }]);
    const share = (rain: number, sunAltitude: number) => {
      const people = world
        .visible(18, 1, center, { rain, sunAltitude })
        .flatMap((a) => (a.vehicle ? [] : (a.people ?? [])));
      return people.filter((p) => p.figure === 'umbrella').length / people.length;
    };
    expect(share(1, 20)).toBeGreaterThan(share(0, 20));
    expect(share(0, 70)).toBeGreaterThan(share(0, 20));
    expect(share(0, -10)).toBeLessThanOrEqual(UMBRELLA.base + 0.1);
  });

  it('sets up carts beside walking paths, more of them near a market, and omits road vendors', () => {
    const road = new TileLife(tile, across(LifeLine.roadMinor, 8, [[2048, 2100]]), 3);
    expect(road.stalls).toHaveLength(0);
    expect(road.movers.some((m) => m.kind === 'person')).toBe(false);
    const plain = new TileLife(tile, across(LifeLine.path), 3);
    const market = new TileLife(tile, across(LifeLine.path, 0, [[2048, 2100]]), 3);
    expect(plain.stalls.length).toBeGreaterThan(0);
    expect(market.stalls.length).toBeGreaterThan(plain.stalls.length);
    expect(market.stalls.length).toBeLessThanOrEqual(VENDORS.maxPerTile);
    for (const s of plain.stalls) {
      expect(Math.abs(s.y - 2048) / perMeter).toBeCloseTo(VENDORS.beside, 3);
    }
  });

  it('keep their carts still, shown from the people’s zoom, the vendor beside', () => {
    const geo = across(LifeLine.plaza);
    const life = new TileLife(tile, geo, 5);
    const at = life.stalls.map((s) => [s.x, s.y]);
    life.step(1);
    expect(life.stalls.map((s) => [s.x, s.y])).toEqual(at);
    const world = new LifeWorld();
    world.sync([{ key: 's', tile, life: geo }]);
    const carts = (zoom: number) => world.visible(zoom, 1, center).filter((a) => a.vehicle);
    expect(carts(16)).toHaveLength(0);
    expect(carts(18).length).toBeGreaterThan(0);
    for (const cart of carts(18)) {
      expect(cart).toMatchObject({ kind: 'person', vehicle: 'cart' });
      expect(Math.abs(cart.people![0]!.lateral)).toBe(1);
    }
  });
});

describe('alongTrail and cutTrail', () => {
  const trail = [10, 0, 0, 0, 0, 10];

  it('finds a point along a polyline and the heading back toward its start', () => {
    expect(alongTrail(trail, 4)).toEqual({ x: 6, y: 0, hx: 1, hy: 0 });
    expect(alongTrail(trail, 15)).toMatchObject({ x: 0, y: 5, hy: -1 });
    expect(alongTrail(trail, 21)).toBeNull();
  });

  it('cuts a polyline to a length', () => {
    expect(cutTrail(trail, 15)).toEqual([10, 0, 0, 0, 0, 5]);
    expect(cutTrail(trail, 4)).toEqual([10, 0, 6, 0]);
  });
});

describe('people at places', () => {
  const center = tileToLngLat(tile, { x: 2048, y: 2048 });
  const withPlaces = (
    places: [PlaceKind, number, boolean?][],
    lines: [LifeLine, [number, number][]][] = [],
  ) => {
    const b = new LifeBuilder();
    for (const [kind, points] of lines)
      b.line(
        points.map(([x, y]) => ({ x, y })),
        kind,
      );
    for (const [kind, radiusM, building] of places) {
      b.place({ x: 2048, y: 2048 }, kind, radiusM * perMeter, building);
    }
    return b.finish();
  };
  const at = (hour: number, weekday: number) => activityLevels(1, { minutes: hour * 60, weekday });
  const count = (world: LifeWorld, hour: number, weekday = 1) =>
    world.visible(18, at(hour, weekday), center).length;

  it('stand around a building, never on it', () => {
    const life = new TileLife(tile, withPlaces([['worship', 20, true]]), 7);
    expect(life.gatherers.length).toBeGreaterThan(5);
    for (let i = 0; i < 600; i++) life.step(0.1);
    for (const g of life.gatherers) {
      const d = Math.hypot(g.x - 2048, g.y - 2048) / perMeter;
      expect(d).toBeGreaterThanOrEqual(20);
      expect(d).toBeLessThanOrEqual(20 + 1.5 + PLACES.worship.wander + 0.01);
    }
  });

  it('crowd a school’s gates before classes and after, on school days', () => {
    const world = new LifeWorld();
    world.sync([{ key: 's', tile, life: withPlaces([['school', 40, true]]) }]);
    expect(count(world, 6.75)).toBeGreaterThan(count(world, 10.5) * 3);
    expect(count(world, 16.5)).toBeGreaterThan(count(world, 10.5) * 3);
    expect(count(world, 6.75, 0)).toBeLessThan(count(world, 6.75));
  });

  it('crowd a church only around the city’s services', () => {
    const world = new LifeWorld();
    world.sync([{ key: 'c', tile, life: withPlaces([['worship', 40, true]]) }]);
    const life = {
      schedules: { worship: [{ weekdays: [0], times: ['09:00'] }] },
      source: 'test',
    };
    const sunday = (hour: number, cityLife?: typeof life) =>
      world.visible(
        18,
        activityLevels(1, { minutes: hour * 60, weekday: 0, life: cityLife }),
        center,
      ).length;
    expect(sunday(9, life)).toBeGreaterThan(sunday(12, life) * 3);
    // Without services, no crowd at 9 either.
    expect(sunday(9)).toBeLessThan(sunday(9, life) / 3);
  });

  it('keep to at most MAX_TILE_GATHERERS a tile', () => {
    const places = Array.from({ length: 40 }, (): [PlaceKind, number, boolean] => [
      'school',
      200,
      true,
    ]);
    const life = new TileLife(tile, withPlaces(places), 3);
    expect(life.gatherers).toHaveLength(MAX_TILE_GATHERERS);
  });

  it('sit still on a bench', () => {
    const life = new TileLife(tile, withPlaces([['bench', 0]]), 5);
    const before = life.gatherers.map((g) => [g.x, g.y]);
    expect(before.length).toBeGreaterThanOrEqual(1);
    expect(before.length).toBeLessThanOrEqual(2);
    for (let i = 0; i < 100; i++) life.step(0.1);
    expect(life.gatherers.map((g) => [g.x, g.y])).toEqual(before);
  });

  it('work the fields with carabao in the morning, not at night', () => {
    const world = new LifeWorld();
    const places = Array.from({ length: 8 }, (): [PlaceKind, number] => ['farm', 100]);
    world.sync([{ key: 'f', tile, life: withPlaces(places) }]);
    const morning = world.visible(18, at(7, 1), center);
    expect(morning.length).toBeGreaterThan(0);
    expect(morning.some((a) => a.vehicle === 'carabao')).toBe(true);
    expect(world.visible(18, at(22, 1), center)).toHaveLength(0);
  });

  it('don’t change who else is out', () => {
    const road: [LifeLine, [number, number][]][] = [
      [
        LifeLine.roadMinor,
        [
          [0, 1000],
          [4095, 1000],
        ],
      ],
    ];
    const plain = new TileLife(tile, withPlaces([], road), 9);
    const busy = new TileLife(tile, withPlaces([['school', 40, true]], road), 9);
    expect(busy.movers.map((m) => [m.x, m.y])).toEqual(plain.movers.map((m) => [m.x, m.y]));
  });
});

describe('canals', () => {
  it('carry only small boats', () => {
    const geo = geometry([
      [
        LifeLine.canal,
        [
          [0, 2048],
          [4095, 2048],
        ],
      ],
    ]);
    const life = new TileLife(tile, geo, 2);
    const boats = life.movers.filter((m) => m.kind === 'boat');
    expect(boats.length).toBeGreaterThan(0);
    for (const b of boats) expect(['rowboat', 'banca']).toContain(b.vehicle);
    expect(life.parked).toHaveLength(0);
  });
});
