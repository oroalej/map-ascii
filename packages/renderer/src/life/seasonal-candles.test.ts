import { describe, expect, it } from 'vitest';
import { LifeBuilder } from './geometry';
import { candleFixtures, candleLamps, memorialAnchors } from './seasonal-candles';
import { seasonalFixtures } from './seasonal';
import { packFixtures, FixturePart } from './fixtures';
import { LampState, lightByte } from './lights';
import { mapGlyphs, themes } from '../theme';
import { tileToLngLat } from '../raster/geometry';
import { unpackGlyph } from '../glyphs/select';
import { glyphFragmentFor } from '../shaders/glyph';
import { classId } from '../classes';

const tile = { z: 16, x: 55192, y: 30266 };
const ring = (l = 500, t = 500, r = 3500, b = 3500) => [
  { x: l, y: t },
  { x: r, y: t },
  { x: r, y: b },
  { x: l, y: b },
  { x: l, y: t },
];
describe('seasonal memorial candles', () => {
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
  it('finds a safe interior in a small fragment and rejects blocked fragments', () => {
    const b = new LifeBuilder();
    b.cemeteryArea('small', [ring(501, 501, 551, 551)]);
    expect(memorialAnchors(tile, b.finish(), 0.01)).toHaveLength(1);
    b.area('blocked', [ring(400, 400, 600, 600)]);
    expect(memorialAnchors(tile, b.finish(), 1)).toEqual([]);
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
});
