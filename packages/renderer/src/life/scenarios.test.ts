import { describe, expect, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  makeScenario,
  scenarioState,
  worldTiles,
  retiredTiles,
  SCENE_CURB_Y,
  SCENARIO_DIALOGUE,
} from './testing/scenarios';
import { LifeWorld, type Mover, type TileLife } from './simulate';
import { LifeBuilder, LifeLine } from './geometry';
import { MAX_STEP_S } from './config';
import { bodiesOverlap, type Body, bodyCorners, Occupancy, PolygonIndex } from './occupancy';

it('exercises scene speech and visible cues when a performance scenario opts into dialogue', () => {
  const scenario = makeScenario('moments', 1, false, 1, LifeWorld, undefined, {
    dialogue: SCENARIO_DIALOGUE,
  });
  bounded(scenario.world);
  let cues = 0;
  for (let frame = 0; frame < 300; frame++)
    cues += scenario.step(frame).filter((agent) => agent.speech?.id.includes(':scene:')).length;
  const admissions = [...worldTiles(scenario.world).values()].reduce(
    (sum, tile) =>
      sum +
      Object.values(tile.momentHost.scenes.selector.selected).reduce((n, count) => n + count, 0),
    0,
  );
  expect(admissions).toBeGreaterThan(0);
  expect(cues).toBeGreaterThan(0);
});

function valid(world: LifeWorld) {
  const owners = new Set<object>();
  for (const tile of [
    ...worldTiles(world).values(),
    ...[...retiredTiles(world).values()].map((entry) => entry.life),
  ]) {
    for (const m of [...tile.movers, ...tile.gatherers]) {
      assert.equal(owners.has(m), false, 'duplicate owner');
      owners.add(m);
      assert.ok([m.x, m.y, m.hx, m.hy].every(Number.isFinite), 'non-finite position');
    }
    const queued = new Set<Mover>();
    for (const site of tile.scenes.sites) {
      const seats = new Set<number>();
      for (const m of site.queue) {
        assert.equal(queued.has(m), false, 'duplicate reservation');
        queued.add(m);
        const v = tile.scenes.visits.get(m)!;
        assert.equal(v.site, site);
        for (let i = 0; i < (m.group?.length ?? 1); i++) {
          const slot = v.seat + i;
          assert.ok(slot < site.capacity, 'queue over capacity');
          assert.equal(seats.has(slot), false, 'duplicate seat');
          seats.add(slot);
        }
      }
      assert.ok(
        [...tile.scenes.services.values()].filter((s) => s.site === site).length <=
          (site.kind === 'terminal' ? 3 : 1),
        'service over capacity',
      );
      assert.ok(
        [...tile.scenes.visits.values()].filter((v) => v.site === site && v.state === 'board')
          .length <= 1,
        'multiple boarding groups',
      );
    }
    for (const [m, visit] of tile.scenes.visits) {
      assert.ok(tile.movers.includes(m), 'orphan visit');
      if (['return', 'board', 'aboard'].includes(visit.state))
        assert.equal(queued.has(m), false, 'released visit still reserves a queue slot');
      assert.equal(tile.scenes.hidden(m), visit.state === 'aboard');
    }
    for (const m of tile.scenes.services.keys())
      assert.ok(tile.movers.includes(m), 'orphan service');
    const retained = tile.scenes as unknown as {
      cooldown: Map<Mover, number>;
      stopCooldown: Map<Mover, unknown>;
    };
    assert.ok(retained.cooldown.size <= tile.movers.length);
    assert.ok(retained.stopCooldown.size <= tile.movers.length);
  }
}
function bounded(world: LifeWorld) {
  // CI checks long lifecycles with a bounded population; CPU benchmarks retain full density.
  for (const tile of worldTiles(world).values()) {
    if (tile.movers.length <= 48) continue;
    const near = (m: Mover) => Math.hypot(m.x - 1900, m.y - SCENE_CURB_Y);
    const targets = [
      { x: 1900, y: SCENE_CURB_Y },
      tile.scenes.sites.find((s) => s.kind === 'vendor') ?? { x: 1300, y: 1800 },
      tile.scenes.sites.find((s) => s.kind === 'shelter') ?? { x: 1800, y: 800 },
    ];
    const people = targets.flatMap((p) =>
      tile.movers
        .filter((m) => m.kind === 'person')
        .sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))
        .slice(0, 4),
    );
    const keep = [
      ...new Set(people),
      ...['vehicle', 'dog', 'cat'].flatMap((kind) =>
        tile.movers
          .filter((m) => m.kind === kind)
          .sort((a, b) => near(a) - near(b))
          .slice(0, 12),
      ),
    ];
    tile.movers.splice(0, tile.movers.length, ...keep);
    tile.gatherers.splice(12);
  }
}

describe('combined living-city scenarios', () => {
  for (const seed of [1]) {
    for (const kind of ['junction', 'transit', 'rain'] as const) {
      it(`${kind}, seed ${seed}: 180 seconds retain finite positions and valid ownership`, () => {
        const s = makeScenario(kind, 4, false, seed);
        bounded(s.world);
        let visits = 0,
          services = 0;
        const states = new Set<string>();
        for (let frame = 0; frame < 180 * 30; frame++) {
          const agents = s.step(frame);
          assert.ok(agents.length <= 1200, 'visible cap exceeded');
          for (const tile of worldTiles(s.world).values()) {
            visits = Math.max(visits, tile.scenes.visits.size);
            services = Math.max(services, tile.scenes.services.size);
            for (const visit of tile.scenes.visits.values()) states.add(visit.state);
          }
          if (frame % 60 === 0) valid(s.world);
        }
        valid(s.world);
        if (kind !== 'junction') expect(visits).toBeGreaterThan(0);
        if (kind === 'transit') {
          expect(services).toBeGreaterThan(0);
          expect(states.has('wait')).toBe(true);
        }
        if (kind === 'rain') expect(states.has('shelter')).toBe(true);
      }, 30_000);
    }
  }
  for (const seed of [1, 42]) {
    it(`seed ${seed}: view changes revive tiles and respawn deterministically after expiry`, () => {
      const s = makeScenario('transit', 4, false, seed);
      bounded(s.world);
      const original = worldTiles(s.world).get(s.tiles[0]!.key)!;
      for (let cycle = 0; cycle < 100; cycle++) {
        s.world.sync(s.tiles.slice(0, 1));
        expect(worldTiles(s.world).get(s.tiles[0]!.key)).toBe(original);
        const before = original.movers.map((m) => [m.x, m.y, m.pause]);
        for (let frame = 0; frame < 30; frame++)
          s.world.step(1 / 30, undefined, 18, [0, 0, 0.001, 0.001]);
        expect(original.movers.map((m) => [m.x, m.y, m.pause])).toEqual(before);
        s.world.sync(s.tiles);
        bounded(s.world);
        for (let frame = 0; frame < 24; frame++) s.step(frame);
        valid(s.world);
      }
      s.world.sync([]);
      expect(worldTiles(s.world).size).toBe(0);
      expect((s.world as unknown as { groundTerrain?: unknown }).groundTerrain).toBeUndefined();
      for (let i = 0; i < 90; i++) s.world.step(0.1);
      expect(retiredTiles(s.world).size).toBe(0);
      s.world.sync(s.tiles);
      bounded(s.world);
      const fresh = makeScenario('transit', 4, false, seed);
      bounded(fresh.world);
      expect(scenarioState(s.world)).toEqual(scenarioState(fresh.world));
      expect(worldTiles(s.world).get(s.tiles[0]!.key)).not.toBe(original);
      s.world.setTraffic();
      expect(worldTiles(s.world).size).toBe(0);
    }, 30_000);
    it(`seed ${seed}: purchases and boarding complete through the world's collision guard`, () => {
      const s = makeScenario('transit', 1, false, seed);
      const b = new LifeBuilder();
      b.line(
        [
          { x: 0, y: 2048 },
          { x: 4095, y: 2048 },
        ],
        LifeLine.roadMajor,
        6,
      );
      b.line(
        [
          { x: 0, y: 2090 },
          { x: 4095, y: 2090 },
        ],
        LifeLine.path,
      );
      // Give the cart's customer side its own walkway, so the route avoids its body.
      const customerY = 2090 + 2.5 * [...worldTiles(s.world).values()][0]!.perMeter;
      b.line(
        [
          { x: 0, y: customerY },
          { x: 4095, y: customerY },
        ],
        LifeLine.path,
      );
      b.site({ x: 1900, y: 2090 }, 0, 7, true);
      b.market({ x: 2300, y: 2090 });
      const world = new LifeWorld({ road_major: { jeepney: 1 } });
      world.sync([{ ...s.tiles[0]!, life: b.finish() }]);
      const tile = [...worldTiles(world).values()][0]!;
      const people = tile.movers.filter((m) => m.kind === 'person').slice(0, 2);
      const vehicle = tile.movers.find((m) => m.kind === 'vehicle')!;
      tile.movers.splice(0, tile.movers.length, ...people, vehicle);
      tile.gatherers.length = 0;
      const stop = tile.scenes.sites.findIndex((site) => site.kind === 'stop');
      const vendorSite = tile.scenes.sites
        .filter((site) => site.kind === 'vendor' && Math.abs(site.y - customerY) < 0.01)
        .sort((a, b) => Math.abs(a.x - 2300) - Math.abs(b.x - 2300))[0]!;
      const vendor = tile.scenes.sites.indexOf(vendorSite);
      vendorSite.stall!.rank = 0;
      for (const [i, index] of [stop, vendor].entries()) {
        const p = people[i]!,
          site = tile.scenes.sites[index]!;
        Object.assign(p, {
          x: site.x - 10,
          y: site.y,
          hx: 1,
          hy: 0,
          line: 1,
          from: 0,
          dir: 1,
          d: site.x - 10,
          pause: 0,
          rank: 0,
          speed: 1.5 * tile.perMeter,
        });
        p.group = [{ ...p.group![0]!, lateral: 0, back: 0 }];
        expect(tile.scenes.reserve(p, index)).toBe(true);
      }
      Object.assign(vehicle, {
        x: 1800,
        y: 2048,
        hx: 1,
        hy: 0,
        line: 0,
        from: 0,
        dir: 1,
        d: 1800,
        speed: 2 * tile.perMeter,
        pause: 0,
        rank: 0,
      });
      world.visible(18, s.levels, s.center, undefined, s.bounds);
      const states = new Set<string>();
      let services = 0;
      for (let frame = 0; frame < 180 * 30; frame++) {
        world.step(1 / 30, undefined, 18, s.bounds, undefined, { rain: 0 }, 0.9);
        world.visible(18, s.levels, s.center, undefined, s.bounds);
        for (const visit of tile.scenes.visits.values()) states.add(visit.state);
        services = Math.max(services, tile.scenes.services.size);
        if (frame % 60 === 0) valid(world);
      }
      valid(world);
      expect(services).toBeGreaterThan(0);
      for (const state of ['wait', 'purchase', 'board', 'aboard', 'return'])
        expect(states.has(state), `missing ${state}; observed ${[...states].join(', ')}`).toBe(
          true,
        );
    }, 30_000);
  }
  for (const hz of [30, 60, 120])
    it(`replays ${hz} Hz inputs exactly and clamps oversized steps`, () => {
      const a = makeScenario('rain', 1),
        b = makeScenario('rain', 1);
      bounded(a.world);
      bounded(b.world);
      for (let frame = 0; frame < hz * 3; frame++) {
        assert.deepEqual(a.step(frame, 1 / hz), b.step(frame, 1 / hz));
      }
      expect(scenarioState(a.world)).toEqual(scenarioState(b.world));
      a.world.step(100, undefined, 18, a.bounds);
      b.world.step(MAX_STEP_S, undefined, 18, b.bounds);
      expect(scenarioState(a.world)).toEqual(scenarioState(b.world));
    });
});

describe('collision storage isolation', () => {
  it('reuses caller storage without changing allocating callers or retaining query neighbors', () => {
    const s = makeScenario('junction', 1),
      tile: TileLife = [...worldTiles(s.world).values()][0]!;
    const m = tile.movers.find((m) => m.kind === 'person')!;
    const out: Body[] = [];
    const fresh = tile.groundBodies(m, 0.9);
    expect(tile.groundBodies(m, 0.9, out)).toEqual(fresh);
    const first = out[0];
    m.x += 2;
    tile.groundBodies(m, 0.9, out);
    expect(out[0]).toBe(first);
    expect(out).not.toEqual(fresh);
    const corners = bodyCorners(out[0]!);
    const saved = corners[0];
    bodyCorners(out[0]!, corners);
    expect(corners[0]).toBe(saved);
    const occupied = new Occupancy(),
      owner = {};
    occupied.set(owner, out);
    expect(occupied.conflicts({}, out)).toBeGreaterThan(0);
    expect((occupied as unknown as { neighbors: Set<object> }).neighbors.size).toBe(0);
    occupied.delete(owner);
    expect((occupied as unknown as { bins: Map<number, unknown> }).bins.size).toBe(0);
    const p = new PolygonIndex();
    p.add([corners]);
    expect(p.hits(out)).toBe(true);
    expect((p as unknown as { tested: Set<unknown> }).tested.size).toBe(0);
    const second = new Occupancy();
    expect(second.conflicts({}, out)).toBe(0);
    expect(bodiesOverlap(out[0]!, out[0]!)).toBe(true);
  });
});
