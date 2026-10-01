import { describe, expect, it } from 'vitest';
import { LifeWorld, type LifeTile } from './simulate';
import { continuityTile, continuityMover, left, right, parent } from './testing/continuity';
import { worldTiles } from './testing/scenarios';
import { LifeBuilder, LifeLine } from './geometry';
import { frameBetween } from './frames';
import { seamAhead } from './seams';
import { activityLevels } from './config';

function fixture(entries: LifeTile[]) {
  const world = new LifeWorld({ road_major: { car: 1 } });
  world.sync(entries);
  for (const life of worldTiles(world).values()) life.movers.splice(0);
  world.visible(18, activityLevels(1), [123, 13]);
  return { world, lives: [...worldTiles(world).values()] };
}

describe('runtime geographic seam handover', () => {
  it('crosses an exactly clipped west endpoint and continues through successive owners', () => {
    const a = continuityTile(left),
      b = continuityTile(right),
      c = continuityTile({ ...right, x: right.x + 1 });
    a.life.coords[0] = 0;
    b.life.coords[0] = 0;
    const { world, lives } = fixture([a, b, c]);
    const m = continuityMover(lives[1]!, 0.01);
    Object.assign(m, { from: 1, dir: -1, hx: -1, d: 4196 - m.x });
    lives[1]!.movers.push(m);
    for (let i = 0; i < 10 && lives[1]!.movers.includes(m); i++) world.step(0.1);
    expect(lives[0]!.movers).toContain(m);
    const through = continuityMover(lives[0]!, 4095);
    lives[0]!.movers.push(through);
    for (let frame = 0; frame < 1500; frame++) {
      world.step(0.1);
      expect(lives.filter((life) => life.movers.includes(through))).toHaveLength(1);
    }
    expect(lives[2]!.movers).toContain(through);
    expect(through.routing?.turns).toBe(7);
  });
  it('holds a motorboat before a canal and a rowboat before occupied water', () => {
    for (const motor of [true, false]) {
      const { world, lives } = fixture([
        continuityTile(left, LifeLine.river),
        continuityTile(right, LifeLine.canal),
      ]);
      const source = lives[0]!,
        target = lives[1]!,
        m = continuityMover(source, 4096 - 10 * source.perMeter, 'boat');
      if (motor) m.vehicle = 'motorboat';
      else {
        const blocker = continuityMover(target, 2, 'boat');
        blocker.speed = 0;
        blocker.v = 0;
        target.movers.push(blocker);
      }
      source.movers.push(m);
      for (let i = 0; i < 100; i++) world.step(0.1);
      expect(source.movers).toContain(m);
      expect(m.x).toBeLessThan(4096);
      expect(m.v).toBeLessThan(0.01);
    }
  });
  for (const kind of [LifeLine.roadMajor, LifeLine.river, LifeLine.canal])
    for (const dir of [1, -1] as const)
      it(`preserves identity and steps once on ${kind}, direction ${dir}`, () => {
        const { world, lives } = fixture([continuityTile(left, kind), continuityTile(right, kind)]);
        const source = lives[dir === 1 ? 0 : 1]!,
          target = lives[dir === 1 ? 1 : 0]!;
        const m = continuityMover(
          source,
          dir === 1 ? 4095 : 1,
          kind === LifeLine.roadMajor ? 'vehicle' : 'boat',
        );
        if (dir === -1) {
          m.from = 1;
          m.d = 4196 - m.x;
          m.dir = -1;
          m.hx = -1;
        }
        source.movers.push(m);
        const old = { ...m },
          f = frameBetween(source.tile, target.tile);
        for (let i = 0; i < 10 && source.movers.includes(m); i++) world.step(0.1);
        expect(source.movers).not.toContain(m);
        expect(target.movers).toContain(m);
        expect(target.movers.filter((candidate) => candidate === m)).toHaveLength(1);
        expect(Math.abs(m.x - f.x - old.x * f.scale) / target.perMeter).toBeLessThan(2);
        expect([m.paint, m.lane, m.rank, m.vehicle]).toEqual([
          old.paint,
          old.lane,
          old.rank,
          old.vehicle,
        ]);
        expect(m.routing?.turns).toBe(old.routing?.turns);
        expect(m.speed / target.perMeter).toBeCloseTo(old.speed / source.perMeter);
        const x = m.x;
        world.step(0.1);
        expect((m.x - x) * dir).toBeGreaterThan(0);
      });

  it('brakes before unavailable, full, opposite one-way or occupied destinations and resumes safely', () => {
    for (const reason of ['missing', 'full', 'oneway', 'occupied'] as const) {
      const a = continuityTile(left),
        b = continuityTile(right, LifeLine.roadMajor, 77, 0, reason === 'oneway' ? -1 : 0);
      const { world, lives } = fixture(reason === 'missing' ? [a] : [a, b]);
      const source = lives[0]!,
        m = continuityMover(source, 4096 - 12 * source.perMeter);
      source.movers.push(m);
      const target = lives[1];
      if (reason === 'full')
        target!.movers.push(
          ...Array.from({ length: 600 }, () => ({ ...continuityMover(target!, 2000), rank: 1 })),
        );
      if (reason === 'occupied') {
        const blocker = continuityMover(target!, 2);
        blocker.speed = 0;
        blocker.v = 0;
        target!.movers.push(blocker);
      }
      for (let i = 0; i < 60; i++) world.step(0.1);
      expect(source.movers).toContain(m);
      expect(m.x).toBeLessThan(4096);
      expect(m.v).toBeLessThan(0.01);
      if (target) target.movers.splice(0);
      if (reason === 'missing') world.sync([a, b]);
      if (reason === 'oneway') target!.geo.oneway![0] = 0;
      for (let i = 0; i < 80 && source.movers.includes(m); i++) world.step(0.1);
      expect(source.movers).not.toContain(m);
      expect(
        [...worldTiles(world).values()].filter((life) => life.movers.includes(m)),
      ).toHaveLength(1);
    }
  });

  it('uses the finest half-open owner at a mixed-zoom boundary', () => {
    const { world, lives } = fixture([continuityTile(parent), continuityTile(right)]);
    const source = lives[0]!,
      target = lives[1]!,
      m = continuityMover(source, 2047);
    source.movers.push(m);
    for (let i = 0; i < 10 && source.movers.includes(m); i++) world.step(0.1);
    expect(source.movers).not.toContain(m);
    expect(target.movers).toContain(m);
  });

  it('finds a diagonal corner and a later segment without inventing a route turn', () => {
    const builder = new LifeBuilder();
    builder.line(
      [
        { x: 3800, y: 3800 },
        { x: 4000, y: 4000 },
        { x: 4200, y: 4200 },
      ],
      LifeLine.roadMajor,
      8,
      77,
    );
    const sourceEntry = { key: 'corner', tile: left, life: builder.finish() };
    const nextBuilder = new LifeBuilder();
    nextBuilder.line(
      [
        { x: -296, y: -296 },
        { x: 104, y: 104 },
      ],
      LifeLine.roadMajor,
      8,
      77,
    );
    const destEntry = {
      key: 'next',
      tile: { ...left, x: left.x + 1, y: left.y + 1 },
      life: nextBuilder.finish(),
    };
    const { world, lives } = fixture([sourceEntry, destEntry]);
    const source = lives[0]!,
      target = lives[1]!,
      m = continuityMover(source, 4095);
    Object.assign(m, {
      from: 1,
      d: 95 * Math.SQRT2,
      x: 4095,
      y: 4095,
      hx: Math.SQRT1_2,
      hy: Math.SQRT1_2,
    });
    source.movers.push(m);
    expect(seamAhead(source, m, [], 20 * source.perMeter)?.preview.x).toBeGreaterThan(4096);
    for (let i = 0; i < 20 && source.movers.includes(m); i++) world.step(0.1);
    expect(target.movers).toContain(m);
    expect(m.routing?.turns).toBe(7);
  });
});
