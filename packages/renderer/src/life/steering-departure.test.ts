import { expect, it } from 'vitest';
import { LifeBuilder, LifeLine } from './geometry';
import { LifeWorld, type GroundGuard, type Mover, type WorldGroundGuard } from './simulate';
import { worldTiles } from './testing/scenarios';

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

it.each([30, 60])(
  'backs a pinned nose out along its heading, then drives straight at %s Hz',
  (hz) => {
    const { life, m, physical } = fixture();
    const initial = m.x;
    let reversed = 0,
      released = false;
    const guard: GroundGuard = (next, before, reserve, reject) => {
      if (next !== m || !('kind' in next) || !before || !('kind' in before)) return false;
      // The nose touches something ahead: nothing is allowed forward until it has backed off.
      if (!released && next.d > before.d) {
        reject?.('terrain');
        return false;
      }
      if (next.d < before.d) {
        // It retraces its heading exactly, without pivoting on the spot.
        expect(next.roadYaw).toBe(before.roadYaw);
        reversed++;
      }
      expect(next.d === before.d && next.roadYaw !== before.roadYaw).toBe(false);
      return physical(life, next, before, undefined, reserve, m, reject);
    };
    for (let frame = 0; frame < hz; frame++)
      life.step(1 / hz, undefined, undefined, undefined, undefined, guard);
    expect(reversed).toBeGreaterThan(0);
    expect(m.x).toBeLessThan(initial);
    released = true;
    m.roadBackoff = undefined;
    for (let frame = 0; frame < 12 * hz; frame++) {
      life.step(1 / hz, undefined, undefined, undefined, undefined, guard);
      expect(m.dir).toBe(1);
    }
    expect(m.roadYaw ?? 0).toBeLessThan(0.02);
    expect((m.x - initial) / life.perMeter).toBeGreaterThan(0.5);
  },
);

it('restores a refused step without consuming its translation or routing', () => {
  const { life, m } = fixture();
  const before = structuredClone(m);
  life.step(1 / 30, undefined, undefined, undefined, undefined, () => false);
  for (const key of ['x', 'y', 'd', 'dir', 'from', 'line', 'roadYaw', 'roadShift'] as const)
    expect(m[key]).toBe(before[key]);
  expect(m.v).toBe(0);
  expect(m.waiting).toBeGreaterThan(before.waiting!);
});
