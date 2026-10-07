import { expect, it } from 'vitest';
import { LifeBuilder, LifeLine } from './geometry';
import { LifeWorld, TileLife } from './simulate';
import { worldTiles } from './testing/scenarios';
import { continuityMover, left } from './testing/continuity';
import { bodiesOverlap } from './occupancy';

it.each([12, 3])(
  'uses guarded curb passing without overlap or narrow-road deadlock (width=%s)',
  (width) => {
    const b = new LifeBuilder();
    b.line(
      [
        { x: 100, y: 2000 },
        { x: 4000, y: 2000 },
      ],
      LifeLine.roadMajor,
      width,
    );
    const world = new LifeWorld();
    world.sync([{ key: 'road', tile: left, life: b.finish() }]);
    const life = worldTiles(world).get('road')!,
      pm = life.perMeter;
    const urgent = continuityMover(life, 1000),
      yielder = continuityMover(life, 1000 + 11 * pm);
    for (const m of [urgent, yielder]) {
      m.from = 0;
      m.d = m.x - 100;
      m.speed = 8 * pm;
      m.v = 4 * pm;
      m.y = 2000;
    }
    urgent.vehicle = 'ambulance';
    urgent.emergency = {
      id: 'a',
      kind: 'ambulance',
      phase: 'responding',
      lights: true,
      baseSpeedMps: 8,
      remaining: 0,
      offscreen: 0,
      run: 1,
    };
    life.movers.splice(0, life.movers.length, urgent, yielder);
    life.parked.length = life.stalls.length = 0;
    expect(Object.hasOwn(yielder, 'roadShift')).toBe(false);
    const start = yielder.x;
    let shifted = false,
      passed = false;
    for (let i = 0; i < 600; i++) {
      world.step(1 / 30, undefined, 18);
      shifted ||= (yielder.roadShift ?? 0) > 0.1;
      passed ||= urgent.x > yielder.x + 6 * pm;
      expect(
        life
          .groundBodies(urgent)
          .some((a) => life.groundBodies(yielder).some((b) => bodiesOverlap(a, b))),
      ).toBe(false);
    }
    expect(shifted).toBe(true);
    expect(yielder.x).toBeGreaterThan(start + 10 * pm);
    if (width === 12) expect(passed).toBe(true);
    urgent.emergency = { ...urgent.emergency, lights: false, phase: 'cleared' };
    for (let i = 0; i < 300; i++) world.step(1 / 30, undefined, 18);
    expect(Math.abs(yielder.roadShift ?? 0)).toBeLessThan(0.1);
  },
);
it('rolls back a rejected pull-aside trial from an absent roadShift', () => {
  const b = new LifeBuilder();
  b.line(
    [
      { x: 100, y: 2000 },
      { x: 4000, y: 2000 },
    ],
    LifeLine.roadMajor,
    12,
  );
  const life = new TileLife(left, b.finish(), 1),
    a = continuityMover(life, 1000),
    bMover = continuityMover(life, 1100);
  for (const m of [a, bMover]) {
    m.y = 2000;
    m.d = m.x - 100;
  }
  a.emergency = {
    id: 'a',
    kind: 'ambulance',
    phase: 'responding',
    lights: true,
    baseSpeedMps: 10,
    remaining: 0,
    offscreen: 0,
    run: 1,
  };
  life.movers.splice(0, life.movers.length, a, bMover);
  life.step(
    1 / 30,
    () => true,
    () => true,
    undefined,
    { rain: 0 },
    (m, before) => !before || (m as typeof a).roadShift === (before as typeof a).roadShift,
  );
  expect(bMover.roadShift).toBeUndefined();
});
