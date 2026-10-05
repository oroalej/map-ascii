import { describe, expect, it, vi } from 'vitest';
import { LifeWorld, type LifeTile, type Mover } from './simulate';
import { continuityTile, continuityMover, left, right, parent } from './testing/continuity';
import { worldTiles } from './testing/scenarios';
import { LifeBuilder, LifeLine } from './geometry';
import { frameBetween } from './frames';
import { seamAhead, SEAMS } from './seams';
import { activityLevels, MAX_TILE_AGENTS, SIGNAL } from './config';
import { signalState } from './signals';
import { metersPerUnit } from '../raster/geometry';
import { VEHICLES } from './vehicles';

function fixture(entries: LifeTile[]) {
  const world = new LifeWorld({ road_major: { car: 1 } });
  world.sync(entries);
  for (const life of worldTiles(world).values()) life.movers.splice(0);
  world.visible(18, activityLevels(1), [123, 13]);
  return { world, lives: [...worldTiles(world).values()] };
}

describe('runtime geographic seam handover', () => {
  it.each([1, -1] as const)(
    'projects a quantized oblique seam into its destination footprint (direction %s)',
    (dir) => {
      const b = new LifeBuilder();
      b.line(
        [
          { x: 1000, y: 0 },
          { x: 1500, y: 4096 },
        ],
        LifeLine.roadMajor,
        6,
        77,
        dir,
      );
      const n = new LifeBuilder(),
        base = 1000 + 500 * dir + 1;
      n.line(
        [
          { x: base - (500 * 100) / 4096, y: -100 },
          { x: base, y: 0 },
          { x: base + 500, y: 4096 },
          { x: base + 500 + (500 * 100) / 4096, y: 4196 },
        ],
        LifeLine.roadMajor,
        6,
        77,
        dir,
      );
      const { world, lives } = fixture([
        { key: 'source', tile: left, life: b.finish() },
        { key: 'target', tile: { ...left, y: left.y + dir }, life: n.finish() },
      ]);
      const source = lives[0]!,
        target = lives[1]!,
        length = Math.hypot(500, 4096),
        m = continuityMover(source, 0);
      const gap = 0.004 * source.perMeter,
        hx = (dir * 500) / length,
        hy = (dir * 4096) / length;
      Object.assign(m, {
        from: dir === 1 ? 0 : 1,
        dir,
        d: length - gap,
        hx,
        hy,
        v: 0,
        x: (dir === 1 ? 1500 : 1000) - hx * gap,
        y: (dir === 1 ? 4096 : 0) - hy * gap,
      });
      source.movers.push(m);
      for (let i = 0; i < 30 && source.movers.includes(m); i++) world.step(1 / 30);
      expect(target.movers).toContain(m);
      expect(source.movers).not.toContain(m);
      expect(m.dir).toBe(dir);
      expect(m.routing?.turns).toBe(7);
      const start = target.pose(m);
      for (let frame = 0; frame < 120; frame++) {
        const before = target.pose(m);
        world.step(1 / 30);
        const after = target.pose(m);
        expect(Math.hypot(after.x - before.x, after.y - before.y) / target.perMeter).toBeLessThan(
          0.5,
        );
        expect(lives.filter((life) => life.movers.includes(m))).toHaveLength(1);
        expect(m.dir).toBe(dir);
        expect(m.routing?.turns).toBe(7);
      }
      expect(
        Math.hypot(target.pose(m).x - start.x, target.pose(m).y - start.y) / target.perMeter,
      ).toBeGreaterThan(VEHICLES.car.length);
    },
  );
  it.each([false, true])(
    'checks physical continuity at an inflated seam (physical obstruction %s)',
    (physical) => {
      const pm = 1 / metersPerUnit(right),
        b = new LifeBuilder();
      b.line(
        [
          { x: -100, y: 2000 },
          { x: 4196, y: 2000 },
        ],
        LifeLine.roadMajor,
        6,
        77,
        1,
      );
      const x = (physical ? 1 : 3.1) * pm;
      b.area('blocked', [
        [
          { x, y: 2000 - 5 * pm },
          { x: x + pm, y: 2000 - 5 * pm },
          { x: x + pm, y: 2000 + 5 * pm },
          { x, y: 2000 + 5 * pm },
          { x, y: 2000 - 5 * pm },
        ],
      ]);
      const { world, lives } = fixture([
        continuityTile(left, LifeLine.roadMajor, 77, 0, 1),
        { key: 'target', tile: right, life: b.finish() },
      ]);
      const source = lives[0]!,
        target = lives[1]!,
        m = continuityMover(source, 4096 - 0.002 * source.perMeter);
      m.v = 0;
      source.movers.push(m);
      for (let i = 0; i < 10 && source.movers.includes(m); i++)
        world.step(1 / 30, undefined, 17, undefined, undefined, undefined, 7);
      expect(target.movers.includes(m)).toBe(!physical);
      expect(source.movers.includes(m)).toBe(physical);
      expect(m.dir).toBe(1);
      expect(m.routing?.turns).toBe(7);
    },
  );
  it.each([1, -1] as const)(
    'finishes a slow oblique clipped handover in direction %s without rolling back short of the edge',
    (dir) => {
      const geometry = (x: number) => {
        const b = new LifeBuilder();
        b.line(
          [
            { x, y: 0 },
            { x: x + 500, y: 4096 },
          ],
          LifeLine.roadMajor,
          6,
          77,
          dir,
        );
        return b.finish();
      };
      const { world, lives } = fixture([
        { key: 'source', tile: left, life: geometry(1000) },
        { key: 'target', tile: { ...left, y: left.y + dir }, life: geometry(1000 + 500 * dir) },
      ]);
      const source = lives[0]!,
        target = lives[1]!,
        length = Math.hypot(500, 4096),
        gap = 0.004 * source.perMeter;
      const hx = (dir * 500) / length,
        hy = (dir * 4096) / length;
      const m = continuityMover(source, 0);
      Object.assign(m, {
        from: dir === 1 ? 0 : 1,
        dir,
        d: length - gap,
        x: (dir === 1 ? 1500 : 1000) - hx * gap,
        y: (dir === 1 ? 4096 : 0) - hy * gap,
        hx,
        hy,
        v: 0,
      });
      source.movers.push(m);
      for (let frame = 0; frame < 20 && source.movers.includes(m); frame++) world.step(1 / 30);
      expect(target.movers).toContain(m);
      expect(source.movers).not.toContain(m);
      expect(m.dir).toBe(dir);
      expect(m.routing?.turns).toBe(7);
      const before = { x: m.x, y: m.y };
      world.step(1 / 30);
      expect((m.y - before.y) * dir).toBeGreaterThan(0);
    },
  );

  it('preserves a checked lane offset and physical pose through a tile handover', () => {
    const { world, lives } = fixture([continuityTile(left), continuityTile(right)]);
    const source = lives[0]!,
      target = lives[1]!;
    const m = continuityMover(source, 4095);
    m.roadShift = -1;
    source.movers.push(m);
    const old = source.pose(m),
      frame = frameBetween(source.tile, target.tile);
    const preview = target.projectFrom(m, source);
    expect(preview?.roadShift).toBe(-1);
    expect(m.roadShift).toBe(-1);
    expect(target.pose(preview!).y).toBeCloseTo(frame.y + old.y * frame.scale);
    for (let i = 0; i < 10 && source.movers.includes(m); i++) world.step(0.1);
    expect(target.movers).toContain(m);
    expect(m.roadShift).toBe(-1);
    const before = target.pose(m);
    world.step(0.1);
    const after = target.pose(m);
    expect(after.x).toBeGreaterThan(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

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
    for (let frame = 0; frame < 1500 && !lives[2]!.movers.includes(through); frame++) {
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
      for (let i = 0; i < (reason === 'missing' ? 20 : 60); i++) world.step(0.1);
      expect(source.movers).toContain(m);
      expect(m.x).toBeLessThan(4096);
      expect(m.v).toBeLessThan(reason === 'missing' ? 3 * source.perMeter : 0.01);
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

it.each(['vehicle', 'boat'] as const)(
  'lets a %s turn at a permanently missing outer neighbor',
  (kind) => {
    const { world, lives } = fixture([
      continuityTile(left, kind === 'boat' ? LifeLine.river : LifeLine.roadMajor),
    ]);
    const source = lives[0]!,
      mover = continuityMover(source, 4096 - 12 * source.perMeter, kind);
    source.movers.push(mover);
    for (let frame = 0; frame < 600 && mover.dir === 1; frame++) world.step(0.1);
    expect(source.elapsed).toBeGreaterThanOrEqual(SEAMS.missingSeconds);
    expect(mover.dir).toBe(-1);
    expect(source.movers).toContain(mover);
  },
);
it('keeps one-way endpoint restrictions after a missing-owner timeout', () => {
  const { world, lives } = fixture([continuityTile(left, LifeLine.roadMajor, 77, 0, 1)]);
  const source = lives[0]!,
    mover = continuityMover(source, 4096 - 12 * source.perMeter);
  source.movers.push(mover);
  for (let frame = 0; frame < 600; frame++) world.step(0.1);
  expect(mover.dir).toBe(1);
  expect(mover.v).toBeLessThan(0.01);
});

it.each(['quota', 'projection', 'final'] as const)(
  'recovers a two-way vehicle after repeated %s rejection without transferring ownership',
  (reason) => {
    const { world, lives } = fixture([
      continuityTile(left),
      continuityTile(right, reason === 'projection' ? LifeLine.path : LifeLine.roadMajor),
    ]);
    const source = lives[0]!,
      target = lives[1]!;
    for (const life of lives) life.parked.length = life.stalls.length = life.gatherers.length = 0;
    if (reason === 'quota')
      target.movers.push(
        ...Array<Mover>(MAX_TILE_AGENTS).fill({
          ...continuityMover(target, 20),
          kind: 'train',
          rank: 1,
          vehicle: undefined,
        }),
      );
    if (reason === 'final') vi.spyOn(target, 'adoptFrom').mockReturnValue(false);
    const m = continuityMover(source, 4095);
    source.movers.push(m);
    const before = { ...m };
    for (let frame = 0; frame < 100 && m.dir === 1; frame++) world.step(0.1);
    expect(m.dir).toBe(-1);
    expect(source.movers).toContain(m);
    expect(target.movers).not.toContain(m);
    expect(m.x).toBeLessThan(4096);
    expect(m.routing?.seed).toBe(before.routing?.seed);
    expect(m.routing?.turns).toBe(before.routing?.turns);
    expect(source.elapsed).toBeGreaterThanOrEqual(SEAMS.rejectedSeconds);
    expect(source.elapsed).toBeLessThan(10);
  },
);

it('keeps a queued seam recovery frozen during an active service hold', () => {
  const { world, lives } = fixture([continuityTile(left), continuityTile(right, LifeLine.path)]);
  const source = lives[0]!,
    m = continuityMover(source, 4095);
  for (const life of lives) life.parked.length = life.stalls.length = life.gatherers.length = 0;
  source.movers.push(m);
  source.scenes.services.set(m, {
    site: {
      x: m.x,
      y: m.y,
      kind: 'stop',
      modes: 7,
      covered: false,
      queue: [],
      capacity: 4,
      hx: 1,
      hy: 0,
      road: 0,
      roadWidth: 6,
      direction: 1,
    },
    time: 10,
    boarded: 0,
    arriving: false,
  });
  const history = { key: 'pending', seconds: 8, at: 0, queued: true };
  (world as unknown as { rejectedSeams: WeakMap<Mover, typeof history> }).rejectedSeams.set(
    m,
    history,
  );
  world.step(0.1);
  expect(m.dir).toBe(1);
  expect(m.x).toBe(4095);
  expect(source.scenes.services.get(m)?.time).toBeCloseTo(9.9);
  expect(history.seconds).toBe(8);
});

it('keeps a queued seam recovery frozen at a red signal', () => {
  const pm = 1 / metersPerUnit(left),
    b = new LifeBuilder();
  b.line(
    [
      { x: -100, y: 2000 },
      { x: 4196, y: 2000 },
    ],
    LifeLine.roadMajor,
    6,
    77,
  );
  b.signal({ x: 4095 + (8 + SIGNAL.gap + 2.2) * pm, y: 2000 }, 8, 90, 0, true);
  const { world, lives } = fixture([
    { key: 'signal-source', tile: left, life: b.finish() },
    continuityTile(right, LifeLine.path),
  ]);
  const source = lives[0]!,
    m = continuityMover(source, 4095);
  for (const life of lives) life.parked.length = life.stalls.length = life.gatherers.length = 0;
  source.movers.push(m);
  const s = source.signals.signals[0]!;
  const clock = Array.from({ length: 140 }, (_, i) => i).find(
    (t) => signalState(s.seed, t + 0.1, s.a < 0).a === 'red',
  )!;
  (world as unknown as { clock: number }).clock = clock;
  const history = { key: 'pending', seconds: 8, at: 0, queued: true };
  (world as unknown as { rejectedSeams: WeakMap<Mover, typeof history> }).rejectedSeams.set(
    m,
    history,
  );
  world.step(0.1);
  expect(m.dir).toBe(1);
  expect(m.x).toBeCloseTo(4095);
  expect(m.v).toBe(0);
  expect(history.seconds).toBe(8);
});
