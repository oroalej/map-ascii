import { expect, it } from 'vitest';
import { LifeBuilder, LifeLine } from './geometry';
import { LifeWorld, type GroundGuard, type Mover, type WorldGroundGuard } from './simulate';
import { worldTiles } from './testing/scenarios';
import { VEHICLES } from './vehicles';

function fixture() {
  const tile = { z: 16, x: 55192, y: 30266 };
  const b = new LifeBuilder();
  b.line(
    [
      { x: 0, y: 2048 },
      { x: 4095, y: 2048 },
    ],
    LifeLine.roadMajor,
    8,
    0,
    1,
  );
  const world = new LifeWorld(undefined, undefined, { enabled: false });
  world.sync([{ key: 'departure', tile, life: b.finish() }]);
  const life = worldTiles(world).get('departure')!;
  life.movers.length = life.gatherers.length = life.parked.length = life.stalls.length = 0;
  life.scenes.sites.length = 0;
  const m: Mover = {
    kind: 'vehicle',
    vehicle: 'bicycle',
    line: 0,
    from: 0,
    dir: 1,
    d: 1000,
    x: 1000,
    y: 2048,
    hx: 1,
    hy: 0,
    speed: 3 * life.perMeter,
    v: 0,
    paint: 0,
    lane: 0.2,
    pause: 0,
    rank: 0,
    roadShift: -1,
    roadYaw: 0.4,
    waiting: 4,
  };
  life.movers.push(m);
  const physical = (
    world as unknown as { groundGuard(minimum: number): WorldGroundGuard }
  ).groundGuard(0);
  return { world, life, m, physical };
}

it.each([30, 60])('straightens a blocked nose through guarded, bounded steps at %s Hz', (hz) => {
  const { life, m, physical } = fixture();
  const initial = m.x;
  let rotations = 0;
  const guard: GroundGuard = (next, before, reserve, reject) => {
    if (next !== m || !('kind' in next) || !before || !('kind' in before)) return false;
    // Translation cannot clear this approach while the retained nose angle remains.
    // Every permitted rotation and departure still uses the production physical sweep.
    if (
      (next.roadYaw ?? 0) > 0.02 &&
      (next.d !== before.d || (next.roadYaw ?? 0) >= (before.roadYaw ?? 0))
    )
      return false;
    if (next.d === before.d && (next.roadYaw ?? 0) < (before.roadYaw ?? 0)) {
      const a = life.pose(before, undefined, m),
        b = life.pose(m);
      const spec = VEHICLES[m.vehicle!];
      const travel =
        Math.hypot(b.x - a.x, b.y - a.y) / life.perMeter +
        (Math.hypot(spec.length, spec.width) / 2) * Math.hypot(b.hx - a.hx, b.hy - a.hy);
      expect(travel).toBeLessThanOrEqual(m.speed / life.perMeter / hz + 1e-8);
      rotations++;
    }
    return physical(life, next, before, undefined, reserve, m, reject);
  };
  for (let frame = 0; frame < 3 * hz; frame++) {
    life.step(1 / hz, undefined, undefined, undefined, undefined, guard);
    expect(m.dir).toBe(1);
  }
  expect(rotations).toBeGreaterThan(0);
  expect(m.roadYaw ?? 0).toBeLessThan(0.02);
  expect((m.x - initial) / life.perMeter).toBeGreaterThan(0.5);
});

it('restores a refused rotation without consuming its translation or routing', () => {
  const { life, m } = fixture();
  const before = structuredClone(m);
  life.step(1 / 30, undefined, undefined, undefined, undefined, () => false);
  for (const key of ['x', 'y', 'd', 'dir', 'from', 'line', 'roadYaw', 'roadShift'] as const)
    expect(m[key]).toBe(before[key]);
  expect(m.v).toBe(0);
  expect(m.waiting).toBeGreaterThan(before.waiting!);
});
