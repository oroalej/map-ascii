import { describe, expect, it } from 'vitest';
import { LifeBuilder, LifeLine } from './geometry';
import { LifeWorld, type Gatherer, type Mover, type Walker } from './simulate';
import { activityLevels } from './config';
import { completeScenarioState, makeScenario, worldTiles } from './testing/scenarios';
import { metersPerUnit, tileToLngLat } from '../raster/geometry';
import { cellStep, DEFAULT_CELLS, stepCell } from '../density';
import { metersPerCssPx } from '../grid';

const tileId = { z: 16, x: 55192, y: 30266 };
const pm = 1 / metersPerUnit(tileId);
const levels = activityLevels(1);
const member: Walker = {
  figure: 'adult',
  shirt: 2,
  umbrella: 1,
  canopy: 0,
  lateral: 0,
  back: 0,
  step: 0,
};
function fixture(enabled = true, withStop = false) {
  const b = new LifeBuilder();
  b.line(
    [
      { x: 0, y: 1000 },
      { x: 4095, y: 1000 },
    ],
    LifeLine.path,
  );
  b.line(
    [
      { x: 0, y: 1800 },
      { x: 4095, y: 1800 },
    ],
    LifeLine.path,
  );
  b.place({ x: 1600, y: 1800 }, 'monument', 2 * pm);
  b.place({ x: 2600, y: 2600 }, 'pitch', 14 * pm);
  if (withStop) b.site({ x: 800 + 2 * pm, y: 1000 }, 0, 7, true);
  const world = new LifeWorld(undefined, undefined, { enabled, rng: () => 0 });
  const input = { key: 'moment-fixture', tile: tileId, life: b.finish() };
  world.sync([input]);
  const tile = worldTiles(world).get(input.key)!;
  const exemplar = tile.movers.find((m) => m.kind === 'person')!;
  const walker = (x: number, y: number, hx = 1, line = 0): Mover => ({
    ...exemplar,
    line,
    from: tile.geo.starts[line]!,
    dir: hx > 0 ? 1 : -1,
    d: x,
    x,
    y,
    hx,
    hy: 0,
    group: [{ ...member }],
    pause: 0.5,
    rank: 0,
    avoid: 0,
  });
  const a = walker(800, 1000),
    bWalker = walker(800 + 2.5 * pm, 1000, -1);
  bWalker.from = tile.geo.starts[1]! - 1;
  bWalker.d = 4095 - bWalker.x;
  const looker = walker(1600 - 10 * pm, 1800, 1, 1);
  tile.movers.splice(0, tile.movers.length, a, bWalker, looker);
  const gather = (place: 'monument' | 'pitch', source: number, x: number, y: number): Gatherer => {
    const original = tile.gatherers.find((g) => g.place === place)!;
    return {
      ...original,
      source,
      x,
      y,
      tx: x + 20,
      ty: y,
      pause: 5,
      rank: 0,
      walker: { ...member, figure: place === 'pitch' ? 'child' : 'adult' },
    };
  };
  const talk = [
    gather('monument', 0, 1600 - 3 * pm, 1800 - 4 * pm),
    gather('monument', 0, 1600 + 3 * pm, 1800 - 4 * pm),
  ];
  const players = [
    gather('pitch', 1, 2600 - 3 * pm, 2600),
    gather('pitch', 1, 2600 + 3 * pm, 2600),
  ];
  tile.gatherers.splice(0, tile.gatherers.length, ...talk, ...players);
  const center = tileToLngLat(tileId, { x: 2048, y: 2048 });
  world.visible(21, levels, center);
  const step = (rain = 0, zoom = 21, width = 0.2) =>
    world.step(0.1, undefined, zoom, undefined, undefined, { rain, minutes: 720 }, width);
  return { world, tile, input, a, b: bWalker, looker, talk, players, center, step };
}

describe('moments through the simulation', () => {
  it('gives existing LocalScenes reservations priority and prevents double booking', () => {
    const reserved = fixture(true, true);
    expect(reserved.tile.scenes.reserve(reserved.a, 0)).toBe(true);
    reserved.step();
    expect(reserved.tile.momentHost.moments.busy(reserved.a)).toBe(false);
    const social = fixture(true, true);
    social.step();
    expect(social.tile.momentHost.moments.busy(social.a)).toBe(true);
    expect(social.tile.scenes.reserve(social.a, 0)).toBe(false);
    expect(social.tile.scenes.visits.has(social.a)).toBe(false);
  });
  it('admits all four promptly in a legal noon fixture matrix', () => {
    const counts = { greet: 0, talk: 0, ball: 0, look: 0 };
    let balls = 0;
    for (const zoom of [18, 19.5, 21]) {
      const f = fixture();
      const css = stepCell(DEFAULT_CELLS, cellStep(DEFAULT_CELLS, zoom));
      const width = metersPerCssPx({ lng: f.center[0], lat: f.center[1], zoom }) * css.width;
      for (let frame = 0; frame < 20; frame++) {
        f.step(0, zoom, width);
        const visible = f.world.visible(zoom, levels, f.center);
        balls += visible.filter((a) => a.prop === 'ball').length;
      }
      for (const kind of Object.keys(counts) as (keyof typeof counts)[])
        counts[kind] += f.tile.momentHost.moments.stats.started[kind];
    }
    for (const value of Object.values(counts)) expect(value).toBeGreaterThan(0);
    expect(balls).toBeGreaterThan(0);
  });
  it('holds route cursors, detours and gatherer targets, then resumes through the guard', () => {
    const f = fixture();
    f.a.avoid = 0.1;
    const route = {
      line: f.a.line,
      from: f.a.from,
      dir: f.a.dir,
      d: f.a.d,
      avoid: f.a.avoid,
      x: f.a.x,
      y: f.a.y,
      hx: f.a.hx,
      hy: f.a.hy,
    };
    const target = { tx: f.talk[0]!.tx, ty: f.talk[0]!.ty };
    f.step();
    expect(f.tile.momentHost.moments.busy(f.a)).toBe(true);
    for (let i = 0; i < 10; i++) f.step();
    expect(Object.fromEntries(Object.keys(route).map((k) => [k, f.a[k as keyof Mover]]))).toEqual(
      route,
    );
    expect({ tx: f.talk[0]!.tx, ty: f.talk[0]!.ty }).toEqual(target);
    expect(f.a.pause).toBe(0);
    f.step(0.8);
    expect(f.tile.momentHost.moments.busy(f.a)).toBe(false);
    expect(f.a.d).not.toBe(route.d);
    expect(f.a.momentFacing).toBeUndefined();
  });
  it('uses displayed heading in physical bodies and preserves the detoured center', () => {
    const f = fixture();
    f.a.avoid = 0.5;
    const before = f.tile.pose(f.a);
    f.a.momentFacing = { hx: 0, hy: 1 };
    const after = f.tile.pose(f.a),
      body = f.tile.groundBodies(f.a)[0]!;
    expect([after.x, after.y]).toEqual([before.x, before.y]);
    expect([body.hx, body.hy]).toEqual([0, 1]);
    expect(body.x * pm).toBeCloseTo(after.x, 10);
    expect(body.y * pm).toBeCloseTo(after.y, 10);
  });
  it('removes balls when a player is culled, and never spends existing visible capacity', () => {
    const f = fixture();
    for (let i = 0; i < 8; i++) f.step();
    expect(f.world.visible(21, levels, f.center).some((a) => a.prop === 'ball')).toBe(true);
    expect(f.world.visible(21, levels, f.center, undefined, undefined, 1, 0)).toEqual([]);
    f.players[0]!.rank = 0.9;
    expect(
      f.world.visible(21, levels, f.center, undefined, undefined, 0.5).some((a) => a.prop),
    ).toBe(false);
    const capped = f.world.visible(21, levels, f.center, undefined, undefined, 1, 1);
    expect(capped.some((a) => a.prop)).toBe(false);
  });
  it('releases ownership on eviction and traffic reset and respawns deterministically', () => {
    const f = fixture();
    f.step();
    expect(f.tile.momentHost.moments.snapshot().active.length).toBeGreaterThan(0);
    f.world.sync([]);
    expect(f.tile.momentHost.moments.snapshot().active).toEqual([]);
    expect(f.tile.momentHost.moments.snapshot().cooldown).toEqual([]);
    expect(f.a.momentFacing).toBeUndefined();
    f.world.sync([f.input]);
    const tile = [...worldTiles(f.world).values()][0]!;
    expect(tile).not.toBe(f.tile);
    expect(tile.momentHost.moments.snapshot().active).toEqual([]);
    f.world.setTraffic();
    expect(worldTiles(f.world).size).toBe(0);
  });
  it('preserves initial population, looks and random draws when disabled per instance', () => {
    const tiles = makeScenario('moments', 1).tiles;
    const on = new LifeWorld(),
      off = new LifeWorld(undefined, undefined, { enabled: false });
    on.sync(tiles);
    off.sync(tiles);
    expect(
      [...worldTiles(on).values()].map((t) => [t.movers, t.gatherers, t.parked, t.flocks]),
    ).toEqual(
      [...worldTiles(off).values()].map((t) => [t.movers, t.gatherers, t.parked, t.flocks]),
    );
  });
  it('keeps isolated traffic identical with moments enabled and disabled', () => {
    const tiles = makeScenario('transit', 1).tiles;
    const on = new LifeWorld(),
      off = new LifeWorld(undefined, undefined, { enabled: false });
    for (const world of [on, off]) {
      world.sync(tiles);
      for (const t of worldTiles(world).values())
        t.movers.splice(0, t.movers.length, ...t.movers.filter((m) => m.kind !== 'person'));
      world.visible(18, levels, tileToLngLat(tileId, { x: 2048, y: 2048 }));
    }
    for (let frame = 0; frame < 60; frame++) {
      for (const world of [on, off])
        world.step(1 / 30, undefined, 18, undefined, undefined, { rain: 0 }, 0.9);
    }
    expect([...worldTiles(on).values()].map((t) => t.movers)).toEqual(
      [...worldTiles(off).values()].map((t) => t.movers),
    );
  });
  it('keeps full moment state independent of draw quality and repeats at each supported rate', () => {
    for (const hz of [30, 60, 120]) {
      const a = fixture(),
        b = fixture();
      for (let i = 0; i < 2 * hz; i++) {
        for (const f of [a, b])
          f.world.step(1 / hz, undefined, 21, undefined, undefined, { rain: 0 }, 0.2);
        a.world.visible(21, levels, a.center);
        b.world.visible(21, levels, b.center, undefined, undefined, 0.3, 2);
      }
      expect(completeScenarioState(b.world)).toEqual(completeScenarioState(a.world));
      expect(a.tile.momentHost.moments.stats.started.ball).toBeGreaterThan(0);
    }
  });
});
