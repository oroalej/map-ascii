import { describe, expect, it } from 'vitest';
import { mapGlyphs, themes } from '../theme';
import { drawProcedural } from '../glyphs/atlas';
import { MAX_GLYPHS, unpackGlyph } from '../glyphs/select';
import { metersPerUnit } from '../raster/geometry';
import { CAT_PAINTS, catGlyph, catGlyphs } from './cats';
import { CAT, CellBit, LIFE_ZOOM, MAX_TILE_AGENTS } from './config';
import { packLife, type LifeGrid } from './draw';
import { LifeBuilder, LifeLine } from './geometry';
import { Heading } from './masters';
import { TileLife, LifeWorld, type VisibleAgent } from './simulate';

describe('cats', () => {
  it('draws every walking, resting, and grooming cell with a bounded atlas', () => {
    for (const theme of Object.values(themes)) {
      const glyphs = mapGlyphs(theme);
      expect(glyphs.length).toBeLessThanOrEqual(MAX_GLYPHS + 1);
      for (const glyph of catGlyphs()) {
        expect(glyphs).toContain(glyph);
        const data = new Uint8Array(10 * 18);
        expect(drawProcedural({ data, stride: 10, x0: 0, y0: 0, w: 10, h: 18 }, glyph)).toBe(true);
        expect(data.some((v) => v > 0)).toBe(true);
      }
    }
  });

  it('renders at a legible cell size, then at its real size with distinct poses', () => {
    const grid: LifeGrid = {
      cols: 40,
      rows: 30,
      cellWidth: 10,
      cellHeight: 18,
      toCell: (lng, lat) => [lng, lat],
    };
    const glyphs = mapGlyphs(themes.dark);
    const lookup = (glyph: string) => glyphs.indexOf(glyph);
    const render = (scale: number, flap: number) => {
      const out = new Uint8Array(grid.cols * grid.rows * 4);
      const agent: VisibleAgent = {
        kind: 'cat',
        lng: 20,
        lat: 15,
        ahead: [20 + scale, 15],
        paint: CAT_PAINTS[0],
        flap,
      };
      packLife(out, grid, [agent], themes.dark, lookup);
      return out;
    };
    const small = render(0.5, 1);
    const at = (15 * 40 + 20) * 4;
    expect(unpackGlyph(small[at]!, small[at + 1]!).glyph).toBe(lookup(catGlyph(1, Heading.right)));
    expect(small[(15 * 40 + 20) * 4 + 2]).toBe(CellBit.person);
    const rest = render(12, 2),
      groom = render(12, 3);
    expect(Array.from(rest).filter((v, i) => i % 4 === 2 && v !== 0).length).toBeGreaterThan(4);
    expect(rest).not.toEqual(groom);
  });

  it('spawns deterministically on quiet paths within the existing agent cap', () => {
    const tile = { z: 16, x: 55192, y: 30266 };
    const b = new LifeBuilder();
    for (let i = 0; i < 12; i++)
      b.line(
        [
          { x: 10, y: 200 + i * 250 },
          { x: 4000, y: 200 + i * 250 },
        ],
        LifeLine.path,
      );
    const geometry = b.finish();
    const a = new TileLife(tile, geometry, 7),
      other = new TileLife(tile, geometry, 7);
    const cats = a.movers.filter((m) => m.kind === 'cat');
    expect(cats.length).toBeGreaterThan(0);
    expect(cats.length).toBeLessThanOrEqual(CAT.maxPerTile);
    expect(a.movers.length).toBeLessThanOrEqual(MAX_TILE_AGENTS);
    expect(cats).toEqual(other.movers.filter((m) => m.kind === 'cat'));
    for (const cat of cats) {
      expect(cat.pause).toBeGreaterThan(0);
      expect(CAT_PAINTS).toContain(cat.paint);
      expect(cat.speed * metersPerUnit(tile)).toBeLessThan(1);
    }
    const world = new LifeWorld();
    world.sync([{ key: 'cats', tile, life: geometry }]);
    expect(world.visible(LIFE_ZOOM.cat.min - 0.1, 1, [123, 13]).some((m) => m.kind === 'cat')).toBe(
      false,
    );
    expect(world.visible(LIFE_ZOOM.cat.min, 1, [123, 13]).some((m) => m.kind === 'cat')).toBe(true);
  });
});
