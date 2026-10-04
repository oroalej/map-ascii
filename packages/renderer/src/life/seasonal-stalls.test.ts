import { simulationSeasons } from './seasonal-simulation';
import { describe, expect, it, vi } from 'vitest';
import type { SeasonConfig, SeasonalDisplayRecord } from '@atlas/shared';
import { LifeBuilder, LifeLine } from './geometry';
import { LifeWorld } from './simulate';
import { MAX_TILE_AGENTS, activityLevels } from './config';
import { worldTiles } from './testing/scenarios';
import { stripRing } from './terrain';
import { metersPerUnit, tileToLngLat } from '../raster/geometry';
import { createLifeWorkerApi, runLifeFrame, type FrameInput } from './worker-api';

const tile = { z: 16, x: 55192, y: 30266 };
const season: SeasonConfig = {
  id: 'feast',
  title: { en: 'Feast' },
  sources: [{ title: 'Calendar', url: 'https://example.com/calendar' }],
  window: { from: { month: 9, day: 1 }, to: { month: 9, day: 20 } },
  stalls: { label: 'Food carts', near: ['worship'], radius_m: 300, per_tile: 12 },
};
const select = (world: LifeWorld, id: string | null = 'feast') =>
  world.step(0, undefined, undefined, undefined, undefined, { rain: 0, season: id });
function setup(road = false, places = true, blocked = false) {
  const b = new LifeBuilder();
  for (const y of [800, 1600, 2400, 3200])
    b.line(
      [
        { x: 0, y },
        { x: 4095, y },
      ],
      road ? LifeLine.roadMinor : LifeLine.path,
      8,
    );
  if (places) b.place({ x: 2000, y: 2000 }, 'worship', 20);
  if (blocked)
    b.area('blocked', [
      [
        { x: 0, y: 0 },
        { x: 4096, y: 0 },
        { x: 4096, y: 4096 },
        { x: 0, y: 4096 },
        { x: 0, y: 0 },
      ],
    ]);
  const tiles = [{ key: 'seasonal', tile, life: b.finish() }],
    world = new LifeWorld();
  world.setSeasons(simulationSeasons([season]));
  world.sync(tiles);
  return { tiles, world, life: worldTiles(world).values().next().value! };
}
describe('seasonal stall lifecycle', () => {
  function physicalPreview() {
    const result = setup();
    const display: SeasonalDisplayRecord = {
      version: 1,
      kind: 'christmas-tree',
      id: 'tree',
      installation: 'tree',
      season: season.id,
      anchor: 'osm:way/1',
      seed: 1,
      radius_m: 5,
      at: tileToLngLat(tile, { x: 20, y: 20 }),
    };
    result.tiles[0]!.life.seasonalTrees = [display];
    result.world.setSeasons(
      simulationSeasons([
        {
          ...season,
          installations: [
            {
              id: 'tree',
              kind: 'christmas-tree',
              anchor: display.anchor,
              label: 'Tree',
            },
          ],
        },
      ]),
    );
    return { ...result, display };
  }
  it('leaves off-footprint closed carts and seated gatherers alone despite hidden-body overlaps', () => {
    const { world, life } = physicalPreview();
    const cart = life.stalls[0]!,
      walker = life.movers.find((m) => m.kind === 'person')!;
    expect(cart).toBeDefined();
    expect(walker).toBeDefined();
    cart.open = false;
    walker.x = cart.x;
    walker.y = cart.y;
    const seated = life.gatherers[0]!;
    expect(seated).toBeDefined();
    seated.behavior = 'sit';
    seated.x = walker.x;
    seated.y = walker.y;
    for (const id of [season.id, null]) {
      select(world, id);
      expect(life.stalls).toContain(cart);
      expect(life.gatherers).toContain(seated);
      expect(life.movers).toContain(walker);
    }
  });
  it('restores obstructed actors and cart sites after deselection, including retirement and revival', () => {
    const { world, life, tiles, display } = physicalPreview();
    const cart = life.stalls[0]!;
    display.at = tileToLngLat(tile, cart);
    const population = life.population;
    select(world);
    expect(life.stalls).not.toContain(cart);
    expect(life.canIdle(cart)).toBe(false);
    expect(life.scenes.sites.some((site) => site.stall === cart)).toBe(false);
    expect(life.population).toBe(population);
    world.sync([]);
    select(world, null);
    world.sync(tiles);
    select(world, null);
    expect(world.active(tiles[0]!.key)).toBe(life);
    expect(life.stalls).toContain(cart);
    expect(life.scenes.sites.some((site) => site.stall === cart)).toBe(true);
    expect(life.canIdle(cart)).toBe(true);
    expect(life.population).toBe(population);
  });
  it('skips anchorless and unchanged candidate searches after unrelated tile arrivals', () => {
    for (const anchored of [false, true]) {
      const { world, life, tiles } = setup(false, anchored, anchored);
      select(world);
      expect(life.seasonalStalls).toEqual([]);
      const admission = vi.spyOn(life, 'admitSeasonalStalls');
      const points = vi.spyOn(life, 'pointAt');
      world.sync([
        ...tiles,
        { key: 'far', tile: { ...tile, x: tile.x + 4 }, life: new LifeBuilder().finish() },
      ]);
      select(world);
      expect(admission).not.toHaveBeenCalled();
      expect(points).not.toHaveBeenCalled();
    }
  });

  it('reconsiders an existing anchorless tile when a neighboring worship anchor arrives', () => {
    const { world, life, tiles } = setup(false, false);
    select(world);
    expect(life.seasonalStalls).toEqual([]);
    const neighbor = new LifeBuilder();
    neighbor.place({ x: 10, y: 2000 }, 'worship', 20);
    world.sync([
      ...tiles,
      { key: 'anchor', tile: { ...tile, x: tile.x + 1 }, life: neighbor.finish() },
    ]);
    select(world);
    expect(life.seasonalStalls.length).toBeGreaterThan(0);
  });

  it('retains a cart and its purchasing customer when a neighboring tile arrives', () => {
    const { world, life, tiles } = setup();
    select(world);
    const stall = life.seasonalStalls[0]!;
    const site = life.scenes.sites.findIndex((s) => s.kind === 'vendor' && s.stall === stall);
    const customer = life.movers.find((m) => m.kind === 'person' && life.scenes.reserve(m, site))!;
    const visit = life.scenes.visits.get(customer)!;
    visit.state = 'purchase';
    world.sync([
      ...tiles,
      { key: 'empty-neighbor', tile: { ...tile, x: tile.x + 1 }, life: new LifeBuilder().finish() },
    ]);
    select(world);
    expect(life.seasonalStalls).toContain(stall);
    expect(life.scenes.visits.get(customer)).toBe(visit);
    expect(visit.state).toBe('purchase');
  });

  it('invalidates only carts ceded to a new finer owner and preserves the remaining identities', () => {
    const { world, life, tiles } = setup();
    select(world);
    const previous = [...life.seasonalStalls];
    world.sync([
      ...tiles,
      {
        key: 'fine',
        tile: { z: tile.z + 3, x: tile.x * 8, y: tile.y * 8 + 1 },
        life: tiles[0]!.life,
      },
    ]);
    select(world);
    const retained = previous.filter((s) => s.x >= 512 || s.y < 512 || s.y >= 1024);
    expect(retained.length).toBeGreaterThan(0);
    for (const stall of retained) expect(life.seasonalStalls).toContain(stall);
    const ceded = previous.filter((s) => s.x < 512 && s.y >= 512 && s.y < 1024);
    expect(ceded.length).toBeGreaterThan(0);
    for (const stall of ceded) expect(life.seasonalStalls).not.toContain(stall);
  });
  it('keeps a customer at the same cart long enough to purchase across ordinary frames', () => {
    const { world, life } = setup();
    select(world);
    const stall = life.seasonalStalls[0]!;
    const site = life.scenes.sites.findIndex((s) => s.kind === 'vendor' && s.stall === stall);
    const customer = life.movers.find((m) => m.kind === 'person' && life.scenes.reserve(m, site))!;
    expect(customer).toBeDefined();
    const visit = life.scenes.visits.get(customer)!;
    visit.state = 'wait';
    visit.time = 60;
    world.step(0.1, undefined, 20, undefined, undefined, {
      rain: 0,
      minutes: 720,
      season: 'feast',
    });
    expect(visit.state).toBe('purchase');
    for (let frame = 0; frame < 30; frame++)
      world.step(1 / 30, undefined, 20, undefined, undefined, {
        rain: 0,
        minutes: 720,
        season: 'feast',
      });
    expect(life.seasonalStalls[0]).toBe(stall);
    expect(life.scenes.visits.get(customer)).toBe(visit);
    expect(visit.state).toBe('purchase');
  });
  it('reconciles a changed season on revival and regenerates carts after a hard clear', () => {
    const { world, life, tiles } = setup();
    select(world);
    expect(life.seasonalStalls.length).toBeGreaterThan(0);
    const mover = life.movers[0];
    world.sync([]);
    select(world, null);
    world.sync(tiles);
    select(world, null);
    expect(worldTiles(world).get('seasonal')).toBe(life);
    expect(life.movers[0]).toBe(mover);
    expect(life.seasonalStalls).toEqual([]);
    select(world);
    expect(life.seasonalStalls.length).toBeGreaterThan(0);
    world.clearTiles();
    world.sync(tiles);
    select(world);
    const fresh = worldTiles(world).get('seasonal')!;
    expect(fresh).not.toBe(life);
    expect(fresh.seasonalStalls.length).toBeGreaterThan(0);
  });

  it('admits mixed-zoom seasonal carts only within the finest resident footprint', () => {
    const { world, life, tiles } = setup();
    const fine = { z: tile.z + 1, x: tile.x * 2, y: tile.y * 2 };
    world.sync([...tiles, { key: 'fine', tile: fine, life: tiles[0]!.life }]);
    select(world);
    expect(life.seasonalStalls.length).toBeGreaterThan(0);
    expect(life.seasonalStalls.every((s) => s.x >= 2048 || s.y >= 2048)).toBe(true);
    expect(worldTiles(world).get('fine')!.seasonalStalls.length).toBeGreaterThan(0);
  });

  it('uses tile-owned neighboring markets even when selected worship places are absent', () => {
    const { world, life, tiles } = setup(false, false),
      neighbor = new LifeBuilder();
    neighbor.market({ x: 10, y: 2000 });
    world.sync([
      ...tiles,
      { key: 'market', tile: { ...tile, x: tile.x + 1 }, life: neighbor.finish() },
    ]);
    select(world);
    expect(life.seasonalStalls.length).toBeGreaterThan(0);
  });
  it('admits deterministic bounded carts after commerce without changing legacy populations', () => {
    const a = setup(),
      b = setup(),
      movers = structuredClone(a.life.movers),
      stalls = structuredClone(a.life.stalls),
      gatherers = structuredClone(a.life.gatherers);
    select(a.world);
    select(b.world);
    expect(a.life.seasonalStalls.length).toBeGreaterThan(0);
    expect(a.life.seasonalStalls.length).toBeLessThanOrEqual(12);
    expect(a.life.seasonalStalls).toEqual(b.life.seasonalStalls);
    expect(a.life.movers).toEqual(movers);
    expect(a.life.stalls).toEqual(stalls);
    expect(a.life.gatherers).toEqual(gatherers);
    const ref = a.life.seasonalStalls[0];
    select(a.world);
    expect(a.life.seasonalStalls[0]).toBe(ref);
    select(a.world, null);
    expect(a.life.seasonalStalls).toEqual([]);
    select(a.world);
    expect(a.life.seasonalStalls).toEqual(b.life.seasonalStalls);
  });
  it('requires paths/plazas and mapped proximity, rejecting blocked footprints', () => {
    for (const scene of [setup(true), setup(false, false), setup(false, true, true)]) {
      select(scene.world);
      expect(scene.life.seasonalStalls).toEqual([]);
    }
  });
  it('shares the mover quota and removes sites when reclaimed or deactivated at zero dt', () => {
    const { world, life } = setup();
    select(world);
    const scenes = life.scenes as unknown as { sites: { stall?: unknown; queue: unknown[] }[] };
    const seasonal = new Set(life.seasonalStalls);
    expect(
      scenes.sites.filter((s) => seasonal.has(s.stall as (typeof life.seasonalStalls)[number])),
    ).toHaveLength(life.seasonalStalls.length * 2);
    while (life.movers.length < MAX_TILE_AGENTS) life.movers.push({ ...life.movers[0]! });
    select(world);
    expect(life.seasonalStalls).toHaveLength(0);
    expect(
      scenes.sites.some((s) => seasonal.has(s.stall as (typeof life.seasonalStalls)[number])),
    ).toBe(false);
    select(world, null);
    expect(life.stalls.length).toBeGreaterThan(0);
  });
  it.each([4096, 250])(
    'keeps both bodies off neighboring roads of length %s, preserves valid carts and releases evicted carts',
    (length) => {
      const { world, life, tiles } = setup();
      select(world);
      const original = [...life.seasonalStalls];
      const neighbor = new LifeBuilder(),
        pm = 1 / metersPerUnit(tile);
      neighbor.line(
        [
          { x: -4096, y: 800 },
          { x: -4096 + length, y: 800 },
        ],
        LifeLine.roadMinor,
        10,
      );
      neighbor.area('crossing', [
        stripRing({ x: -4096, y: 800 }, { x: -4096 + length, y: 800 }, 5 * pm),
      ]);
      const next = { key: 'neighbor', tile: { ...tile, x: tile.x + 1 }, life: neighbor.finish() };
      world.sync([...tiles, next]);
      select(world);
      for (const stall of life.seasonalStalls) expect(life.canIdle(stall)).toBe(true);
      expect(
        life.seasonalStalls.every((s) => s.x > length + 5 * pm || Math.abs(s.y - 800) > 5 * pm),
      ).toBe(true);
      if (length < 4096) {
        const unaffected = original.filter((s) => s.x > length + 50 * pm);
        expect(unaffected.length).toBeGreaterThan(0);
        for (const stall of unaffected) expect(life.seasonalStalls).toContain(stall);
      }
      world.sync([]);
      select(world);
      expect(worldTiles(world).size).toBe(0);
    },
  );
  it('matches direct and worker frames through activation, deactivation and reload', () => {
    const { tiles, world } = setup(),
      api = createLifeWorkerApi();
    api.init(structuredClone({ processions: [], seasons: simulationSeasons([season]) }));
    api.sync(structuredClone(tiles));
    const center = tileToLngLat(tile, { x: 2048, y: 2048 });
    for (let frame = 0; frame < 12; frame++) {
      if (frame === 8) {
        world.sync([]);
        api.sync([]);
      }
      if (frame === 9) {
        world.sync(tiles);
        api.sync(structuredClone(tiles));
      }
      const input: FrameInput = {
        gust: {
          camera: { lng: center[0], lat: center[1], zoom: 20 },
          size: { width: 1920, height: 1080 },
          cssCell: { w: 5, h: 9 },
          time: frame / 30,
          wind: { dir: [1, 0], strength: 0 },
        },
        step: {
          dt: frame % 3 ? 1 / 30 : 0,
          zoom: 20,
          bounds: undefined,
          wind: undefined,
          weather: {
            rain: 0,
            minutes: 720,
            season: frame < 4 || frame > 6 ? 'feast' : null,
          },
          cellMeters: 0,
        },
        visible: [20, activityLevels(720), center, { rain: 0, sunAltitude: 45 }],
      };
      expect(api.frame(structuredClone(input)).agents).toEqual(runLifeFrame(world, input).agents);
    }
  });
});
