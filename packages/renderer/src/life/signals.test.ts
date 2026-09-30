import { describe, expect, it } from 'vitest';
import { metersPerUnit } from '../raster/geometry';
import { LifeBuilder, LifeLine } from './geometry';
import { signalState } from './signals';
import { TileLife, LifeWorld, type Mover } from './simulate';
import { completeScenarioState, worldTiles } from './testing/scenarios';
const tile = { z: 16, x: 55192, y: 30266 },
  pm = 1 / metersPerUnit(tile);
function geography(signal = true, shared = true) {
  const b = new LifeBuilder();
  b.line(
    shared
      ? [
          { x: 0, y: 2048 },
          { x: 2048, y: 2048 },
          { x: 4096, y: 2048 },
        ]
      : [
          { x: 0, y: 2048 },
          { x: 4096, y: 2048 },
        ],
    LifeLine.roadMajor,
    14,
  );
  b.line(
    shared
      ? [
          { x: 2048, y: 0 },
          { x: 2048, y: 2048 },
          { x: 2048, y: 4096 },
        ]
      : [
          { x: 2048, y: 0 },
          { x: 2048, y: 4096 },
        ],
    LifeLine.roadMinor,
    6,
  );
  if (signal) b.signal({ x: 2048, y: 2048 }, 8, 90, 0, true);
  return b.finish();
}
const car = (): Mover => ({
  kind: 'vehicle',
  line: 0,
  from: 0,
  dir: 1,
  d: 2048 - 50 * pm,
  x: 2048 - 50 * pm,
  y: 2048,
  hx: 1,
  hy: 0,
  speed: 8 * pm,
  vehicle: 'car',
  paint: 0,
  lane: 0,
  pause: 0,
  rank: 0,
});
describe('signals', () => {
  it('cycles both axes with amber and all-red gaps, with mid-block pedestrian clearance', () => {
    const colors = new Set(
      Array.from({ length: 1000 }, (_, i) => {
        const s = signalState(7, i / 10);
        expect(s.a === 'green' && s.b === 'green').toBe(false);
        return `${s.a}/${s.b}`;
      }),
    );
    expect(colors).toEqual(
      new Set(['green/red', 'amber/red', 'red/red', 'red/green', 'red/amber']),
    );
    expect(
      Array.from({ length: 60 }, (_, i) => signalState(0, i, true)).some(
        (s) => s.walkA && s.a === 'red' && s.b === 'red',
      ),
    ).toBe(true);
  });
  it('stops before a red line, proceeds on green, and leaves existing spawns unchanged', () => {
    const life = new TileLife(tile, geography(), 1),
      baseline = new TileLife(tile, geography(false), 1);
    expect(life.movers).toEqual(baseline.movers);
    const m = car(),
      follower = { ...car(), d: car().d - 15 * pm, x: car().x - 15 * pm };
    life.movers.splice(0, life.movers.length, m, follower);
    life.parked.length = 0;
    const s = life.signals.signals[0]!;
    const red = Array.from({ length: 100 }, (_, t) => t).find(
      (t) => signalState(s.seed, t).a === 'red',
    )!;
    const stopX = 2048 - (8 + 1.5 + 2.2) * pm;
    for (let i = 0; i < 600; i++) {
      life.step(1 / 60, undefined, undefined, undefined, { rain: 0, clock: red });
      expect(m.x).toBeLessThanOrEqual(stopX + 0.01 * pm);
    }
    expect((stopX - m.x) / pm).toBeLessThan(0.5);
    expect(follower.x).toBeLessThan(m.x - 4.4 * pm);
    const green = Array.from({ length: 100 }, (_, t) => t).find(
      (t) => signalState(s.seed, t).a === 'green',
    )!;
    for (let i = 0; i < 120; i++)
      life.step(1 / 60, undefined, undefined, undefined, { rain: 0, clock: green });
    expect(m.x).toBeGreaterThan(stopX + pm);
  });
  it('waits at the curb but lets walkers already crossing clear', () => {
    const life = new TileLife(tile, geography(), 1),
      s = life.signals.signals[0]!;
    const red = Array.from({ length: 100 }, (_, t) => t).find(
      (t) => !signalState(s.seed, t).walkA,
    )!;
    const from = { x: 2048 - 10 * pm, y: 2048 },
      target = { x: 2048, y: 2048 };
    expect(life.signals.walkDistance(from, target, 10 * pm, red) / pm).toBeCloseTo(1.5);
    expect(life.signals.walkDistance(target, { x: 2100, y: 2048 }, pm, red)).toBe(pm);
  });
  it('shares phases across buffered tiles and replays exactly independently at 30 and 60 Hz', () => {
    const g = geography(),
      other = { ...g, signals: Float32Array.from([-2048, 2048, 8, 90, 0, 1]) };
    const a = new TileLife(tile, g, 1),
      b = new TileLife({ ...tile, x: tile.x + 1 }, other, 2);
    expect(a.signals.signals[0]!.seed).toBe(b.signals.signals[0]!.seed);
    for (const hz of [30, 60]) {
      const worlds = [new LifeWorld(), new LifeWorld()];
      for (const world of worlds) world.sync([{ tile, key: 'signal-test', life: g }]);
      for (let i = 0; i < 60; i++) for (const world of worlds) world.step(1 / hz);
      expect(completeScenarioState(worlds[0]!)).toEqual(completeScenarioState(worlds[1]!));
    }
  }, 30000);
});
describe('junction reservations', () => {
  it('clears a real shared junction within thirty seconds with collision protection enabled', () => {
    const world = new LifeWorld();
    world.sync([{ tile, key: 'yield', life: geography(false) }]);
    const life = worldTiles(world).get('yield')!;
    life.parked.length = 0;
    life.stalls.length = 0;
    life.gatherers.length = 0;
    const high = car(),
      low = {
        ...car(),
        line: 1,
        from: 3,
        hx: 0,
        hy: 1,
        x: 2048 + 2 * pm,
        y: 2048 - 25 * pm,
        d: 2048 - 25 * pm,
      };
    high.y += 4 * pm;
    life.movers.splice(0, life.movers.length, high, low);
    for (let i = 0; i < 30 * 60; i++) world.step(1 / 60);
    expect(low.y).toBeGreaterThan(2048 + 10 * pm);
    expect(low.waiting ?? 0).toBeLessThan(30);
  });
  it('indexes shared vertices including signalized junctions, but ignores bridges', () => {
    expect(new TileLife(tile, geography(false, false), 1).junctionIndex.junctions).toHaveLength(0);
    expect(new TileLife(tile, geography(true), 1).junctionIndex.junctions).toHaveLength(1);
  });
});
