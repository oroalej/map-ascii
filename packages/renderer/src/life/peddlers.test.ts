import { describe, expect, it, vi } from 'vitest';
import { peddlerBodies, peddlerShare, peddlerWindow, type PeddlerOwner } from './peddlers';
import { MAX_TILE_AGENTS } from './config';
import { LifeBuilder, LifeLine } from './geometry';
import { LifeWorld, type LifeEnv } from './simulate';
import { completeScenarioState, worldTiles } from './testing/scenarios';
import {
  peddlerConfig,
  peddlerFixture,
  peddlerGeometry,
  peddlerPM,
  peddlerTile,
  peddlerCenter,
  peddlerWeather,
} from './testing/peddlers';
import { bodyCorners, bodiesOverlap, type Body } from './occupancy';
import { EXTENT } from '../raster/geometry';
import type { EmojiObservation } from './emoji';

describe('isolated peddler population', () => {
  it('queries ordinary bodies only for owners or an admissible birth attempt', () => {
    const { population } = peddlerFixture([{ ...peddlerConfig, perTile: 1 }]);
    const query = vi.spyOn(population.context, 'ordinary');
    population.step(1, { ...peddlerWeather, minutes: 180 }, 0);
    population.step(1, peddlerWeather, MAX_TILE_AGENTS);
    expect(query).not.toHaveBeenCalled();
    population.step(0, peddlerWeather, 0);
    expect(query).toHaveBeenCalledTimes(1);
    population.step(1, { ...peddlerWeather, minutes: 660 }, 0);
    expect(query).toHaveBeenCalledTimes(2);
    population.clear();
    population.step(1, { ...peddlerWeather, minutes: 660 }, 0);
    expect(query).toHaveBeenCalledTimes(2);
    const absent = peddlerFixture([{ ...peddlerConfig, share: 0 }]).population,
      none = vi.spyOn(absent.context, 'ordinary');
    absent.step(1, peddlerWeather, 0);
    expect(none).not.toHaveBeenCalled();
  });
  it('has no births without a local clock or outside inclusive/exclusive hours', () => {
    const { population } = peddlerFixture();
    for (const minutes of [undefined, 299, 660])
      population.step(1, { ...peddlerWeather, minutes }, 0);
    expect(population.owners).toHaveLength(0);
    population.step(1, { ...peddlerWeather, minutes: 300 }, 0);
    expect(population.owners).toHaveLength(2);
    expect(peddlerWindow({ ...peddlerConfig, hours: { from: 18, to: 2 } }, 60)).toMatchObject({
      elapsed: 420,
      progress: 0.875,
    });
  });
  it('retains admission ranks across thousands of reduced-share opportunities', () => {
    const { population } = peddlerFixture([{ ...peddlerConfig, share: 0.3 }]);
    const expected = population.slots.filter((s) => s.rank < 0.3).length;
    for (let i = 0; i < 1000; i++) population.step(0.1, peddlerWeather, 0);
    expect(population.owners).toHaveLength(expected);
  });
  it('uses the minimum applicable override, preserves missing overrides, and forbids storms', () => {
    const config = { ...peddlerConfig, share: 0.3, weather: { heat: 1, wind: 0.5, rain: 0.2 } };
    expect(peddlerShare(config, { ...peddlerWeather, minutes: 780, sunAltitude: 60 })).toBe(1);
    expect(peddlerShare(config, { ...peddlerWeather, wet: true, windPreset: 'gusty' })).toBe(0.2);
    expect(
      peddlerShare({ ...config, weather: { heat: 1 } }, { ...peddlerWeather, windPreset: 'gusty' }),
    ).toBe(0.3);
    expect(peddlerShare(config, { ...peddlerWeather, windPreset: 'storm' })).toBe(0);
  });
  it('counts active/departing slots against spare tile capacity', () => {
    const { population } = peddlerFixture();
    population.step(0.1, peddlerWeather, MAX_TILE_AGENTS);
    expect(population.owners).toHaveLength(0);
    population.step(0.1, peddlerWeather, MAX_TILE_AGENTS - 1);
    expect(population.owners).toHaveLength(1);
  });
  it('walks off at a checked route endpoint without popping in the middle', () => {
    const { population } = peddlerFixture();
    population.step(10, peddlerWeather, 0);
    const positions = population.owners.map((p) => [p.x, p.y]);
    population.step(0.1, { ...peddlerWeather, minutes: 660 }, 0);
    expect(population.owners.every((p) => p.leaving)).toBe(true);
    expect(population.owners.map((p) => [p.x, p.y])).not.toEqual(positions);
    for (let i = 0; i < 250; i++) population.step(1, { ...peddlerWeather, minutes: 660 }, 0);
    expect(population.owners).toHaveLength(0);
  });
  it.each(['hours', 'storm'] as const)(
    'continues through an interior bend during %s departure',
    (reason) => {
      const b = new LifeBuilder(),
        pm = peddlerPM;
      b.line(
        [
          { x: 1000, y: 1500 },
          { x: 1000 + 40 * pm, y: 1500 },
          { x: 1000 + 40 * pm, y: 1500 + 40 * pm },
        ],
        LifeLine.path,
        4,
      );
      const { population } = peddlerFixture([{ ...peddlerConfig, perTile: 1 }], b.finish());
      population.step(0, peddlerWeather, 0);
      const owner = population.owners[0]!;
      expect(owner).toBeDefined();
      const start = { x: owner.x, y: owner.y },
        route = owner.route,
        interior = owner.dir === 1 ? route.b : route.a,
        env =
          reason === 'hours'
            ? { ...peddlerWeather, minutes: 660 }
            : { ...peddlerWeather, windPreset: 'storm' as const };
      population.step(route.length / 0.84 + 0.001, env, 0);
      expect(population.owners).toContain(owner);
      expect(owner.x).toBeCloseTo(interior.x);
      expect(owner.y).toBeCloseTo(interior.y);
      expect(owner.route).not.toBe(route);
      population.step(owner.route.length / 0.84 + 0.001, env, 0);
      expect(population.owners).toHaveLength(0);
      expect(Math.hypot(owner.x - start.x, owner.y - start.y)).toBeGreaterThan(40);
    },
  );
  it('clips near routes and every complete footprint to a mapped terminal radius', () => {
    const config = {
      ...peddlerConfig,
      prop: 'flatbed-cart' as const,
      near: { kind: 'terminal' as const, reach: 30 },
    };
    const { population, geo } = peddlerFixture([config]);
    const site = { x: geo.sites[0]! / peddlerPM, y: geo.sites[1]! / peddlerPM };
    for (let i = 0; i < 250; i++) {
      population.step(1, peddlerWeather, 0);
      for (const owner of population.owners)
        for (const body of peddlerBodies(config.prop, owner, owner.hx, owner.hy))
          for (const p of bodyCorners(body))
            expect(Math.hypot(p.x - site.x, p.y - site.y)).toBeLessThanOrEqual(30);
    }
    expect(population.owners.length).toBeGreaterThan(0);
    geo.sites = new Float32Array();
    const none = peddlerFixture([config], geo).population;
    none.step(1, peddlerWeather, 0);
    expect(none.owners).toHaveLength(0);
  });
  it.each(['hours', 'storm'] as const)(
    'leaves an exitless connected line through a reachable real exit after %s',
    (reason) => {
      const b = new LifeBuilder(),
        pm = peddlerPM,
        junction = { x: 1000 + 40 * pm, y: 1500 },
        start = { x: 1000, y: 1500 };
      b.line([start, junction], LifeLine.path, 4);
      b.line(
        [{ x: junction.x, y: 1500 - 40 * pm }, junction, { x: junction.x, y: 1500 + 40 * pm }],
        LifeLine.path,
        4,
      );
      const geo = b.finish(),
        square = (y: number) => [
          [
            { x: junction.x - 4 * pm, y: y - 4 * pm },
            { x: junction.x + 4 * pm, y: y - 4 * pm },
            { x: junction.x + 4 * pm, y: y + 4 * pm },
            { x: junction.x - 4 * pm, y: y + 4 * pm },
            { x: junction.x - 4 * pm, y: y - 4 * pm },
          ],
        ];
      geo.areas = [
        { kind: 'carriageway', rings: square(1500 - 40 * pm) },
        { kind: 'carriageway', rings: square(1500 + 40 * pm) },
      ];
      const config = { ...peddlerConfig, perTile: 1 as const },
        { population, blocked } = peddlerFixture([config], geo);
      population.step(0, peddlerWeather, 0);
      const routes = (
          population as unknown as {
            routesFor(config: typeof peddlerConfig): PeddlerOwner['route'][];
          }
        ).routesFor(config),
        exitless = routes.filter((route) => route.line === 1),
        route = exitless[0]!,
        owner = population.owners[0]!;
      expect(exitless.length).toBeGreaterThan(0);
      expect(
        exitless.every(
          (route) => !route.exitA && !route.exitB && Number.isFinite(route.exitDistance),
        ),
      ).toBe(true);
      Object.assign(owner, {
        route,
        x: (route.a.x + route.b.x) / 2,
        y: (route.a.y + route.b.y) / 2,
        distance: route.length / 2,
        dir: 1,
        hx: route.hx,
        hy: route.hy,
        nextCall: 1e6,
      });
      const env =
        reason === 'hours'
          ? { ...peddlerWeather, minutes: 660 }
          : { ...peddlerWeather, windPreset: 'storm' as const };
      population.step(0.1, env, 0);
      expect(population.owners).toContain(owner);
      for (let i = 0; i < 200 && population.owners.length; i++) {
        population.step(1, env, 0);
        expect(blocked.hits(peddlerBodies(owner.config.prop, owner, owner.hx, owner.hy))).toBe(
          false,
        );
      }
      expect(population.owners).toHaveLength(0);
      expect(
        Math.min(
          ...[start, junction].map((exit) =>
            Math.hypot(owner.x - exit.x / pm, owner.y - exit.y / pm),
          ),
        ),
      ).toBeLessThan(0.02);
    },
  );
  it('reverses at an unobstructed dead end and retries a temporary turn obstruction after waiting', () => {
    for (const obstructed of [false, true]) {
      const b = new LifeBuilder(),
        pm = peddlerPM;
      b.line(
        [
          { x: 1000, y: 1500 },
          { x: 1000 + 30 * pm, y: 1500 },
        ],
        LifeLine.path,
        6,
      );
      const { population, ordinary } = peddlerFixture(
        [{ ...peddlerConfig, prop: 'box-cart', perTile: 1 }],
        b.finish(),
      );
      population.step(0, peddlerWeather, 0);
      const owner = population.owners[0]!,
        route = owner.route;
      Object.assign(owner, {
        ...route.a,
        hx: route.hx,
        hy: route.hy,
        dir: 1,
        distance: 0,
        nextCall: 1e6,
      });
      if (obstructed)
        ordinary.push({ x: route.b.x, y: route.b.y + 1.4, hx: 1, hy: 0, length: 0.1, width: 0.1 });
      population.step(route.length / 0.84 + 0.001, peddlerWeather, 0);
      if (obstructed) {
        expect(owner.dir).toBe(1);
        expect(owner.transitionWait).toBe(2);
        ordinary.length = 0;
        population.step(1, peddlerWeather, 0);
        expect(owner.dir).toBe(1);
        population.step(1, peddlerWeather, 0);
      }
      expect(owner.dir).toBe(-1);
      population.step(1, peddlerWeather, 0);
      expect(owner.distance).toBeLessThan(route.length);
      expect(population.owners).toContain(owner);
    }
  });
  it('rejects cart admission where straight travel fits but static turnaround hits a parallel carriageway', () => {
    const b = new LifeBuilder(),
      pm = peddlerPM;
    b.line(
      [
        { x: 1000, y: 1500 },
        { x: 1000 + 100 * pm, y: 1500 },
      ],
      LifeLine.path,
      4,
    );
    const geo = b.finish();
    geo.areas = [
      {
        kind: 'carriageway',
        rings: [
          [
            { x: 900, y: 1500 + 1.5 * pm },
            { x: 1200 + 100 * pm, y: 1500 + 1.5 * pm },
            { x: 1200 + 100 * pm, y: 1500 + 6 * pm },
            { x: 900, y: 1500 + 6 * pm },
            { x: 900, y: 1500 + 1.5 * pm },
          ],
        ],
      },
    ];
    const config = { ...peddlerConfig, prop: 'box-cart' as const };
    const { population, blocked } = peddlerFixture([config], geo);
    expect(blocked.hits(peddlerBodies(config.prop, { x: 1000 / pm, y: 1500 / pm }, 1, 0))).toBe(
      false,
    );
    population.step(1, peddlerWeather, 0);
    expect(population.owners).toHaveLength(0);
    const carrier = peddlerFixture([peddlerConfig], geo).population;
    carrier.step(1, peddlerWeather, 0);
    expect(carrier.owners.length).toBeGreaterThan(0);
  });
  it('checks unknown-width crossings against uncut carriageways and cart widths', () => {
    const geo = peddlerGeometry(),
      b = new LifeBuilder();
    b.line(
      [
        { x: 1300, y: 1000 },
        { x: 1300, y: 2000 },
      ],
      LifeLine.roadMid,
      10,
    );
    const road = b.finish();
    geo.areas = [
      {
        kind: 'carriageway',
        rings: [
          [
            { x: 1290, y: 1000 },
            { x: 1310, y: 1000 },
            { x: 1310, y: 2000 },
            { x: 1290, y: 2000 },
            { x: 1290, y: 1000 },
          ],
        ],
      },
    ];
    geo.widths.fill(0);
    const { population, blocked } = peddlerFixture(
      [{ ...peddlerConfig, prop: 'flatbed-cart' }],
      geo,
    );
    for (let i = 0; i < 200; i++) {
      population.step(1, peddlerWeather, 0);
      for (const p of population.owners)
        expect(blocked.hits(peddlerBodies(p.config.prop, p, p.hx, p.hy))).toBe(false);
    }
    expect(population.owners.length).toBeGreaterThan(0);
    const narrow = peddlerGeometry();
    narrow.widths.fill(0.5);
    const none = peddlerFixture([{ ...peddlerConfig, prop: 'box-cart' }], narrow).population;
    none.step(1, peddlerWeather, 0);
    expect(none.owners).toHaveLength(0);
    expect(road.kinds[0]).toBe(LifeLine.roadMid);
  });
  it('replays exactly and freezes physical/effect clocks while inspected', () => {
    const a = peddlerFixture().population,
      b = peddlerFixture().population;
    for (let i = 0; i < 100; i++) {
      a.step(0.1, peddlerWeather, 0);
      b.step(0.1, peddlerWeather, 0);
    }
    expect(JSON.stringify(a.owners)).toBe(JSON.stringify(b.owners));
    const owner = a.owners[0]!,
      snapshot = JSON.stringify(owner);
    a.context.held = (p) => p === owner;
    a.step(10, peddlerWeather, 0);
    expect(JSON.stringify(owner)).toBe(snapshot);
  });
});

describe('world integration and ordinary isolation', () => {
  it('shares one fresh ordinary snapshot per frame and projects a neighboring vehicle for yielding', () => {
    const world = new LifeWorld();
    world.setPeddlers([{ ...peddlerConfig, perTile: 1 }]);
    world.sync([
      { key: 'snapshot-a', tile: peddlerTile, life: peddlerGeometry() },
      {
        key: 'snapshot-b',
        tile: { ...peddlerTile, x: peddlerTile.x + 1 },
        life: peddlerGeometry(),
      },
    ]);
    world.step(0, undefined, 19, undefined, undefined, { ...peddlerWeather, minutes: 180 });
    const a = worldTiles(world).get('snapshot-a')!,
      b = worldTiles(world).get('snapshot-b')!;
    a.movers.length = 0;
    b.movers.splice(1);
    expect(b.movers).toHaveLength(1);
    for (const life of [a, b]) {
      life.gatherers.length = life.stalls.length = life.parked.length = 0;
    }
    // An ordinary vehicle footprint straddles the neighbor's edge; only its read-only query is mocked.
    const neighbor: Body = { x: 0.5, y: 1500 / peddlerPM, hx: 1, hy: 0, length: 8, width: 1 };
    const source = vi.spyOn(b, 'groundBodies').mockImplementation(() => [{ ...neighbor }]);
    const phase = world as unknown as {
        stepPeddlers(dt: number, zoom: number, env: LifeEnv): void;
        ordinaryPeddlerBodies(life: object): Body[];
      },
      query = vi.spyOn(phase, 'ordinaryPeddlerBodies');
    phase.stepPeddlers(0, 19, { ...peddlerWeather, minutes: 180 });
    expect(source).not.toHaveBeenCalled();
    phase.stepPeddlers(0, 19, peddlerWeather);
    expect(source).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(2);
    const bodiesA = query.mock.results[0]!.value as Body[],
      bodiesB = query.mock.results[1]!.value as Body[],
      projected = bodiesA[0]!;
    expect(projected.x).toBeCloseTo(EXTENT / peddlerPM + neighbor.x);
    expect(projected.y).toBeCloseTo(neighbor.y);
    expect(bodiesB[0]!.x).toBeCloseTo(neighbor.x);
    neighbor.y += 10;
    phase.stepPeddlers(0, 19, peddlerWeather);
    expect(source).toHaveBeenCalledTimes(2);
    expect((query.mock.results[2]!.value as Body[])[0]!.y).toBeCloseTo(neighbor.y);
    const builder = new LifeBuilder();
    builder.line(
      [
        { x: EXTENT - 30 * peddlerPM, y: 1500 },
        { x: EXTENT, y: 1500 },
      ],
      LifeLine.path,
      6,
    );
    const { population } = peddlerFixture(
      [{ ...peddlerConfig, prop: 'box-cart', perTile: 1 }],
      builder.finish(),
    );
    population.context.ordinary = () => bodiesA;
    for (let i = 0; i < 10 && !population.owners.length; i++) population.step(0, peddlerWeather, 0);
    const owner = population.owners[0]!;
    expect(owner).toBeDefined();
    Object.assign(owner, { ...owner.route.a, dir: 1, hx: 1, hy: 0, distance: 0, nextCall: 1e6 });
    for (let i = 0; i < 50; i++) {
      population.step(1, peddlerWeather, 0);
      expect(
        peddlerBodies(owner.config.prop, owner, owner.hx, owner.hy).some((body) =>
          bodiesOverlap(body, projected),
        ),
      ).toBe(false);
    }
    expect(owner.distance).toBeLessThan(owner.route.length);
  });
  it('clears peddler metadata when ordinary observations are reused', () => {
    const world = new LifeWorld();
    world.sync([{ key: 'pool', tile: peddlerTile, life: peddlerGeometry() }]);
    const life = worldTiles(world).get('pool')!;
    const input: Partial<EmojiObservation> = {
      peddler: {} as NonNullable<EmojiObservation['peddler']>,
    };
    (
      life as unknown as { clearEmojiInput(input: Partial<EmojiObservation>): void }
    ).clearEmojiInput(input);
    expect(input.peddler).toBeUndefined();
  });
  it.each([0, 0.7])('leaves complete ordinary movers/scenes unchanged in rain %s', (rain) => {
    const entry = { key: 'peddler-isolation', tile: peddlerTile, life: peddlerGeometry() };
    const a = new LifeWorld(),
      b = new LifeWorld();
    b.setPeddlers([peddlerConfig]);
    a.sync([entry]);
    b.sync([structuredClone(entry)]);
    for (let i = 0; i < 60; i++) {
      for (const world of [a, b]) {
        world.step(0.1, undefined, 19, undefined, undefined, { ...peddlerWeather, rain });
        world.visible(19, 1, peddlerCenter);
      }
      expect(JSON.stringify(completeScenarioState(b))).toBe(
        JSON.stringify(completeScenarioState(a)),
      );
    }
  });
  it('retains separate owners through retirement and clears them on reset', () => {
    const entry = { key: 'peddler-retire', tile: peddlerTile, life: peddlerGeometry() },
      world = new LifeWorld();
    world.setPeddlers([peddlerConfig]);
    world.sync([entry]);
    // Isolate lifecycle from endpoint occupancy by ordinary walkers in this fixture.
    worldTiles(world).get(entry.key)!.movers.length = 0;
    world.step(0.1, undefined, 19, undefined, undefined, peddlerWeather);
    const before = world.visible(19, 1, peddlerCenter).filter((a) => a.peddler);
    expect(before.length).toBeGreaterThan(0);
    world.sync([]);
    expect(world.visible(19, 1, peddlerCenter).filter((a) => a.peddler)).toHaveLength(0);
    world.sync([entry]);
    expect(world.visible(19, 1, peddlerCenter).filter((a) => a.peddler)).toEqual(before);
    expect(world.visible(19, 1, peddlerCenter, undefined, undefined, 1, 0)).toHaveLength(0);
    world.clearTiles();
    expect(world.visible(19, 1, peddlerCenter)).toHaveLength(0);
  });
});
