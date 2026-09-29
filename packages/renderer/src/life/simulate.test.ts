import { describe, expect, it } from 'vitest';
import { metersPerUnit } from '../raster/geometry';
import { MAX_VISIBLE_AGENTS } from './config';
import { LifeBuilder, LifeLine, type LifeGeometry } from './geometry';
import { hashString, LifeWorld, random, TileLife, type Mover } from './simulate';

/** A z16 tile over Naga's Centro (about 600 m across). */
const tile = { z: 16, x: 55192, y: 30266 };
const perMeter = 1 / metersPerUnit(tile);

const geometry = (
  lines: [LifeLine, [number, number][]][],
  roosts: [number, number][] = [],
): LifeGeometry => {
  const b = new LifeBuilder();
  for (const [kind, points] of lines)
    b.line(
      points.map(([x, y]) => ({ x, y })),
      kind,
    );
  for (const [x, y] of roosts) b.roost({ x, y });
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
    // About 600 m of major road, one vehicle per 60 m.
    const { movers } = new TileLife(tile, road, 7);
    expect(movers.length).toBeGreaterThanOrEqual(8);
    expect(movers.length).toBeLessThanOrEqual(12);
    expect(movers.every((m) => m.kind === 'vehicle')).toBe(true);
    expect(movers.every((m) => m.y === 2048 && m.x >= 0 && m.x <= 4095)).toBe(true);
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
