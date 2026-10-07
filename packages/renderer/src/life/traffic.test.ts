import { checkCrossroads } from './testing/road-crossroads-checks';
import { describe, expect, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { metersPerUnit } from '../raster/geometry';
import { LifeBuilder, LifeLine } from './geometry';
import { TileLife, LifeWorld, type Mover } from './simulate';
import type { JunctionTable } from './junctions';
import { FOLLOW, JUNCTION, kinematicsOf } from './config';
import { worldTiles } from './testing/scenarios';
import { VEHICLES } from './vehicles';

const tile = { z: 16, x: 55192, y: 30266 };
const pm = 1 / metersPerUnit(tile);
function corner(split: boolean) {
  const b = new LifeBuilder();
  const points = [
    { x: 1000, y: 1000 },
    { x: 1000 + 100 * pm, y: 1000 },
    { x: 1000 + 100 * pm, y: 1000 + 100 * pm },
  ];
  if (split) {
    b.line(points.slice(0, 2), LifeLine.roadMinor, 8);
    b.line(points.slice(1), LifeLine.roadMinor, 8);
  } else b.line(points, LifeLine.roadMinor, 8);
  const life = new TileLife(tile, b.finish(), 1);
  life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
  life.scenes.sites.length = 0;
  const m: Mover = {
    kind: 'vehicle',
    vehicle: 'car',
    line: 0,
    from: 0,
    dir: 1,
    d: 80 * pm,
    speed: 1 * pm,
    v: 1 * pm,
    paint: 0,
    lane: 0,
    pause: 0,
    rank: 0,
    x: 1000 + 80 * pm,
    y: 1000,
    hx: 1,
    hy: 0,
  };
  life.movers.push(m);
  return { life, m };
}

describe('curved traffic', () => {
  it('distinguishes legal exits from incoming-only roads without terminal option arrays', () => {
    const { life, m } = corner(true);
    const terminal = life as unknown as {
      terminalTarget(m: Mover, target: number, remaining: number): number;
    };
    expect(terminal.terminalTarget(m, 8 * pm, pm)).toBe(8 * pm);
    life.geo.oneway![1] = -1;
    expect(terminal.terminalTarget(m, 8 * pm, pm)).toBeLessThan(8 * pm);
    life.geo.oneway![1] = 1;
    expect(terminal.terminalTarget(m, 8 * pm, pm)).toBe(8 * pm);
  });
  it('starts an uninitialized vehicle at its safe target before a closed one-way endpoint', () => {
    const { life, m } = corner(false);
    life.geo.oneway![0] = 1;
    Object.assign(m, {
      from: 1,
      d: 99 * pm,
      x: 1000 + 100 * pm,
      y: 1000 + 99 * pm,
      hx: 0,
      hy: 1,
      v: undefined,
      speed: 8 * pm,
    });
    life.step(0.1, undefined, undefined, undefined, undefined, () => true);
    expect(m.v).toBe(0);
    expect(life.motionStats.hardCaps).toBe(0);
    expect(m.dir).toBe(1);
  });
  it('slows before a two-way dead-end U-turn with bounded braking', () => {
    const { life, m } = corner(false);
    Object.assign(m, {
      from: 1,
      d: 70 * pm,
      x: 1000 + 100 * pm,
      y: 1000 + 70 * pm,
      hx: 0,
      hy: 1,
      speed: 10 * pm,
      v: 10 * pm,
    });
    let previous = 10,
      turned = false;
    for (let frame = 0; frame < 200; frame++) {
      life.step(0.1, undefined, undefined, undefined, undefined, () => true);
      const v = m.v! / pm;
      expect(previous - v).toBeLessThanOrEqual(kinematicsOf('car').maxBrake * 0.1 + 1e-7);
      if (m.dir === -1) {
        expect(v).toBeLessThanOrEqual(1.3);
        turned = true;
        break;
      }
      previous = v;
    }
    expect(turned).toBe(true);
    expect(life.motionStats.hardCaps).toBe(0);
  });
  it('still brakes fast vehicles outside the ordinary terminal broad phase', () => {
    const { life, m } = corner(false);
    Object.assign(m, {
      from: 1,
      d: 20 * pm,
      x: 1000 + 100 * pm,
      y: 1000 + 20 * pm,
      hx: 0,
      hy: 1,
      speed: 30 * pm,
      v: 30 * pm,
    });
    life.step(0.1, undefined, undefined, undefined, undefined, () => true);
    expect(m.v! / pm).toBeLessThan(30);
    expect(30 - m.v! / pm).toBeLessThanOrEqual(kinematicsOf('car').maxBrake * 0.1 + 1e-7);
    expect(life.motionStats.hardCaps).toBe(0);
  });
  it('brakes for a leader approaching the lane from the curb before footprints touch', () => {
    const { life, m } = corner(false);
    life.geo.widths[0] = 14;
    m.speed = m.v = 8 * pm;
    const leader = { ...m, d: m.d + 14 * pm, x: m.x + 14 * pm, v: 0, speed: 0 };
    life.movers.push(leader);
    const offset = vi
      .spyOn(life.scenes, 'offset')
      .mockImplementation((owner, normal) => (owner === leader ? 6 : normal));
    const curb = vi.spyOn(life.scenes, 'hasCurbScenes', 'get').mockReturnValue(true);
    const merging = vi
      .spyOn(life.scenes, 'merging')
      .mockImplementation((owner) => owner === leader);
    try {
      life.step(0.1);
    } finally {
      offset.mockRestore();
      curb.mockRestore();
      merging.mockRestore();
    }
    expect(m.v / pm).toBeLessThan(8);
    expect(8 - m.v / pm).toBeLessThanOrEqual(kinematicsOf('car').maxBrake * 0.1 + 1e-7);
    expect(life.motionStats.hardCaps).toBe(0);
  });
  for (const split of [false, true])
    it(`keeps pose and clearance continuous across ${split ? 'line ends' : 'interior bends'}`, () => {
      const { life, m } = corner(split);
      let previous = life.pose(m);
      for (let i = 0; i < 800; i++) {
        life.step(0.05);
        const before = structuredClone(m);
        const p = life.pose(m);
        expect(Math.hypot(p.x - previous.x, p.y - previous.y) / pm).toBeLessThanOrEqual(
          1.5 * 0.05 + 1e-6,
        );
        const body = life.groundBodies(m)[0]!;
        expect(body.x).toBeCloseTo(p.x / pm, 10);
        expect(body.y).toBeCloseTo(p.y / pm, 10);
        expect(body.hx).toBe(p.hx);
        expect(body.hy).toBe(p.hy);
        expect(m).toEqual(before);
        previous = p;
      }
    });

  it('brakes before the curve and respects its lateral speed at the midpoint', () => {
    const { life, m } = corner(true);
    m.d = 40 * pm;
    m.x = 1000 + m.d;
    m.speed = m.v = 15 * pm;
    for (let i = 0; i < 1000 && m.line === 0; i++) life.step(0.01);
    // 8m road, inner lane 2m: R = 10 - 2 = 8m.
    expect(m.line).toBe(1);
    expect(m.v / pm).toBeLessThanOrEqual(Math.sqrt(2.5 * 8) + 0.03);
  });

  it('holds its heading at a disconnected one-way exit, even when already past the setback', () => {
    const { life, m } = corner(true);
    life.geo.oneway![0] = 1;
    life.geo.oneway![1] = -1;
    m.d = 99.99 * pm;
    m.x = 1000 + m.d;
    for (let i = 0; i < 100; i++) life.step(0.1);
    expect(m.line).toBe(0);
    expect(m.dir).toBe(1);
    expect(m.d / pm).toBeCloseTo(99.99);
    expect(m.v).toBe(0);
    expect(Number.isFinite(m.x + m.y + m.hx + m.hy)).toBe(true);
    expect(m.routing?.turns ?? 0).toBe(0);
  });

  for (const vehicle of ['car', 'bicycle'] as const)
    for (const dir of [-1, 1] as const)
      it(`brakes and holds ${vehicle} in ${dir} one-way flow at a clipped endpoint`, () => {
        const b = new LifeBuilder();
        b.line(
          [
            { x: -100, y: 1000 },
            { x: 4300, y: 1000 },
          ],
          LifeLine.roadMinor,
          8,
          1,
          dir,
        );
        const life = new TileLife(tile, b.finish(), 4);
        life.movers.length = life.parked.length = life.stalls.length = 0;
        life.scenes.sites.length = 0;
        const { m } = corner(true);
        Object.assign(m, {
          vehicle,
          dir,
          from: dir === 1 ? 0 : 1,
          d: 0,
          x: dir === 1 ? -100 : 4300,
          hx: dir,
          speed: 10 * pm,
          v: 10 * pm,
        });
        life.movers.push(m);
        let previous = m.x;
        let braking = false;
        for (let i = 0; i < 1200; i++) {
          life.step(0.1);
          expect(m.dir).toBe(dir);
          expect((m.x - previous) * dir).toBeGreaterThanOrEqual(-1e-8);
          expect(Number.isFinite(m.x + m.y + m.hx + m.hy)).toBe(true);
          if (m.v! > 0 && m.v! < 9 * pm) braking = true;
          previous = m.x;
        }
        expect(braking).toBe(true);
        expect(m.v! / pm).toBeLessThan(0.001);
        const front = VEHICLES[vehicle].length / 2;
        expect((dir === 1 ? 4300 - m.x : m.x + 100) / pm).toBeGreaterThanOrEqual(
          front + FOLLOW.minGap - 1e-6,
        );
      });

  it('never reverses one-way vehicles while retrying obstructed initial placement', () => {
    const b = new LifeBuilder();
    b.line(
      [
        { x: 1000, y: 1000 },
        { x: 1200, y: 1000 },
      ],
      LifeLine.roadMinor,
      8,
      1,
      -1,
    );
    const life = new TileLife(tile, b.finish(), 7);
    const { m } = corner(true);
    Object.assign(m, { from: 1, dir: -1, d: 190, x: 1010, hx: -1 });
    life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
    life.movers.push(m);
    let checks = 0;
    life.settleGround((owner) => {
      if (owner === m) {
        checks++;
        expect(m.dir).toBe(-1);
        expect(Number.isFinite(m.x)).toBe(true);
      }
      return false;
    });
    expect(checks).toBeGreaterThan(1);
    expect(life.movers).toHaveLength(0);
  });

  for (const dir of [-1, 1] as const)
    it(`rejects a bus settlement overlapping a different-road T box in ${dir} flow`, () => {
      const b = new LifeBuilder();
      b.line(
        dir === 1
          ? [
              { x: 1000, y: 2000 },
              { x: 2000, y: 2000 },
            ]
          : [
              { x: 2000, y: 2000 },
              { x: 3000, y: 2000 },
            ],
        LifeLine.roadMid,
        8,
        77,
        dir,
      );
      b.line(
        [
          { x: 2000, y: 1000 },
          { x: 2000, y: 2000 },
          { x: 2000, y: 3000 },
        ],
        LifeLine.roadMinor,
        6,
        88,
      );
      b.splitRoadJunctions(pm, 40);
      const life = new TileLife(tile, b.finish(), 7);
      const { m } = corner(true);
      Object.assign(m, {
        vehicle: 'bus',
        line: 0,
        from: dir === 1 ? 0 : 1,
        dir,
        d: 1000 - 8 * pm,
        x: 2000 - dir * 8 * pm,
        y: 2000,
        hx: dir,
        hy: 0,
      });
      life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
      life.movers.push(m);
      const setback = VEHICLES.bus.length / 2 + FOLLOW.minGap;
      life.settleGround((owner) => {
        expect(m.dir).toBe(dir);
        return owner === m && ((2000 - m.x) * dir) / pm <= setback + 1e-6;
      });
      expect(life.movers).toEqual([]);
      expect(m.line).toBe(0);
      expect(((2000 - m.x) * dir) / pm).toBeCloseTo(setback, 6);
      expect(m.routing?.turns ?? 0).toBe(0);
    });

  for (const dir of [-1, 1] as const)
    for (const oneway of [false, true])
      it(`settles across an original-line split in ${dir} ${oneway ? 'one-way' : 'two-way'} flow`, () => {
        const b = new LifeBuilder();
        b.line(
          [
            { x: 1000, y: 2000 },
            { x: 2000, y: 2000 },
            { x: 3000, y: 2000 },
          ],
          LifeLine.roadMid,
          8,
          77,
          oneway ? dir : 0,
        );
        b.line(
          [
            { x: 2000, y: 1000 },
            { x: 2000, y: 2000 },
            { x: 2000, y: 3000 },
          ],
          LifeLine.roadMinor,
          6,
          88,
        );
        b.splitRoadJunctions(pm, 40);
        const life = new TileLife(tile, b.finish(), 7);
        const { m } = corner(true);
        const line = dir === 1 ? 0 : 1;
        Object.assign(m, {
          line,
          from: dir === 1 ? life.geo.starts[line] : life.geo.starts[line + 1]! - 1,
          dir,
          d: 1000 - pm,
          x: 2000 - dir * pm,
          y: 2000,
          hx: dir,
          hy: 0,
        });
        life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
        life.movers.push(m);
        life.settleGround((owner) => {
          expect(m.dir).toBe(dir);
          return owner === m && (m.x - 2000) * dir > pm;
        });
        expect(life.movers).toEqual([m]);
        expect(m.line).toBe(dir === 1 ? 1 : 0);
        expect(m.routing?.turns ?? 0).toBe(0);
        expect(m.routing?.signal).toBeUndefined();
      });

  it('still turns around at a two-way dead end', () => {
    const { life, m } = corner(false);
    m.from = 1;
    m.d = 99.99 * pm;
    life.step(0.1);
    expect(m.dir).toBe(-1);
  });

  it('keeps one-way state intact through rejected movement and shorter collision retries', () => {
    const { life, m } = corner(true);
    life.geo.oneway![0] = 1;
    life.geo.oneway![1] = -1;
    m.d = 90 * pm;
    m.x = 1000 + m.d;
    m.speed = m.v = 20 * pm;
    let trials = 0;
    for (let frame = 0; frame < 10; frame++)
      life.step(0.1, undefined, undefined, undefined, undefined, (owner) => {
        if (owner === m) {
          trials++;
          expect(m.dir).toBe(1);
          expect(Number.isFinite(m.x + m.y + m.hx + m.hy)).toBe(true);
        }
        return false;
      });
    expect(trials).toBeGreaterThan(10);
    expect(m.d / pm).toBeCloseTo(90);
    expect(m.dir).toBe(1);
    expect(m.v).toBe(0);
    expect(m.routing?.turns ?? 0).toBe(0);
  });
  it('keeps vehicles in legal flow for 120 seconds on a connected one-way loop', () => {
    const b = new LifeBuilder();
    const points = [
      { x: 800, y: 800 },
      { x: 3000, y: 800 },
      { x: 3000, y: 3000 },
      { x: 800, y: 3000 },
    ];
    for (let i = 0; i < 4; i++) b.line([points[i]!, points[(i + 1) % 4]!], LifeLine.roadMajor, 12);
    const geo = b.finish();
    geo.oneway!.fill(1);
    const life = new TileLife(tile, geo, 3);
    life.parked.length = life.stalls.length = 0;
    // Keep at most twelve original seeded vehicles spread across the population for this 120 s flow check.
    const vehicles = life.movers.filter((m) => m.kind === 'vehicle');
    const stride = Math.max(1, Math.ceil(vehicles.length / 12));
    life.movers.splice(0, life.movers.length, ...vehicles.filter((_, i) => i % stride === 0));
    for (let frame = 0; frame < 120 * 30; frame++) {
      life.step(1 / 30);
      for (const m of life.movers) if (m.kind === 'vehicle') assert.equal(m.dir, 1);
    }
  });
  it('queues behind a leader on the planned exit without compressing the bumper gap', () => {
    const { life, m } = corner(true);
    m.d = 90 * pm;
    m.x = 1000 + m.d;
    m.speed = m.v = 10 * pm;
    const leader: Mover = {
      ...m,
      line: 1,
      from: 2,
      d: 10 * pm,
      x: 1000 + 100 * pm,
      y: 1000 + 10 * pm,
      hx: 0,
      hy: 1,
      speed: 0,
      v: 0,
    };
    life.movers.push(leader);
    for (let frame = 0; frame < 600; frame++) {
      life.step(0.1);
      const separation = m.line === 0 ? 100 + leader.d / pm - m.d / pm : (leader.d - m.d) / pm;
      expect(separation - 4.4).toBeGreaterThanOrEqual(FOLLOW.minGap - 1e-6);
    }
  });
});

describe('crossroads traffic', () => {
  it('retains a human-blocked physical occupant beyond holdMax and releases all approaches', () => {
    const b = new LifeBuilder(),
      cx = 2048,
      cy = 2048;
    b.line(
      [
        { x: 0, y: cy },
        { x: cx, y: cy },
        { x: 4096, y: cy },
      ],
      LifeLine.roadMajor,
      14,
    );
    b.line(
      [
        { x: cx, y: 0 },
        { x: cx, y: cy },
        { x: cx, y: 4096 },
      ],
      LifeLine.roadMajor,
      14,
    );
    const stripe = cx + 3 * pm;
    b.line(
      [
        { x: stripe, y: cy - 12 * pm },
        { x: stripe, y: cy + 12 * pm },
      ],
      LifeLine.path,
      3,
    );
    b.area('crossing', [
      [
        { x: stripe - 1.5 * pm, y: cy - 7 * pm },
        { x: stripe + 1.5 * pm, y: cy - 7 * pm },
        { x: stripe + 1.5 * pm, y: cy + 7 * pm },
        { x: stripe - 1.5 * pm, y: cy + 7 * pm },
      ],
    ]);
    const world = new LifeWorld();
    world.sync([{ key: 'human-junction', tile, life: b.finish() }]);
    const life = worldTiles(world).get('human-junction')!;
    // This junction-hold fixture needs a stationary human rather than a spontaneous runner.
    (life as unknown as { runRng: () => number }).runRng = () => 1;
    life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
    life.scenes.sites.length = 0;
    const car: Mover = {
      kind: 'vehicle',
      vehicle: 'car',
      line: 0,
      from: 0,
      dir: 1,
      d: cx - 5 * pm,
      x: cx - 5 * pm,
      y: cy,
      hx: 1,
      hy: 0,
      speed: 2 * pm,
      v: 2 * pm,
      paint: 0,
      lane: 0,
      pause: 0,
      rank: 0,
    };
    const waiter: Mover = {
      ...car,
      line: 1,
      from: 3,
      d: cy - 20 * pm,
      x: cx,
      y: cy - 20 * pm,
      hx: 0,
      hy: 1,
      v: 0,
    };
    life.movers.push(car, waiter);
    world.step(0.1, undefined, 18);
    const table = (world as unknown as { junctions: JunctionTable }).junctions;
    expect(table.snapshot().find((r) => r.index === 0)?.inside).toBe(true);
    const human: Mover = {
      ...car,
      kind: 'person',
      vehicle: undefined,
      line: 2,
      from: 6,
      d: (12 + life.offsetOf(car)) * pm,
      x: stripe,
      y: cy + life.offsetOf(car) * pm,
      hx: 0,
      hy: 1,
      speed: 0,
      v: undefined,
      pause: 100,
      group: [{ figure: 'adult', shirt: 3, umbrella: 0, canopy: 0, lateral: 0, back: 0, step: 0 }],
    };
    life.movers.push(human);
    for (let i = 0; i < (JUNCTION.holdMax + 2) * 10; i++) {
      world.step(0.1, undefined, 18, undefined, undefined, undefined, 0.9);
      expect(table.granted(car)).toBe(true);
      expect(table.granted(waiter)).toBe(false);
    }
    expect(car.v).toBe(0);
    expect(table.snapshot().find((r) => r.index === 1)).toMatchObject({
      ready: true,
      inside: false,
    });
    expect(waiter.v! / pm).toBeCloseTo(0, 6);
    const pending = table.movement(waiter);
    if (!pending) throw new Error('Expected a ready waiter at the stop line');
    expect(Math.abs(pending.ahead / pm)).toBeLessThan(0.01);
    life.movers.splice(life.movers.indexOf(human), 1);
    for (let i = 0; i < 180; i++) world.step(0.1, undefined, 18);
    expect(car.x).toBeGreaterThan(cx + 20 * pm);
    expect(waiter.y).toBeGreaterThan(cy + 10 * pm);
  });
});

checkCrossroads('original', 0);
