import { expect, it } from 'vitest';
import { FOLLOW, kinematicsOf } from './config';
import { cruise } from './driving';
import { LifeLine } from './geometry';
import { driveMover, driveRoad, driveStep, driveStreams } from './testing/driving';
import { makeScenario, worldTiles } from './testing/scenarios';
import { VEHICLES } from './vehicles';
import { continuityMover } from './testing/continuity';

it('eases to wet cruise and back within the existing acceleration and braking bounds', () => {
  const life = driveRoad(),
    m = driveMover(life);
  driveStreams(life).rushRng = () => 1;
  for (const rain of [1, 0]) {
    for (let frame = 0; frame < 30; frame++) {
      const before = m.v!;
      driveStep(life, rain);
      expect(before - m.v!).toBeLessThanOrEqual(
        kinematicsOf('car').maxBrake * life.perMeter * 0.1 + 1e-8,
      );
      expect(m.v! - before).toBeLessThanOrEqual(
        kinematicsOf('car').accel * life.perMeter * 0.1 + 1e-8,
      );
    }
    expect(m.v).toBeCloseTo(cruise(m, !!rain), 8);
  }
  expect(life.motionStats.hardCaps).toBe(0);
});

it('settles at a longer following gap when wet while preserving physical safety caps', () => {
  const gaps = [0, 1].map((rain) => {
    const life = driveRoad();
    driveStreams(life).rushRng = () => 1;
    const follower = driveMover(life, 500),
      leader = driveMover(life, 700, 2);
    for (let frame = 0; frame < 500; frame++) driveStep(life, rain);
    const gap = (leader.x - follower.x) / life.perMeter - VEHICLES.car.length;
    expect(gap).toBeGreaterThan(FOLLOW.minGap);
    expect(life.motionStats.hardCaps).toBe(0);
    return gap;
  });
  expect(gaps[1]).toBeGreaterThan(gaps[0]! + 1);
});

it('takes a bend more gently in rain and leaves boat bending and following unchanged', () => {
  const bendTarget = (rain: number, boat: boolean) => {
    const life = driveRoad(1, Math.PI / 2, boat ? LifeLine.river : LifeLine.roadMajor);
    const m = driveMover(life, 2990, 12);
    if (boat) Object.assign(m, { kind: 'boat', vehicle: 'motorboat' });
    driveStreams(life).rushRng = () => 1;
    driveStep(life, rain);
    return (life as unknown as { curveTarget(owner: typeof m): number }).curveTarget(m);
  };
  expect(bendTarget(1, false)).toBeLessThan(bendTarget(0, false));
  expect(bendTarget(1, true)).toBe(bendTarget(0, true));
  const boats = [0, 1].map((rain) => {
    const life = driveRoad(1, 0, LifeLine.river);
    for (const m of [driveMover(life, 500), driveMover(life, 650, 2)])
      Object.assign(m, { kind: 'boat', vehicle: 'motorboat' });
    for (let i = 0; i < 50; i++) driveStep(life, rain);
    return life.movers;
  });
  expect(boats[1]).toEqual(boats[0]);
});

it('leaves train motion unchanged in rain', () => {
  const trains = [0, 1].map((rain) => {
    const life = driveRoad(1, 0, LifeLine.rail);
    const m = continuityMover(life, 1000, 'train');
    life.movers.push(m);
    for (let i = 0; i < 50; i++) driveStep(life, rain);
    return m;
  });
  expect(trains[1]).toEqual(trains[0]);
});

it('does not add hard caps when rain starts over dense crossroads', () => {
  const runs = [0, 1].map((rain) => {
    const f = makeScenario('crossroads', 1);
    for (const life of worldTiles(f.world).values()) {
      driveStreams(life).rushRng = () => 1;
      // Exercise the crossroads queue without unrelated walkers, crowds and commerce.
      life.movers.splice(
        0,
        life.movers.length,
        ...life.movers.filter((m) => m.kind === 'vehicle').slice(0, 16),
      );
      life.parked.length = life.stalls.length = life.gatherers.length = life.flocks.length = 0;
      life.pending.length = life.scenes.sites.length = 0;
    }
    for (let frame = 0; frame < 100; frame++)
      f.world.step(0.1, undefined, 18, f.bounds, undefined, { rain: frame < 50 ? 0 : rain });
    return [...worldTiles(f.world).values()].reduce(
      (sum, life) => sum + life.motionStats.hardCaps,
      0,
    );
  });
  expect(runs[1]).toBeLessThanOrEqual(runs[0]!);
});
