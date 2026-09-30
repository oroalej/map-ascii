import { describe, expect, it } from 'vitest';
import { metersPerUnit } from '../raster/geometry';
import { LifeBuilder, LifeLine } from './geometry';
import { TileLife, LifeWorld, type Mover } from './simulate';
import { compatible, type JunctionTable } from './junctions';
import { FOLLOW } from './config';
import { worldTiles } from './testing/scenarios';

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

  it('retains the no-legal-exit one-way U-turn exception', () => {
    const { life, m } = corner(true);
    life.geo.oneway![0] = 1;
    life.geo.oneway![1] = -1;
    m.d = 99.99 * pm;
    m.x = 1000 + m.d;
    life.step(0.1);
    expect(m.line).toBe(0);
    expect(m.dir).toBe(-1); // Exactly one fallback at the deliberately unconnected flow.
    expect(m.routing?.turns).toBe(1);
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
    for (let frame = 0; frame < 120 * 30; frame++) {
      life.step(1 / 30);
      for (const m of life.movers) if (m.kind === 'vehicle') expect(m.dir).toBe(1);
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
  it('clears every arm with compatible holds, safe stops and bounded waits over 180 seconds', () => {
    const b = new LifeBuilder();
    const center = { x: 2048, y: 2048 };
    for (const [dx, dy] of [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
    ])
      b.line(
        [center, { x: center.x + dx! * 220 * pm, y: center.y + dy! * 220 * pm }],
        LifeLine.roadMajor,
        12,
      );
    const world = new LifeWorld();
    world.sync([{ key: 'cross', tile, life: b.finish() }]);
    const life = worldTiles(world).get('cross')!;
    life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
    life.scenes.sites.length = 0;
    for (let arm = 0; arm < 4; arm++)
      for (let n = 0; n < 3; n++) {
        const angle = (arm * Math.PI) / 2,
          hx = -Math.cos(angle),
          hy = -Math.sin(angle);
        const remaining = 35 + 28 * n;
        life.movers.push({
          kind: 'vehicle',
          vehicle: 'car',
          line: arm,
          from: arm * 2 + 1,
          dir: -1,
          d: (220 - remaining) * pm,
          x: 2048 - hx * remaining * pm,
          y: 2048 - hy * remaining * pm,
          hx,
          hy,
          speed: 8 * pm,
          v: 8 * pm,
          paint: 0,
          lane: 0,
          pause: 0,
          rank: 0,
        });
      }
    const table = (world as unknown as { junctions: JunctionTable }).junctions;
    const crossed = new Set<number>();
    let maxWait = 0;
    for (let frame = 0; frame < 180 * 30; frame++) {
      const before = life.movers.map((m) => ({
        line: m.line,
        turns: m.routing?.turns ?? 0,
        movement: table.movement(m),
        granted: table.granted(m),
      }));
      world.step(1 / 30, undefined, 18);
      const holders = table.snapshot().filter((r) => r.since !== undefined);
      for (let a = 0; a < holders.length; a++)
        for (let c = a + 1; c < holders.length; c++)
          expect(compatible(holders[a]!.movement, holders[c]!.movement)).toBe(true);
      for (let i = 0; i < life.movers.length; i++) {
        const m = life.movers[i]!;
        maxWait = Math.max(maxWait, table.waited(m));
        if ((m.routing?.turns ?? 0) > before[i]!.turns) crossed.add(before[i]!.line);
        const move = table.movement(m);
        if (
          move &&
          !table.granted(m) &&
          move.ahead >= 0 &&
          m.line === move.line &&
          m.dir === move.dir
        ) {
          const distance = Math.hypot(m.x - center.x, m.y - center.y);
          expect(distance / pm).toBeGreaterThanOrEqual(
            move.junction.radius / pm + 1.5 + 2.2 - 0.05,
          );
        }
        // Same lane cars never compress a queued leader's bumper gap.
        for (let j = i + 1; j < life.movers.length; j++) {
          const other = life.movers[j]!;
          if (other.line === m.line && other.dir === m.dir)
            expect(Math.abs(other.d - m.d) / pm - 4.4).toBeGreaterThanOrEqual(FOLLOW.minGap - 1e-6);
        }
      }
      if ((frame + 1) % (60 * 30) === 0) {
        expect(crossed.size).toBe(4);
        crossed.clear();
      }
    }
    expect(maxWait).toBeLessThanOrEqual(50);
  }, 30000);
});
