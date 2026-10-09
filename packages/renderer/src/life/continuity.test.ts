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
it('rebases an active boat shift during zoom adoption without adding pointer-free properties', () => {
  const a = continuityTile(parent, LifeLine.river),
    b = continuityTile(left, LifeLine.river, 77, 1 / metersPerUnit(left));
  const source = new TileLife(parent, a.life, 1),
    target = new TileLife(left, b.life, 1);
  const boat = continuityMover(source, 1000, 'boat');
  const ordinary = target.projectFrom(boat, source)!;
  expect(ordinary).not.toHaveProperty('boatShift');
  boat.boatShift = 1.5;
  const projected = target.projectFrom(boat, source)!;
  const old = tileToLngLat(parent, source.pose(boat)),
    next = tileToLngLat(left, target.pose(projected));
  expect(next[0]).toBeCloseTo(old[0], 9);
  expect(next[1]).toBeCloseTo(old[1], 9);
  expect(projected.boatShift).toBeCloseTo(0.5, 3);
  source.movers.push(boat);
  expect(
    target.adoptFrom(boat, source, {}, (preview) => {
      expect(target.pose(preview)).toEqual(target.pose(projected));
      return true;
    }),
  ).toBe(true);
  expect(boat.boatShift).toBe(projected.boatShift);
  expect(target.pose(boat)).toEqual(target.pose(projected));
});
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
  it('revives accepted maneuver pose and active timers without aging them while retired', () => {
    const source = continuityTile(parent, LifeLine.roadMajor, 77, 0, 1);
    source.life.widths[0] = 9.6;
    const world = new LifeWorld({ road_major: { car: 1 } });
    world.sync([source]);
    const life = worldTiles(world).get(source.key)!,
      m = continuityMover(life, 1500);
    life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
    life.scenes.sites.length = 0;
    Object.assign(m, {
      vehicle: 'motorcycle',
      lane: 0.9,
      chosenLane: 0.9,
      lat: -0.2,
      latYaw: -0.1,
      v: 0,
      maneuver: { kind: 'filter', target: 0.9, corridor: 2 / 3, queueSpeed: 0 },
      laneSignal: 'left',
      laneCooldown: 6,
      filterRetry: 3,
    });
    const queued = continuityMover(life, m.x + 30 * life.perMeter);
    Object.assign(queued, { lane: 0.9, v: 0, speed: 0 });
    life.movers.push(m, queued);
    world.visible(18, activityLevels(1), tileToLngLat(parent, m));
    const before = structuredClone(m);
    world.sync([]);
    for (let frame = 0; frame < 30; frame++) world.step(0.1);
    expect(m).toEqual(before);
    world.sync([structuredClone(source)]);
    expect(worldTiles(world).get(source.key)).toBe(life);
    expect(life.movers).toContain(m);
    expect(m).toEqual(before);
    world.step(0.1, undefined, 18);
    expect(m.lat).toBeLessThan(before.lat!);
    expect(m.laneCooldown).toBeCloseTo(5.9);
    expect(m.filterRetry).toBeCloseTo(2.9);
  });

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
  it('returns material displacement after a genuine parking-width change without teleporting', () => {
    const a = continuityTile(left, LifeLine.roadMinor, 77, 0, 1),
      b = continuityTile(right, LifeLine.roadMinor, 77, 0, 1);
    a.life.widths[0] = b.life.widths[0] = 14;
    const source = new TileLife(left, a.life, 2),
      target = new TileLife(right, b.life, 1);
    for (const life of [source, target]) {
      life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
      life.scenes.sites.length = 0;
    }
    expect(source.directionalLanes(0).span).toBe(14);
    expect(target.directionalLanes(0).span).toBeCloseTo(9.2);
    const m = continuityMover(source, 4095);
    Object.assign(m, { lane: 0.9, chosenLane: 0.1 });
    source.movers.push(m);
    const before = structuredClone(m),
      pose = source.pose(m),
      frame = frameBetween(left, right),
      preview = target.projectFrom(m, source)!;
    expect(target.pose(preview).y).toBeCloseTo(frame.y + pose.y * frame.scale);
    expect(preview.lat).toBeCloseTo(-2.95);
    expect(preview.maneuver?.kind).toBe('return');
    expect(target.adoptFrom(m, source, {}, () => false)).toBe(false);
    expect(m).toEqual(before);
    expect(target.adoptFrom(m, source)).toBe(true);
    for (let step = 0; step < 10 * 30 && m.maneuver; step++) target.step(1 / 30);
    expect(m.maneuver).toBeUndefined();
    expect(m.lat).toBeUndefined();
    expect(m.latYaw).toBeUndefined();
    expect(m.laneSignal).toBeUndefined();
    expect(target.offsetOf(m)).toBeCloseTo(-2.3);
  });

  it('does not retain floating-point lateral noise on identical geometry', () => {
    const a = continuityTile(left, LifeLine.roadMajor, 77, 0, 1),
      b = continuityTile(right, LifeLine.roadMajor, 77, 0, 1);
    a.life.widths[0] = b.life.widths[0] = 9.6;
    const source = new TileLife(left, a.life, 2),
      target = new TileLife(right, b.life, 1),
      m = continuityMover(source, 4095);
    Object.assign(m, { lane: 0.9, chosenLane: 0.1 });
    const preview = target.projectFrom(m, source)!;
    expect(preview.lat).toBeUndefined();
    expect(preview.maneuver).toBeUndefined();
    expect(target.offsetVaries(preview)).toBe(false);
  });

  it.each([
    { width: 5.5, oneway: 1 as const, offset: 2.15 },
    { width: 11, oneway: 0 as const, offset: 4.9 },
  ])(
    'preserves a legal single-lane edge filter on a $width m road',
    ({ width, oneway, offset }) => {
      const a = continuityTile(left, LifeLine.roadMajor, 77, 0, oneway),
        b = continuityTile(right, LifeLine.roadMajor, 77, 0, oneway);
      a.life.widths[0] = b.life.widths[0] = width;
      const source = new TileLife(left, a.life, 2),
        target = new TileLife(right, b.life, 1);
      for (const life of [source, target]) {
        life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
        life.scenes.sites.length = 0;
      }
      const m = continuityMover(source, 4095);
      Object.assign(m, { vehicle: 'motorcycle', lane: 0.5, chosenLane: 0.5, v: 0 });
      const fit = source.filterCorridor(m, {
        kind: 'filter',
        target: 0.5,
        corridor: 1,
        queueSpeed: 0,
      })!;
      m.lat = fit.offset - source.offsetOf(m);
      m.maneuver = fit.maneuver;
      m.laneSignal = 'right';
      source.movers.push(m);
      const before = structuredClone(m),
        old = source.pose(m),
        preview = target.projectFrom(m, source)!;
      expect(target.directionalLanes(0).count).toBe(1);
      expect(target.offsetOf(preview)).toBeCloseTo(offset);
      expect(target.pose(preview).y).toBeCloseTo(old.y);
      expect(preview.maneuver?.kind).toBe('filter');
      expect(target.adoptFrom(m, source, {}, () => false)).toBe(false);
      expect(m).toEqual(before);
      expect(target.adoptFrom(m, source)).toBe(true);
      const queued = continuityMover(target, m.x + 30 * target.perMeter);
      Object.assign(queued, { lane: 0.5, speed: 0, v: 0 });
      target.movers.push(queued);
      target.step(0.1);
      expect(m.maneuver?.kind).toBe('filter');
      target.movers.splice(target.movers.indexOf(queued), 1);
      // Exercise an admitted return after transfer, independently of the carried queue-loss trigger.
      m.maneuver = { ...m.maneuver, returning: true };
      for (let step = 0; step < 10 * 30 && m.maneuver; step++) target.step(1 / 30);
      expect(m.maneuver).toBeUndefined();
      expect(m.lat).toBeUndefined();
      expect(m.latYaw).toBeUndefined();
      expect(m.laneSignal).toBeUndefined();
    },
  );

  it('converts an unsupported corridor to a guarded return while refusal preserves the source', () => {
    const a = continuityTile(left, LifeLine.roadMajor, 77, 0, 1),
      b = continuityTile(right, LifeLine.roadMajor, 77, 0, 1);
    a.life.widths[0] = 5.5;
    b.life.widths[0] = 0.9;
    const source = new TileLife(left, a.life, 2),
      target = new TileLife(right, b.life, 1),
      m = continuityMover(source, 4095);
    Object.assign(m, { vehicle: 'motorcycle', lane: 0.5, chosenLane: 0.5 });
    const fit = source.filterCorridor(m, { kind: 'filter', target: 0.5, corridor: 1 })!;
    m.lat = fit.offset - source.offsetOf(m);
    m.maneuver = fit.maneuver;
    source.movers.push(m);
    const before = structuredClone(m),
      old = source.pose(m),
      preview = target.projectFrom(m, source)!;
    expect(target.pose(preview).y).toBeCloseTo(old.y);
    expect(preview.maneuver?.kind).toBe('return');
    expect(preview.maneuver?.corridor).toBeUndefined();
    expect(target.adoptFrom(m, source, {}, () => false)).toBe(false);
    expect(m).toEqual(before);
  });

  it.each(['lane', 'filter'] as const)(
    'rebases an active %s maneuver across differing lane counts without teleporting',
    (kind) => {
      const a = continuityTile(parent, LifeLine.roadMajor, 77, 0, 1);
      const b = continuityTile(left, LifeLine.roadMajor, 77, 0, 1);
      a.life.widths[0] = 9.6;
      b.life.widths[0] = 6.4;
      const source = new TileLife(parent, a.life, 1),
        target = new TileLife(left, b.life, 2);
      source.movers.length = target.movers.length = 0;
      const m = continuityMover(source, 1500);
      Object.assign(m, {
        lane: 0.9,
        chosenLane: 0.9,
        lat: kind === 'lane' ? -2 : -1.6,
        latYaw: -0.1,
        roadShift: 0.2,
        roadYaw: 0.03,
        maneuver: {
          kind,
          target: 0.5,
          corridor: kind === 'filter' ? 2 / 3 : undefined,
          queueSpeed: 1,
        },
        laneSignal: 'left',
        lanePatience: 1.4,
        laneCooldown: 6,
        filterRetry: 3,
        roadScan: 0.3,
      });
      source.movers.push(m);
      const before = structuredClone(m),
        old = source.pose(m),
        frame = frameBetween(parent, left);
      const preview = target.projectFrom(m, source)!;
      const pose = target.pose(preview);
      expect(pose.x).toBeCloseTo(frame.x + old.x * frame.scale);
      expect(pose.y).toBeCloseTo(frame.y + old.y * frame.scale);
      expect(pose.hx).toBeCloseTo(old.hx);
      expect(preview.maneuver?.kind).toBe(kind === 'lane' ? 'return' : 'filter');
      if (kind === 'filter') expect(preview.maneuver?.corridor).toBe(0.5);
      expect(m).toEqual(before);
      expect(target.adoptFrom(m, source, {}, () => false)).toBe(false);
      expect(m).toEqual(before);
      expect(target.adoptFrom(m, source)).toBe(true);
      expect(m.speed / target.perMeter).toBe(before.speed / source.perMeter);
      for (const field of [
        'laneSignal',
        'lanePatience',
        'laneCooldown',
        'filterRetry',
        'roadScan',
      ] as const)
        expect(m[field]).toBe(before[field]);
      expect(m.lat).toBeCloseTo(preview.lat!);
    },
  );

  for (const kind of [LifeLine.roadMajor, LifeLine.river, LifeLine.rail])
    it(`carries identity, rendered pose and physical velocity on line kind ${kind}`, () => {
      const { world, life, movers } = fixture(kind);
      const crossingHold = {
        key: 'geographic-crossing',
        x: 100,
        y: 200,
        radius: 8,
        elapsed: 7,
        expired: false,
      };
      if (kind === LifeLine.roadMajor)
        for (const m of movers) {
          m.pedestrianHolds = [crossingHold];
          m.roadShift = 0.4;
        }
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
        expect(m.pedestrianHolds).toEqual(state.pedestrianHolds);
        expect(m.roadShift).toBe(state.roadShift);
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
  it.each([1, -1] as const)(
    'keeps repeated-coordinate routing on the first matching arm (direction %i)',
    (dir) => {
      const a = new LifeBuilder(),
        b = new LifeBuilder();
      for (const builder of [a, b]) {
        builder.line(
          [
            { x: 0, y: 2000 },
            { x: 400, y: 2000 },
          ],
          LifeLine.roadMajor,
          8,
          77,
        );
        const arm = [
          { x: 400, y: 2000 },
          { x: 400, y: 2000 },
          { x: 400, y: 3000 },
        ];
        builder.line(dir === 1 ? arm : [...arm].reverse(), LifeLine.roadMajor, 8, 88, dir);
      }
      const duplicate = [
        { x: 400, y: 2000 },
        { x: 400, y: 2000 },
        { x: 400, y: 3000 },
      ];
      b.line(dir === 1 ? duplicate : [...duplicate].reverse(), LifeLine.roadMajor, 8, 88, dir);
      const source = new TileLife(left, a.finish(), 1),
        target = new TileLife(left, b.finish(), 2);
      const m = continuityMover(source, 100),
        exit = dir === 1 ? 2 : 3;
      m.d = 100;
      m.junctionRoute = { key: 'repeated', exits: [exit] };
      m.routing = {
        seed: 10,
        turns: 7,
        plan: { line: 0, dir: 1, vertex: 1, exit, target: source.directedExit(exit, 1), radius: 4 },
      };
      const before = structuredClone(m),
        preview = target.projectFrom(m, source)!;
      expect(preview.junctionRoute?.exits).toEqual([exit]);
      expect(preview.routing?.plan?.exit).toBe(exit);
      expect(m).toEqual(before);
    },
  );
  it.each([1, -1] as const)(
    'remaps an interior arm in direction %i without connecting a merely nearby plan',
    (direction) => {
      const a = new LifeBuilder(),
        b = new LifeBuilder();
      for (const builder of [a, b])
        builder.line(
          [
            { x: 0, y: 2000 },
            { x: 400, y: 2000 },
          ],
          LifeLine.roadMajor,
          8,
          77,
        );
      a.line(
        [
          { x: 400, y: 1000 },
          { x: 400, y: 2000 },
          { x: 400, y: 3000 },
        ],
        LifeLine.roadMajor,
        8,
        88,
      );
      b.line(
        [
          { x: 1000, y: 500 },
          { x: 1500, y: 500 },
        ],
        LifeLine.roadMajor,
        8,
        88,
      );
      const arm = [
        { x: 400, y: 1000 },
        { x: 400, y: 2000 },
        { x: 400, y: 3000 },
      ];
      b.line(direction === 1 ? arm : [...arm].reverse(), LifeLine.roadMajor, 8, 88, direction);
      // Same way identity and quantized proximity do not establish exact plan connectivity.
      b.line(
        arm.map((p) => ({ ...p, x: p.x + 0.4 })),
        LifeLine.roadMajor,
        8,
        88,
        1,
      );
      const source = new TileLife(left, a.finish(), 1),
        target = new TileLife(left, b.finish(), 2),
        m = continuityMover(source, 100);
      m.d = 100;
      m.junctionRoute = { key: 'interior', exits: [2] };
      m.routing = {
        seed: 10,
        turns: 7,
        indicating: true,
        plan: { line: 0, dir: 1, vertex: 1, exit: 2, target: source.directedExit(2, 1), radius: 4 },
      };
      const before = structuredClone(m),
        preview = target.projectFrom(m, source)!;
      const exit = direction === 1 ? 4 : 5;
      expect(preview.junctionRoute?.exits).toEqual([exit]);
      expect(preview.routing?.plan?.exit).toBe(exit);
      expect(preview.routing?.plan?.target).toEqual(target.directedExit(exit, 1));
      expect(m).toEqual(before);
    },
  );
  it('remaps a quantized curve and linked exits by identity before adopting their local frame', () => {
    const sourceTile = { z: 16, x: 55192, y: 30266 };
    const targetTile = { ...sourceTile, x: sourceTile.x + 1 };
    const a = new LifeBuilder(),
      b = new LifeBuilder();
    a.line(
      [
        { x: 0, y: 2000 },
        { x: 4200, y: 2000 },
      ],
      LifeLine.roadMajor,
      8,
      77,
    );
    a.line(
      [
        { x: 4200, y: 2000 },
        { x: 4200, y: 3000 },
      ],
      LifeLine.roadMajor,
      8,
      88,
      1,
    );
    b.line(
      [
        { x: 1000, y: 500 },
        { x: 1500, y: 500 },
      ],
      LifeLine.roadMinor,
      6,
      99,
    );
    b.line(
      [
        { x: -4096, y: 2000.2 },
        { x: 104.4, y: 2000.2 },
      ],
      LifeLine.roadMajor,
      8,
      77,
    );
    b.line(
      [
        { x: 104.4, y: 2000.2 },
        { x: 104.4, y: 3000 },
      ],
      LifeLine.roadMajor,
      8,
      88,
      1,
    );
    const source = new TileLife(sourceTile, a.finish(), 1),
      target = new TileLife(targetTile, b.finish(), 2);
    source.movers.length = target.movers.length = 0;
    const m = continuityMover(source, 4090);
    m.d = 4090;
    m.curveLengthM = 2;
    m.curveCorner = { x: 4200, y: 2000 };
    m.roadShift = 0.2;
    m.waiting = 17;
    m.junctionRoute = { key: 'retained-world-zone', exits: [2] };
    m.routing = {
      seed: 10,
      turns: 7,
      indicating: true,
      plan: { line: 0, dir: 1, vertex: 1, exit: 2, target: source.directedExit(2, 1), radius: 4 },
    };
    source.movers.push(m);
    const before = structuredClone(m);
    const preview = target.projectFrom(m, source)!;
    expect(preview.curveCorner).toEqual({ x: target.geo.coords[6]!, y: target.geo.coords[7]! });
    expect(preview.junctionRoute).toEqual({ key: 'retained-world-zone', exits: [4] });
    expect(preview.routing?.plan?.target).toEqual(target.directedExit(4, 3));
    expect(target.adoptFrom(m, source, {}, () => false)).toBe(false);
    expect(m).toEqual(before);
    expect(source.movers).toContain(m);
    expect(target.adoptFrom(m, source)).toBe(true);
    expect(m.curveCorner).toEqual(preview.curveCorner);
    expect(m.curveLengthM).toBe(2);
    expect(m.roadShift).toBe(0.2);
    expect(m.junctionRoute).toEqual(preview.junctionRoute);
    expect(m.waiting).toBe(17);
    expect(m.routing?.turns).toBe(7);
    expect(source.movers).not.toContain(m);
    expect(target.movers).toContain(m);
  });
  it('hands a split road vehicle across a tile seam onto the matching way piece', () => {
    const entries = [left, right].map((tile) => {
      const b = new LifeBuilder();
      b.line(
        [
          { x: -100, y: 2000 },
          { x: 2000, y: 2000 },
          { x: 4196, y: 2000 },
        ],
        LifeLine.roadMajor,
        6,
        77,
      );
      b.line(
        [
          { x: 2000, y: 1000 },
          { x: 2000, y: 2000 },
        ],
        LifeLine.roadMinor,
        6,
        88,
      );
      b.splitRoadJunctions(1 / metersPerUnit(tile), 40);
      return { key: `${tile.z}/${tile.x}/${tile.y}`, tile, life: b.finish() };
    });
    const world = new LifeWorld({ road_major: { car: 1 } });
    world.sync(entries);
    const source = worldTiles(world).get(entries[0]!.key)!;
    const target = worldTiles(world).get(entries[1]!.key)!;
    for (const life of [source, target]) {
      life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
      life.scenes.sites.length = 0;
    }
    const m = continuityMover(source, 4090);
    m.line = 1;
    m.from = source.geo.starts[1]!;
    m.d = m.x - 2000;
    const routing = structuredClone(m.routing);
    source.movers.push(m);
    for (let frame = 0; frame < 100 && !target.movers.includes(m); frame++)
      world.step(0.1, undefined, 18);
    expect(source.movers).not.toContain(m);
    expect(target.movers).toContain(m);
    expect(m.line).toBe(0);
    expect(target.geo.lineIds![m.line]).toBe(77);
    expect(m.routing?.seed).toBe(routing?.seed);
    expect(m.routing?.turns).toBe(routing?.turns);
    expect(m.x).toBeGreaterThanOrEqual(0);
    assertUnique(world);
  });
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
