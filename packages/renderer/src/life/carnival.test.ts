import { afterEach, expect, it, vi } from 'vitest';
import * as shared from '@atlas/shared';
import { CARNIVAL_STYLES, type SeasonalCarnivalRecord, type SeasonConfig } from '@atlas/shared';
import { packCarnival } from './carnival';
import { SeasonalPart } from './seasonal-glyphs';
import { seasonalFixtures } from './seasonal';
import {
  LifeBuilder,
  encodeSeasonalPayload,
  seasonalRecords,
  physicalSeasonalRecords,
} from './geometry';
import { LifeWorld } from './simulate';
import { simulationSeasons } from './seasonal-simulation';
import {
  metersPerUnit,
  tileToLngLat,
  lngLatToTile,
  buildTileGeometry,
  createIdRegistry,
} from '../raster/geometry';
const tile = { z: 16, x: 55192, y: 30266 };
afterEach(() => vi.restoreAllMocks());
const ride: SeasonalCarnivalRecord = {
  version: 1,
  kind: 'carnival',
  id: 'wheel',
  season: 'winter',
  installation: 'fair',
  anchor: 'osm:way/1',
  seed: 17,
  style: 'ferris-wheel',
  at: tileToLngLat(tile, { x: 2000, y: 2000 }),
  size_m: [7, 22],
  angle_deg: 0,
};
const season: SeasonConfig = {
  id: 'winter',
  title: { en: 'Winter' },
  window: { from: { month: 12, day: 1 }, to: { month: 1, day: 6 } },
  sources: [],
  installations: [
    {
      id: 'fair',
      kind: 'carnival',
      anchor: ride.anchor,
      label: 'Christmas carnival',
      grounds: 'lot',
      sources: [],
      components: [],
    },
  ],
};
it('packs filled overhead rides and keeps world patterns stable through clipping and panning', () => {
  const pack = (style: SeasonalCarnivalRecord['style'], shift = 0) => {
    const cells = new Map<string, { glyph: string; part: number; info: number }>();
    const r: SeasonalCarnivalRecord = {
      ...ride,
      style,
      size_m: style === 'carousel' ? [18, 18] : [7, 22],
    };
    packCarnival(
      r,
      {
        cols: 140,
        rows: 100,
        cellWidth: 5,
        cellHeight: 9,
        toCell: (lng, lat) => [
          70 + shift + (lng - ride.at[0]) * 111319.49 * Math.cos((ride.at[1] * Math.PI) / 180) * 2,
          50 - (lat - ride.at[1]) * 111319.49,
        ],
      },
      (x, y, glyph, part, info) => {
        cells.set(`${x - shift}/${y}`, { glyph, part, info });
        return true;
      },
    );
    return cells;
  };
  for (const style of CARNIVAL_STYLES) {
    const cells = pack(style);
    expect(cells.size).toBeGreaterThan(100);
    expect(cells).toEqual(pack(style, 9));
    expect([...cells.values()].some((c) => c.part === SeasonalPart.carnivalLight)).toBe(true);
  }
  const wheel = [...pack('ferris-wheel').keys()].map((key) => key.split('/').map(Number));
  expect(Math.max(...wheel.map((p) => p[0]!)) - Math.min(...wheel.map((p) => p[0]!))).toBeLessThan(
    Math.max(...wheel.map((p) => p[1]!)) - Math.min(...wheel.map((p) => p[1]!)),
  );
});
it('lights the open midway throughout its length while retaining a legible walkable aisle', () => {
  const collect = (shift: number) => {
    const cells = new Map<string, { part: number; info: number }>();
    packCarnival(
      { ...ride, style: 'midway', size_m: [36, 104], angle_deg: -20 },
      {
        cols: 140,
        rows: 140,
        cellWidth: 5,
        cellHeight: 9,
        toCell: (lng, lat) => [
          70 + shift + (lng - ride.at[0]) * 111319.49 * Math.cos((ride.at[1] * Math.PI) / 180) * 2,
          70 - (lat - ride.at[1]) * 111319.49,
        ],
      },
      (x, y, _glyph, part, info) => {
        cells.set(`${x - shift}/${y}`, { part, info });
        return true;
      },
    );
    return cells;
  };
  const full = collect(0),
    clipped = collect(60);
  expect(clipped.size).toBeLessThan(full.size);
  for (const [key, cell] of clipped) expect(cell).toEqual(full.get(key));
  const litBands = new Set<number>(),
    tints = new Set<number>();
  let path = 0;
  for (const [key, cell] of full) {
    const [x, y] = key.split('/').map(Number),
      e = (x! + 0.5 - 70) / 2,
      n = 70 - y! - 0.5,
      angle = (-20 * Math.PI) / 180,
      u = e * Math.cos(angle) + n * Math.sin(angle),
      v = -e * Math.sin(angle) + n * Math.cos(angle);
    expect(Math.abs(u)).toBeLessThanOrEqual(18.01);
    expect(Math.abs(v)).toBeLessThanOrEqual(52.01);
    expect(cell.info & 7).toBeLessThanOrEqual(5);
    if (cell.part === SeasonalPart.carnivalLight && Math.abs(u) < 16 && Math.abs(v) < 50) {
      litBands.add(Math.floor((v + 52) / 10));
      tints.add(cell.info & 7);
    }
    if (u > 2.5 && u < 5.5 && cell.part === SeasonalPart.carnivalGround && cell.info === 1) path++;
  }
  // This rejects perimeter-only lighting and canopy patterns that erase the walkway.
  expect(litBands.size).toBeGreaterThanOrEqual(10);
  expect(tints.size).toBeGreaterThanOrEqual(4);
  expect(path).toBeGreaterThan(100);
});
it('orders the midway beneath rides, deduplicates records and only shows the matching season', () => {
  const midway = {
    ...ride,
    id: 'midway',
    style: 'midway' as const,
    size_m: [36, 104] as [number, number],
  };
  const group = {
    tile,
    life: new LifeBuilder().finish(),
    fixtures: [],
    seasonal: [ride, midway, ride],
  };
  const fixtures = seasonalFixtures([group, group], season, 13.6);
  expect(fixtures).toHaveLength(2);
  expect(fixtures[0]).toMatchObject({ record: { style: 'midway' } });
  expect(seasonalFixtures([group], undefined, 13.6)).toEqual([]);
  expect(seasonalFixtures([group], { ...season, id: 'fiesta' }, 13.6)).toEqual([]);
});
it('blocks solid ride footprints only while active and leaves the midway walkable', () => {
  const world = new LifeWorld();
  world.setSeasons(simulationSeasons([season]));
  const midway = {
    ...ride,
    id: 'midway',
    style: 'midway' as const,
    at: tileToLngLat(tile, { x: 2600, y: 2000 }),
  };
  world.sync([
    {
      key: 'fair',
      tile,
      life: { ...new LifeBuilder().finish(), seasonalRides: [ride, ride, midway] },
    },
  ]);
  const body = (r: SeasonalCarnivalRecord) => {
    const p = lngLatToTile(tile, ...r.at);
    return {
      x: p.x * metersPerUnit(tile),
      y: p.y * metersPerUnit(tile),
      hx: 1,
      hy: 0,
      length: 1,
      width: 1,
    };
  };
  const choose = (id: string | null) =>
    world.step(0.001, undefined, 20, undefined, undefined, { rain: 0, season: id });
  choose(null);
  expect(world.cellTerrain()!.trees.hits([body(ride)])).toBe(false);
  choose('winter');
  expect(world.cellTerrain()!.trees.hits([body(ride)])).toBe(true);
  expect(world.cellTerrain()!.trees.hits([body(midway)])).toBe(false);
  const version = world.cellTerrain()!.version;
  choose('winter');
  expect(world.cellTerrain()!.version).toBe(version);
  choose(null);
  expect(world.cellTerrain()!.trees.hits([body(ride)])).toBe(false);
});
it('lazily supplies physical obstacles when already loaded raw tiles acquire an active season', () => {
  const parse = vi.spyOn(shared, 'parseSeasonalTileRecord');
  const world = new LifeWorld();
  world.setSeasons(simulationSeasons([season]));
  world.sync([
    {
      key: 'raw-fair',
      tile,
      life: {
        ...new LifeBuilder().finish(),
        seasonalPayload: encodeSeasonalPayload([
          JSON.stringify(ride),
          '{',
          JSON.stringify({ ...ride, version: 2 }),
        ]),
      },
    },
  ]);
  expect(parse).not.toHaveBeenCalled();
  const p = lngLatToTile(tile, ...ride.at);
  const body = {
    x: p.x * metersPerUnit(tile),
    y: p.y * metersPerUnit(tile),
    hx: 1,
    hy: 0,
    length: 1,
    width: 1,
  };
  for (const id of ['winter', null, 'winter']) {
    world.step(0, undefined, 20, undefined, undefined, { rain: 0, season: id });
    expect(world.cellTerrain()!.trees.hits([body])).toBe(id === 'winter');
    expect(parse).toHaveBeenCalledTimes(3);
  }
});
it.each([true, false])(
  'rejects prepared carnival terrain after the season changes (prepared active: %s)',
  (active) => {
    const world = new LifeWorld();
    world.setSeasons(simulationSeasons([season]));
    const select = (on: boolean) =>
      world.step(0, undefined, 20, undefined, undefined, { rain: 0, season: on ? 'winter' : null });
    const complete = <T>(generator: Generator<void, T, void>): T => {
      let next = generator.next();
      while (!next.done) next = generator.next();
      return next.value;
    };
    const entries = [
      {
        key: 'prepared-fair',
        tile,
        life: { ...new LifeBuilder().finish(), seasonalRides: [ride] },
      },
    ];
    select(active);
    const life = complete(world.prepareTile(entries[0]!));
    const prepared = new Map([[entries[0]!.key, life]]);
    complete(world.prepareActivation(entries, prepared));
    select(!active);
    world.sync(entries, undefined, undefined, prepared);
    select(!active);
    const at = lngLatToTile(tile, ...ride.at),
      unit = metersPerUnit(tile);
    expect(
      world
        .cellTerrain()!
        .trees.hits([{ x: at.x * unit, y: at.y * unit, hx: 1, hy: 0, length: 1, width: 1 }]),
    ).toBe(!active);
  },
);
it('decodes exact neighboring payloads and transfers only solid rides to Life', () => {
  const records = [ride, { ...ride, id: 'midway', style: 'midway' }, { ...ride, version: 2 }];
  const layer = {
    extent: 4096,
    length: records.length,
    feature: (i: number) => ({
      type: 3 as const,
      properties: { seasonal: JSON.stringify(records[i]) },
      loadGeometry: () => [
        [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
          { x: 0, y: 0 },
        ],
      ],
    }),
  };
  const result = buildTileGeometry({ seasons: layer }, createIdRegistry(), tile, 16);
  expect(seasonalRecords(result.seasonal)).toHaveLength(2);
  expect(physicalSeasonalRecords(result.life)).toEqual([ride]);
});
