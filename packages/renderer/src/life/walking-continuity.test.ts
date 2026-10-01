import { expect, it } from 'vitest';
import { TileLife, LifeWorld, type Mover, type Walker } from './simulate';
import { continuityMover, continuityTile, left, parent, right } from './testing/continuity';
import { worldTiles } from './testing/scenarios';
import { LifeLine } from './geometry';
import { frameBetween } from './frames';
import { activityLevels } from './config';

function group(size: number): Walker[] {
  return Array.from({ length: size }, (_, i) => ({
    figure: i % 2 ? 'child' : 'adult',
    shirt: i + 2,
    umbrella: i / 4,
    canopy: i + 7,
    lateral: i % 2,
    back: Math.floor(i / 2),
    step: (i % 2) as 0 | 1,
  }));
}
function walker(life: TileLife, size: number, x = 600): Mover {
  return {
    ...continuityMover(life, x, 'person'),
    group: group(size),
    walked: 11.75,
    pause: 4.5,
    speed: 1.4 * life.perMeter,
    v: 1.1 * life.perMeter,
    avoid: 0.1,
    waiting: 3,
  };
}

for (const size of [1, 2, 3, 4])
  it(`transfers an entire ${size}-member group through zoom and reversal`, () => {
    const world = new LifeWorld(),
      p = continuityTile(parent, LifeLine.path);
    world.sync([p]);
    const source = worldTiles(world).get(p.key)!,
      m = walker(source, size);
    source.movers.splice(0, source.movers.length, m);
    const people = m.group!,
      state = structuredClone(m),
      oldBodies = source.groundBodies(m);
    world.sync([continuityTile(left, LifeLine.path), continuityTile(right, LifeLine.path)]);
    const target = [...worldTiles(world).values()].find((life) => life.movers.includes(m))!;
    expect(target).toBeDefined();
    expect(m.group).toBe(people);
    expect(m.group).toEqual(state.group);
    expect([m.walked, m.pause, m.waiting, m.avoid, m.paint, m.rank]).toEqual([
      state.walked,
      state.pause,
      state.waiting,
      state.avoid,
      state.paint,
      state.rank,
    ]);
    expect(m.speed / target.perMeter).toBeCloseTo(1.4);
    expect(m.v! / target.perMeter).toBeCloseTo(1.1);
    const f = frameBetween(source.tile, target.tile);
    for (const [i, body] of target.groundBodies(m).entries()) {
      const a = oldBodies[i]!,
        ratio = (f.scale * source.perMeter) / target.perMeter;
      expect(
        Math.hypot(
          body.x - f.x / target.perMeter - a.x * ratio,
          body.y - f.y / target.perMeter - a.y * ratio,
        ),
      ).toBeLessThanOrEqual(2);
    }
    world.sync([p]);
    expect(worldTiles(world).get(p.key)).toBe(source);
    expect(source.movers).toContain(m);
    expect(m.group).toBe(people);
    expect(m.walked).toBe(state.walked);
    expect(m.pause).toBe(state.pause);
  });

it('rejects excessive member displacement and preserves a failed donor atomically', () => {
  const a = continuityTile(parent, LifeLine.path),
    b = continuityTile(left, LifeLine.path, 77, 3 * 2);
  const source = new TileLife(a.tile, a.life, 1),
    target = new TileLife(b.tile, b.life, 2);
  const m = walker(source, 4);
  source.movers.splice(0, source.movers.length, m);
  const before = structuredClone(m);
  // Three meters in the child exceeds the walking budget (vehicle budget is four).
  b.life.coords[1] = b.life.coords[3] = 2000 + 3 * target.perMeter;
  expect(target.adoptFrom(m, source)).toBe(false);
  expect(m).toEqual(before);
  expect(source.movers).toContain(m);
  expect(target.movers).not.toContain(m);
});

it('rejects an obstacle under a trailing member and local visiting groups', () => {
  for (const visiting of [false, true]) {
    const world = new LifeWorld(),
      p = continuityTile(parent, LifeLine.path);
    world.sync([p]);
    const source = worldTiles(world).get(p.key)!,
      m = walker(source, 4);
    source.movers.splice(0, source.movers.length, m);
    const b = continuityTile(left, LifeLine.path);
    if (visiting)
      source.scenes.visits.set(m, {
        site: { x: m.x, y: m.y, queue: [] } as never,
        state: 'wait',
        path: [],
        trail: [],
        next: 0,
        seat: 0,
        time: 1,
        sheltering: false,
        blocked: 0,
      });
    else {
      const target = new TileLife(b.tile, b.life, 2),
        preview = target.projectFrom(m, source)!;
      const body = target.groundBodies(preview)[3]!;
      const x = body.x * target.perMeter,
        y = body.y * target.perMeter,
        r = 0.3 * target.perMeter;
      b.life.areas = [
        {
          kind: 'blocked',
          water: false,
          rings: [
            [
              { x: x - r, y: y - r },
              { x: x + r, y: y - r },
              { x: x + r, y: y + r },
              { x: x - r, y: y + r },
              { x: x - r, y: y - r },
            ],
          ],
        },
      ];
    }
    const before = structuredClone(m);
    world.sync([b]);
    expect(source.movers).toContain(m);
    expect(m).toEqual(before);
    expect([...worldTiles(world).values()].some((life) => life.movers.includes(m))).toBe(false);
  }
});
it('keeps gait and umbrella appearance while children load in stages and the parent remains', () => {
  const world = new LifeWorld(),
    p = continuityTile(parent, LifeLine.path);
  const a = continuityTile(left, LifeLine.path),
    b = continuityTile(right, LifeLine.path);
  world.sync([p]);
  const source = worldTiles(world).get(p.key)!,
    m = walker(source, 4);
  m.pause = 0;
  source.movers.splice(0, source.movers.length, m);
  const center: [number, number] = [123, 13],
    levels = activityLevels(1);
  const before = world
    .visible(20, levels, center, { rain: 1, sunAltitude: 40 })
    .find((v) => v.kind === 'person')!;
  world.sync([p, a]);
  const target = worldTiles(world).get(a.key)!;
  expect(target.movers).toContain(m);
  expect(source.movers).not.toContain(m);
  const carried = world
    .visible(20, levels, center, { rain: 1, sunAltitude: 40 })
    .find((v) => v.people?.length === 4 && v.people[0]?.paint === before.people![0]!.paint)!;
  expect(carried.people).toEqual(before.people);
  const walked = m.walked!;
  world.step(0.1);
  expect(m.walked).toBeGreaterThan(walked);
  const members = m.group;
  world.sync([p, a, b]);
  world.sync([p]);
  expect(source.movers).toContain(m);
  expect(m.group).toBe(members);
  expect(
    [...worldTiles(world).values()].flatMap((life) => life.movers).filter((value) => value === m),
  ).toHaveLength(1);
});
