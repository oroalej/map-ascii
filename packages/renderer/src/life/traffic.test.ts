import { describe, expect, it } from 'vitest';
import { metersPerUnit } from '../raster/geometry';
import { LifeBuilder, LifeLine } from './geometry';
import { TileLife, type Mover } from './simulate';

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
    expect(m.v! / pm).toBeLessThanOrEqual(Math.sqrt(2.5 * 8) + 0.03);
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
});
