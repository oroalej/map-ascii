import { describe, expect, it } from 'vitest';
import { LifeBuilder, lifeTransferables, inTile } from './geometry';
import {
  candleFixtures,
  candleLamps,
  memorialAnchors,
  prepareMemorialSites,
} from './seasonal-candles';
import { createSeasonalFixtureCache, seasonalFixtures } from './seasonal';
import { packFixtures, FixturePart } from './fixtures';
import { LampState, lightByte } from './lights';
import { mapGlyphs, themes } from '../theme';
import { tileToLngLat } from '../raster/geometry';
import { unpackGlyph } from '../glyphs/select';
import { glyphFragmentFor } from '../shaders/glyph';
import { classId } from '../classes';
import { CandleFlare, candleFlareStrength } from './candle-flare';
import { tapCandleFixture } from './tap-fixtures';

const tile = { z: 16, x: 55192, y: 30266 };
const ring = (l = 500, t = 500, r = 3500, b = 3500) => [
  { x: l, y: t },
  { x: r, y: t },
  { x: r, y: b },
  { x: l, y: b },
  { x: l, y: t },
];
describe('seasonal memorial candles', () => {
  it('captures the nearest candle within 1.5 cells and reprojects its three-second flare', () => {
    const c = { kind: 'season-candle' as const, at: [0, 0] as [number, number], seed: 91 };
    const project = (lng: number, lat: number): [number, number] => [
      10 + lng * 1e6,
      20 - lat * 1e6,
    ];
    expect(tapCandleFixture([c], [0.0000014, 0], project)?.seed).toBe(91);
    expect(tapCandleFixture([c], [0.0000016, 0], project)).toBeUndefined();
    const flare = new CandleFlare(c, 10);
    expect(flare.uniforms(10, project)?.center).toEqual([10, 20, 1, 27]);
    expect(candleFlareStrength(1.5)).toBe(0.25);
    const moved = flare.uniforms(11, (lng, lat) => {
      const [x, y] = project(lng, lat);
      return [x * 2 + 5, y * 2 - 8];
    });
    expect(moved?.center.slice(0, 2)).toEqual([25, 32]);
    expect(moved?.radius[0]).toBeCloseTo(flare.uniforms(11, project)!.radius[0]! * 2);
    expect(flare.uniforms(13, project)).toBeUndefined();
    const source = glyphFragmentFor();
    expect(source).toContain('if(flame) color *= 1.0+candleFlareAt');
    expect(source).toContain('return flare>0.0 ? flicker*(1.0+flare) : flicker');
  });
  it('limits the burial surface exception to candles in the active shader variant', () => {
    const source = glyphFragmentFor();
    expect(source).toContain(
      `bool burialCandle = part == ${FixturePart.candle} && cls == ${classId('building_part')}`,
    );
    expect(source).toContain('if (!burialCandle &&');
    expect(glyphFragmentFor({ seasonal: false })).not.toContain('burialCandle');
  });
  it('shares stable owned grave selection across neighboring tile groupings', () => {
    const builder = new LifeBuilder();
    builder.grave({ x: 1000, y: 1000 }, 'a', 1);
    builder.grave({ x: 1200, y: 1000 }, 'b', 0xffffff);
    const geo = builder.finish();
    const neighbor = {
      tile: { ...tile, x: tile.x + 1 },
      life: new LifeBuilder().finish(),
      fixtures: [],
    };
    const group = { tile, life: geo, fixtures: [] };
    const season = {
      id: 'memorial',
      title: { en: 'Memorial' },
      window: { from: { month: 11, day: 1 }, to: { month: 11, day: 2 } },
      sources: [],
      candles: { label: 'Candles', share: 0.5 },
    };
    expect(candleFixtures(tile, geo, 0.5)).toEqual([
      { kind: 'season-candle', at: tileToLngLat(tile, { x: 1000, y: 1000 }), seed: 1 },
    ]);
    expect(seasonalFixtures([group, neighbor], season, 13)).toEqual(
      seasonalFixtures([neighbor, group], season, 13),
    );
    expect(seasonalFixtures([group], undefined, 13)).toEqual([]);
  });
  it('bounds markerless fallback, respects holes, and skips fragments with burial rows', () => {
    const b = new LifeBuilder();
    b.cemeteryArea('empty', [ring(), ring(1500, 1500, 2500, 2500)]);
    b.cemeteryArea('marked', [ring(100, 100, 300, 300)]);
    b.burialParent('marked');
    const geo = b.finish();
    const sites = memorialAnchors(tile, geo, 0.001);
    expect(sites.length).toBeGreaterThan(0);
    expect(memorialAnchors(tile, geo, 1).length).toBeLessThanOrEqual(32);
    expect(sites.every((p) => p.x >= 500 && p.x < 3500 && p.y >= 500 && p.y < 3500)).toBe(true);
    expect(sites.some((p) => p.x > 1500 && p.x < 2500 && p.y > 1500 && p.y < 2500)).toBe(false);
    expect(candleFixtures(tile, geo, 0)).toEqual([]);
  });
  it('retains uniquely owned fallback selections across a buffered cemetery seam and neighbor removal', () => {
    const a = new LifeBuilder(),
      b = new LifeBuilder();
    const polygon = ring(3800, 1000, 4396, 2000);
    a.cemeteryArea('cemetery/seam', [polygon]);
    b.cemeteryArea('cemetery/seam', [polygon.map((p) => ({ x: p.x - 4096, y: p.y }))]);
    const current = { tile, life: a.finish(), fixtures: [] };
    const neighbor = { tile: { ...tile, x: tile.x + 1 }, life: b.finish(), fixtures: [] };
    prepareMemorialSites(current.tile, current.life);
    prepareMemorialSites(neighbor.tile, neighbor.life);
    const season = {
      id: 'memorial',
      title: { en: 'Memorial' },
      window: { from: { month: 11, day: 1 }, to: { month: 11, day: 2 } },
      candles: { label: 'Candles', share: 0.75 },
    };
    const keys = (fixtures: ReturnType<typeof seasonalFixtures>) =>
      fixtures
        .map((f) => {
          if (f.kind !== 'season-candle') throw new Error('unexpected fixture');
          return `${f.at[0].toFixed(9)}/${f.at[1].toFixed(9)}/${f.seed}`;
        })
        .sort();
    const onlyCurrent = keys(seasonalFixtures([current], season, 13));
    const onlyNeighbor = keys(seasonalFixtures([neighbor], season, 13));
    expect(onlyCurrent.length).toBeGreaterThan(0);
    expect(onlyNeighbor.length).toBeGreaterThan(0);
    const together = keys(seasonalFixtures([current, neighbor], season, 13));
    expect(together).toEqual([...onlyCurrent, ...onlyNeighbor].sort());
    expect(new Set(together).size).toBe(together.length);
    expect(keys(seasonalFixtures([neighbor, current], season, 13))).toEqual(together);
    expect(keys(seasonalFixtures([current], season, 13))).toEqual(onlyCurrent);
    expect(keys(seasonalFixtures([neighbor], season, 13))).toEqual(onlyNeighbor);
    expect(memorialAnchors(current.tile, current.life, 1).every(inTile)).toBe(true);
    expect(memorialAnchors(neighbor.tile, neighbor.life, 1).every(inTile)).toBe(true);
  });
  it('finds a safe interior in a small fragment and rejects blocked fragments', () => {
    const b = new LifeBuilder();
    b.cemeteryArea('small', [ring(501, 501, 551, 551)]);
    expect(memorialAnchors(tile, b.finish(), 0.01)).toHaveLength(1);
    b.area('blocked', [ring(400, 400, 600, 600)]);
    expect(memorialAnchors(tile, b.finish(), 1)).toEqual([]);
  });
  it('admits bounded fragments by code-point identity regardless of insertion order', () => {
    const ids = [
      'cemetery/Z',
      ...Array.from({ length: 32 }, (_, i) => `cemetery/a${String(i).padStart(2, '0')}`),
      'cemetery/z',
    ];
    const build = (order: readonly string[]) => {
      const b = new LifeBuilder();
      for (const id of order) {
        const i = ids.indexOf(id),
          x = 100 + (i % 8) * 400,
          y = 200 + Math.floor(i / 8) * 400;
        b.cemeteryArea(id, [ring(x, y, x + 20, y + 20)]);
      }
      return memorialAnchors(tile, b.finish(), 1).map((p) => p.memorial);
    };
    expect(build(ids)).toEqual(ids.slice(0, 32));
    expect(build([...ids].reverse())).toEqual(ids.slice(0, 32));
  });
  it('shares transferred safe sites and fragment identities without rebuilding fallback indexes', () => {
    const b = new LifeBuilder();
    b.cemeteryArea('first', [ring(501, 501, 551, 551)]);
    b.cemeteryArea('second', [ring(1501, 1501, 1551, 1551)]);
    const geo = b.finish();
    prepareMemorialSites(tile, geo);
    const sites = memorialAnchors(tile, geo, 0.000001);
    expect(sites.map((p) => p.memorial)).toEqual(['first', 'second']);
    const buffers = lifeTransferables(geo);
    expect(buffers).toContain(geo.memorialSites!.buffer);
    const clone = structuredClone(geo, { transfer: buffers });
    // Prepared consumers need neither polygon fragments nor unsafe terrain indexes.
    clone.cemeteryAreas = undefined;
    clone.areas = undefined;
    expect(memorialAnchors(tile, clone, 0.000001)).toEqual(sites);
    expect(sites.every((p) => Number.isInteger(p.seed) && p.seed < 0x1000000)).toBe(true);
    const empty = new LifeBuilder().finish();
    prepareMemorialSites(tile, empty);
    empty.cemeteryAreas = [{ id: 'later', rings: [ring()], hasBurials: false }];
    expect(memorialAnchors(tile, empty, 1)).toEqual([]);
  });
  it('fades candle ink with Life off and gates headless compact light pools at zoom 18', () => {
    const fixture = {
      kind: 'season-candle' as const,
      at: [5.5, 5.5] as [number, number],
      seed: 17,
    };
    const grid = {
      cols: 10,
      rows: 10,
      cellWidth: 5,
      cellHeight: 9,
      toCell: (x: number, y: number): [number, number] => [x, y],
    };
    const glyphs = mapGlyphs(themes.dark);
    const packed = (zoom: number) =>
      packFixtures(new Uint8Array(400), grid, [fixture], zoom, (s) => glyphs.indexOf(s), 0);
    expect(packed(17.5).visibility.seasonal?.candles).toBeFalsy();
    const middle = packed(17.75),
      full = packed(18);
    const at = (5 * 10 + 5) * 4;
    expect(middle.texels[at + 3]).toBeGreaterThan(0);
    expect(middle.texels[at + 3]).toBeLessThan(255);
    expect(full.texels[at + 3]).toBe(255);
    expect(unpackGlyph(full.texels[at]!, full.texels[at + 1]!).cls).toBe(FixturePart.candle);
    expect(full.texels[at + 2]).toBe(lightByte(LampState.candle, 17));
    expect(full.visibility.seasonal?.candles).toBe(true);
    expect(candleLamps([fixture], 17.99)).toEqual([]);
    expect(candleLamps([fixture], 18)).toMatchObject([{ state: LampState.candle, headless: true }]);
    expect(candleLamps([], 19)).toEqual([]);
  });
  it('omits hidden candles from cached admission and restores them at the fade threshold', () => {
    const b = new LifeBuilder();
    b.grave({ x: 1000, y: 1000 }, 'grave', 1);
    const groups = [{ tile, life: b.finish(), fixtures: [] }];
    const season = {
      id: 'memorial',
      title: { en: 'Memorial' },
      window: { from: { month: 11, day: 1 }, to: { month: 11, day: 2 } },
      candles: { label: 'Candles', share: 1 },
    };
    const cached = createSeasonalFixtureCache();
    expect(cached(groups, season, 13, true, false)).toEqual([]);
    const visible = cached(groups, season, 13, true, true);
    expect(visible).toHaveLength(1);
    expect(cached(groups, season, 13, true, true)).toBe(visible);
    expect(candleLamps(visible, 18)).toBe(candleLamps(visible, 19));
    expect(candleLamps(visible, 17.99)).toEqual([]);
    expect(cached(groups, season, 13, true, false)).toEqual([]);
    expect(cached(groups, undefined, 13)).toEqual([]);
  });
});
