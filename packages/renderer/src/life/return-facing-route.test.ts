import { expect, it } from 'vitest';
import { LifeBuilder, LifeLine } from './geometry';
import { LifeWorld, type GroundGuard, type Mover, type WorldGroundGuard } from './simulate';
import { worldTiles } from './testing/scenarios';
import { metersPerUnit } from '../raster/geometry';
import type { Visit } from './interactions';

it('plans and follows a narrow mapped return with the complete retained-facing formation', () => {
  const tile = { z: 16, x: 55192, y: 30266 },
    pm = 1 / metersPerUnit(tile);
  const point = (x: number, y: number) => ({ x: 1000 + x * pm, y: 1000 + y * pm });
  const b = new LifeBuilder();
  b.line([point(10, 30), point(40, 30)], LifeLine.path, 2);
  b.line([point(40, 30), point(40, 40)], LifeLine.path, 2);
  b.site(point(10, 30), 0, 7, true);
  for (const [x0, x1] of [
    [40.48, 41],
    [38.3, 38.73],
  ])
    b.area('blocked', [[point(x0!, 31), point(x1!, 31), point(x1!, 42), point(x0!, 42)]]);
  const world = new LifeWorld(undefined, undefined, { enabled: false });
  world.sync([{ key: 'return-corridor', tile, life: b.finish() }]);
  const life = worldTiles(world).get('return-corridor')!;
  life.movers.length = life.gatherers.length = life.stalls.length = life.parked.length = 0;
  const m: Mover = {
    kind: 'person',
    line: 0,
    from: 0,
    dir: 1,
    d: 0,
    ...point(10, 30),
    hx: 1,
    hy: 0,
    speed: 2 * pm,
    paint: 0,
    lane: 0,
    pause: 0,
    rank: 0,
    group: [
      { figure: 'adult', shirt: 2, canopy: 3, umbrella: 0.4, lateral: 0, back: 0, step: 1 },
      { figure: 'adult', shirt: 14, canopy: 2, umbrella: 0.9, lateral: -1, back: 0, step: 1 },
      { figure: 'child', shirt: 4, canopy: 10, umbrella: 0.6, lateral: 0, back: 1, step: 1 },
    ],
  };
  life.movers.push(m);
  expect(life.scenes.reserve(m, 0)).toBe(true);
  const visit = life.scenes.visits.get(m)!,
    trail = structuredClone(visit.trail);
  const group = m.group!,
    members = [...group];
  Object.assign(m, point(40, 40));
  visit.state = 'return';
  visit.path = [{ x: m.x, y: m.y }, visit.trail[0]!];
  visit.next = 1;
  visit.blocked = 16;
  const physical = (
    world as unknown as { groundGuard(minimum: number): WorldGroundGuard }
  ).groundGuard(0);
  const guard: GroundGuard = (next, before, reserve, reject) =>
    physical(life, next, before, undefined, reserve, m, reject);
  const before = structuredClone(m);
  (
    life.scenes as unknown as { blockedTimeout(m: Mover, v: Visit, guard: GroundGuard): void }
  ).blockedTimeout(m, visit, guard);
  expect(m).toEqual(before);
  const corner = point(40, 30);
  expect(visit.path.some((p) => Math.hypot(p.x - corner.x, p.y - corner.y) < 0.01 * pm)).toBe(true);
  for (let frame = 0; frame < 300 && life.scenes.visits.has(m); frame++) {
    const old = life.groundBodies(m).map((body) => ({ ...body }));
    life.scenes.step(0.1, [m], {}, undefined, undefined, guard);
    const bodies = life.groundBodies(m);
    bodies.forEach((body, i) => {
      expect(Math.hypot(body.x - old[i]!.x, body.y - old[i]!.y)).toBeLessThanOrEqual(0.2 + 1e-8);
    });
    expect(guard(m, m, false)).toBe(true);
    expect(m.group).toBe(group);
    members.forEach((member, i) => expect(m.group![i]).toBe(member));
    expect(visit.trail).toEqual(trail);
  }
  expect(life.scenes.visits.has(m)).toBe(false);
  expect({ line: m.line, from: m.from, dir: m.dir }).toEqual({
    line: 0,
    from: 0,
    dir: 1,
  });
  // Rejoining uses the line's Float32 coordinates rather than the unsnapped site.
  expect(m.d / pm).toBeLessThan(1e-5);
  expect(Math.hypot(m.x - trail[0]!.x, m.y - trail[0]!.y) / pm).toBeLessThan(1e-5);
});
