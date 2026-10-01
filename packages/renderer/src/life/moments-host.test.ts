import { describe, expect, it } from 'vitest';
import { MomentHost } from './moments-host';
import { LifeBuilder, LifeLine } from './geometry';
import { TileLife, type Gatherer, type Mover } from './simulate';
import { metersPerUnit } from '../raster/geometry';

const tileId = { z: 16, x: 55192, y: 30266 };
const pm = 1 / metersPerUnit(tileId);
function tile() {
  const b = new LifeBuilder();
  b.line(
    [
      { x: 100, y: 1000 },
      { x: 4000, y: 1000 },
    ],
    LifeLine.path,
  );
  b.place({ x: 1000, y: 1000 }, 'monument', 2 * pm);
  return new TileLife(tileId, b.finish(), 5);
}
function walkers(t: TileLife, separation = 2.5) {
  const exemplar = t.movers.find((m) => m.kind === 'person')!;
  const member = {
    figure: 'adult' as const,
    shirt: 2,
    umbrella: 1,
    canopy: 0,
    lateral: 0,
    back: 0,
    step: 0 as const,
  };
  const a: Mover = { ...exemplar, x: 1000, y: 1000, hx: 1, hy: 0, rank: 0, group: [member] };
  const b: Mover = { ...a, x: a.x + separation * pm, hx: -1, group: [{ ...member }] };
  t.movers.splice(0, t.movers.length, a, b);
  t.gatherers.length = 0;
  return [a, b] as const;
}

describe('moment admission adapter', () => {
  it('admits singleton groups and rejects missing or multiple physical members', () => {
    for (const count of [0, 1, 2]) {
      const t = tile(),
        [a] = walkers(t);
      a.group = Array.from({ length: count }, () => ({ ...a.group![0]! }));
      const host = new MomentHost(t, 5, { rng: () => 0 });
      for (let i = 0; i < 20; i++) host.step(0.1, 21, { rain: 0 }, undefined, undefined, 0.2, 1.8);
      expect(host.moments.stats.started.greet).toBe(count === 1 ? 1 : 0);
    }
  });
  it('rejects invisible activity, outside bounds and reserved walkers', () => {
    const t = tile(),
      [a] = walkers(t);
    const host = new MomentHost(t, 5, { rng: () => 0 });
    host.step(1, 21, { rain: 0 }, () => false, undefined, 0.2, 1.8);
    expect(host.moments.busy(a)).toBe(false);
    t.setIdleGuard(() => false);
    host.step(1, 21, { rain: 0 }, undefined, undefined, 0.2, 1.8);
    expect(host.moments.busy(a)).toBe(false);
  });
  it('checks anisotropic cell sizes including possible umbrella footprints', () => {
    for (const [width, aspect, expected] of [
      [0.2, 1.8, 1],
      [0.2, 5, 0],
      [1, 1.8, 0],
    ]) {
      const t = tile();
      walkers(t, 2.5);
      const host = new MomentHost(t, 5, { rng: () => 0 });
      for (let i = 0; i < 20; i++)
        host.step(0.1, 21, { rain: 0 }, undefined, undefined, width!, aspect!);
      expect(host.moments.stats.started.greet).toBe(expected);
    }
  });
  it('restores previous facing on a rejected admission and preserves route and detour', () => {
    const t = tile(),
      [a] = walkers(t);
    a.avoid = 0.7;
    const before = structuredClone(a);
    const host = new MomentHost(t, 5, { rng: () => 0 });
    host.step(0.1, 21, { rain: 0 }, undefined, () => false, 0.2, 1.8);
    expect(a).toEqual(before);
    expect(host.moments.stats.started.greet).toBe(0);
  });
  it('keeps a release pending when terrain rejects the navigation heading', () => {
    const t = tile(),
      [a] = walkers(t);
    const facing = a as Mover & { momentFacing?: { hx: number; hy: number } };
    facing.momentFacing = { hx: 0, hy: 1 };
    const host = new MomentHost(t, 5);
    host.release(facing, () => false);
    expect(facing.momentFacing).toEqual({ hx: 0, hy: 1 });
    host.release(facing, () => true);
    expect(facing.momentFacing).toBeUndefined();
    expect([a.hx, a.hy]).toEqual([1, 0]);
  });
  it('faces paused monument visitors and keeps their target intact', () => {
    const t = tile(),
      g = t.gatherers[0]!;
    g.pause = 5;
    const before = { x: g.x, y: g.y, tx: g.tx, ty: g.ty };
    const host = new MomentHost(t, 5);
    host.attend(g);
    const facing = (g as Gatherer & { momentFacing: { hx: number; hy: number } }).momentFacing;
    expect(Math.hypot(facing.hx, facing.hy)).toBeCloseTo(1, 10);
    expect(facing.hx * (g.cx - g.x) + facing.hy * (g.cy - g.y)).toBeGreaterThan(0);
    expect({ x: g.x, y: g.y, tx: g.tx, ty: g.ty }).toEqual(before);
  });
});
