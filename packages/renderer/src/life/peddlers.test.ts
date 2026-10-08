import { describe, expect, it } from 'vitest';
import { peddlerBodies, peddlerShare, peddlerWindow } from './peddlers';
import { MAX_TILE_AGENTS } from './config';
import { LifeBuilder, LifeLine } from './geometry';
import { LifeWorld } from './simulate';
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
import { bodyCorners } from './occupancy';
import type { EmojiObservation } from './emoji';

describe('isolated peddler population', () => {
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
