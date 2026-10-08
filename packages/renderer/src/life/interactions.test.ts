import { describe, expect, it, vi } from 'vitest';
import { activityLevels, RUN, RECOVERY, SHELTER_DEPARTURE, HEAT } from './config';
import { LifeBuilder, LifeLine } from './geometry';
import { LocalScenes, departureDelay, personSample, type Visit } from './interactions';
import { stripRing } from './terrain';
import type { Mover, Stall, Walker } from './simulate';
import type { WalkingGraph } from './navigation';
import { Occupancy, memberSize, sweptBodyOverlap, type Body } from './occupancy';
import { makeScenario, worldTiles } from './testing/scenarios';
import { valid } from './testing/scenario-checks';

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
const shadeFixture = (covered = false) => {
  const b = new LifeBuilder();
  b.line(
    [
      { x: 0, y: 30 },
      { x: 200, y: 30 },
    ],
    LifeLine.path,
  );
  if (covered) b.site({ x: 50, y: 30 }, 0, 7, true);
  else b.perch({ x: 50, y: 30 });
  const scene = new LocalScenes(b.finish(), 1, 8, []);
  const rank = Array.from({ length: 100 }, (_, i) => i / 100).find(
    (rank) => personSample({ rank }, 72, 'shade-pick') < HEAT.share,
  )!;
  const p = { ...person(), rank, group: [{ ...walker }] };
  return { scene, p };
};
describe('local interaction scenes', () => {
  it('adds tree shade after mapped sites and admits only hot walkers without a parasol', () => {
    for (const env of [
      { rain: 0, minutes: 720, sunAltitude: 60 },
      { rain: 0, minutes: 540, sunAltitude: 60 },
      { rain: 0, minutes: 720, sunAltitude: 40 },
      { rain: 1, minutes: 720, sunAltitude: 60 },
    ])
      for (const umbrella of [0, 1]) {
        const { scene, p } = shadeFixture();
        p.group[0]!.umbrella = umbrella;
        expect(scene.sites[0]).toMatchObject({ kind: 'shade', covered: false, capacity: 2 });
        const rng = vi.spyOn(scene as unknown as { rng: () => number }, 'rng').mockReturnValue(0.9);
        let arrived = false;
        for (let frame = 0; frame < 200; frame++) {
          scene.step(0.1, [p], env);
          if (scene.visits.get(p)?.state === 'shade') {
            arrived = true;
            break;
          }
        }
        expect(arrived).toBe(
          umbrella === 1 && env.rain === 0 && env.minutes === 720 && env.sunAltitude === 60,
        );
        if (arrived) {
          expect(rng).toHaveBeenCalledTimes(2); // Original search and arrival draws only.
          expect(scene.visits.get(p)!.time).toBeCloseTo(
            20 + 40 * personSample(p, 72, 'shade-dwell'),
          );
          expect(scene.speechEvents.some((e) => e.kind === 'shade')).toBe(true);
        }
      }
  });
  it('bounds the checked approach length only for shading reservations', () => {
    const { scene, p } = shadeFixture();
    const graph = (scene as unknown as { graph: WalkingGraph }).graph;
    vi.spyOn(graph, 'route').mockReturnValue([
      { x: 40, y: 30 },
      { x: 40, y: 60 },
      { x: 50, y: 30 },
    ]);
    expect(scene.reserve(p, 0, true)).toBe(false);
    expect(scene.sites[0]!.queue).toHaveLength(0);
    expect(scene.reserve(p, 0)).toBe(true);
  });
  it.each([false, true])(
    'handles rain during shade approach and arrival (covered=%s)',
    (covered) => {
      for (const arrived of [false, true]) {
        const { scene, p } = shadeFixture(covered);
        scene.step(0, [], { rain: 0, minutes: 720 });
        scene.reserve(p, 0, true);
        const visit = scene.visits.get(p)!;
        run(scene, [p], arrived ? 6 : 1);
        expect(visit.state).toBe(arrived ? 'shade' : 'approach');
        const before = { x: p.x, y: p.y },
          path = visit.path;
        scene.step(0.1, [p], { rain: 1 });
        expect(Math.hypot(p.x - before.x, p.y - before.y)).toBeLessThanOrEqual(0.36);
        if (covered) {
          expect(visit.state).toBe(arrived ? 'shelter' : 'approach');
          expect(visit.path).toBe(path);
          expect(visit.sheltering).toBe(true);
          if (!arrived) run(scene, [p], 6, 1);
          expect(visit.state).toBe('shelter');
        } else {
          expect(visit.state).toBe('return');
          run(scene, [p], 10, 1);
          expect(scene.visits.has(p)).toBe(false);
          expect((scene as unknown as { cooldown: Map<Mover, number> }).cooldown.has(p)).toBe(
            false,
          );
        }
      }
    },
  );
  it('uses a long dry shade cooldown, preserving the return draw, then clears it for rain', () => {
    const { scene, p } = shadeFixture(true);
    scene.step(0, [], { rain: 0, minutes: 720 });
    scene.reserve(p, 0, true);
    const visit = scene.visits.get(p)!;
    run(scene, [p], 6);
    visit.time = 0;
    const rng = vi.spyOn(scene as unknown as { rng: () => number }, 'rng');
    for (let frame = 0; frame < 100 && scene.visits.has(p); frame++)
      scene.step(0.1, [p], { rain: 0 });
    expect(scene.visits.has(p)).toBe(false);
    expect(rng).toHaveBeenCalledTimes(1);
    const cooldown = (scene as unknown as { cooldown: Map<Mover, number> }).cooldown;
    expect(cooldown.get(p)).toBeCloseTo(180 + 120 * personSample(p, 72, 'shade-cooldown'));
    scene.step(0, [p], { rain: 1 });
    expect(cooldown.has(p)).toBe(false);
    expect(scene.reserve(p, 0)).toBe(true);
  });
  it('never boards a shaded visitor at a served transit stop', () => {
    const scene = setup(),
      p = person();
    scene.reserve(p, 0, true);
    run(scene, [p], 6);
    const bus = { ...person(50, 'vehicle'), vehicle: 'bus' as const, v: 0 };
    scene.services.set(bus, { site: scene.sites[0]!, arriving: false, time: 5, boarded: 0 });
    scene.step(0.1, [p, bus], { rain: 0 });
    expect(scene.visits.get(p)!.state).toBe('shade');
    expect(scene.services.get(bus)!.boarded).toBe(0);
  });
  it('preserves the dry non-hot baseline scene random stream and visit trace', () => {
    const scene = setup(),
      p = person();
    const rng = vi.spyOn(scene as unknown as { rng: () => number }, 'rng');
    const trace = [];
    for (let frame = 0; frame < 12; frame++) {
      scene.step(1, [p], { rain: 0, minutes: 540 });
      trace.push([
        rng.mock.results.map((r) => r.value as number),
        scene.visits.get(p)?.state ?? null,
      ]);
      rng.mockClear();
    }
    expect(trace).toMatchInlineSnapshot(`
      [
        [
          [
            0.187567800283432,
          ],
          null,
        ],
        [
          [
            0.6389096821658313,
          ],
          null,
        ],
        [
          [
            0.6408124042209238,
          ],
          null,
        ],
        [
          [
            0.8924993227701634,
          ],
          null,
        ],
        [
          [
            0.9745738117489964,
          ],
          null,
        ],
        [
          [
            0.3797166550066322,
          ],
          null,
        ],
        [
          [
            0.4969414749648422,
          ],
          null,
        ],
        [
          [
            0.4215189549140632,
          ],
          null,
        ],
        [
          [
            0.1928215327206999,
          ],
          null,
        ],
        [
          [
            0.40959873516112566,
          ],
          null,
        ],
        [
          [
            0.9414362271782011,
          ],
          null,
        ],
        [
          [
            0.3093199231661856,
          ],
          null,
        ],
      ]
    `);
  });
  it('finds a checked holding corridor wide enough for two intact three-person formations', () => {
    const scene = setup(),
      p = {
        ...person(),
        group: [{ ...walker }, { ...walker, lateral: 1 }, { ...walker, lateral: -1 }],
      },
      priority = {
        ...person(45),
        group: [{ ...walker }, { ...walker, lateral: 1 }, { ...walker, lateral: -1 }],
      };
    const physical = (m: Mover): Body[] => {
      const h = m.momentFacing ?? m;
      return m.group!.map((w) => ({
        x: m.x - h.hy * w.lateral - h.hx * w.back,
        y: m.y + h.hx * w.lateral - h.hy * w.back,
        hx: h.hx,
        hy: h.hy,
        ...memberSize(w.figure),
      }));
    };
    const fixed = physical(priority),
      group = p.group,
      members = [...group];
    let active = true;
    const holding = (m: Mover) =>
      physical(m).every((body) =>
        fixed.every((other) => !sweptBodyOverlap(other, { x: other.x - 25, y: other.y }, body)),
      );
    const guard = Object.assign(
      (next: Mover, before: Mover) => {
        const previous = physical(before);
        return physical(next).every((body, i) =>
          fixed.every((other) => !sweptBodyOverlap(previous[i]!, body, other)),
        );
      },
      {
        yielding: () => (active ? priority : undefined),
        holding,
        cancelYield: () => {
          active = false;
        },
      },
    );
    let cleared = false;
    for (let frame = 0; frame < 80; frame++) {
      const before = structuredClone(p);
      if (!scene.yieldStep(p, 0.1, guard)) break;
      expect(Math.hypot(p.x - before.x, p.y - before.y)).toBeLessThanOrEqual(p.speed * 0.1 + 1e-8);
      expect(guard(p, before)).toBe(true);
      if (holding(p)) {
        cleared = true;
        break;
      }
    }
    expect(cleared).toBe(true);
    expect(p.y - 30).toBeGreaterThan(RECOVERY.holdingOffsets.at(-1)!);
    active = false;
    for (let frame = 0; frame < 100 && scene.yieldStep(p, 0.1, guard); frame++);
    expect(p.group).toBe(group);
    group.forEach((member, i) => expect(member).toBe(members[i]));
    expect([p.x, p.y]).toEqual([40, 30]);
    expect(scene.transferable(p)).toBe(true);
  });

  it('restores every live member and retained visit when a return clearance query throws', () => {
    const scene = setup(),
      p = { ...person(), group: [{ ...walker }, { ...walker, figure: 'child' as const, back: 1 }] };
    expect(scene.reserve(p, 0)).toBe(true);
    const visit = scene.visits.get(p)!,
      path = visit.path,
      trail = visit.trail,
      group = p.group,
      members = [...group];
    visit.state = 'return';
    visit.blocked = RECOVERY.returnReplanSeconds;
    p.x = 48;
    const before = structuredClone(p),
      query = () => {
        throw new Error('clearance query failed');
      };
    const retry = scene as unknown as {
      blockedTimeout(m: Mover, visit: Visit, guard: typeof query): void;
      rng(): number;
    };
    const rng = vi.spyOn(retry, 'rng');
    expect(() => retry.blockedTimeout(p, visit, query)).toThrow('clearance query failed');
    expect(p).toEqual(before);
    expect(p.group).toBe(group);
    group.forEach((w, i) => expect(w).toBe(members[i]));
    expect(scene.visits.get(p)).toBe(visit);
    expect(visit.path).toBe(path);
    expect(visit.trail).toBe(trail);
    expect(scene.sites[0]!.queue).toContain(p);
    expect(rng).not.toHaveBeenCalled();
  });

  it('replans an entire returning formation around a centroid-clear blocked member corridor', () => {
    const b = new LifeBuilder();
    b.line(
      [
        { x: 10, y: 30 },
        { x: 40, y: 30 },
      ],
      LifeLine.path,
      2,
    );
    b.line(
      [
        { x: 10, y: 30 },
        { x: 10, y: 40 },
        { x: 40, y: 40 },
        { x: 40, y: 30 },
      ],
      LifeLine.path,
      2,
    );
    b.site({ x: 10, y: 30 }, 0, 7, true);
    const scene = new LocalScenes(b.finish(), 1, 8, []),
      p = {
        ...person(10),
        d: 0,
        group: [
          { ...walker },
          { ...walker, lateral: -1 },
          { ...walker, figure: 'child' as const, back: 1 },
        ],
      };
    expect(scene.reserve(p, 0)).toBe(true);
    const visit = scene.visits.get(p)!,
      trail = structuredClone(visit.trail),
      group = p.group,
      members = [...group],
      appearances = group.map(({ figure, shirt, umbrella, canopy }) => ({
        figure,
        shirt,
        umbrella,
        canopy,
      })),
      obstacle: Body = { x: 27.5, y: 29, hx: 1, hy: 0, length: 15, width: 0.5 };
    p.x = 35.8;
    visit.state = 'return';
    visit.path = [{ x: p.x, y: p.y }, trail[0]!];
    visit.next = 1;
    visit.blocked = RECOVERY.returnReplanSeconds;
    const physical = (m: Mover): Body[] => {
      const h = m.momentFacing ?? m;
      return m.group!.map((w) => ({
        x: m.x - h.hy * w.lateral - h.hx * w.back,
        y: m.y + h.hx * w.lateral - h.hy * w.back,
        hx: h.hx,
        hy: h.hy,
        ...memberSize(w.figure),
      }));
    };
    let planned = false;
    const guard = (next: Mover, before: Mover, reserve = true) => {
      if (!reserve) planned = true;
      const a = physical(before),
        c = physical(next);
      return c.every((body, i) => !sweptBodyOverlap(a[i]!, body, obstacle));
    };
    const original = structuredClone(p);
    const retry = scene as unknown as {
      blockedTimeout(m: Mover, visit: Visit, clearance: typeof guard): void;
    };
    retry.blockedTimeout(p, visit, guard);
    expect(p).toEqual(original);
    expect(visit.path.some((point) => point.y === 40)).toBe(true);
    for (let frame = 0; frame < 500 && scene.visits.has(p); frame++) {
      const before = structuredClone(p);
      scene.step(0.1, [p], {}, undefined, undefined, guard);
      expect(Math.hypot(p.x - before.x, p.y - before.y)).toBeLessThanOrEqual(p.speed * 0.1 + 1e-8);
      expect(guard(p, before)).toBe(true);
      expect(p.group).toBe(group);
      group.forEach((w, i) => expect(w).toBe(members[i]));
      expect(visit.trail[0]).toEqual(trail[0]);
    }
    expect(planned).toBe(true);
    expect(scene.visits.has(p)).toBe(false);
    expect([p.x, p.y, p.d]).toEqual([10, 30, 0]);
    expect(
      group.map(({ figure, shirt, umbrella, canopy }) => ({ figure, shirt, umbrella, canopy })),
    ).toEqual(appearances);
  });

  it.each([1, -1] as const)('finishes an oblique endpoint return in direction %s', (dir) => {
    const b = new LifeBuilder(),
      a = { x: 100, y: 100 },
      z = { x: 130, y: 133 },
      length = Math.hypot(z.x - a.x, z.y - a.y),
      endpoint = dir === 1 ? z : a;
    b.line([a, z], LifeLine.path, 4);
    b.site({ x: 115, y: 116.5 }, 0, 7, true);
    const scene = new LocalScenes(b.finish(), 1, 8, []),
      p: Mover = {
        ...person(),
        ...endpoint,
        from: dir === 1 ? 0 : 1,
        dir,
        d: length,
        hx: (dir * (z.x - a.x)) / length,
        hy: (dir * (z.y - a.y)) / length,
        group: [{ ...walker }],
      };
    expect(scene.reserve(p, 0)).toBe(true);
    const visit = scene.visits.get(p)!;
    visit.state = 'return';
    visit.path = [{ ...endpoint }];
    visit.next = 1;
    const group = p.group,
      member = group![0];
    scene.step(0.1, [p], {}, undefined, undefined, () => false);
    expect(scene.visits.has(p)).toBe(false);
    expect(p.d).toBeCloseTo(length, 12);
    expect(p.x).toBeCloseTo(endpoint.x, 12);
    expect(p.y).toBeCloseTo(endpoint.y, 12);
    expect(p.group).toBe(group);
    expect(p.group![0]).toBe(member);
    // A real anchor mismatch still cannot bypass the mapped route guard.
    const other = new LocalScenes(b.finish(), 1, 8, []);
    expect(other.reserve(p, 0)).toBe(true);
    const invalid = other.visits.get(p)!;
    invalid.state = 'return';
    invalid.trail[0] = { x: p.x + p.hx * 0.01, y: p.y + p.hy * 0.01 };
    invalid.path = [{ x: p.x, y: p.y }];
    invalid.next = 1;
    const before = structuredClone(p);
    other.step(0.1, [p], {}, undefined, undefined, () => true);
    expect(other.visits.get(p)).toBe(invalid);
    expect(p).toEqual(before);
  });

  it('hands a final return back with its checked facing and rolls back a refused handoff', () => {
    const scene = setup(),
      p = { ...person(), avoid: 0.4, group: [{ ...walker }, { ...walker, back: 1.2 }] };
    expect(scene.reserve(p, 0)).toBe(true);
    const visit = scene.visits.get(p)!,
      group = p.group,
      members = [...group];
    Object.assign(p, { hx: 0, hy: 1 });
    Object.assign(visit, { state: 'return', path: [{ x: 40, y: 30 }], next: 1 });
    const physical = (m: Mover) => {
      const heading = m.momentFacing ?? m,
        lane = scene.walkingOffset(m, p);
      return m.group!.map((member) => ({
        x: m.x - m.hy * lane - heading.hy * member.lateral - heading.hx * member.back,
        y: m.y + m.hx * lane + heading.hx * member.lateral - heading.hy * member.back,
        hx: heading.hx,
        hy: heading.hy,
        ...memberSize(member.figure),
      }));
    };
    const bodies = physical(p),
      occupied = new Occupancy();
    occupied.set({}, [{ x: 40, y: 31.125, hx: 1, hy: 0, ...memberSize('adult') }]);
    for (let frame = 0; frame < 200; frame++)
      scene.step(0.1, [p], {}, undefined, undefined, () => false);
    expect(scene.visits.get(p)).toBe(visit);
    expect(visit.blocked).toBeCloseTo(20);
    expect(visit.retryAt).toBeGreaterThan(visit.blocked);
    expect(physical(p)).toEqual(bodies);
    scene.step(
      0.1,
      [p],
      {},
      undefined,
      undefined,
      (next) => occupied.conflicts(p, physical(next)) === 0,
    );
    expect(scene.visits.has(p)).toBe(false);
    expect(physical(p)).toEqual(bodies);
    expect(p.momentFacing).toEqual({ hx: 0, hy: 1 });
    expect(p.hx).toBe(1);
    expect(p.d).toBe(40);
    expect(p.avoid).toBe(0);
    expect(p.group).toBe(group);
    members.forEach((member, index) => expect(p.group[index]).toBe(member));
    expect(scene.transferable(p)).toBe(true);
  });

  it.each([false, true])(
    'releases a permanently blocked yield return while preserving checked ownership (visit %s)',
    (visiting) => {
      const scene = setup(),
        p = { ...person(), avoid: visiting ? 0 : 0.4, group: [{ ...walker }] };
      if (visiting) expect(scene.reserve(p, 0)).toBe(true);
      const visit = scene.visits.get(p),
        trail = visit && structuredClone(visit.trail),
        group = p.group;
      const body = (m: Mover) => ({
        x: m.x - m.hy * (visiting ? 0 : (m.avoid ?? 0)),
        y: m.y + m.hx * (visiting ? 0 : (m.avoid ?? 0)),
        hx: m.hx,
        hy: m.hy,
        length: 0.5,
        width: 0.45,
      });
      const anchor = body(p),
        occupied = new Occupancy();
      let active = true;
      const guard = Object.assign(
        (next: Mover, _before: Mover, reserve = true) => {
          if (occupied.conflicts(p, [body(next)]) > 0) return false;
          if (reserve) occupied.set(p, [body(next)]);
          return true;
        },
        {
          yielding: () => (active ? person(45) : undefined),
          holding: () => true,
          cancelYield: () => {
            active = false;
          },
        },
      );
      for (let i = 0; i < 10; i++) scene.yieldStep(p, 0.1, guard);
      occupied.set({}, [anchor]);
      let released = false;
      for (let i = 0; i < 500; i++) {
        const before = body(p);
        if (!scene.yieldStep(p, 0.1, guard)) {
          expect(body(p)).toEqual(before);
          released = true;
          break;
        }
      }
      expect(released).toBe(true);
      expect(p.group).toBe(group);
      expect(scene.yieldStep(p, 0, guard)).toBe(false);
      if (visit) {
        expect(scene.visits.get(p)).toBe(visit);
        expect(visit.trail).toEqual(trail);
        expect(scene.sites[0]!.queue).toContain(p);
        const start = p.x;
        for (let i = 0; i < 40; i++) scene.step(0.1, [p], {}, undefined, undefined, guard);
        expect(p.x).toBeGreaterThan(start + 0.5);
      } else {
        expect(p.y).toBe(30);
        expect(p.d).toBeCloseTo(p.x);
        expect(scene.transferable(p)).toBe(true);
      }
    },
  );

  it.each([false, true])(
    'checks a retained-facing corner yield resume (admissible %s)',
    (admissible) => {
      const b = new LifeBuilder();
      b.line(
        [
          { x: 0, y: 30 },
          { x: 40, y: 30 },
          { x: 40, y: 80 },
        ],
        LifeLine.path,
        4,
      );
      const scene = new LocalScenes(b.finish(), 1, 8, []);
      const p: Mover = { ...person(39.8), group: [{ ...walker }, { ...walker, lateral: 1 }] };
      const group = p.group;
      let active = true;
      let holdingY = 0;
      const physical = (m: Mover) => ({
        x: m.x - m.hy * (m.avoid ?? 0),
        y: m.y + m.hx * (m.avoid ?? 0),
        ...(m.momentFacing ?? { hx: m.hx, hy: m.hy }),
      });
      const guard = Object.assign(
        (next: Mover) => {
          if (active) return true;
          const body = physical(next);
          return admissible && body.y >= holdingY - 1e-8 && body.hx === 1 && body.hy === 0;
        },
        { yielding: () => (active ? person(42) : undefined), holding: () => true },
      );
      for (let frame = 0; frame < 10; frame++) scene.yieldStep(p, 0.1, guard);
      const holding = physical(p);
      holdingY = holding.y;
      active = false;
      let resumed = false;
      for (let frame = 0; frame < 300; frame++) {
        if (!scene.yieldStep(p, 0.1, guard)) {
          resumed = true;
          break;
        }
      }
      expect(resumed).toBe(admissible);
      expect(physical(p)).toEqual(holding);
      expect(p.group).toBe(group);
      expect(p.hx).toBe(admissible ? 0 : 1);
      expect(p.hy).toBe(admissible ? 1 : 0);
      expect(p.momentFacing).toEqual(admissible ? { hx: 1, hy: 0 } : undefined);
      expect(scene.transferable(p)).toBe(admissible);
    },
  );

  it('prevents visit admission and tile transfer while yielding owns movement', () => {
    const scene = setup(),
      p = { ...person(), group: [{ ...walker }] };
    const guard = Object.assign(() => true, { yielding: () => person(45), holding: () => true });
    for (let i = 0; i < 10; i++) scene.yieldStep(p, 0.1, guard);
    expect(scene.transferable(p)).toBe(false);
    expect(scene.reserve(p, 0)).toBe(false);
    expect(scene.visits.has(p)).toBe(false);
  });

  it('counts accepted mapped-corner progress after a transient refusal', () => {
    const b = new LifeBuilder();
    b.line(
      [
        { x: 10, y: 30 },
        { x: 40, y: 30 },
        { x: 40, y: 90 },
      ],
      LifeLine.path,
      1,
    );
    b.site({ x: 40, y: 80 }, 0, 7, true);
    const scene = new LocalScenes(b.finish(), 1, 8, []),
      p = { ...person(10), speed: 1, d: 0 };
    expect(scene.reserve(p, 0)).toBe(true);
    for (let i = 0; i < 298; i++) scene.step(0.1, [p], {}, undefined, undefined, () => true);
    scene.step(0.1, [p], {}, undefined, undefined, () => false);
    const visit = scene.visits.get(p)!;
    expect(visit.progress).toBeDefined();
    for (let i = 0; i < 90; i++) scene.step(0.1, [p], {}, undefined, undefined, () => true);
    expect(visit.state).toBe('approach');
    expect(visit.blocked).toBe(0);
    expect(p.y).toBeGreaterThan(38);
    expect(scene.sites[0]!.queue).toContain(p);
  });

  it('retains blockage and retry cadence through rejected corners and futile replans', () => {
    const b = new LifeBuilder();
    b.line(
      [
        { x: 10, y: 30 },
        { x: 40, y: 30 },
        { x: 40, y: 90 },
      ],
      LifeLine.path,
      1,
    );
    b.site({ x: 40, y: 80 }, 0, 7, true);
    const scene = new LocalScenes(b.finish(), 1, 8, []),
      p = { ...person(10), speed: 1, d: 0 };
    expect(scene.reserve(p, 0)).toBe(true);
    for (let i = 0; i < 298; i++) scene.step(0.1, [p], {}, undefined, undefined, () => true);
    const visit = scene.visits.get(p)!,
      before = structuredClone(p),
      goal = visit.path.at(-1)!;
    visit.state = 'return';
    visit.trail = [{ ...goal }];
    visit.blocked = RECOVERY.returnReplanSeconds - 0.1;
    visit.retryAt = RECOVERY.returnReplanSeconds;
    visit.progress = { x: p.x, y: p.y, hx: 1, hy: 0, target: visit.path[visit.next] };
    for (let i = 0; i < 180; i++) scene.step(0.1, [p], {}, undefined, undefined, () => false);
    expect(p).toEqual(before);
    expect(visit.blocked).toBeGreaterThan(32);
    expect(visit.retryAt).toBeGreaterThan(visit.blocked);
    expect(visit.progress).toMatchObject({ x: before.x, y: before.y, hx: 1, hy: 0 });
  });

  it('expires active yielding through a checked return while preserving its reservation', () => {
    const scene = setup(),
      p = { ...person(), group: [{ ...walker }] },
      priority = person(45);
    expect(scene.reserve(p, 0)).toBe(true);
    const visit = scene.visits.get(p)!,
      anchor = structuredClone(p),
      trail = structuredClone(visit.trail),
      group = p.group;
    let active = true,
      returning = false;
    const cancel = vi.fn(() => {
      active = false;
      returning = true;
    });
    let blockReturn = true;
    const guard = Object.assign(
      (next: Mover, before: Mover, reserve = true) => {
        if (reserve) {
          expect(Math.hypot(next.x - before.x, next.y - before.y)).toBeLessThanOrEqual(
            p.speed * 0.1 + 1e-8,
          );
          return !(returning && blockReturn);
        }
        return true;
      },
      { yielding: () => (active ? priority : undefined), holding: () => true, cancelYield: cancel },
    );
    for (let frame = 0; frame < 10; frame++) scene.step(0.1, [p], {}, undefined, undefined, guard);
    expect(p.y).toBeGreaterThan(anchor.y);
    const holding = structuredClone(p);
    // A zero-time call must preserve the active timeout and complete pose.
    for (let frame = 0; frame < 60; frame++) scene.yieldStep(p, 0, guard);
    expect(cancel).not.toHaveBeenCalled();
    expect(p).toEqual(holding);
    for (let frame = 10; frame < (RECOVERY.yieldSeconds + 1) * 10; frame++)
      scene.step(0.1, [p], {}, undefined, undefined, guard);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(p.y).toBe(holding.y);
    expect(scene.visits.get(p)).toBe(visit);
    expect(visit.state).toBe('approach');
    expect(visit.blocked).toBe(0);
    expect(scene.sites[0]!.queue).toContain(p);
    expect(visit.trail).toEqual(trail);
    blockReturn = false;
    for (let frame = 0; frame < 12; frame++) scene.yieldStep(p, 0.1, guard);
    expect(p).toEqual({ ...anchor, walked: p.walked });
    expect(p.group).toBe(group);
    expect(scene.sites[0]!.queue).toContain(p);
    expect(scene.yieldStep(p, 0.1, guard)).toBe(false);
  });

  it('rejects holding candidates before performing a route search', () => {
    const scene = setup(),
      p = { ...person(), group: [{ ...walker }] };
    const graph = (scene as unknown as { graph: WalkingGraph }).graph,
      route = vi.spyOn(graph, 'route'),
      cancel = vi.fn();
    const guard = Object.assign(() => true, {
      yielding: () => person(45),
      holding: () => false,
      cancelYield: cancel,
    });
    expect(scene.yieldStep(p, 0.1, guard)).toBe(false);
    expect(route).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('retreats against mapped travel while retaining a backward physical facing', () => {
    const scene = setup(),
      p = { ...person(), group: [{ ...walker }], momentFacing: { hx: -1, hy: 0 } },
      anchor = structuredClone(p);
    const guard = Object.assign(
      (next: Mover, before: Mover) => {
        expect(next.hx).toBe(before.hx);
        expect(next.hy).toBe(before.hy);
        expect(next.momentFacing).toEqual(anchor.momentFacing);
        return true;
      },
      { yielding: () => person(45), holding: (m: Mover) => m.x < anchor.x - 0.4 },
    );
    for (let frame = 0; frame < 10; frame++) scene.yieldStep(p, 0.1, guard);
    expect(p.x).toBeCloseTo(anchor.x - 0.5);
    expect(p.y).toBeGreaterThan(anchor.y);
    expect(p.momentFacing).toEqual(anchor.momentFacing);
  });

  it('withdraws through its checked path when a replan invalidates the holding spot', () => {
    const scene = setup(),
      p = { ...person(), group: [{ ...walker }] },
      priority = person(45);
    expect(scene.reserve(p, 0)).toBe(true);
    const visit = scene.visits.get(p)!,
      anchor = structuredClone(p),
      trail = structuredClone(visit.trail),
      group = p.group;
    let active = true,
      valid = true,
      cancelled = 0;
    const guard = Object.assign(
      (next: Mover, before: Mover, reserve = true) => {
        if (reserve)
          expect(Math.hypot(next.x - before.x, next.y - before.y)).toBeLessThanOrEqual(
            p.speed * 0.1 + 1e-8,
          );
        return true;
      },
      {
        yielding: () => (active ? priority : undefined),
        holding: () => valid,
        cancelYield: () => {
          active = false;
          cancelled++;
        },
      },
    );
    for (let frame = 0; frame < 10; frame++) scene.yieldStep(p, 0.1, guard);
    expect(p.y).toBeGreaterThan(anchor.y);
    valid = false;
    for (let frame = 0; frame < 12; frame++) scene.yieldStep(p, 0.1, guard);
    expect(cancelled).toBe(1);
    expect(p).toEqual({ ...anchor, walked: p.walked });
    expect(p.walked).toBeGreaterThan(0);
    expect(p.group).toBe(group);
    expect(visit.trail).toEqual(trail);
    expect(scene.visits.get(p)).toBe(visit);
    expect(scene.sites[0]!.queue).toContain(p);
  });

  it.each([0, 1])(
    'translates the physical footprint along a narrow crossing at lane offset %s',
    (lane) => {
      const b = new LifeBuilder();
      b.line(
        [
          { x: 40, y: 25 },
          { x: 40, y: 40 },
        ],
        LifeLine.path,
        1,
      );
      b.line(
        [
          { x: 0, y: 30 },
          { x: 100, y: 30 },
        ],
        LifeLine.roadMajor,
        20,
      );
      b.area('crossing', [
        [
          { x: 39.5, y: 24 },
          { x: 40.5, y: 24 },
          { x: 40.5, y: 41 },
          { x: 39.5, y: 41 },
          { x: 39.5, y: 24 },
        ],
      ]);
      const scene = new LocalScenes(b.finish(), 1, 8, []),
        p = { ...person(), y: 30 - lane, avoid: lane, group: [{ ...walker }] };
      let checked = 0;
      const guard = Object.assign(
        (next: Mover, before: Mover) => {
          checked++;
          expect(next.hx).toBe(before.hx);
          expect(next.hy).toBe(before.hy);
          return true;
        },
        { yielding: () => person(45), holding: () => true },
      );
      for (let frame = 0; frame < 10; frame++) scene.yieldStep(p, 0.1, guard);
      expect(checked).toBeGreaterThan(0);
      expect(p.x).toBe(40);
      expect(p.y).toBeCloseTo(30.65 - lane);
      expect(p.hx).toBe(1);
      expect(p.group).toHaveLength(1);
    },
  );

  it('reports a denied trial after restoring its actual pose and retained route cursor', () => {
    const scene = setup(),
      p = person();
    expect(scene.reserve(p, 0)).toBe(true);
    const visit = scene.visits.get(p)!;
    const before = structuredClone(p),
      next = visit.next;
    let contacted = false;
    const guard = Object.assign(() => false, {
      contact: (owner: Mover, trial?: Mover) => {
        contacted = true;
        expect(owner).toBe(p);
        expect(owner).toEqual(before);
        expect(visit.next).toBe(next);
        expect(trial!.x).toBeGreaterThan(before.x);
      },
    });
    scene.step(0.1, [p], {}, undefined, undefined, guard);
    expect(contacted).toBe(true);
    expect(p).toEqual(before);
  });

  it('advances an owned visit and service when their site is covered by another tile', () => {
    const scene = setup(),
      p = person(),
      bus = { ...person(50, 'vehicle'), line: 1, y: 24, vehicle: 'bus' as const };
    expect(scene.reserve(p, 0)).toBe(true);
    const visit = scene.visits.get(p)!;
    scene.services.set(bus, { site: visit.site, time: 10, arriving: false, boarded: 0 });
    scene.step(
      0.1,
      [p, bus],
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (owner) => owner === p || owner === bus,
    );
    expect(p.x).toBeGreaterThan(40);
    expect(scene.services.get(bus)!.time).toBeCloseTo(9.9);
  });

  it('replans a blocked return on the walking graph while retaining the visit and position', () => {
    const scene = setup(),
      p = person();
    expect(scene.reserve(p, 0)).toBe(true);
    const visit = scene.visits.get(p)!;
    p.x = 48;
    visit.state = 'return';
    visit.path = [
      { x: 48, y: 30 },
      { x: 40, y: 50 },
      { x: 40, y: 30 },
    ];
    visit.next = 1;
    visit.blocked = 15.95;
    scene.step(0.1, [p], {}, undefined, undefined, (_next, _before, reserve = true) => !reserve);
    expect(scene.visits.get(p)).toBe(visit);
    expect([p.x, p.y]).toEqual([48, 30]);
    expect(visit.blocked).toBeCloseTo(16.05);
    expect(visit.retryAt).toBeCloseTo(32.05);
    expect(visit.next).toBe(1);
    expect(visit.path.every((point) => point.y === 30)).toBe(true);
    scene.step(0.1, [p], {}, undefined, undefined, () => true);
    expect(p.x).toBeLessThan(48);
    expect(scene.visits.get(p)).toBe(visit);
  });

  it('continues its retained route when reciprocal yielding has no safe holding corridor', () => {
    const scene = setup(),
      p = { ...person(), hx: 1, hy: 0, group: [{ ...walker }] };
    expect(scene.reserve(p, 0)).toBe(true);
    const visit = scene.visits.get(p)!,
      anchor = structuredClone(visit.trail);
    let cancelled = 0;
    const guard = Object.assign(
      (next: Mover, before: Mover, reserve = true) =>
        reserve && Math.hypot(next.x - before.x, next.y - before.y) <= p.speed * 0.1 + 1e-8,
      {
        yielding: () => person(45),
        cancelYield: () => {
          cancelled++;
        },
      },
    );
    scene.step(0.1, [p], {}, undefined, undefined, guard);
    expect(cancelled).toBe(1);
    expect(p.x).toBeGreaterThan(40);
    expect(p.x - 40).toBeLessThanOrEqual(p.speed * 0.1 + 1e-8);
    expect(visit.trail[0]).toEqual(anchor[0]);
    expect(scene.sites[0]!.queue).toContain(p);
    expect(visit.blocked).toBe(0);
  });

  it('freezes an existing blocked episode and facing during a signal hold', () => {
    const scene = setup(),
      p = { ...person(), hx: 0, hy: 1, group: [{ ...walker }] };
    expect(scene.reserve(p, 0)).toBe(true);
    const visit = scene.visits.get(p)!;
    visit.blocked = 7.5;
    const before = structuredClone(p);
    for (let i = 0; i < 120; i++)
      scene.step(
        0.1,
        [p],
        {},
        undefined,
        undefined,
        () => true,
        undefined,
        () => 0,
      );
    expect(p).toEqual(before);
    expect(visit.blocked).toBe(7.5);
    expect(visit.state).toBe('approach');
    expect(scene.sites[0]!.queue).toContain(p);
  });

  it.each([0, 1e-12])(
    'finishes a return at its route start within %s without a footprint move',
    (residue) => {
      const scene = setup(),
        p = person();
      expect(scene.reserve(p, 0)).toBe(true);
      const visit = scene.visits.get(p)!;
      visit.state = 'return';
      visit.path = [
        { x: p.x, y: p.y },
        { x: p.x, y: p.y },
      ];
      visit.next = 1;
      p.x += residue;
      let checks = 0;
      scene.step(0.1, [p], {}, undefined, undefined, () => {
        checks++;
        return false;
      });
      expect(checks).toBe(0);
      expect(scene.visits.has(p)).toBe(false);
      expect([p.x, p.y, p.d]).toEqual([40, 30, 40]);
    },
  );

  it('replans past a nearby perpendicular attachment without retaining mutable route points', () => {
    const scene = setup(),
      p = person();
    expect(scene.reserve(p, 0)).toBe(true);
    const visit = scene.visits.get(p)!;
    p.x = 48;
    p.y = 30.2;
    visit.state = 'return';
    visit.path = [
      { x: p.x, y: p.y },
      { x: 40, y: 50 },
    ];
    visit.next = 1;
    visit.blocked = 15.95;
    scene.step(0.1, [p], {}, undefined, undefined, (_next, _before, reserve = true) => !reserve);
    expect(visit.path[1]).toEqual({ x: 40, y: 30 });
    expect(visit.path[0]).toEqual({ x: 48, y: 30.2 });
    p.x = 47;
    expect(visit.path[0]!.x).toBe(48);
  });
  it('keeps curb-service ownership and offset blending local to the vehicle', () => {
    const scene = setup(),
      bus = { ...person(40, 'vehicle'), vehicle: 'bus' as const };
    const other = { ...bus };
    const site = scene.sites[0]!;
    scene.services.set(bus, { site, time: 0, boarded: 0, arriving: false });
    expect(scene.hasCurbScenes).toBe(true);
    expect(scene.curbSite(bus)).toBe(site);
    expect(scene.curbSite(other)).toBeUndefined();
    expect(scene.offset(bus, 1, 3)).toBe(scene.offsetAt(bus, bus, 1, 3));
    expect(scene.offsetAt(bus, site, 1, 3)).toBe(3);
    expect(scene.offsetAt(other, site, 1, 3)).toBe(1);
    scene.step(0.1, [bus], {});
    expect(scene.services.has(bus)).toBe(false);
    expect(scene.curbSite(bus)).toBe(site);
    expect(scene.curbSite(other)).toBeUndefined();
  });
  it('waits for accepted arrival speed before starting transit dwell', () => {
    const scene = setup(),
      bus = { ...person(45, 'vehicle'), line: 1, y: 24, vehicle: 'bus' as const, v: 3 };
    for (let i = 0; i < 12; i++) scene.step(0.1, [bus], {});
    bus.x = bus.d = 50;
    scene.step(0.1, [bus], {});
    expect(scene.services.get(bus)?.arriving).toBe(true);
    expect(scene.held(bus)).toBe(false);
    bus.v = 0.05;
    scene.step(0.1, [bus], {});
    expect(scene.held(bus)).toBe(true);
    expect(bus.pause).toBeGreaterThan(0);
  });
  it('skips a stop selected too late for comfortable braking', () => {
    const scene = setup(),
      bus = { ...person(49, 'vehicle'), line: 1, y: 24, vehicle: 'bus' as const, v: 8 };
    run(scene, [bus], 2);
    expect(scene.services.has(bus)).toBe(false);
    bus.x = bus.d = 40;
    bus.v = 3;
    run(scene, [bus], 2);
    expect(scene.services.get(bus)?.arriving).toBe(true);
  });
  it('lets a bus leave a held boarding visitor and safely returns the visitor on release', () => {
    const scene = setup(),
      p = person(),
      bus = { ...person(50, 'vehicle'), line: 1, y: 24, vehicle: 'bus' as const };
    expect(scene.reserve(p, 0)).toBe(true);
    const visit = scene.visits.get(p)!;
    visit.state = 'board';
    visit.time = 20;
    scene.services.set(bus, {
      site: visit.site,
      time: 0.05,
      arriving: false,
      boarded: 1,
      passenger: p,
    });
    const before = structuredClone({ ...visit, site: undefined });
    scene.step(
      0.1,
      [p, bus],
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      p,
    );
    expect(scene.services.has(bus)).toBe(false);
    expect({ ...visit, site: undefined }).toEqual(before);
    expect([p.x, p.y]).toEqual([40, 30]);
    scene.step(0.1, [p, bus], {});
    expect(visit.state).toBe('return');
    run(scene, [p], 3);
    expect(scene.visits.has(p)).toBe(false);
    expect(scene.sites[0]!.queue).not.toContain(p);
  });

  it('keeps a held visit and its timers unchanged while another visitor continues', () => {
    const scene = setup(),
      a = person(40),
      b = person(35);
    expect(scene.reserve(a, 0)).toBe(true);
    expect(scene.reserve(b, 0)).toBe(true);
    const before = structuredClone({ ...scene.visits.get(a), site: undefined });
    const position = [a.x, a.y];
    for (let frame = 0; frame < 60; frame++)
      scene.step(
        0.1,
        [a, b],
        {},
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        a,
      );
    expect([a.x, a.y]).toEqual(position);
    expect({ ...scene.visits.get(a), site: undefined }).toEqual(before);
    expect([b.x, b.y]).not.toEqual([35, 30]);
    scene.step(0.1, [a, b], {});
    expect(Math.hypot(a.x - position[0]!, a.y - position[1]!)).toBeLessThanOrEqual(
      a.speed * 0.1 + 1e-6,
    );
  });

  it('keeps a covered customer frozen while an owned customer can buy at the queue front', () => {
    const stall: Stall = { x: 50, y: 30, hx: 1, hy: 0, paint: 0, shirt: 0, side: 1, rank: 0 };
    const scene = setup(0, [stall]);
    const index = scene.sites.findIndex((s) => s.kind === 'vendor');
    const covered = person(40),
      owned = person(41);
    expect(scene.reserve(covered, index)).toBe(true);
    expect(scene.reserve(owned, index)).toBe(true);
    for (const visit of scene.visits.values()) {
      visit.state = 'wait';
      visit.time = 60;
    }
    const frozen = structuredClone({ ...scene.visits.get(covered), site: undefined });
    scene.step(
      0.1,
      [covered, owned],
      { rain: 0 },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (p) => p.x >= 41,
    );
    expect({ ...scene.visits.get(covered), site: undefined }).toEqual(frozen);
    expect(scene.visits.get(owned)?.state).toBe('purchase');
  });

  it('refreshes a vendor that regains ownership after its opening time changed while covered', () => {
    const stall: Stall = { x: 50, y: 30, hx: 1, hy: 0, paint: 0, shirt: 0, side: 1, rank: 0 };
    const scene = setup(0, [stall]);
    scene.step(0.1, [], { rain: 0, minutes: 720 });
    expect(stall.open).toBe(true);
    scene.step(
      0.1,
      [],
      { rain: 0, minutes: 180 },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => false,
    );
    expect(stall.open).toBe(true);
    scene.step(0.1, [], { rain: 0, minutes: 180 });
    expect(stall.open).toBe(false);
  });

  const crossingScene = (siteX = 110) => {
    const b = new LifeBuilder();
    b.line(
      [
        { x: 0, y: 30 },
        { x: 200, y: 30 },
      ],
      LifeLine.path,
      2,
    );
    b.line(
      [
        { x: 80, y: 0 },
        { x: 80, y: 200 },
      ],
      LifeLine.roadMinor,
      6,
    );
    b.area('crossing', [stripRing({ x: 76, y: 30 }, { x: 84, y: 30 }, 2)]);
    b.site({ x: siteX, y: 30 }, 2, 0, true);
    return new LocalScenes(b.finish(), 1, 8, []);
  };

  it('rejects stationary crossing sites and visits that would start inside the road', () => {
    const unsafe = crossingScene(80);
    const safe = crossingScene();
    for (const kind of ['person', 'cat', 'dog'] as const) {
      expect(unsafe.reserve(person(40, kind), 0)).toBe(false);
      expect(safe.reserve(person(80, kind), 0)).toBe(false);
    }
    const group = person(40);
    group.group = [{ ...walker }, { ...walker, back: 28 }];
    // The first person fits at x110, but the trailing person's queue position lies on the road.
    expect(safe.reserve(group, 0)).toBe(false);
    expect(safe.sites[0]!.queue).toHaveLength(0);
  });

  it('releases a canceled reservation and finishes crossing before reversing', () => {
    for (const kind of ['person', 'cat', 'dog'] as const) {
      const scene = crossingScene();
      scene.step(0, [], { rain: 1 });
      const m = person(40, kind);
      m.group = kind === 'person' ? [{ ...walker }, { ...walker, back: 2 }] : undefined;
      expect(scene.reserve(m, 0)).toBe(true);
      const visit = scene.visits.get(m)!;
      const { world } = makeScenario('rain', 1);
      const tile = [...worldTiles(world).values()][0]!;
      tile.scenes = scene;
      tile.movers.splice(0, tile.movers.length, m);
      tile.gatherers.length = 0;
      valid(world);
      while (m.x < 80) scene.step(0.1, [m], { rain: 1 });
      const x = m.x;
      scene.step(0.1, [m], { rain: 0 });
      expect(visit.site.queue).toHaveLength(0);
      expect(visit.returnPending).toBe(true);
      expect(visit.state).toBe('approach');
      valid(world);
      expect(m.x).toBeGreaterThan(x);
      expect(m.hx).toBe(1);
      for (let i = 0; visit.returnPending && i < 100; i++) {
        const x = m.x;
        scene.step(0.1, [m], { rain: 0 });
        valid(world);
        expect(m.x).toBeGreaterThan(x);
      }
      expect(visit.returnPending).toBe(false);
      expect(visit.state).toBe('return');
      valid(world);
      expect(m.x).toBeGreaterThan(83 + (kind === 'person' ? 2.45 : kind === 'dog' ? 0.45 : 0.325));
      run(scene, [m], 60);
      expect(scene.visits.has(m)).toBe(false);
      expect(visit.site.queue).toHaveLength(0);
      valid(world);
    }
  });

  it('removes a stall immediately while its crossing visitor continues to safe ground', () => {
    const scene = crossingScene();
    scene.sites.length = 0;
    const stall: Stall = { x: 110, y: 28.7, hx: 1, hy: 0, paint: 0, shirt: 0, side: 1, rank: 0 };
    scene.addStall(stall);
    const m = person(40);
    expect(scene.reserve(m, 0)).toBe(true);
    const visit = scene.visits.get(m)!;
    while (m.x < 80) scene.step(0.1, [m], {});
    scene.removeStall(stall);
    expect(scene.sites).toHaveLength(0);
    expect(visit.site.queue).toHaveLength(0);
    expect(visit.returnPending).toBe(true);
    const x = m.x;
    scene.step(0.1, [m], {});
    expect(m.x).toBeGreaterThan(x);
    expect(m.hx).toBe(1);
    run(scene, [m], 60);
    expect(scene.visits.has(m)).toBe(false);
  });

  for (const kind of ['dog', 'cat'] as const) {
    it(`guards the ${kind}'s shelter approach, arrival, and return and releases its reservation`, () => {
      const scene = setup(2);
      scene.step(0, [], { rain: 1 });
      const m = person(40, kind);
      expect(scene.reserve(m, 0)).toBe(true);
      const visit = scene.visits.get(m)!;
      const start = { ...m };
      let limited = 0;
      scene.step(
        0.1,
        [m],
        { rain: 1 },
        undefined,
        undefined,
        () => true,
        undefined,
        (_m, _to, d) => {
          limited++;
          return Math.min(d, 0.1);
        },
      );
      expect(limited).toBeGreaterThan(0);
      expect(m.x - start.x).toBeCloseTo(0.1);
      const next = visit.next;
      const trail = [...visit.trail];
      const before = { ...m };
      scene.step(0.1, [m], { rain: 1 }, undefined, undefined, () => false);
      expect(m).toEqual(before);
      expect(visit.next).toBe(next);
      expect(visit.trail).toEqual(trail);
      let checked = 0;
      const allow = () => {
        checked++;
        return true;
      };
      for (let i = 0; i < 70; i++) scene.step(0.1, [m], { rain: 1 }, undefined, undefined, allow);
      expect(visit.state).toBe('shelter');
      expect(checked).toBeGreaterThan(1);
      expect(visit.site.queue).toContain(m);
      const approachChecks = checked;
      for (let i = 0; i < 100; i++) scene.step(0.1, [m], { rain: 0 }, undefined, undefined, allow);
      expect(checked).toBeGreaterThan(approachChecks);
      expect(scene.visits.has(m)).toBe(false);
      expect(visit.site.queue).toHaveLength(0);
      expect([m.x, m.y]).toEqual([start.x, start.y]);
    });

    it(`rejects a ${kind}'s shelter seat whose center is clear but body overlaps a road`, () => {
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
          { x: 0, y: 20 },
          { x: 200, y: 20 },
        ],
        LifeLine.roadMinor,
        6,
      );
      b.site({ x: 50, y: 23.1 }, 2, 0, true);
      const scene = new LocalScenes(b.finish(), 1, 8, []);
      expect(scene.sites).toHaveLength(1);
      const m = person(40, kind);
      expect(scene.reserve(m, 0)).toBe(false);
      expect(scene.sites[0]!.queue).toHaveLength(0);
    });

    it(`validates the ${kind}'s orientation when it settles at a rest site`, () => {
      const stall: Stall = { x: 50, y: 30, hx: 1, hy: 0, paint: 0, shirt: 0, side: 1, rank: 0 };
      const scene = setup(0, [stall]);
      const m = person(40, kind);
      expect(scene.reserve(m, 2)).toBe(true);
      const visit = scene.visits.get(m)!;
      const arrivalHeading = visit.site.hx;
      let rejected = false;
      for (let i = 0; i < 100 && !rejected; i++)
        scene.step(0.1, [m], {}, undefined, undefined, (_next, _before) => {
          if (visit.state === 'rest') {
            rejected = true;
            return false;
          }
          return true;
        });
      expect(arrivalHeading).toBe(1);
      expect(rejected).toBe(true);
      expect(visit.state).toBe('return');
      expect(visit.site.queue).toHaveLength(0);
      run(scene, [m], 10);
      expect(scene.visits.has(m)).toBe(false);
    });
  }

  it('releases a removed vendor queue and returns active customers along their approach', () => {
    const stall: Stall = { x: 50, y: 30, hx: 1, hy: 0, paint: 0, shirt: 0, side: 1, rank: 0 };
    const scene = setup(0, [stall]),
      p = person();
    expect(scene.reserve(p, 1)).toBe(true);
    run(scene, [p], 1);
    const visit = scene.visits.get(p)!;
    const site = visit.site;
    expect(p.x).not.toBe(40);
    scene.removeStall(stall);
    expect(site.queue).toHaveLength(0);
    expect(scene.sites.some((s) => s.stall === stall)).toBe(false);
    expect(visit.state).toBe('return');
    run(scene, [p], 8);
    expect(scene.visits.has(p)).toBe(false);
    expect([p.x, p.y]).toEqual([40, 30]);
  });

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
  it('runs those with no umbrella to shelter and walks them back after the rain', () => {
    const scene = setup(2);
    const caught = { ...person(), group: [walker] };
    const dry = { ...person(), group: [{ ...walker, umbrella: 0 }] };
    const other = setup(2);
    scene.step(0.1, [], { rain: 1 });
    other.step(0.1, [], { rain: 1 });
    expect(scene.reserve(caught, 0)).toBe(true);
    expect(other.reserve(dry, 0)).toBe(true);
    scene.step(0.5, [caught], { rain: 1 });
    other.step(0.5, [dry], { rain: 1 });
    expect(caught.x - 40).toBeGreaterThan(RUN.dash[0] * 0.5 - 1e-9);
    expect(dry.x - 40).toBeCloseTo(dry.speed * 0.5);
    run(scene, [caught], 6, 1);
    expect(scene.visits.get(caught)!.state).toBe('shelter');
    const visit = scene.visits.get(caught)!;
    for (
      let frame = 0;
      frame < (SHELTER_DEPARTURE.last + 1) * 10 && visit.state !== 'return';
      frame++
    )
      scene.step(0.1, [caught], { rain: 0 });
    expect(visit.state).toBe('return');
    const from = caught.x;
    scene.step(0.5, [caught], { rain: 0 });
    expect(scene.visits.get(caught)!.state).toBe('return');
    expect(from - caught.x).toBeCloseTo(caught.speed * 0.5);
  });
  it('staggered departures repeat deterministically, change order by shower and consume no RNG', () => {
    const departures = (shower: number) => {
      const scene = setup(2);
      const people = [0.08, 0.23, 0.37, 0.51, 0.68, 0.89].map((rank, i) => ({
        ...person(35),
        rank,
        group: [{ ...walker, umbrella: i < 2 ? 0 : 1 }],
      }));
      for (let n = 1; n < shower; n++) {
        scene.step(0, [], { rain: 1 });
        scene.step(0, [], { rain: 0 });
      }
      scene.step(0, [], { rain: 1 });
      people.forEach((p) => expect(scene.reserve(p, 0)).toBe(true));
      run(scene, people, 12, 1);
      const visits = people.map((p) => scene.visits.get(p)!);
      expect(visits.every((v) => v.state === 'shelter')).toBe(true);
      const rng = vi.spyOn(scene as unknown as { rng: () => number }, 'rng');
      const frames = Array<number>(6).fill(-1);
      let clearing = 0;
      for (let frame = 0; frame <= 600 && frames.includes(-1); frame++) {
        // Stop stepping departed walkers so approach/search RNG is excluded.
        scene.step(
          0.1,
          people.filter((_, i) => frames[i] === -1),
          { rain: 0 },
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          (m) => people.some((p, i) => p === m && frames[i] === -1) || m === visits[0]!.site,
        );
        clearing += scene.speechEvents.filter((e) => e.kind === 'clearing').length;
        visits.forEach((v, i) => {
          if (frames[i] === -1 && v.state === 'return') frames[i] = frame;
        });
      }
      expect(rng).not.toHaveBeenCalled();
      expect(clearing).toBe(1);
      expect(frames.every((f) => f >= 0 && f <= 600)).toBe(true);
      expect(new Set(frames).size).toBeGreaterThanOrEqual(4);
      const nonCarriers = frames.slice(2).sort((a, b) => a - b);
      expect(Math.max(...frames.slice(0, 2))).toBeLessThan((nonCarriers[1]! + nonCarriers[2]!) / 2);
      return frames;
    };
    const first = departures(1);
    expect(departures(1)).toEqual(first);
    const order = (frames: number[]) =>
      frames
        .map((f, i) => ({ f, i }))
        .sort((a, b) => a.f - b.f)
        .map((e) => e.i);
    expect(order(departures(2))).not.toEqual(order(first));
  });
  it('cancels pending countdowns on renewed rain and replaces stale inspected shower values', () => {
    const scene = setup(2),
      p = { ...person(), group: [walker], rank: 0.68 };
    scene.step(0, [], { rain: 1 });
    scene.reserve(p, 0);
    run(scene, [p], 10, 1);
    const visit = scene.visits.get(p)!;
    scene.step(0.1, [p], { rain: 0 });
    expect(visit.leaveShower).toBe(1);
    scene.step(0.1, [p], { rain: 1 });
    expect(visit).toMatchObject({ state: 'shelter' });
    expect(visit.leave).toBeUndefined();
    scene.step(0.1, [p], { rain: 0 });
    const prior = visit.leave;
    scene.step(
      0.1,
      [p],
      { rain: 1 },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      p,
    );
    scene.step(
      0.1,
      [p],
      { rain: 0 },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      p,
    );
    expect(visit.leave).toBe(prior);
    scene.step(0.1, [p], { rain: 0 });
    expect(visit.leaveShower).toBe(3);
    expect(visit.leave).toBeCloseTo(departureDelay(p, 3) - 0.1);
  });
  it('samples bounded umbrella and non-carrier departure delays without scene state', () => {
    for (let rank = 0; rank < 1; rank += 0.01)
      for (const umbrella of [0, 1]) {
        const p = { ...person(), rank, group: [{ ...walker, umbrella }] };
        const delay = departureDelay(p, 1);
        expect(delay).toBeGreaterThanOrEqual(umbrella === 0 ? 0 : 2);
        expect(delay).toBeLessThanOrEqual(umbrella === 0 ? 6 : 60);
        expect(departureDelay(p, 1)).toBe(delay);
      }
  });
  it('runs a cancelled vendor customer back while the storm continues', () => {
    const stall: Stall = { x: 65, y: 30, hx: 1, hy: 0, paint: 0, shirt: 0, side: 1, rank: 0 };
    const scene = setup(0, [stall]);
    const p = { ...person(), group: [walker] };
    expect(scene.reserve(p, 1)).toBe(true);
    scene.step(2, [p], { rain: 0 });
    const visit = scene.visits.get(p)!;
    expect(visit.state).toBe('approach');
    expect(visit.sheltering).toBe(false);
    const walked = p.walked ?? 0;
    scene.step(0.1, [p], { rain: 1 });
    expect(visit.state).toBe('return');
    expect(visit.site.queue).toHaveLength(0);
    expect((p.walked ?? 0) - walked).toBeGreaterThanOrEqual(RUN.dash[0] * 0.1);
  });
  it('runs back from an abandoned shelter approach while the storm continues', () => {
    const scene = setup(2);
    const p = { ...person(), group: [walker] };
    scene.step(0, [], { rain: 1 });
    expect(scene.reserve(p, 0)).toBe(true);
    scene.step(1, [p], { rain: 1 });
    const visit = scene.visits.get(p)!;
    expect(visit.state).toBe('approach');
    for (let i = 0; i < 90 && visit.state === 'approach'; i++)
      scene.step(0.1, [p], { rain: 1 }, undefined, undefined, () => false);
    expect(visit.state).toBe('return');
    expect(visit.site.queue).toHaveLength(0);
    const walked = p.walked ?? 0;
    scene.step(0.1, [p], { rain: 1 });
    expect((p.walked ?? 0) - walked).toBeGreaterThanOrEqual(RUN.dash[0] * 0.1);
  });
  it('sends those with no umbrella to cover from further away', () => {
    const reservesShelter = (umbrellaRoll: number) => {
      const scene = setup(2);
      const p = { ...person(), x: 2, d: 2, group: [{ ...walker, umbrella: umbrellaRoll }] };
      run(scene, [p], 20, 1);
      return scene.visits.has(p);
    };
    expect(reservesShelter(1)).toBe(true);
    expect(reservesShelter(0)).toBe(false);
  });

  const rainShelters = (fallback = false) => {
    const b = new LifeBuilder();
    for (const y of [30, 81])
      b.line(
        [
          { x: 0, y },
          { x: 200, y },
        ],
        LifeLine.path,
      );
    b.site({ x: 50, y: 81 }, 2, 0, true);
    if (fallback) b.site({ x: 105, y: 30 }, 2, 0, true);
    const scene = new LocalScenes(b.finish(), 1, 8, []);
    (scene as unknown as { rng: () => number }).rng = () => 0;
    return scene;
  };

  it('waits five seconds before retrying unreachable cover for a caught walker', () => {
    const scene = rainShelters();
    const p = { ...person(50), group: [walker] };
    const reserve = vi.spyOn(scene, 'reserve');
    scene.step(1, [p], { rain: 1 });
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(scene.visits.has(p)).toBe(false);
    for (let i = 0; i < 4; i++) scene.step(1, [p], { rain: 1 });
    expect(reserve).toHaveBeenCalledTimes(1);
    scene.step(1, [p], { rain: 1 });
    expect(reserve).toHaveBeenCalledTimes(2);
  });

  it('tries reachable fallback cover before applying a failed-search cooldown', () => {
    const scene = rainShelters(true);
    const p = { ...person(50), group: [walker] };
    const reserve = vi.spyOn(scene, 'reserve');
    scene.step(1, [p], { rain: 1 });
    expect(reserve.mock.calls.map(([, index]) => index)).toEqual([0, 1]);
    expect(scene.visits.get(p)?.site).toBe(scene.sites[1]);
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
    // The failed approach never left its route start, so its return completes safely.
    expect(scene.visits.has(p)).toBe(false);
    scene.step(0.1, [p], {}, undefined, undefined, () => true);
    expect(scene.visits.size).toBe(0);
  });
  it('keeps a signal-delayed visit reserved until its walking phase resumes', () => {
    const scene = setup(),
      p = person();
    expect(scene.reserve(p, 0)).toBe(true);
    for (let i = 0; i < 120; i++)
      scene.step(
        0.1,
        [p],
        {},
        undefined,
        undefined,
        () => true,
        undefined,
        () => 0,
      );
    expect(p.x).toBe(40);
    expect(scene.visits.get(p)!.state).toBe('approach');
    expect(scene.visits.get(p)!.blocked).toBe(0);
    expect(scene.sites[0]!.queue).toContain(p);
    for (let i = 0; i < 100; i++)
      scene.step(
        0.1,
        [p],
        {},
        undefined,
        undefined,
        () => true,
        undefined,
        (_m, _target, distance) => distance,
      );
    expect(p.x).toBeGreaterThan(40);
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
