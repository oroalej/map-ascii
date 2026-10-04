import { expect, it } from 'vitest';
import type { SeasonConfig, SeasonalRecord } from '@atlas/shared';
import { seasonalFixtures, createSeasonalFixtureCache } from './seasonal';
import { LifeBuilder, LifeLine } from './geometry';
import { lngLatToTile, tileToLngLat } from '../raster/geometry';
import { FixturePart, packFixtures, type FixtureGrid } from './fixtures';
import { mapGlyphs, themes } from '../theme';
import { SEASONAL_GLYPHS } from './seasonal-glyphs';
import { selectBuntingRows } from './bunting-junctions';
const tile = { z: 16, x: 55192, y: 30266 };
const point = (x: number, y: number) => tileToLngLat(tile, { x, y });
const season: SeasonConfig = {
  id: 'feast',
  title: { en: 'Feast' },
  sources: [],
  window: { from: { month: 9, day: 1 }, to: { month: 9, day: 20 } },
  bunting: {
    label: 'Banderitas',
    near: ['worship'],
    radius_m: 400,
    spacing_m: 30,
    corridors: [{ id: 'route', ways: ['osm:way/1'], spacing_m: 6, style: 'red-yellow-rectangles' }],
  },
};
const row: SeasonalRecord = {
  version: 1,
  kind: 'bunting',
  id: 'dense',
  season: 'feast',
  corridor: 'route',
  road: 'osm:way/1',
  from: point(2000, 1900),
  to: point(2000, 2100),
  segment: [point(1000, 2000), point(3000, 2000)],
  seed: 7,
};
const make = (places = true) => {
  const b = new LifeBuilder();
  b.line(
    [
      { x: 0, y: 2000 },
      { x: 4096, y: 2000 },
    ],
    LifeLine.roadMinor,
    8,
  );
  if (places) b.place({ x: 2000, y: 2000 }, 'worship', 20);
  return { tile, life: b.finish(), fixtures: [], seasonal: [row] };
};
it('keeps included corridor records and their dense-row suppression during a different season', () => {
  const groups = [make()];
  const preview = { ...season, id: 'new-year', includes: ['feast'] };
  expect(seasonalFixtures(groups, preview, 13.6)).toEqual(seasonalFixtures(groups, season, 13.6));
});
it('uses exact buffered corridor records once, independently of nearby worship samples', () => {
  const a = make(false),
    b = { ...make(false), tile: { ...tile, x: tile.x + 1 } };
  const result = seasonalFixtures([a, b], season, 13.6);
  expect(result).toMatchObject([
    {
      kind: 'season-bunting',
      id: 'dense',
      from: row.from,
      to: row.to,
      seed: 7,
      style: 'red-yellow-rectangles',
      priority: { corridor: 0, road: 'osm:way/1' },
    },
  ]);
  expect(seasonalFixtures([b], season, 13.6)).toEqual(result);
  expect(seasonalFixtures([a], { ...season, id: 'other' }, 13.6)).toEqual([]);
  expect(
    seasonalFixtures([{ ...a, seasonal: [{ ...row, road: 'osm:way/99' }] }], season, 13.6),
  ).toEqual([]);
});
it('replaces sparse rows only along the trimmed segment, retaining ordinary rows beyond it', () => {
  const result = seasonalFixtures([make()], season, 13.6);
  expect(result.some((f) => f.kind === 'season-bunting' && f.id === 'dense')).toBe(true);
  const sparse = result.filter((f) => f.kind === 'season-bunting' && !f.style);
  expect(sparse.length).toBeGreaterThan(0);
  for (const f of sparse)
    if (f.kind === 'season-bunting') {
      const x = (f.from[0] + f.to[0]) / 2;
      expect(x < row.segment[0][0] || x > row.segment[1][0]).toBe(true);
    }
});
it('suppresses fallback from a buffered neighboring segment using its complete width envelope', () => {
  const home = { ...make(), seasonal: [] };
  const buffered: SeasonalRecord = {
    ...row,
    id: 'buffered',
    segment: [point(-500, 2100), point(3500, 2100)],
    from: point(2000, 1800),
    to: point(2000, 2400),
  };
  const neighbor = {
    tile: { ...tile, x: tile.x + 1 },
    life: new LifeBuilder().finish(),
    fixtures: [],
    seasonal: [buffered],
  };
  const result = seasonalFixtures([home, neighbor], season, 13.6);
  const sparse = result.filter((f) => f.kind === 'season-bunting' && !f.style);
  expect(sparse.length).toBeGreaterThan(0);
  for (const f of sparse)
    if (f.kind === 'season-bunting') {
      const center = lngLatToTile(tile, (f.from[0] + f.to[0]) / 2, (f.from[1] + f.to[1]) / 2);
      expect(center.x).toBeGreaterThan(3500);
    }
  expect(result.some((f) => f.kind === 'season-bunting' && f.id === buffered.id)).toBe(true);
});
it('invalidates when the decoded corridor payload changes and keeps old archives working', () => {
  const group = make(),
    cache = createSeasonalFixtureCache();
  const a = cache([group], season, 13.6);
  expect(cache([group], season, 13.6)).toBe(a);
  expect(cache([{ ...group, seasonal: [{ ...row, seed: 8 }] }], season, 13.6)).not.toBe(a);
  expect(
    cache([{ ...group, seasonal: undefined }], season, 13.6).every(
      (f) => f.kind !== 'season-bunting' || !f.style,
    ),
  ).toBe(true);
});
it('keeps rejected dense segments covered and resolves buffered copies regardless of tile order', () => {
  const group = make(),
    cross: SeasonalRecord = {
      ...row,
      id: 'cross',
      road: 'osm:way/2',
      from: point(1800, 2000),
      to: point(2200, 2000),
      segment: [point(2000, 1000), point(2000, 3000)],
    };
  const neighbor = { ...make(), tile: { ...tile, x: tile.x + 1 }, seasonal: [cross, row] };
  const config = structuredClone(season);
  config.bunting!.corridors![0]!.ways.push('osm:way/2');
  const a = seasonalFixtures([group, neighbor], config, 13.6);
  expect(seasonalFixtures([neighbor, group], config, 13.6)).toEqual(a);
  const grid: FixtureGrid = {
    cols: 100,
    rows: 100,
    cellWidth: 5,
    cellHeight: 9,
    toCell: (lng, lat) => {
      const p = lngLatToTile(tile, lng, lat);
      return [p.x / 40, p.y / 40];
    },
  };
  const accepted = [...selectBuntingRows(a, grid).keys()];
  expect(accepted.some((f) => f.id === 'dense')).toBe(false);
  expect(accepted.some((f) => f.id === 'cross')).toBe(true);
  for (const f of a)
    if (f.kind === 'season-bunting' && !f.style) {
      const x = (f.from[0] + f.to[0]) / 2;
      expect(x < row.segment[0][0] || x > row.segment[1][0]).toBe(true);
    }
});
it('packs only rectangular red/yellow marks and keeps their phase stable when clipped by panning', () => {
  const glyphs = mapGlyphs(themes.dark),
    index = (g: string) => glyphs.indexOf(g);
  const grid: FixtureGrid = {
    cols: 100,
    rows: 100,
    cellWidth: 5,
    cellHeight: 9,
    toCell: (x, y) => [x, y],
  };
  const fixture = {
    kind: 'season-bunting' as const,
    id: 'row',
    from: [10.5, 40.5] as [number, number],
    to: [80.5, 40.5] as [number, number],
    seed: 7,
    style: 'red-yellow-rectangles' as const,
  };
  const a = packFixtures(new Uint8Array(40000), grid, [fixture], 20, index, 0);
  const b = packFixtures(
    new Uint8Array(40000),
    { ...grid, toCell: (x, y) => [x - 20, y] },
    [fixture],
    20,
    index,
    0,
  );
  expect(a.visibility.seasonal?.bunting).toBe(true);
  for (let x = 21; x < 80; x++) {
    const old = (42 * 100 + x) * 4,
      current = (42 * 100 + x - 20) * 4;
    expect(b.texels.slice(current, current + 4)).toEqual(a.texels.slice(old, old + 4));
    expect(a.texels[old + 1]! & 63).toBe(FixturePart.bunting);
    expect(a.texels[old + 2]! & 7).toBeLessThan(2);
    const code = a.texels[old]! | ((a.texels[old + 1]! >> 6) << 8);
    expect([index(SEASONAL_GLYPHS[3]), index(SEASONAL_GLYPHS[4])]).toContain(code);
  }
});
