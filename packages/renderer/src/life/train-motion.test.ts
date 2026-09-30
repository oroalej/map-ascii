import { describe, expect, it } from 'vitest';
import { metersPerUnit, tileToLngLat } from '../raster/geometry';
import { LifeBuilder, LifeLine } from './geometry';
import { LifeWorld, TileLife, trainLength, type Mover } from './simulate';
import { trainLimits } from './train-motion';
import { frameBetween } from './frames';
import { worldTiles } from './testing/scenarios';
import { activityLevels } from './config';

const tile = { z: 16, x: 55192, y: 30266 },
  pm = 1 / metersPerUnit(tile);
function rail(station = false) {
  const b = new LifeBuilder();
  b.line(
    [
      { x: -80, y: 2048 },
      { x: 4176, y: 2048 },
    ],
    LifeLine.rail,
  );
  if (station) b.station({ x: 350 * pm, y: 2048 + 5 * pm });
  return b.finish();
}
function train(x: number, speed = 12, dir: 1 | -1 = 1): Mover {
  const cars = ['locomotive', 'coach'] as const;
  return {
    kind: 'train',
    line: 0,
    from: dir === 1 ? 0 : 1,
    dir,
    d: dir === 1 ? x + 80 : 4176 - x,
    speed: speed * pm,
    v: speed * pm,
    paint: 0,
    lane: 0,
    pause: 0,
    rank: 0,
    x,
    y: 2048,
    hx: dir,
    hy: 0,
    train: {
      cars: [...cars],
      trail: [x - dir * trainLength(cars) * pm, 2048],
      edge: false,
      reverse: false,
      stopX: NaN,
      stopY: NaN,
    },
  };
}
describe('train motion', () => {
  for (const state of ['moving', 'dwelling'] as const)
    it(`keeps an existing ${state} train active at zero activity`, () => {
      const world = new LifeWorld();
      world.sync([{ key: 'rail', tile, life: rail(state === 'dwelling') }]);
      const life = worldTiles(world).get('rail')!;
      const m = train((state === 'dwelling' ? 350 : 100) * pm);
      life.movers.splice(0, life.movers.length, m);
      if (state === 'dwelling') {
        m.pause = 0.2;
        m.v = 0;
        m.train!.stopX = m.x;
        m.train!.stopY = m.y;
      }
      const center = tileToLngLat(tile, { x: 2048, y: 2048 });
      const visible = () =>
        world
          .visible(18, { ...activityLevels(1), train: 0 }, center)
          .filter((a) => a.kind === 'train');
      expect(visible().map((a) => a.vehicle)).toEqual(['locomotive', 'coach']);
      const before = m.x;
      world.step(0.1, undefined, 18);
      if (state === 'dwelling') {
        expect(m.pause).toBeCloseTo(0.1);
        expect(m.x).toBe(before);
      } else expect(m.x).toBeGreaterThan(before);
      for (let i = 0; i < 10; i++) world.step(0.1, undefined, 18);
      expect(m.pause).toBeLessThanOrEqual(0);
      expect(m.x).toBeGreaterThan(before);
      expect(visible().map((a) => a.vehicle)).toEqual(['locomotive', 'coach']);
    });

  it('transforms frames at different zooms and samples track without mutation', () => {
    const to = { z: 17, x: tile.x * 2 + 1, y: tile.y * 2 };
    const f = frameBetween(tile, to),
      back = frameBetween(to, tile);
    expect(back.x + (f.x + 1234 * f.scale) * back.scale).toBe(1234);
    const life = new TileLife(tile, rail(), 1),
      m = train(100 * pm);
    const before = structuredClone(m),
      samples: number[] = [];
    life.trackAhead(m, 100 * pm, (p) => samples.push(p.distance));
    expect(samples[0]).toBe(0);
    expect(samples.at(-1)).toBeCloseTo(100 * pm);
    expect(m).toEqual(before);
  });
  it('queues behind the full consist at a station, then stops after its leader leaves', () => {
    const life = new TileLife(tile, rail(true), 1);
    const leader = train(300 * pm, 6),
      follower = train(170 * pm, 12);
    life.movers.splice(0, life.movers.length, leader, follower);
    const stopped = new Set<Mover>();
    for (let i = 0; i < 700; i++) {
      const previous = new Map(life.movers.map((m) => [m, m.v ?? m.speed]));
      life.step(0.1);
      for (const m of [leader, follower]) {
        if (m.pause > 0) {
          stopped.add(m);
          expect(m.v).toBe(0);
        }
        expect(m.v! - previous.get(m)!).toBeLessThanOrEqual(0.8 * pm * 0.1 + 1e-8);
      }
      if (!leader.train!.edge)
        expect(
          (leader.x - follower.x) / pm - trainLength(leader.train!.cars),
        ).toBeGreaterThanOrEqual(30 - 1e-6);
    }
    expect(stopped.has(leader)).toBe(true);
    expect(stopped.has(follower)).toBe(true);
  });
  it('brakes behind a dwelling train across a loaded seam', () => {
    const east = { ...tile, x: tile.x + 1 },
      world = new LifeWorld();
    world.sync([
      { key: 'west', tile, life: rail() },
      { key: 'east', tile: east, life: rail() },
    ]);
    const westLife = worldTiles(world).get('west')!,
      eastLife = worldTiles(world).get('east')!;
    const follower = train(3500, 14),
      leader = train(200, 0);
    leader.pause = 100;
    westLife.movers.splice(0, westLife.movers.length, follower);
    eastLife.movers.splice(0, eastLife.movers.length, leader);
    const limit = trainLimits([westLife, eastLife], 0.1).get(follower)!;
    expect(limit.target).toBeLessThan(follower.speed);
    for (let i = 0; i < 200; i++) {
      world.step(0.1);
      expect(
        (4096 + leader.x - follower.x) / pm - trainLength(leader.train!.cars),
      ).toBeGreaterThanOrEqual(30 - 1e-6);
    }
  });
  it('keeps the existing head-on passing policy', () => {
    const life = new TileLife(tile, rail(), 1),
      a = train(200 * pm),
      b = train(250 * pm, 12, -1);
    life.movers.splice(0, life.movers.length, a, b);
    const limits = trainLimits([life], 0.1);
    expect(limits.get(a)!.target).toBe(a.speed);
    expect(limits.get(b)!.target).toBe(b.speed);
  });
});
