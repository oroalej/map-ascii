import { describe, expect, it } from 'vitest';
import { hashString, metersPerUnit, tileToLngLat } from '../raster/geometry';
import { LifeBuilder, LifeLine } from './geometry';
import { signalState, SignalPresses, pedestrianState } from './signals';
import { SIGNAL } from './config';
import { TileLife, LifeWorld, type Mover } from './simulate';
import { completeScenarioState, worldTiles } from './testing/scenarios';
import type { JunctionTable } from './junctions';
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
  it.each([false, true])(
    'presses retain complete clearance and mid-block walk windows (mid-block=%s)',
    (midBlock) => {
      for (let clock = 0; clock < 130; clock++) {
        const presses = new SignalPresses(),
          before = signalState(0, clock, midBlock);
        expect(presses.snapshot()).toBeUndefined();
        expect(presses.press(0, midBlock, clock)).toBe(true);
        const after = signalState(0, clock, midBlock, presses.offsets);
        if (before.a === 'green' || before.b === 'green') {
          expect(after.a === 'amber' || after.b === 'amber').toBe(true);
          expect(after.left).toBe(SIGNAL.amber);
          const end = signalState(0, clock + SIGNAL.amber, midBlock, presses.offsets);
          expect(end).toMatchObject({ a: 'red', b: 'red', left: SIGNAL.allRed });
          expect(pedestrianState(0, clock, midBlock, 'a', presses.offsets)).toBe('dont');
        } else expect(after).toEqual(before);
        expect(presses.press(0, midBlock, clock + 4.99)).toBe(false);
        expect(presses.press(0, midBlock, clock + 5)).toBe(true);
      }
    },
  );
  it('catches only moving, stoppable vehicles before the pressed approach stop line', () => {
    const life = new TileLife(tile, geography(), 1),
      m = car(),
      signal = life.signals.signals[0]!;
    const clock = Array.from({ length: 150 }, (_, t) => t).find(
      (t) => signalState(signal.seed, t).a === 'green',
    )!;
    const presses = new SignalPresses();
    presses.press(signal.seed, false, clock);
    life.signals.offsets = presses.offsets;
    m.v = pm;
    expect(life.signals.caught(m, signal.seed, false, clock)).toBe(true);
    m.v = 0;
    expect(life.signals.caught(m, signal.seed, false, clock)).toBe(false);
    m.v = pm;
    m.d = 2200;
    expect(life.signals.caught(m, signal.seed, false, clock)).toBe(false);
  });
  it('recognizes only explicitly tagged crossing anchors, including mapped crossings outside the old disk', () => {
    const geo = geography();
    const stripe = { x: 2048 + 15 * pm, y: 2048 };
    geo.controlledCrossings = [
      {
        id: 'mapped-cross',
        anchor: stripe,
        bearing: 90,
        width: 3,
        lineId: 42,
        controller: {
          id: 'signal',
          at: tileToLngLat(tile, { x: 2048, y: 2048 }),
          seed: 1,
          midBlock: false,
          walk: 'b',
        },
      },
    ];
    const life = new TileLife(tile, geo, 1);
    expect(life.signals.controlsCrossing(stripe)).toBe(true);
    expect(life.signals.controlsCrossing({ x: 2048, y: 2048 })).toBe(false);
    expect(life.signals.controlsCrossing({ x: stripe.x + 8, y: stripe.y })).toBe(false);
  });
  it('does not substitute a radius stop when exact layout stops fail local road matching', () => {
    const geo = geography(true, false);
    geo.lineIds = Uint32Array.from([hashString('road/main'), hashString('road/side')]);
    const center = tileToLngLat(tile, { x: 2048, y: 2048 });
    geo.signalLayouts = [
      {
        members: [center],
        arms: [
          {
            road_id: 'road/main',
            junction: center,
            toward: tileToLngLat(tile, { x: 0, y: 2048 }),
            direction: 1,
            inbound: true,
            outbound: true,
            bearing: 90,
            width: 14,
            group: 'a',
            stop: tileToLngLat(tile, { x: 2048 - 9.5 * pm, y: 2048 }),
            stop_width: 7,
          },
        ],
      },
    ];
    const life = new TileLife(tile, geo, 1);
    expect(life.signals.signals[0]!.approaches).toEqual([]);
    const m = { ...car(), d: 2048 - 15 * pm, x: 2048 - 15 * pm };
    for (const color of ['red', 'green'] as const) {
      const clock = Array.from({ length: 140 }, (_, t) => t).find(
        (t) => signalState(life.signals.signals[0]!.seed, t).a === color,
      )!;
      expect(life.signals.allows(m, 2048, 2048, clock, 15 * pm)).toBe(true);
      const speed = life.signals.vehicleSpeed(m, 0.1, clock);
      expect(speed).toBe(m.speed);
    }
  });
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
  // eslint-disable-next-line no-restricted-syntax -- slow before the time-limit ban; tracked by the CI file budget
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
  it('does not prepare or reserve zoom-hidden vehicles and releases their previous grants', () => {
    const world = new LifeWorld();
    world.sync([{ tile, key: 'zoom', life: geography(false) }]);
    const life = worldTiles(world).get('zoom')!;
    life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
    life.scenes.sites.length = 0;
    const m = { ...car(), d: 2048 - 10 * pm, x: 2048 - 10 * pm, v: 0 };
    life.movers.push(m);
    const table = (world as unknown as { junctions: JunctionTable }).junctions;
    const before = structuredClone(m);
    world.step(0.1, undefined, 14);
    expect(m).toEqual(before);
    expect(table.snapshot()).toEqual([]);

    world.step(0.1, undefined, 18);
    expect(table.granted(m)).toBe(true);
    expect(m.x).toBeGreaterThan(before.x);
    const paused = structuredClone(m);
    world.step(0.1, undefined, 14);
    expect(m).toEqual(paused);
    expect(table.snapshot()).toEqual([]);

    world.step(0.1, undefined, 18);
    expect(table.granted(m)).toBe(true);
    expect(m.x).toBeGreaterThan(paused.x);
  });
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
