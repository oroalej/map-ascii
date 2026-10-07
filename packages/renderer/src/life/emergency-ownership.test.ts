import { expect, it } from 'vitest';
import { LifeWorld } from './simulate';
import { continuityMover, continuityTile, left, parent } from './testing/continuity';
import { emergencyConfig, emergencyFixture } from './testing/emergency';
import { retiredTiles, worldTiles } from './testing/scenarios';
import { dispatchFixture, emergencyMovers } from './testing/emergency-replay';

it('carries a reserved police owner into zero ordinary quota and scales calls in the new owner', () => {
  const world = new LifeWorld();
  world.configureEmergency(
    { source: 'fixture', police: emergencyConfig.police },
    emergencyFixture().data,
  );
  const source = continuityTile(parent),
    child = continuityTile(left);
  child.life.navigationOnly = new Uint8Array(child.life.kinds.length).fill(1);
  world.sync([source]);
  const old = worldTiles(world).get(source.key)!,
    m = continuityMover(old, 500);
  m.vehicle = 'police';
  m.emergency = {
    id: 'police/manual',
    kind: 'police',
    phase: 'patrol',
    lights: false,
    baseSpeedMps: 10,
    remaining: 0.1,
    offscreen: 0,
    run: 1,
  };
  old.movers.splice(0, old.movers.length, m);
  world.sync([child]);
  const next = worldTiles(world).get(child.key)!;
  expect(next.movers).toContain(m);
  expect(old.movers).not.toContain(m);
  expect(m.emergency.baseSpeedMps).toBe(10);
  world.emergencyDispatch!.step(
    0.2,
    [{ life: next, mover: m }],
    () => true,
    () => false,
    () => false,
    () => undefined,
    () => {},
  );
  expect(m.speed / next.perMeter).toBeCloseTo(13);
  world.sync([source]);
  const back = worldTiles(world).get(source.key)!;
  expect(back.movers).toContain(m);
  world.emergencyDispatch!.step(
    2,
    [{ life: back, mover: m }],
    () => true,
    () => false,
    () => false,
    () => undefined,
    () => {},
  );
  expect(m.speed / back.perMeter).toBeCloseTo(10);
});
it('reserves retired runs, revives their identity, and releases all reservations on hard clear', () => {
  const f = dispatchFixture({ source: 'fixture', police: { ...emergencyConfig.police!, max: 1 } });
  for (let i = 0; i < 40; i++) f.step();
  const m = emergencyMovers(f.life)[0]!;
  f.world.sync([]);
  expect([...retiredTiles(f.world).values()][0]!.life.residentMovers().next().value).toBe(m);
  expect(f.world.emergencyDispatch!.snapshot().reservations).toHaveLength(1);
  f.world.sync([{ key: 'road', tile: f.life.tile, life: f.life.geo }]);
  f.world.updateView(f.view);
  for (let i = 0; i < 40; i++) f.step();
  expect(emergencyMovers(f.life)).toEqual([m]);
  f.world.clearTiles();
  expect(f.world.emergencyDispatch!.snapshot().reservations).toEqual([]);
});
it('expires only completed continuous off-view runs and resets release time on reentry', () => {
  const f = dispatchFixture({
    source: 'fixture',
    police: { ...emergencyConfig.police!, max: 1, call_every_s: [100, 100] },
  });
  for (let i = 0; i < 40; i++) f.step();
  const m = emergencyMovers(f.life)[0]!,
    owners = [{ life: f.life, mover: m }],
    removed: object[] = [];
  const step = (dt: number, out: boolean) =>
    f.world.emergencyDispatch!.step(
      dt,
      owners,
      () => true,
      () => out,
      () => false,
      () => undefined,
      (o) => removed.push(o.mover),
    );
  step(20, true);
  step(1, false);
  expect(m.emergency!.offscreen).toBe(0);
  step(29, true);
  expect(removed).toEqual([]);
  step(2, true);
  expect(removed).toEqual([m]);
  m.emergency = { ...m.emergency!, phase: 'call', lights: true, remaining: 100, offscreen: 0 };
  removed.length = 0;
  step(31, true);
  expect(removed).toEqual([]);
});
