import { expect, it, vi } from 'vitest';
import { FrameProfiler } from '../profile';
import { LifeDiagnostics, PackingOutcome } from './diagnostics';
import { LifeBuilder, LifeLine } from './geometry';
import { LifeWorld, type Mover, type TileLife, type WorldGroundGuard } from './simulate';
import { completeScenarioState, worldTiles } from './testing/scenarios';
import { pedestrianEntry, seedPedestrians } from './testing/pedestrians';
import { continuityMover, continuityTile, left, right } from './testing/continuity';
import { metersPerUnit } from '../raster/geometry';
import { PEDESTRIAN } from './config';

const bounds = [-180, -85, 180, 85];
function observed(seam = false, profiled = true) {
  const sink = new LifeDiagnostics();
  const world = new LifeWorld(undefined, profiled ? new FrameProfiler(() => 0, sink) : undefined, {
    enabled: false,
  });
  let life: TileLife, car: Mover, human: Mover;
  if (!seam) {
    world.sync([pedestrianEntry()]);
    ({ life, car, human } = seedPedestrians(world));
    car.x = car.d = 2000 - 5.2 * life.perMeter;
  } else {
    const pm = 1 / metersPerUnit(left),
      b = new LifeBuilder();
    b.line(
      [
        { x: -100, y: 2000 },
        { x: 4196, y: 2000 },
      ],
      LifeLine.roadMajor,
      14,
      77,
    );
    b.line(
      [
        { x: 4090, y: 2000 - 40 * pm },
        { x: 4090, y: 2000 + 40 * pm },
      ],
      LifeLine.path,
      3,
    );
    b.area('crossing', [
      [
        { x: 4090 - 1.5 * pm, y: 2000 - 7 * pm },
        { x: 4090 + 1.5 * pm, y: 2000 - 7 * pm },
        { x: 4090 + 1.5 * pm, y: 2000 + 7 * pm },
        { x: 4090 - 1.5 * pm, y: 2000 + 7 * pm },
      ],
    ]);
    const target = continuityTile(right);
    const blocked = new LifeBuilder();
    blocked.line(
      [
        { x: -100, y: 2000 },
        { x: 4196, y: 2000 },
      ],
      LifeLine.roadMajor,
      14,
      77,
    );
    blocked.area('blocked', [
      [
        { x: -20, y: 1900 },
        { x: 50, y: 1900 },
        { x: 50, y: 2100 },
        { x: -20, y: 2100 },
      ],
    ]);
    target.life = blocked.finish();
    world.sync([{ key: 'source', tile: left, life: b.finish() }, target]);
    life = worldTiles(world).get('source')!;
    for (const tile of worldTiles(world).values()) {
      tile.movers.length = tile.parked.length = tile.stalls.length = tile.gatherers.length = 0;
      tile.scenes.sites.length = 0;
    }
    car = continuityMover(life, 4090 - 5.2 * pm);
    human = {
      ...car,
      kind: 'person',
      vehicle: undefined,
      routing: undefined,
      line: 1,
      from: 2,
      x: 4090,
      y: 2000 - 5 * pm,
      d: 35 * pm,
      hx: 0,
      hy: 1,
      speed: 0,
      v: undefined,
      pause: 100,
      group: [{ figure: 'adult', shirt: 3, canopy: 0, umbrella: 0, lateral: 0, back: 0, step: 0 }],
    };
    life.movers.push(car, human);
  }
  car.v = 0;
  car.waiting = 30;
  human.pause = 100;
  (life as unknown as { runRng: () => number }).runRng = () => 1;
  const step = () => {
    sink.beginFrame(0.1, bounds, 18, 1, true);
    world.step(0.1, undefined, 18);
    const agents = world.visible(18, 1, [123, 13]);
    sink.finishFrame(agents, new Uint8Array(agents.length).fill(PackingOutcome.drawn));
  };
  const guard = () => (world as unknown as { groundGuard(): WorldGroundGuard }).groundGuard();
  return { world, life, car, human, sink, step, guard };
}

it('excludes a real courtesy stop beyond ten seconds, then counts persistent physical blockage after expiry', () => {
  const f = observed();
  const start = f.car.x;
  for (let i = 0; i < 150; i++) f.step();
  expect(f.car.x).toBeCloseTo(start);
  expect(f.car.dir).toBe(1);
  expect(f.car.waiting).toBe(30);
  expect(f.car.pedestrianHolds?.[0]?.elapsed).toBeCloseTo(15);
  expect(f.sink.report().holds.signal).toBe(150);
  expect(f.sink.report().motion.vehicle.stuckFrames).toBe(0);
  f.human.y = f.life.pose(f.car).y;
  f.human.d = f.human.y - f.life.geo.coords[5]!;
  for (let i = 0; i < 180; i++) f.step();
  expect(f.car.pedestrianHolds?.[0]?.expired).toBe(true);
  expect(f.car.pedestrianHolds?.[0]?.elapsed).toBe(PEDESTRIAN.holdMax);
  expect(f.sink.report().motion.vehicle.stuckFrames).toBeGreaterThan(0);
});

it.each(['cleared', 'committed', 'expired', 'retained', 'approach'] as const)(
  'grants no courtesy exemption to a %s record or unrelated blockage',
  (state) => {
    const f = observed();
    f.step();
    const record = f.car.pedestrianHolds![0]!;
    if (state === 'committed') f.car.pedestrianHolds = [{ ...record, committed: true }];
    if (state === 'expired') f.car.pedestrianHolds = [{ ...record, expired: true, elapsed: 20 }];
    if (state === 'retained') {
      f.car.x = 2000 + 2 * f.life.perMeter;
      f.car.d = f.car.x;
    }
    if (state === 'approach') {
      f.car.x -= 5 * f.life.perMeter;
      f.car.d = f.car.x;
    }
    if (state === 'cleared') f.life.movers.splice(f.life.movers.indexOf(f.human), 1);
    const before = structuredClone(f.car.pedestrianHolds);
    const g = f.guard();
    expect(f.life.courtesyHeld(f.car, g.pedestrians(f.life), 0.1)).toBe(false);
    expect(f.car.pedestrianHolds).toEqual(before);
    const holds = f.sink.report().holds.signal;
    f.step();
    expect(f.sink.report().holds.signal).toBe(holds);
  },
);

it.each([
  [false, 'cleared'],
  [true, 'cleared'],
  [false, 'expired'],
  [true, 'expired'],
] as const)(
  'freezes unsafe-seam rejection and queued recovery only while courtesy is active (queued %s, %s)',
  (queued, release) => {
    const f = observed(true),
      plain = observed(true, false);
    const history = { key: 'pending', seconds: queued ? 8 : 7, at: 0, queued };
    const plainHistory = { ...history };
    type Internals = {
      rejectedSeams: WeakMap<Mover, typeof history>;
      queuedSeams: Map<Mover, TileLife>;
    };
    (f.world as unknown as Internals).rejectedSeams.set(f.car, history);
    (plain.world as unknown as Internals).rejectedSeams.set(plain.car, plainHistory);
    if (queued) {
      (f.world as unknown as Internals).queuedSeams.set(f.car, f.life);
      (plain.world as unknown as Internals).queuedSeams.set(plain.car, plain.life);
    }
    const recover = vi.spyOn(f.life, 'recoverVehicle');
    const start = f.car.x;
    for (let i = 0; i < 120; i++) {
      f.step();
      plain.step();
    }
    expect(recover).not.toHaveBeenCalled();
    expect(history.seconds).toBe(queued ? 8 : 7);
    expect(history.queued).toBe(queued);
    expect(f.car.x).toBeCloseTo(start);
    expect(f.car.pedestrianHolds?.[0]?.elapsed).toBeCloseTo(12);
    expect(completeScenarioState(f.world)).toEqual(completeScenarioState(plain.world));
    if (release === 'cleared')
      for (const fixture of [f, plain])
        fixture.life.movers.splice(fixture.life.movers.indexOf(fixture.human), 1);
    for (let i = 0; i < (release === 'cleared' ? 100 : 180); i++) {
      f.step();
      plain.step();
    }
    expect(recover).toHaveBeenCalled();
    expect(worldTiles(f.world).get('source')!.movers).toContain(f.car);
    expect(f.car.dir).toBe(-1);
    expect(completeScenarioState(f.world)).toEqual(completeScenarioState(plain.world));
  },
);

it('expires the read-only seam decision on the same step as its single production timer advance', () => {
  const f = observed(true);
  f.step();
  f.car.pedestrianHolds = [{ ...f.car.pedestrianHolds![0]!, elapsed: 19.9 }];
  const record = f.car.pedestrianHolds;
  const g = f.guard();
  for (let i = 0; i < 3; i++)
    expect(f.life.courtesyHeld(f.car, g.pedestrians(f.life), 0.1)).toBe(false);
  expect(f.car.pedestrianHolds).toBe(record);
  const holds = f.sink.report().holds.signal;
  f.step();
  expect(f.car.pedestrianHolds?.[0]?.elapsed).toBe(20);
  expect(f.sink.report().holds.signal).toBe(holds);
});
