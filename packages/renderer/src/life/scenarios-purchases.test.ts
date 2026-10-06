import { expect, it } from 'vitest';
import { makeScenario, worldTiles } from './testing/scenarios';
import { valid } from './testing/scenario-checks';
import { LifeWorld } from './simulate';
import { LifeBuilder, LifeLine } from './geometry';
import { remoteGroundEvent } from './testing/processions';

// Split from scenarios.test.ts so these run in parallel with the soaks.
for (const [seed, remoteEvent] of [
  [1, false],
  [42, false],
  [1, true],
] as const) {
  it(`seed ${seed}, remote event ${remoteEvent}: purchases and boarding complete through the world's collision guard`, () => {
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
    if (remoteEvent) {
      world.setProcessions([remoteGroundEvent]);
      world.setLive(remoteGroundEvent.id, 0.6, 'remote');
    }
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
    const vendorStates = new Set<string>();
    const expectedStates = ['wait', 'purchase', 'board', 'aboard', 'return'];
    const originalVisits = new Map(people.map((p) => [p, tile.scenes.visits.get(p)!]));
    const returning = new Set<(typeof people)[number]>();
    const completed = new Set<(typeof people)[number]>();
    let services = 0;
    for (let frame = 0; frame < 30 * 30; frame++) {
      world.step(1 / 30, undefined, 18, s.bounds, undefined, { rain: 0 }, 0.9);
      world.visible(18, s.levels, s.center, undefined, s.bounds);
      for (const visit of tile.scenes.visits.values()) states.add(visit.state);
      const vendorVisit = tile.scenes.visits.get(people[1]!);
      if (vendorVisit) vendorStates.add(vendorVisit.state);
      for (const p of people) {
        const visit = tile.scenes.visits.get(p);
        if (visit === originalVisits.get(p) && visit?.state === 'return') returning.add(p);
        if (returning.has(p) && visit !== originalVisits.get(p)) completed.add(p);
      }
      services = Math.max(services, tile.scenes.services.size);
      if (frame % 60 === 0) valid(world);
      if (completed.size === people.length) break;
    }
    valid(world);
    if (remoteEvent) {
      expect(tile.eventPopulation).toBe(0);
      for (const state of ['approach', 'wait', 'purchase', 'return'])
        expect(vendorStates.has(state)).toBe(true);
    }
    expect(services).toBeGreaterThan(0);
    expect(completed.size).toBe(people.length);
    for (const state of expectedStates)
      expect(states.has(state), `missing ${state}; observed ${[...states].join(', ')}`).toBe(true);
  });
}
