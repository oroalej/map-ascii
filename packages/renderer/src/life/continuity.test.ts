import { describe, expect, it } from 'vitest';
import { LifeWorld, TileLife, type Mover } from './simulate';
import { LifeBuilder, LifeLine } from './geometry';
import { SegmentGrid } from './continuity';
import { activityLevels, RETIRE } from './config';
import { cede, frameBetween, masked, ownedFootprints } from './frames';
import { metersPerUnit, tileToLngLat } from '../raster/geometry';
import {
  completeScenarioState,
  retiredTiles,
  scenarioState,
  worldTiles,
} from './testing/scenarios';
import { continuityMover, continuityTile, left, parent, right } from './testing/continuity';
import { trainLimits } from './train-motion';
import { withoutDecorations } from '../../scripts/decorations';

const entry = continuityTile(parent);
function fixture(kind: LifeLine = LifeLine.roadMajor) {
  const source = continuityTile(parent, kind);
  const world = new LifeWorld({ road_major: { car: 1 } });
  world.sync([source]);
  const life = worldTiles(world).get(source.key)!;
  const agentKind = kind === LifeLine.river ? 'boat' : kind === LifeLine.rail ? 'train' : 'vehicle';
  const movers = Array.from({ length: agentKind === 'train' ? 1 : 18 }, (_, i) =>
    continuityMover(life, 150 + i * 200, agentKind),
  );
  life.movers.splice(0, life.movers.length, ...movers);
  return { world, life, movers, source };
}
function assertUnique(world: LifeWorld) {
  const lives = [
    ...worldTiles(world).values(),
    ...[...retiredTiles(world).values()].map((r) => r.life),
  ];
  const all = lives.flatMap((life) => life.movers);
  expect(new Set(all).size).toBe(all.length);
  for (const life of lives) {
    for (const [m, s] of life.scenes.services) {
      expect(life.movers).toContain(m);
      if (s.passenger) expect(life.movers).toContain(s.passenger);
    }
    for (const m of life.scenes.visits.keys()) expect(life.movers).toContain(m);
    for (const site of life.scenes.sites)
      for (const m of site.queue) expect(life.movers).toContain(m);
  }
}

describe('tile retirement', () => {
  it('freezes retired state, draws nothing, and revives original motion after cloned geometry returns', () => {
    const { world, life, source } = fixture();
    world.step(0.1);
    const saved = structuredClone(scenarioState(world));
    world.sync([]);
    expect(worldTiles(world).size).toBe(0);
    expect(world.cellTerrain()).toBeUndefined();
    const before = completeScenarioState(world).retired;
    for (let i = 0; i < 40; i++) world.step(0.1);
    expect(completeScenarioState(world).retired).toEqual(before);
    expect(world.visible(18, activityLevels(1), [123, 13])).toEqual([]);
    world.sync([structuredClone(source)]);
    expect(worldTiles(world).get(source.key)).toBe(life);
    expect(withoutDecorations(scenarioState(world))).toEqual(withoutDecorations(saved));
    expect(retiredTiles(world).size).toBe(0);
  });

  it('revives the original population immediately before retirement expiry', () => {
    const { world, source, life } = fixture();
    world.sync([]);
    (world as unknown as { clock: number }).clock = RETIRE.seconds - 1e-6;
    world.sync([source]);
    expect(worldTiles(world).get(source.key)).toBe(life);
  });

  it('expires at the boundary before revival and keeps only the newest 24 retirements', () => {
    const { world, source, life } = fixture();
    world.sync([]);
    // Set only the test clock to hit the exact boundary without floating point accumulation.
    (world as unknown as { clock: number }).clock = RETIRE.seconds;
    world.sync([source]);
    expect(worldTiles(world).get(source.key)).not.toBe(life);
    const tiles = Array.from({ length: 26 }, (_, i) =>
      continuityTile({ ...parent, x: parent.x + i }),
    );
    world.clearTiles();
    world.sync(tiles);
    world.sync([]);
    expect(retiredTiles(world).size).toBe(24);
    expect([...retiredTiles(world).keys()]).toEqual(tiles.slice(2).map((t) => t.key));
  });

  it('hard-clears history for preferences and traffic without resetting the signal clock', () => {
    const { world, source, life } = fixture();
    world.step(0.1);
    const clock = world.signalClock;
    world.sync([]);
    world.clearTiles();
    expect(retiredTiles(world).size).toBe(0);
    expect(world.signalClock).toBe(clock);
    world.sync([source]);
    expect(worldTiles(world).get(source.key)).not.toBe(life);
    world.sync([]);
    world.setTraffic({ road_major: { car: 1 } });
    expect(retiredTiles(world).size).toBe(0);
  });
});

describe('cross-zoom continuity', () => {
  for (const kind of [LifeLine.roadMajor, LifeLine.river, LifeLine.rail])
    it(`carries identity, rendered pose and physical velocity on line kind ${kind}`, () => {
      const { world, life, movers } = fixture(kind);
      if (movers[0]!.train) {
        movers[0]!.pause = 9;
        movers[0]!.train.reverse = true;
      }
      const old = movers.map((m) => ({ m, pose: life.pose(m), state: structuredClone(m) }));
      const children = [continuityTile(left, kind), continuityTile(right, kind)];
      world.sync(children);
      const lives = [...worldTiles(world).values()];
      const carries = old.filter(({ m }) => lives.some((target) => target.movers.includes(m)));
      expect(carries.length).toBeGreaterThan(0);
      for (const { m, pose, state } of carries) {
        const target = lives.find((t) => t.movers.includes(m))!;
        const f = frameBetween(life.tile, target.tile),
          now = target.pose(m);
        expect(
          Math.hypot(now.x - f.x - pose.x * f.scale, now.y - f.y - pose.y * f.scale) /
            target.perMeter,
        ).toBeLessThanOrEqual(4);
        expect(now.hx * pose.hx + now.hy * pose.hy).toBeGreaterThanOrEqual(
          Math.cos((35 * Math.PI) / 180),
        );
        expect(m.v! / target.perMeter).toBeCloseTo(state.v! / life.perMeter);
        expect(m.speed / target.perMeter).toBeCloseTo(state.speed / life.perMeter);
        expect([m.paint, m.vehicle, m.rank, m.lane]).toEqual([
          state.paint,
          state.vehicle,
          state.rank,
          state.lane,
        ]);
        expect(m.routing?.seed).toBe(state.routing?.seed);
        expect(m.routing?.turns).toBe(state.routing?.turns);
        if (m.train) {
          expect(m.pause).toBe(9);
          expect(m.train.reverse).toBe(true);
          expect(m.train.trail).toEqual(
            state.train!.trail.map((v, i) => (i % 2 ? f.y : f.x) + v * f.scale),
          );
          expect(m.train.stopX).toBe(f.x + state.train!.stopX * f.scale);
        }
      }
      assertUnique(world);
    });

  it('retains partial donors for a delayed child and returns carries to a still-live parent', () => {
    const { world, life, movers, source } = fixture();
    const a = continuityTile(left),
      b = continuityTile(right);
    world.sync([source, a]);
    const child = worldTiles(world).get(a.key)!;
    const transferred = movers.filter((m) => child.movers.includes(m));
    expect(transferred.length).toBeGreaterThan(0);
    const remainder = movers.filter((m) => m.x >= 2048 && life.movers.includes(m));
    expect(remainder.length).toBeGreaterThan(0);
    world.sync([a]);
    world.sync([a, b]);
    expect(remainder.some((m) => worldTiles(world).get(b.key)!.movers.includes(m))).toBe(true);
    world.sync([source, a]);
    world.sync([source]);
    expect(transferred.some((m) => life.movers.includes(m))).toBe(true);
    assertUnique(world);
  });

  it('keeps seeded quotas and preserves residents outside regained territory', () => {
    const { world, life, source } = fixture();
    const child = continuityTile(left);
    const seeded = new LifeWorld({ road_major: { car: 1 } });
    seeded.sync([child]);
    const quota = worldTiles(seeded)
      .get(child.key)!
      .movers.filter((m) => m.kind === 'vehicle' && m.x >= 0 && m.x < 4096).length;
    world.sync([source, child]);
    expect(
      worldTiles(world)
        .get(child.key)!
        .movers.filter((m) => m.kind === 'vehicle' && m.x >= 0 && m.x < 4096).length,
    ).toBeLessThanOrEqual(quota);
    const protectedMovers = life.movers.filter((m) => m.x >= 2048);
    const before = structuredClone(protectedMovers);
    world.sync([source]);
    expect(protectedMovers).toEqual(before);
    for (const m of protectedMovers) expect(life.movers).toContain(m);
  });

  it('does not redonate failed projections and does not use fresh tiles as donors', () => {
    const { world, source, movers } = fixture();
    const mismatch = continuityTile(left, LifeLine.roadMajor, 999);
    world.sync([mismatch]);
    expect(
      [...worldTiles(world).values()].flatMap((t) => t.movers).some((m) => movers.includes(m)),
    ).toBe(false);
    world.sync([mismatch, continuityTile(right)]);
    world.sync([continuityTile(left)]);
    expect(
      [...worldTiles(world).values()]
        .flatMap((t) => t.movers)
        .some((m) => movers.includes(m) && m.x < 2048),
    ).toBe(false);
    const mixed = new LifeWorld(),
      direct = new LifeWorld();
    mixed.sync([source, continuityTile(left)]);
    direct.sync([source, continuityTile(left)]);
    expect(completeScenarioState(mixed)).toEqual(completeScenarioState(direct));
    expect(worldTiles(mixed).get(source.key)!.movers.length).toBeGreaterThan(0);
  });

  it('replays multi-level jumps and reversals deterministically with detached history snapshots', () => {
    const a = fixture(),
      b = fixture();
    const saved = completeScenarioState(a.world);
    const grandchild = continuityTile({ z: 17, x: left.x * 2, y: left.y * 2 });
    for (const tiles of [
      [grandchild],
      [continuityTile(left)],
      [entry, continuityTile(left)],
      [entry],
      [],
      [entry],
    ]) {
      for (const f of [a, b]) {
        f.world.sync(structuredClone(tiles));
        f.world.step(0.1, undefined, 18);
        assertUnique(f.world);
      }
      expect(completeScenarioState(a.world)).toEqual(completeScenarioState(b.world));
    }
    expect(saved.tiles[0]!.elapsed).toBe(0);
    expect(saved.tiles[0]!.movers[0]!.x).toBe(150);
  });
});

describe('transactional adoption', () => {
  function pair(targetEntry = continuityTile(left)) {
    const { life, movers } = fixture();
    const target = new TileLife(targetEntry.tile, targetEntry.life, 42);
    return { life, m: movers[0]!, target };
  }
  it('leaves owners and victims unchanged when clearance rejects a pure preview', () => {
    const { life, m, target } = pair();
    const victim = target.movers.find((m) => m.kind === 'vehicle')!;
    const state = structuredClone([life.movers, target.movers]);
    expect(target.adoptFrom(m, life, { replace: victim }, () => false)).toBe(false);
    expect([life.movers, target.movers]).toEqual(state);
    expect(target.adoptFrom(m, life, { replace: victim })).toBe(true);
    expect(life.movers).not.toContain(m);
    expect(target.movers).toContain(m);
    expect(target.movers).not.toContain(victim);
  });
  for (const [name, tile] of [
    ['identity', continuityTile(left, LifeLine.roadMajor, 999)],
    ['snap', continuityTile(left, LifeLine.roadMajor, 77, 200)],
    ['oneway', continuityTile(left, LifeLine.roadMajor, 77, 0, -1)],
    ['craft', continuityTile(left, LifeLine.path)],
  ] as const)
    it(`rejects incompatible ${name} without mutation`, () => {
      const { life, m, target } = pair(tile);
      const state = structuredClone([life.movers, target.movers]);
      expect(target.adoptFrom(m, life)).toBe(false);
      expect([life.movers, target.movers]).toEqual(state);
    });
  it('falls back to geometric matching only for legacy unidentified lines', () => {
    const { life, m, target } = pair(continuityTile(left, LifeLine.roadMajor, 0));
    expect(target.adoptFrom(m, life)).toBe(true);
  });

  it('rejects a nearby perpendicular bearing and a motorboat entering a canal', () => {
    const b = new LifeBuilder();
    b.line(
      [
        { x: 300, y: -100 },
        { x: 300, y: 4196 },
      ],
      LifeLine.roadMajor,
      6,
      77,
    );
    const { life, m, target } = pair({ key: 'vertical', tile: left, life: b.finish() });
    expect(target.adoptFrom(m, life)).toBe(false);
    const boats = fixture(LifeLine.river);
    const canal = continuityTile(left, LifeLine.canal);
    boats.movers[0]!.vehicle = 'motorboat';
    expect(new TileLife(left, canal.life, 1).adoptFrom(boats.movers[0]!, boats.life)).toBe(false);
  });

  it('indexes only crossed cells for long diagonal segments', () => {
    const b = new LifeBuilder();
    b.line(
      [
        { x: -1000, y: -1000 },
        { x: 100_000, y: 100_000 },
      ],
      LifeLine.roadMajor,
    );
    const grid = new SegmentGrid(b.finish(), 1);
    const bins = (grid as unknown as { bins: Map<number, Map<number, unknown>> }).bins;
    expect([...bins.values()].reduce((count, row) => count + row.size, 0)).toBeLessThan(13_000);
    expect(grid.near(50_000, 50_000, 4)).toHaveLength(1);
    expect(grid.near(50_000, 20_000, 4)).toHaveLength(0);
  });
  it('enforces 600 movers and protects active service relationships', () => {
    const { life, m, target } = pair();
    target.movers.splice(
      0,
      target.movers.length,
      ...Array.from({ length: 600 }, () => continuityMover(target, 100)),
    );
    expect(target.adoptFrom(m, life)).toBe(false);
    target.movers.length = 0;
    const site = { x: m.x, y: m.y } as Parameters<typeof life.scenes.services.set>[1]['site'];
    life.scenes.services.set(m, { site, arriving: false, time: 5, boarded: 0 });
    expect(target.adoptFrom(m, life)).toBe(false);
    life.scenes.release(m);
    expect(life.scenes.transferable(m)).toBe(true);
  });
});

describe('finest geographic ownership', () => {
  it('keeps live ownership histories canonical when descendants overlap or complete a parent', () => {
    const world = new LifeWorld();
    const grandchild = { z: 17, x: left.x * 2, y: left.y * 2 };
    world.sync([entry, continuityTile(left), continuityTile(grandchild)]);
    expect(completeScenarioState(world).ownership.find((o) => o.key === entry.key)!.ceded).toEqual([
      left,
    ]);
    world.sync([
      entry,
      ...[0, 1].flatMap((dy) =>
        [0, 1].map((dx) => continuityTile({ z: 16, x: left.x + dx, y: left.y + dy })),
      ),
    ]);
    expect(completeScenarioState(world).ownership.find((o) => o.key === entry.key)!.ceded).toEqual([
      parent,
    ]);
  });

  it('uses half-open boundaries and compacts ceded regions', () => {
    const masks: (typeof parent)[] = [];
    for (let dy = 0; dy < 2; dy++)
      for (let dx = 0; dx < 2; dx++) cede(masks, { z: 16, x: left.x + dx, y: left.y + dy }, parent);
    expect(masks).toEqual([parent]);
    expect(ownedFootprints(parent, masks)).toEqual([]);
    expect(masked(parent, { x: 2048, y: 1000 }, [left])).toBe(false);
    expect(masked(parent, { x: 2048 - 1e-6, y: 1000 }, [left])).toBe(true);
  });
  it('freezes hidden coarse movers and excludes them from traffic, collision and visible output', () => {
    const { world, life, source } = fixture();
    const fine = continuityTile(left, LifeLine.roadMajor, 999);
    world.sync([source, fine]);
    const covered = life.movers.filter((m) => m.x < 2048);
    const before = structuredClone(covered);
    world.step(0.1, undefined, 18);
    expect(covered).toEqual(before);
    const levels = activityLevels(1),
      center = tileToLngLat(left, { x: 2048, y: 2000 });
    const visible = world.visible(18, levels, center);
    const coveredLng = new Set(covered.map((m) => tileToLngLat(life.tile, life.pose(m))[0]));
    expect(visible.some((v) => v.kind === 'vehicle' && coveredLng.has(v.lng))).toBe(false);
    const target = worldTiles(world).get(fine.key)!;
    const probe = continuityMover(target, covered[0]!.x * 2);
    for (const m of [...target.movers]) target.release(m);
    // Rebuild occupancy after removing fine seeds. Coarse bodies must remain absent.
    expect(
      (world as unknown as { groundGuard(): (life: TileLife, m: Mover) => boolean }).groundGuard()(
        target,
        probe,
      ),
    ).toBe(true);
  });
  it('looks ahead through a finer fragment and ignores covered coarse trains/stations', () => {
    const coarse = new TileLife(parent, continuityTile(parent, LifeLine.rail).life, 1);
    const fine = new TileLife(right, continuityTile(right, LifeLine.rail).life, 2);
    const follower = continuityMover(coarse, 2048 - 12 * coarse.perMeter, 'train');
    const leader = continuityMover(fine, 15 * fine.perMeter, 'train');
    leader.pause = 8;
    leader.v = 0;
    coarse.movers.splice(0, coarse.movers.length, follower);
    fine.movers.splice(0, fine.movers.length, leader);
    const owns = (life: TileLife, p: { x: number; y: number }) =>
      life === fine || !masked(parent, p, [right]);
    expect(trainLimits([coarse, fine], 0.1, owns).get(follower)!.target).toBeLessThan(
      follower.speed,
    );
    const hidden = continuityMover(coarse, 2100, 'train');
    coarse.movers.push(hidden);
    expect(trainLimits([coarse, fine], 0.1, owns).has(hidden)).toBe(false);
    expect(metersPerUnit(parent)).toBeGreaterThan(metersPerUnit(left));
  });
});
