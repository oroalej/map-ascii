import { expect, it } from 'vitest';
import { JunctionTable, type Movement } from './junctions';
import { LifeBuilder, LifeLine } from './geometry';
import { LifeWorld, TileLife, type Mover, type GroundGuard } from './simulate';
import { pedestrianWorld } from './testing/pedestrians';
import { signalizedCrossingEntry, seedSignalizedCrossing } from './testing/signalized-crossing';
import { continuityMover, left } from './testing/continuity';
import { signalState } from './signals';
import { EMERGENCY } from './emergency';

it('retains pedestrian braking and controlled crossing reservations with lights on', () => {
  const f = pedestrianWorld(3);
  f.car.vehicle = 'ambulance';
  f.car.emergency = {
    id: 'a',
    kind: 'ambulance',
    phase: 'responding',
    lights: true,
    baseSpeedMps: 8,
    remaining: 0,
    offscreen: 0,
    run: 1,
  };
  for (let i = 0; i < 150; i++) f.world.step(1 / 30, undefined, 18);
  expect(f.car.x).toBeLessThan(f.human.x - 2 * f.life.perMeter);
  expect(f.car.v! / f.life.perMeter).toBeLessThan(0.1);
  const world = new LifeWorld();
  world.sync([signalizedCrossingEntry()]);
  const { life, m: human } = seedSignalizedCrossing(world),
    car = continuityMover(life, 2000 - 15 * life.perMeter);
  car.from = 0;
  car.d = car.x - life.geo.coords[0]!;
  car.y = 2000;
  car.vehicle = 'ambulance';
  car.emergency = { ...f.car.emergency, id: 'controlled' };
  life.movers.push(car);
  for (let i = 0; i < 60; i++) world.step(1 / 30, undefined, 18);
  expect(human.x).toBeGreaterThan(2000 - 6 * life.perMeter);
  expect(car.x).toBeLessThan(2000);
});

it('orders urgent arrivals first while keeping conflicting grants and occupants authoritative', () => {
  const life = new TileLife(left, new LifeBuilder().finish(), 1);
  const path = (x: number, y: number): Movement => ({
    key: 'j',
    junction: { key: 'j', x: 0, y: 0, radius: 7, arms: [] },
    inHx: x,
    inHy: y,
    outHx: x,
    outHy: y,
    stop: 0,
    line: 0,
    dir: 1,
    exit: { line: 0, along: 0, out: 1, hx: x, hy: y },
    ahead: 0,
  });
  const urgent = {
    kind: 'vehicle',
    vehicle: 'ambulance',
    emergency: {
      id: 'a',
      kind: 'ambulance',
      phase: 'responding',
      lights: true,
      baseSpeedMps: 8,
      remaining: 0,
      offscreen: 0,
      run: 1,
    },
  } as Mover;
  const ordinary = { kind: 'vehicle', vehicle: 'car' } as Mover;
  for (const occupied of [false, true]) {
    const table = new JunctionTable();
    table.begin(new Set([life]));
    table.request({
      m: ordinary,
      life,
      tileKey: '0',
      index: 0,
      movement: path(0, -1),
      ready: true,
      inside: occupied,
      atLine: true,
    });
    table.request({
      m: urgent,
      life,
      tileKey: '1',
      index: 1,
      movement: path(-1, 0),
      ready: true,
      inside: false,
      atLine: true,
    });
    table.resolve(0);
    expect(table.granted(urgent)).toBe(!occupied);
  }
  const table = new JunctionTable();
  table.begin(new Set([life]));
  table.request({
    m: ordinary,
    life,
    tileKey: '0',
    index: 0,
    movement: path(0, -1),
    ready: true,
    inside: false,
    atLine: true,
  });
  table.resolve(0);
  table.begin(new Set([life]));
  table.request({
    m: ordinary,
    life,
    tileKey: '0',
    index: 0,
    movement: path(0, -1),
    ready: true,
    inside: false,
    atLine: true,
  });
  table.request({
    m: urgent,
    life,
    tileKey: '1',
    index: 1,
    movement: path(-1, 0),
    ready: true,
    inside: false,
    atLine: true,
  });
  table.resolve(1);
  expect(table.granted(urgent)).toBe(false);
});
it.each([false, true])('creeps through an earned red grant only with lights on (%s)', (lights) => {
  const b = new LifeBuilder();
  b.line(
    [
      { x: 0, y: 2000 },
      { x: 2000, y: 2000 },
      { x: 4096, y: 2000 },
    ],
    LifeLine.roadMajor,
    12,
  );
  b.line(
    [
      { x: 2000, y: 0 },
      { x: 2000, y: 2000 },
      { x: 2000, y: 4096 },
    ],
    LifeLine.roadMajor,
    12,
  );
  b.signal({ x: 2000, y: 2000 }, 8, 90, 0, true);
  const life = new TileLife(left, b.finish(), 1),
    m = continuityMover(life, 2000 - 30 * life.perMeter);
  m.from = 0;
  m.d = m.x;
  m.y = 2000;
  m.speed = 8 * life.perMeter;
  m.v = 8 * life.perMeter;
  m.vehicle = 'ambulance';
  m.emergency = {
    id: 'a',
    kind: 'ambulance',
    phase: lights ? 'responding' : 'cleared',
    lights,
    baseSpeedMps: 8,
    remaining: 0,
    offscreen: 0,
    run: 1,
  };
  const seed = life.signals.signals[0]!.seed,
    clock = Array.from({ length: 100 }, (_, i) => i).find((i) => signalState(seed, i).a === 'red')!;
  life.movers.splice(0, life.movers.length, m);
  const ground = (life as unknown as { standaloneGround: GroundGuard }).standaloneGround;
  life.parked.length = life.stalls.length = 0;
  for (let i = 0; i < 600; i++) {
    life.step(
      1 / 30,
      () => 0,
      (kind) => kind === 'vehicle',
      undefined,
      { rain: 0, clock },
      ground,
    );
    if (m.x >= 2000 - 10 * life.perMeter && m.x <= 2000 + 10.7 * life.perMeter)
      expect(m.v / life.perMeter).toBeLessThanOrEqual(EMERGENCY.creepMps + 1e-6);
  }
  expect(
    m.x > 2000,
    JSON.stringify({
      x: m.x,
      speed: m.v / life.perMeter,
      signals: life.signals.signals,
      holds: (life as unknown as { localJunctions: JunctionTable }).localJunctions.snapshot(),
    }),
  ).toBe(lights);
});
