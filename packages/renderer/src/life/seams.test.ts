import { describe, expect, it, vi } from 'vitest';
import {
  LifeWorld,
  type TileLife,
  type LifeTile,
  type Mover,
  type WorldGroundGuard,
} from './simulate';
import { JunctionTable } from './junctions';
import { continuityTile, continuityMover, left, right, parent } from './testing/continuity';
import { worldTiles } from './testing/scenarios';
import { LifeBuilder, LifeLine } from './geometry';
import { frameBetween } from './frames';
import { seamAhead, SEAMS } from './seams';
import { activityLevels, FOLLOW, MAX_TILE_AGENTS, SIGNAL } from './config';
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
  it('previews a unique turnable future exit and discovers both junctions without choosing a route', () => {
    const pm = 1 / metersPerUnit(left),
      builder = new LifeBuilder(),
      a = { x: 4096 - 30 * pm, y: 2000 },
      b = { x: 4096 - 10 * pm, y: 2000 };
    builder.line([{ x: a.x - 100 * pm, y: a.y }, a], LifeLine.roadMajor, 4);
    builder.line([a, b], LifeLine.roadMajor, 4);
    builder.line([b, { x: b.x + 100 * pm, y: b.y }], LifeLine.roadMajor, 4);
    builder.line(
      [
        b,
        { x: b.x - 100 * Math.cos(Math.PI / 18) * pm, y: b.y + 100 * Math.sin(Math.PI / 18) * pm },
      ],
      LifeLine.roadMajor,
      4,
    );
    builder.line([a, { x: a.x, y: a.y - 100 * pm }], LifeLine.roadMinor, 4);
    const entry = continuityTile(left);
    entry.life = builder.finish();
    const { lives } = fixture([entry]),
      source = lives[0]!,
      mover = continuityMover(source, a.x - 5 * pm);
    Object.assign(mover, { from: 0, d: 95 * pm, x: a.x - 5 * pm, y: a.y, next: 2 });
    const before = structuredClone(mover);
    expect(source.seamExit(mover, 1, 1)).toBe(4);
    const movements = source.junctionIndex.movements(mover, 60 * pm, (line, dir) =>
      source.seamExit(mover, line, dir),
    );
    expect(movements).toHaveLength(2);
    expect(movements[1]!.exit.line).toBe(2);
    expect(seamAhead(source, mover, [], 100 * pm)?.preview.line).toBe(2);
    expect(mover).toEqual(before);
    // The existing dead-end policy still permits the only legal hairpin.
    source.geo.oneway![2] = -1;
    expect(source.seamExit(mover, 1, 1)).toBe(6);
  });
  it('previews reserved future exits ahead of competing plans and remembered exits', () => {
    const builder = new LifeBuilder();
    builder.line(
      [
        { x: 3600, y: 2000 },
        { x: 3700, y: 2000 },
        { x: 3800, y: 2000 },
        { x: 4200, y: 2000 },
      ],
      LifeLine.roadMajor,
      6,
      77,
    );
    for (const x of [3700, 3800])
      builder.line(
        [
          { x, y: 2000 },
          { x, y: 3000 },
        ],
        LifeLine.roadMinor,
        6,
        x,
      );
    builder.splitRoadJunctions(1 / metersPerUnit(left), 40);
    const entry = continuityTile(left);
    entry.life = builder.finish();
    const { lives } = fixture([entry]);
    const source = lives[0]!;
    const mover = continuityMover(source, 3650);
    mover.d = 50;
    mover.next = 6;
    mover.routing = {
      seed: 123,
      turns: 0,
      plan: { line: 0, dir: 1, vertex: 1, exit: 6, radius: 0 },
    };
    mover.junctionRoute = { key: 'reserved', exits: [2, 4] };
    const before = structuredClone(mover);
    expect(source.seamExit(mover, 0, 1)).toBe(2);
    expect(source.seamExit(mover, 1, 1)).toBe(4);
    expect(seamAhead(source, mover, [], 100 * source.perMeter)?.preview.line).toBe(2);
    expect(mover).toEqual(before);
    mover.junctionRoute = undefined;
    mover.next = 2;
    expect(source.seamExit(mover, 0, 1)).toBe(6);
    mover.routing = { ...mover.routing, plan: { ...mover.routing.plan!, vertex: 0 } };
    expect(source.seamExit(mover, 0, 1)).toBe(2);
    mover.next = 4;
    expect(source.seamExit(mover, 1, 1)).toBeUndefined();
  });

  it.each([1, -1] as const)(
    'carries only unconsumed reserved exits across a seam (direction %i)',
    (dir) => {
      const xs = dir === 1 ? [3600, 3700, 3900, 4300, 4500] : [-404, -204, 196, 396, 496];
      const builder = new LifeBuilder();
      builder.line(
        xs.map((x) => ({ x, y: 2000 })),
        LifeLine.roadMajor,
        8,
        77,
      );
      for (const x of xs.slice(1, -1))
        builder.line(
          [
            { x, y: 2000 },
            { x, y: 3000 },
          ],
          LifeLine.roadMinor,
          6,
          x + 10000,
        );
      builder.splitRoadJunctions(1 / metersPerUnit(left), 40);
      const entry = continuityTile(left);
      entry.life = builder.finish();
      const { lives } = fixture([entry]);
      const source = lives[0]!;
      const mover = continuityMover(source, dir === 1 ? 3650 : 446);
      Object.assign(mover, {
        line: dir === 1 ? 0 : 3,
        from: dir === 1 ? 0 : 7,
        dir,
        d: 50,
        hx: dir,
      });
      mover.junctionRoute = { key: 'reserved', exits: dir === 1 ? [2, 4, 6] : [5, 3, 1] };
      mover.routing = { seed: 123, turns: 7 };
      const before = structuredClone(mover);
      const preview = seamAhead(source, mover, [], 1000)!;
      expect(preview.preview.line).toBe(dir === 1 ? 2 : 1);
      expect(preview.preview.junctionRoute?.exits).toEqual(dir === 1 ? [6] : [1]);
      const targetEntry = continuityTile(left);
      targetEntry.life = structuredClone(entry.life);
      const { lives: targets } = fixture([targetEntry]);
      expect(targets[0]!.projectFrom(preview.preview, source)?.junctionRoute?.exits).toEqual(
        dir === 1 ? [6] : [1],
      );
      expect(mover).toEqual(before);
    },
  );

  it('keeps a missing-owner timeout across a committed junction continuation', () => {
    const pm = 1 / metersPerUnit(left);
    const junctionX = 4096 - pm;
    const builder = new LifeBuilder();
    builder.line(
      [
        { x: 3800, y: 2000 },
        { x: junctionX, y: 2000 },
        { x: 4200, y: 2000 },
      ],
      LifeLine.roadMajor,
      6,
      77,
    );
    builder.line(
      [
        { x: junctionX, y: 1000 },
        { x: junctionX, y: 2000 },
        { x: junctionX, y: 3000 },
      ],
      LifeLine.roadMinor,
      6,
      88,
    );
    builder.splitRoadJunctions(pm, 40);
    const entry = continuityTile(left);
    entry.life = builder.finish();
    const { world, lives } = fixture([entry]);
    const source = lives[0]!;
    source.parked.length = source.stalls.length = source.gatherers.length = 0;
    source.scenes.sites.length = 0;
    const mover = continuityMover(source, 4096 - 11 * pm);
    Object.assign(mover, { d: mover.x - 3800, v: 10 * pm, next: 2 });
    source.movers.push(mover);
    for (let frame = 0; frame < 180 && mover.line === 0; frame++) world.step(1 / 30);
    expect(mover.line).toBe(1);
    expect(source.elapsed).toBeGreaterThanOrEqual(SEAMS.missingSeconds);
    for (let frame = 0; frame < 3; frame++) {
      world.step(1 / 30);
      expect(mover.dir).toBe(1);
      expect(mover.v! / pm).toBeGreaterThan(0.5);
    }
  });

  for (const accepted of [false, true])
    it(`previews a seam beyond a split junction with ${accepted ? 'an accepted' : 'a refused'} destination`, () => {
      const pm = 1 / metersPerUnit(left);
      const junctionX = 4096 - pm;
      const builder = new LifeBuilder();
      builder.line(
        [
          { x: 3800, y: 2000 },
          { x: junctionX, y: 2000 },
          { x: 4200, y: 2000 },
        ],
        LifeLine.roadMajor,
        6,
        77,
      );
      builder.line(
        [
          { x: junctionX, y: 1000 },
          { x: junctionX, y: 2000 },
          { x: junctionX, y: 3000 },
        ],
        LifeLine.roadMinor,
        6,
        88,
      );
      builder.splitRoadJunctions(pm, 40);
      const entry = continuityTile(left);
      entry.life = builder.finish();
      const { world, lives } = fixture([
        entry,
        continuityTile(right, LifeLine.roadMajor, 77, 0, accepted ? 0 : -1),
      ]);
      for (const life of lives) {
        life.parked.length = life.stalls.length = life.gatherers.length = 0;
        life.scenes.sites.length = 0;
      }
      const source = lives[0]!,
        target = lives[1]!;
      const m = continuityMover(source, 4096 - 11 * pm);
      Object.assign(m, { d: m.x - 3800, v: 10 * pm, next: 2 });
      source.movers.push(m);
      const before = structuredClone(m);
      const preview = seamAhead(source, m, [], 20 * pm)!;
      expect(preview.distance / pm).toBeCloseTo(11, 5);
      expect(preview.preview.line).toBe(1);
      expect(preview.preview.dir).toBe(1);
      expect(preview.preview.from).toBe(source.geo.starts[1]);
      expect(preview.preview.x).toBeGreaterThan(4096);
      expect(m).toEqual(before);
      if (!accepted) {
        for (let frame = 0; frame < 60; frame++) world.step(1 / 30);
        expect(source.movers).toContain(m);
        expect(m.v! / pm).toBeLessThan(0.02);
        expect((4096 - m.x) / pm).toBeGreaterThanOrEqual(
          VEHICLES.car.length / 2 + FOLLOW.minGap - 1e-4,
        );
        target.geo.oneway![0] = 0;
      }
      for (let frame = 0; frame < 120 && source.movers.includes(m); frame++) world.step(1 / 30);
      expect(target.movers).toContain(m);
      expect(source.movers).not.toContain(m);
      expect(lives.filter((life) => life.movers.includes(m))).toHaveLength(1);
      expect(target.geo.lineIds![m.line]).toBe(77);
      expect(m.dir).toBe(1);
    });

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
    m.roadSteering = 1;
    source.movers.push(m);
    const old = source.pose(m),
      frame = frameBetween(source.tile, target.tile);
    const preview = target.projectFrom(m, source);
    expect(preview?.roadShift).toBe(-1);
    expect(preview?.roadSteering).toBe(1);
    expect(m.roadShift).toBe(-1);
    expect(target.pose(preview!).y).toBeCloseTo(frame.y + old.y * frame.scale);
    const original = structuredClone(m);
    expect(target.adoptFrom(m, source, {}, () => false)).toBe(false);
    expect(m).toEqual(original);
    expect(target.adoptFrom(m, source)).toBe(true);
    expect(m.roadSteering).toBe(1);
    for (let i = 0; i < 10 && source.movers.includes(m); i++) world.step(0.1);
    expect(target.movers).toContain(m);
    expect(m.roadShift).toBe(-1);
    const before = target.pose(m);
    world.step(0.1);
    const after = target.pose(m);
    expect(after.x).toBeGreaterThan(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it.each([1, -1] as const)(
    'lets the leading vehicle clear a predicted seam reservation in direction %s',
    (dir) => {
      const { world, lives } = fixture([
        continuityTile(left, LifeLine.roadMajor, 77, 0, dir),
        continuityTile(right, LifeLine.roadMajor, 77, 0, dir),
      ]);
      const source = lives[dir === 1 ? 0 : 1]!,
        target = lives[dir === 1 ? 1 : 0]!,
        pm = source.perMeter;
      for (const life of lives) {
        life.parked.length = life.stalls.length = life.gatherers.length = 0;
        life.scenes.sites.length = 0;
      }
      const follower = continuityMover(source, dir === 1 ? 4096 - 8 * pm : 8 * pm),
        leader = continuityMover(target, dir === 1 ? 0.5 * pm : 4096 - 0.5 * pm);
      for (const m of [follower, leader]) {
        Object.assign(m, {
          dir,
          from: dir === 1 ? 0 : 1,
          d: dir === 1 ? m.x + 100 : 4196 - m.x,
          hx: dir,
          vehicle: 'jeepney',
          speed: 5 * pm,
          v: 0,
        });
      }
      source.movers.push(follower);
      target.movers.push(leader);
      const start = target.pose(leader);
      for (let frame = 0; frame < 12 * 30; frame++) {
        world.step(1 / 30, undefined, 17, undefined, undefined, undefined, 7);
        expect(lives.filter((life) => life.movers.includes(follower))).toHaveLength(1);
        expect(lives.filter((life) => life.movers.includes(leader))).toHaveLength(1);
        const owner = source.movers.includes(follower) ? source : target;
        const p = owner.pose(follower),
          q = target.pose(leader),
          frame = frameBetween(owner.tile, target.tile);
        expect(
          Math.hypot(q.x - (frame.x + p.x * frame.scale), q.y - p.y * frame.scale) / pm,
        ).toBeGreaterThanOrEqual(VEHICLES.jeepney.length);
      }
      expect(((target.pose(leader).x - start.x) * dir) / pm).toBeGreaterThan(10);
      expect(target.movers).toContain(follower);
      expect(follower.dir).toBe(dir);
      expect(follower.routing?.turns).toBe(7);
    },
  );

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

it('starts a fresh seam episode after an intervening safe preflight', () => {
  const {
    world,
    lives: [source, target],
  } = fixture([continuityTile(left), continuityTile(right)]);
  for (const life of [source!, target!])
    life.parked.length = life.stalls.length = life.gatherers.length = 0;
  const m = continuityMover(source!, 4096 - 8 * source!.perMeter);
  m.speed = m.v = 0;
  source!.movers.push(m);
  const state = world as unknown as {
    rejectedSeams: WeakMap<Mover, { seconds: number; queued: boolean }>;
  };
  let denied = vi.spyOn(target!, 'projectFrom').mockReturnValue(undefined);
  for (let i = 0; i < 10; i++) world.step(0.1);
  expect(state.rejectedSeams.get(m)?.seconds).toBeCloseTo(1);
  denied.mockRestore();
  world.step(0.1);
  expect(state.rejectedSeams.has(m)).toBe(false);
  denied = vi.spyOn(target!, 'projectFrom').mockReturnValue(undefined);
  world.step(0.1);
  expect(state.rejectedSeams.get(m)?.seconds).toBeCloseTo(0.1);
  expect(state.rejectedSeams.get(m)?.queued).toBe(false);
  denied.mockRestore();
});

it('retains final-adoption failure age across alternating preflight refusals', () => {
  const { world, lives } = fixture([continuityTile(left), continuityTile(right)]);
  const source = lives[0]!,
    target = lives[1]!;
  for (const life of lives) life.parked.length = life.stalls.length = life.gatherers.length = 0;
  const m = continuityMover(source, 4095);
  source.movers.push(m);
  const initial = { ...m };
  let refusePreview = false;
  const project = target.projectFrom.bind(target);
  vi.spyOn(target, 'projectFrom').mockImplementation((...args) =>
    refusePreview ? undefined : project(...args),
  );
  const adoption = vi.spyOn(target, 'adoptFrom').mockReturnValue(false);
  for (let frame = 0; frame < 120 && m.dir === 1; frame++) {
    refusePreview = frame % 2 === 1;
    world.step(0.1);
  }
  expect(adoption).toHaveBeenCalled();
  expect(m.dir).toBe(-1);
  expect(source.elapsed).toBeGreaterThanOrEqual(SEAMS.rejectedSeconds);
  expect(source.elapsed).toBeLessThan(12);
  expect(source.movers).toContain(m);
  expect(target.movers).not.toContain(m);
  expect(m.x).toBeLessThan(4096);
  expect(m.routing?.seed).toBe(initial.routing?.seed);
  expect(m.routing?.turns).toBe(initial.routing?.turns);
});

it.each([false, true])(
  'preserves a red-light seam queue, including retained recovery %s',
  (queued) => {
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
    b.signal({ x: (1 + 8 + SIGNAL.gap + 2.2) * pm, y: 2000 }, 8, 90, 0, true);
    const {
      world,
      lives: [source, target],
    } = fixture([continuityTile(left), { key: 'red', tile: right, life: b.finish() }]);
    for (const life of [source!, target!]) {
      life.parked.length = life.stalls.length = life.gatherers.length = 0;
      life.scenes.sites.length = 0;
    }
    const follower = continuityMover(source!, 4096 - 10 * pm),
      leader = continuityMover(target!, pm);
    follower.v = leader.v = 0;
    source!.movers.push(follower);
    target!.movers.push(leader);
    const signal = target!.signals.signals[0]!;
    const seed = Array.from({ length: 512 }, (_, i) => i).find((seed) =>
      Array.from({ length: 13 }, (_, i) => i).every(
        (i) => signalState(seed, i, signal.a < 0).a === 'red',
      ),
    );
    expect(seed).toBeDefined();
    signal.seed = seed!;
    if (queued) {
      const state = world as unknown as {
        rejectedSeams: WeakMap<
          Mover,
          { key: string; seconds: number; at: number; queued: boolean }
        >;
        queuedSeams: Map<Mover, TileLife>;
      };
      state.rejectedSeams.set(follower, { key: 'pending', seconds: 8, at: 0, queued: true });
      state.queuedSeams.set(follower, source!);
    }
    const start = leader.x,
      recover = vi.spyOn(source!, 'recoverVehicle');
    for (let i = 0; i < 12 * 30; i++) world.step(1 / 30, undefined, 18);
    expect(leader.x).toBeCloseTo(start);
    expect(follower.dir).toBe(1);
    expect(source!.movers).toContain(follower);
    expect(recover).not.toHaveBeenCalled();
  },
);

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

it('resumes accepted travel after a recovered vehicle queues at a full destination', () => {
  const westId = { ...left, x: left.x - 1 };
  const { world, lives } = fixture([continuityTile(left), continuityTile(westId)]);
  const source = lives[0]!,
    target = lives[1]!;
  for (const life of lives) {
    life.parked.length = life.stalls.length = life.gatherers.length = 0;
    life.scenes.sites.length = 0;
  }
  const m = continuityMover(source, 5 * source.perMeter);
  m.v = 0;
  source.movers.push(m);
  const guard = (world as unknown as { groundGuard(): WorldGroundGuard }).groundGuard();
  expect(
    source.recoverVehicle(
      m,
      (next, before, reserve) => guard(source, next, before, undefined, reserve),
      new JunctionTable(),
      new Set(),
      undefined,
      0.1,
    ),
  ).toBe(true);
  const inactive = {
    ...continuityMover(target, 2000),
    kind: 'train' as const,
    rank: 1,
    vehicle: undefined,
  };
  target.movers.push(...Array<Mover>(MAX_TILE_AGENTS).fill(inactive));
  for (let frame = 0; frame < 110; frame++) world.step(0.1, undefined, 18);
  const recovery = source as unknown as { recoveryProgress: WeakMap<Mover, number> };
  const queues = world as unknown as { queuedSeams: Map<Mover, TileLife> };
  expect(queues.queuedSeams.get(m)).toBe(source);
  expect(recovery.recoveryProgress.get(m)).toBeGreaterThan(0);
  const stopped = m.x;
  target.movers.length = 0;
  for (let frame = 0; frame < 150 && source.movers.includes(m); frame++)
    world.step(0.1, undefined, 18);
  expect(target.movers).toContain(m);
  expect(source.movers).not.toContain(m);
  expect(recovery.recoveryProgress.has(m)).toBe(false);
  expect(m.x).not.toBe(stopped);
  expect(queues.queuedSeams.has(m)).toBe(false);
});

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
  (world as unknown as { queuedSeams: Map<Mover, TileLife> }).queuedSeams.set(m, source);
  world.step(0.1);
  expect(m.dir).toBe(1);
  expect(m.x).toBe(4095);
  expect(source.scenes.services.get(m)?.time).toBeCloseTo(9.9);
  expect(history.seconds).toBe(8);
});

it.each([30, 60, 120])(
  'advances a queued recovery once per frame at %s Hz, including selection',
  (hz) => {
    const { world, lives } = fixture([continuityTile(left), continuityTile(right, LifeLine.path)]);
    const source = lives[0]!,
      m = continuityMover(source, 4055);
    for (const life of lives) life.parked.length = life.stalls.length = life.gatherers.length = 0;
    m.v = 0;
    m.waiting = 30;
    source.movers.push(m);
    const start = m.x,
      original = source.recoverVehicle.bind(source);
    const recover = vi
      .spyOn(source, 'recoverVehicle')
      .mockImplementation((owner, guard, table, lines, owns, dt) =>
        original(
          owner,
          (next, before, reserve) =>
            (!('dir' in next) ||
              next.dir !== -1 ||
              next.x <= start - 0.5 * source.perMeter + 1e-8) &&
            guard(next, before, reserve),
          table,
          lines,
          owns,
          dt,
        ),
      );
    const history = { key: 'pending', seconds: 8, at: 0, queued: true };
    (world as unknown as { rejectedSeams: WeakMap<Mover, typeof history> }).rejectedSeams.set(
      m,
      history,
    );
    (world as unknown as { queuedSeams: Map<Mover, TileLife> }).queuedSeams.set(m, source);
    for (let frame = 0; frame < 3; frame++) {
      recover.mockClear();
      const before = m.x;
      world.step(1 / hz, undefined, 17);
      expect(recover).toHaveBeenCalledTimes(1);
      expect(recover.mock.calls[0]![5]).toBe(1 / hz);
      expect((before - m.x) / source.perMeter).toBeCloseTo(0.6 / hz);
      expect(m.dir).toBe(1);
    }
  },
);

it('releases sparse queue ownership on retirement and reset, and revives frozen history', () => {
  const entries = [continuityTile(left), continuityTile(right, LifeLine.path)];
  const { world, lives } = fixture(entries);
  const source = lives[0]!,
    m = continuityMover(source, 4055);
  source.movers.push(m);
  const state = world as unknown as {
    rejectedSeams: WeakMap<Mover, { key: string; seconds: number; at: number; queued: boolean }>;
    queuedSeams: Map<Mover, TileLife>;
  };
  state.rejectedSeams.set(m, { key: 'pending', seconds: 8, at: 0, queued: true });
  state.queuedSeams.set(m, source);
  world.sync([entries[1]!]);
  expect(state.queuedSeams.size).toBe(0);
  expect(state.rejectedSeams.get(m)?.queued).toBe(true);
  world.sync(entries);
  expect(state.queuedSeams.get(m)).toBe(source);
  world.clearTiles();
  expect(state.queuedSeams.size).toBe(0);
  expect(state.rejectedSeams.get(m)).toBeUndefined();
});

it('prunes a queued actor removed from its source before attempting recovery', () => {
  const { world, lives } = fixture([continuityTile(left), continuityTile(right, LifeLine.path)]);
  const source = lives[0]!,
    m = continuityMover(source, 4055);
  const state = world as unknown as {
    rejectedSeams: WeakMap<Mover, { key: string; seconds: number; at: number; queued: boolean }>;
    queuedSeams: Map<Mover, TileLife>;
  };
  state.rejectedSeams.set(m, { key: 'pending', seconds: 8, at: 0, queued: true });
  state.queuedSeams.set(m, source);
  const recover = vi.spyOn(source, 'recoverVehicle');
  world.step(0.1);
  expect(recover).not.toHaveBeenCalled();
  expect(state.queuedSeams.size).toBe(0);
  expect(state.rejectedSeams.get(m)).toBeUndefined();
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
  (world as unknown as { queuedSeams: Map<Mover, TileLife> }).queuedSeams.set(m, source);
  world.step(0.1);
  expect(m.dir).toBe(1);
  expect(m.x).toBeCloseTo(4095);
  expect(m.v).toBe(0);
  expect(history.seconds).toBe(8);
});
