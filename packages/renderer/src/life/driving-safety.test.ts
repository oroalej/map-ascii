import { expect, it, vi } from 'vitest';
import { LifeBuilder, LifeLine } from './geometry';
import { LifeWorld, TileLife } from './simulate';
import { activityLevels, FOLLOW } from './config';
import { signalState } from './signals';
import { VEHICLES } from './vehicles';
import { bodiesOverlap } from './occupancy';
import { tileToLngLat } from '../raster/geometry';
import {
  driveMover,
  drivePm,
  driveRoad,
  driveStep,
  driveStreams,
  driveTile,
} from './testing/driving';
import { pedestrianWorld, pedestrianEntry, seedPedestrians } from './testing/pedestrians';
import { createLifeWorkerApi, runLifeFrame, type FrameInput } from './worker-api';
import { completeScenarioState } from './testing/scenarios';
import { continuityMover, continuityTile, left } from './testing/continuity';
import { worldTiles } from './testing/scenarios';
import type { JunctionTable } from './junctions';

it('still follows a slower leader during a forced burst', () => {
  const life = driveRoad(),
    follower = driveMover(life, 500),
    leader = driveMover(life, 650, 2);
  follower.rush = 12;
  driveStreams(life).rushRng = () => 1;
  for (let frame = 0; frame < 100; frame++) {
    driveStep(life);
    expect((leader.x - follower.x) / drivePm - VEHICLES.car.length).toBeGreaterThanOrEqual(
      FOLLOW.minGap - 1e-7,
    );
  }
  expect(follower.v).toBeLessThan(follower.speed);
});

it('cancels a burst on a service approach and does not admit one during dwell', () => {
  const life = driveRoad(),
    m = driveMover(life, 1000);
  m.vehicle = 'jeepney';
  m.rush = 5;
  const site = {
    kind: 'stop' as const,
    x: m.x + 40 * drivePm,
    y: m.y + 8 * drivePm,
    modes: 7,
    covered: true,
    queue: [],
    capacity: 6,
    hx: 1,
    hy: 0,
    road: 0,
    roadWidth: 14,
    direction: 1,
  };
  life.scenes.sites.push(site);
  life.scenes.services.set(m, { site, time: 10, boarded: 0, arriving: true });
  driveStreams(life).rushRng = () => 0;
  driveStep(life);
  expect(m.rush).toBe(0);
  life.scenes.services.set(m, { site, time: 10, boarded: 0, arriving: false });
  driveStep(life);
  expect(m.rush).toBe(0);
  expect(m.v).toBe(0);
});

it('stops a forced speeder at a red signal', () => {
  const b = new LifeBuilder();
  b.line(
    [
      { x: 0, y: 2000 },
      { x: 2048, y: 2000 },
      { x: 4095, y: 2000 },
    ],
    LifeLine.roadMajor,
    14,
  );
  b.line(
    [
      { x: 2048, y: 0 },
      { x: 2048, y: 2000 },
      { x: 2048, y: 4095 },
    ],
    LifeLine.roadMinor,
    6,
  );
  b.signal({ x: 2048, y: 2000 }, 8, 90, 0, true);
  const geo = b.finish(),
    life = new TileLife(driveTile, geo, 1);
  life.movers.length = life.scenes.sites.length = 0;
  const m = driveMover(life, 2048 - 50 * drivePm);
  m.rush = 12;
  driveStreams(life).rushRng = () => 1;
  const red = Array.from({ length: 100 }, (_, t) => t).find(
    (t) => signalState(life.signals.signals[0]!.seed, t).a === 'red',
  )!;
  for (let frame = 0; frame < 100; frame++) driveStep(life, 0, { clock: red });
  expect(m.x).toBeLessThan(2048);
  expect(m.v).toBe(0);
});

it('a forced speeder still brakes for a complete pedestrian footprint', () => {
  const f = pedestrianWorld(3);
  f.car.rush = 10;
  driveStreams(f.life).rushRng = () => 1;
  for (let frame = 0; frame < 50; frame++) {
    f.world.step(0.1, undefined, 18, undefined, undefined, { rain: 0 });
    expect(bodiesOverlap(f.life.groundBodies(f.car)[0]!, f.life.groundBodies(f.human)[0]!)).toBe(
      false,
    );
  }
  expect(f.car.x).toBeLessThan(f.human.x);
  expect(f.car.v).toBeLessThan(f.car.speed);
});

it('keeps forced bursts and rain transitions identical through worker and inline frames', () => {
  const entry = pedestrianEntry(),
    direct = new LifeWorld(),
    remote = new LifeWorld();
  direct.sync([entry]);
  const api = createLifeWorkerApi(undefined, () => remote);
  api.init({ processions: [] });
  api.sync([structuredClone(entry)]);
  for (const world of [direct, remote]) {
    const { life, car } = seedPedestrians(world);
    life.movers.splice(1); // isolate the driven car, keeping production world clearance
    car.x = car.d = 1000;
    car.rush = 10;
    driveStreams(life).rushRng = () => 1;
  }
  const center = tileToLngLat(driveTile, { x: 2000, y: 2000 });
  for (let frame = 0; frame < 30; frame++) {
    const input: FrameInput = {
      gust: {
        camera: { lng: center[0], lat: center[1], zoom: 18 },
        size: { width: 800, height: 600 },
        cssCell: { w: 5, h: 7.5 },
        time: frame / 10,
        wind: { dir: [1, 0], strength: 0 },
      },
      step: {
        dt: 0.1,
        zoom: 18,
        bounds: undefined,
        wind: undefined,
        weather: { rain: frame < 15 ? 0 : 1 },
        cellMeters: 0.9,
      },
      visible: [18, activityLevels(1), center],
    };
    expect(api.frame(input).agents).toEqual(runLifeFrame(direct, input).agents);
  }
  expect(completeScenarioState(remote)).toEqual(completeScenarioState(direct));
});

it('does not perturb the existing route and population random streams', () => {
  const a = driveRoad(),
    b = driveRoad();
  driveMover(a);
  driveMover(b);
  const states = [a, b].map(
    (life) =>
      life as unknown as {
        rng: () => number;
        routeRng: () => number;
        walkerRng: () => number;
        runRng: () => number;
      },
  );
  const tick = a as unknown as {
    rushTick(m: (typeof a.movers)[number], dt: number, room: boolean): void;
  };
  driveStreams(a).rushRng = vi.fn(() => 0);
  tick.rushTick(a.movers[0]!, 0.1, true);
  for (const key of ['rng', 'routeRng', 'walkerRng', 'runRng'] as const)
    expect(states[0]![key]()).toBe(states[1]![key]());
});

it('holds a forced speeder before a denied junction', () => {
  const b = new LifeBuilder();
  b.line(
    [
      { x: 0, y: 2000 },
      { x: 2000, y: 2000 },
      { x: 4000, y: 2000 },
    ],
    LifeLine.roadMajor,
    14,
  );
  b.line(
    [
      { x: 2000, y: 0 },
      { x: 2000, y: 2000 },
      { x: 2000, y: 4000 },
    ],
    LifeLine.roadMinor,
    6,
  );
  const life = new TileLife(driveTile, b.finish(), 1);
  life.movers.length = life.parked.length = life.scenes.sites.length = 0;
  const car = driveMover(life, 2000 - 40 * drivePm);
  car.rush = 10;
  driveStreams(life).rushRng = () => 1;
  const table = (life as unknown as { localJunctions: JunctionTable }).localJunctions;
  const denied = vi.spyOn(table, 'canEnter').mockReturnValue(false);
  try {
    for (let i = 0; i < 80; i++) driveStep(life);
    expect(denied).toHaveBeenCalled();
    expect(car.x).toBeLessThan(2000);
    expect(car.v).toBe(0);
  } finally {
    denied.mockRestore();
  }
});

it('keeps a forced speeder inside a tile while the destination seam is unavailable', () => {
  const entry = continuityTile(left),
    world = new LifeWorld();
  world.sync([entry]);
  const life = worldTiles(world).get(entry.key)!;
  life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
  life.pending.length = life.scenes.sites.length = 0;
  const car = continuityMover(life, 4096 - 12 * life.perMeter);
  car.rush = 10;
  car.v = car.speed;
  life.movers.push(car);
  driveStreams(life).rushRng = () => 1;
  for (let i = 0; i < 20; i++) {
    world.step(0.1, undefined, 18, undefined, undefined, { rain: 0 });
    expect(life.pose(car).x).toBeLessThan(4096);
  }
  expect(life.movers).toContain(car);
  expect(car.v).toBeLessThan(car.speed);
});
