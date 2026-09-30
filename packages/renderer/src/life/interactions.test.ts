import { describe, expect, it } from 'vitest';
import { activityLevels } from './config';
import { LifeBuilder, LifeLine } from './geometry';
import { LocalScenes } from './interactions';
import type { Mover, Stall, Walker } from './simulate';

const person = (x = 40, kind: Mover['kind'] = 'person'): Mover => ({
  kind,
  line: 0,
  from: 0,
  dir: 1,
  d: x,
  speed: 2,
  paint: 0,
  lane: 0,
  pause: 0,
  rank: 0,
  x,
  y: 30,
  hx: 1,
  hy: 0,
});
const walker: Walker = {
  figure: 'adult',
  shirt: 0,
  umbrella: 1,
  canopy: 0,
  lateral: 0,
  back: 0,
  step: 0,
};
const setup = (kind: number = 0, stalls: Stall[] = []) => {
  const b = new LifeBuilder();
  b.line(
    [
      { x: 0, y: 30 },
      { x: 200, y: 30 },
    ],
    LifeLine.path,
  );
  b.line(
    [
      { x: 0, y: 24 },
      { x: 200, y: 24 },
    ],
    LifeLine.roadMinor,
    6,
  );
  b.site({ x: 50, y: 30 }, kind, 7, true);
  return new LocalScenes(b.finish(), 1, 8, stalls);
};
const run = (scene: LocalScenes, movers: Mover[], seconds: number, rain = 0) => {
  for (let t = 0; t < seconds; t += 0.1) scene.step(0.1, movers, { rain });
};
describe('local interaction scenes', () => {
  it('reserves whole groups and never claims the same slots twice', () => {
    const scene = setup();
    const a = person();
    a.group = [walker, { ...walker, lateral: 1 }];
    const b = person(35);
    b.group = [walker, walker, walker, walker];
    expect(scene.reserve(a, 0)).toBe(true);
    expect(scene.reserve(a, 0)).toBe(false);
    expect(scene.reserve(b, 0)).toBe(true);
    expect(scene.reserve(person(32), 0)).toBe(false);
    expect(scene.visits.get(a)!.seat).toBe(0);
    expect(scene.visits.get(b)!.seat).toBe(2);
    run(scene, [a, b], 8);
    expect(a.group).toHaveLength(2);
  });
  it('finishes a purchase and retraces the route without duplicating a walker', () => {
    const stall: Stall = { x: 50, y: 30, hx: 1, hy: 0, paint: 0, shirt: 0, side: 1, rank: 0 };
    const scene = setup(0, [stall]);
    const p = person();
    const group = [walker, { ...walker, lateral: 1 }];
    p.group = group;
    expect(scene.reserve(p, 1)).toBe(true);
    run(scene, [p], 25);
    expect(scene.visits.has(p)).toBe(false);
    expect(p.x).toBe(40);
    expect(p.y).toBe(30);
    expect(p.group).toBe(group);
    expect(scene.sites[1]!.queue).toHaveLength(0);
  });
  it('boards and alights existing passengers while one eligible vehicle dwells', () => {
    const scene = setup();
    const p = person();
    expect(scene.reserve(p, 0)).toBe(true);
    run(scene, [p], 7);
    expect(scene.visits.get(p)!.state).toBe('wait');
    const v = person(50, 'vehicle');
    v.line = 1;
    v.y = 24;
    v.vehicle = 'jeepney';
    let aboard = false;
    let held = false;
    for (let t = 0; t < 30; t += 0.1) {
      scene.step(0.1, [p, v], { rain: 0 });
      aboard ||= scene.hidden(p);
      held ||= scene.held(v);
    }
    expect(held).toBe(true);
    expect(aboard).toBe(true);
    expect(scene.hidden(p)).toBe(false);
    expect(scene.visits.has(p)).toBe(false);
    expect(p.x).toBe(40);
    expect(scene.services.size).toBe(0);
  });
  it('abandons a stop the vehicle can no longer reach instead of freezing', () => {
    for (const leave of [
      (v: Mover) => (v.x = 60), // carried past it, as around a bend
      (v: Mover) => (v.line = 0), // turned onto another line
    ]) {
      const scene = setup();
      const v = person(45, 'vehicle');
      v.line = 1;
      v.y = 24;
      v.vehicle = 'jeepney';
      for (let t = 0; t < 5 && !scene.services.has(v); t += 0.1) scene.step(0.1, [v], {});
      expect(scene.services.get(v)?.arriving).toBe(true);
      leave(v);
      scene.step(0.1, [v], {});
      expect(scene.services.has(v)).toBe(false);
      expect(scene.speed(v, 0.1)).toBe(v.speed);
    }
  });
  it('ignores vehicles of the wrong mode and direction', () => {
    const scene = setup();
    const car = person(50, 'vehicle');
    car.line = 1;
    car.y = 24;
    car.vehicle = 'car';
    const bus = { ...car, vehicle: 'bus' as const, dir: -1 as const };
    run(scene, [car, bus], 5);
    expect(scene.services.size).toBe(0);
  });
  it('cancels purchases in rain, covers the cart, and releases reservations', () => {
    const stall: Stall = { x: 50, y: 30, hx: 1, hy: 0, paint: 0, shirt: 0, side: 1, rank: 0 };
    const scene = setup(0, [stall]);
    const p = person();
    scene.reserve(p, 1);
    run(scene, [p], 3, 1);
    expect(stall.covered).toBe(true);
    expect(scene.sites[1]!.queue).toHaveLength(0);
  });
  it('shelters people and animals, with hysteresis, then returns them when rain ends', () => {
    const scene = setup(2);
    const dog = person(40, 'dog');
    scene.step(0.1, [], { rain: 1 });
    expect(scene.reserve(dog, 0)).toBe(true);
    run(scene, [dog], 7, 1);
    expect(scene.visits.get(dog)!.state).toBe('shelter');
    run(scene, [dog], 2, 0.3);
    expect(scene.visits.get(dog)!.state).toBe('shelter');
    run(scene, [dog], 12, 0);
    expect(scene.visits.has(dog)).toBe(false);
    expect(dog.lying).toBe(false);
  });
  it('freezes unseen visits and resumes them without accumulating time', () => {
    const scene = setup();
    const p = person();
    scene.reserve(p, 0);
    scene.step(30, [p], { rain: 0 }, () => false);
    expect(p.x).toBe(40);
    expect(scene.visits.get(p)!.state).toBe('approach');
    scene.step(0.1, [p], { rain: 0 });
    expect(p.x).toBeGreaterThan(40);
  });
  it('returns inactive groups and clears their reservation', () => {
    const scene = setup();
    const p = person();
    p.rank = 0.8;
    scene.reserve(p, 0);
    run(scene, [p], 3);
    const levels = { ...activityLevels(1), person: 0 };
    for (let i = 0; i < 100; i++) scene.step(0.1, [p], { rain: 0, levels });
    expect(scene.visits.size).toBe(0);
    expect(scene.sites[0]!.queue).toHaveLength(0);
  });
  it('is deterministic for the same tile seed', () => {
    const a = setup();
    const b = setup();
    const p = person();
    const q = person();
    run(a, [p], 30);
    run(b, [q], 30);
    expect(p).toEqual(q);
    expect([...a.visits.values()]).toEqual([...b.visits.values()]);
  });

  it('waits for a blocked approach, releases its slot, and returns without jumping', () => {
    const scene = setup();
    const p = person();
    scene.reserve(p, 0);
    for (let i = 0; i < 90; i++) scene.step(0.1, [p], {}, undefined, undefined, () => false);
    expect(p.x).toBe(40);
    expect(scene.sites[0]!.queue).toHaveLength(0);
    expect(scene.visits.get(p)?.state).toBe('return');
    scene.step(0.1, [p], {}, undefined, undefined, () => true);
    expect(scene.visits.size).toBe(0);
  });

  it('limits a terminal to three vehicles and only one active boarding group', () => {
    const scene = setup(1);
    const people = [person(), person(38)];
    for (const p of people) expect(scene.reserve(p, 0)).toBe(true);
    run(scene, people, 8);
    const vehicles = Array.from({ length: 5 }, () => ({
      ...person(50, 'vehicle'),
      line: 1,
      y: 24,
      vehicle: 'jeepney' as const,
    }));
    scene.step(1, [...people, ...vehicles], {});
    expect(scene.services.size).toBe(3);
    for (let i = 0; i < 50; i++) {
      scene.step(0.1, [...people, ...vehicles], {});
      expect(
        [...scene.visits.values()].filter((v) => v.state === 'board').length,
      ).toBeLessThanOrEqual(1);
    }
  });

  it('times out an unserved stop and releases closed vendor queues', () => {
    const scene = setup();
    const p = person();
    scene.reserve(p, 0);
    run(scene, [], 110);
    expect(scene.visits.size).toBe(0);
    const stall: Stall = { x: 50, y: 30, hx: 1, hy: 0, paint: 0, shirt: 0, side: 1, rank: 0.5 };
    const closed = setup(0, [stall]);
    const customer = person();
    closed.reserve(customer, 1);
    for (let i = 0; i < 200; i++)
      closed.step(0.1, [customer], { minutes: 180, levels: { ...activityLevels(1), person: 0 } });
    expect(stall.open).toBe(false);
    expect(closed.sites[1]!.queue).toHaveLength(0);
    expect(closed.visits.size).toBe(0);
  });
});
