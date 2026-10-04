import { describe, expect, it } from 'vitest';
import type { SeasonConfig, UtilityRecord } from '@atlas/shared';
import { LifeBuilder, LifeLine } from './geometry';
import {
  collectSeasonAnchors,
  createSeasonalFixtureCache,
  seasonalFixtures,
  SEASONAL_GLYPHS,
} from './seasonal';
import {
  FixturePart,
  packFixtures,
  updateFixtureFlags,
  type FixtureGrid,
  type LegacyStreetFixture,
} from './fixtures';
import { LampState } from './lights';
import { tileToLngLat } from '../raster/geometry';
import { mapGlyphs, themes } from '../theme';
import { drawProcedural } from '../glyphs/atlas';
import { utilityFixtures } from './utilities';

const tile = { z: 16, x: 55192, y: 30266 };
const season: SeasonConfig = {
  id: 'winter',
  title: { en: 'Winter' },
  status: 'draft',
  note: 'TODO(verify)',
  window: { from: { month: 12, day: 1 }, to: { month: 1, day: 6 } },
  sources: [{ title: 'Calendar', url: 'https://example.com/calendar' }],
  lanterns: { label: 'Stars', shape: 'star' },
  bunting: { label: 'Pennants', near: ['worship'], radius_m: 300, spacing_m: 30 },
};
const lamp: Extract<LegacyStreetFixture, { kind: 'streetlight' }> = {
  kind: 'streetlight',
  base: [40.5, 40.5],
  tip: [43.5, 40.5],
  forward: [41.5, 40.5],
  right: [40.5, 41.5],
  roadCenter: [45.5, 40.5],
  state: LampState.working,
  seed: 17,
};
const grid: FixtureGrid = {
  cols: 100,
  rows: 100,
  cellWidth: 5,
  cellHeight: 9,
  toCell: (x, y) => [x, y],
};
const glyphs = mapGlyphs(themes.dark),
  index = (s: string) => glyphs.indexOf(s);
const pack = (fixtures: Parameters<typeof packFixtures>[2], zoom = 20) =>
  packFixtures(new Uint8Array(40000), grid, fixtures, zoom, index, 0);

describe('seasonal fixtures', () => {
  it('skips hidden bunting preparation and invalidates eligibility while retaining lanterns', () => {
    const b = new LifeBuilder();
    b.line(
      [
        { x: 0, y: 2000 },
        { x: 4096, y: 2000 },
      ],
      LifeLine.roadMinor,
      8,
    );
    b.place({ x: 2000, y: 2000 }, 'worship', 20);
    const groups = [{ tile, life: b.finish(), fixtures: [lamp] }];
    const cache = createSeasonalFixtureCache();
    const hidden = cache(groups, season, 13.6, false);
    expect(hidden.map((f) => f.kind)).toEqual(['season-lantern']);
    expect(cache(groups, season, 13.6, false)).toBe(hidden);
    const shown = cache(groups, season, 13.6, true);
    expect(shown.some((f) => f.kind === 'season-bunting')).toBe(true);
    expect(cache(groups, season, 13.6, true)).toBe(shown);
    expect(cache(groups, season, 13.6, false).map((f) => f.kind)).toEqual(['season-lantern']);
  });
  it('hangs pennants beside horizontal, vertical and diagonal utility cables without erasing them', () => {
    for (const end of [
      [80.5, 40.5],
      [40.5, 80.5],
      [80.5, 80.5],
    ] as [number, number][]) {
      const pole = (id: string, at: [number, number]) => ({
        id,
        road: 'r',
        component: 'r/0',
        at,
        heading: [1, 0] as [number, number],
        normal: [0, 1] as [number, number],
        transformer: false,
      });
      const span = {
        id: 'crossing',
        kind: 'crossing' as const,
        from: pole('a', [40.5, 40.5]),
        to: pole('b', end),
        seed: 7,
      };
      const hardware = utilityFixtures([{ version: 1, kind: 'span', span }]);
      const base = pack(hardware),
        decorated = pack([
          ...hardware,
          {
            kind: 'season-bunting',
            id: span.id,
            from: span.from.at,
            to: span.to.at,
            seed: span.seed,
          },
        ]);
      expect(decorated.visibility.seasonal?.bunting).toBe(true);
      expect(base.utilityCells.length).toBeGreaterThan(0);
      for (const cell of base.utilityCells)
        expect(decorated.texels.slice(cell * 4, cell * 4 + 4)).toEqual(
          base.texels.slice(cell * 4, cell * 4 + 4),
        );
    }
  });
  it('uses neighboring tile-owned places and invalidates changed payload/config identities', () => {
    const b = new LifeBuilder();
    b.line(
      [
        { x: 3500, y: 2000 },
        { x: 4500, y: 2000 },
      ],
      LifeLine.roadMinor,
      8,
    );
    const neighbor = new LifeBuilder();
    neighbor.place({ x: 50, y: 2000 }, 'worship', 20);
    const groups = [
      { tile, life: b.finish(), fixtures: [] },
      { tile: { ...tile, x: tile.x + 1 }, life: neighbor.finish(), fixtures: [] },
    ];
    expect(collectSeasonAnchors(groups)).toHaveLength(1);
    const cache = createSeasonalFixtureCache(),
      a = cache(groups, season, 13.6);
    expect(a.length).toBeGreaterThan(0);
    expect(cache(groups, season, 13.6)).toBe(a);
    expect(cache(groups, { ...season }, 13.6)).not.toBe(a);
    expect(cache([{ ...groups[0]!, life: new LifeBuilder().finish() }], season, 13.6)).toEqual([]);
    const empty = cache(groups, undefined, 13.6);
    expect(cache(groups, undefined, 13.6)).toBe(empty);
  });
  it('prefers eligible utility crossings, otherwise uses deterministic half-open world spacing', () => {
    const b = new LifeBuilder();
    b.line(
      [
        { x: 0, y: 2000 },
        { x: 4096, y: 2000 },
      ],
      LifeLine.roadMinor,
      8,
    );
    b.place({ x: 2000, y: 2000 }, 'worship', 20);
    const life = b.finish(),
      fixtures: LegacyStreetFixture[] = [];
    const point = (x: number, y: number) => tileToLngLat(tile, { x, y });
    const pole = (id: string, y: number) => ({
      id,
      road: 'r',
      component: 'r/0',
      at: point(2000, y),
      heading: [1, 0] as [number, number],
      normal: [0, 1] as [number, number],
      transformer: false,
    });
    const crossing: UtilityRecord = {
      version: 1,
      kind: 'span',
      span: {
        id: 'crossing',
        kind: 'crossing',
        from: pole('a', 1950),
        to: pole('b', 2050),
        seed: 7,
      },
    };
    const preferred = seasonalFixtures(
      [{ tile, life, fixtures, utilities: [crossing, crossing] }],
      season,
      13.6,
    );
    expect(preferred).toMatchObject([{ kind: 'season-bunting', id: 'crossing' }]);
    b.line(
      [
        { x: 0, y: 2500 },
        { x: 4096, y: 2500 },
      ],
      LifeLine.roadMinor,
      8,
    );
    const partial = seasonalFixtures(
      [{ tile, life: b.finish(), fixtures, utilities: [crossing] }],
      season,
      13.6,
    );
    expect(partial.some((f) => f.kind === 'season-bunting' && f.id === 'crossing')).toBe(true);
    expect(partial.some((f) => f.kind === 'season-bunting' && f.id.startsWith('fallback/'))).toBe(
      true,
    );
    const fallback = seasonalFixtures([{ tile, life, fixtures }], season, 13.6);
    expect(fallback.length).toBeGreaterThan(1);
    expect(fallback).toEqual(seasonalFixtures([{ tile, life, fixtures }], season, 13.6));
    expect(new Set(fallback.map((f) => f.kind === 'season-bunting' && f.id)).size).toBe(
      fallback.length,
    );
    expect(
      seasonalFixtures([{ tile, life: new LifeBuilder().finish(), fixtures }], season, 13.6),
    ).toEqual([]);
  });
  it('preserves hardware and every animated flag envelope, clipping offscreen decorations', () => {
    const flag = {
      ...lamp,
      base: [20.5, 40.5] as [number, number],
      kind: 'flagpole' as const,
      flag: 'PH' as const,
    };
    const base = pack([lamp, flag]),
      decorated = pack([
        lamp,
        flag,
        { kind: 'season-lantern', lamp },
        { kind: 'season-bunting', id: 'long', from: [-1e8, 40.5], to: [1e8, 40.5], seed: 7 },
      ]);
    expect(decorated.visibility.seasonal).toEqual({ lanterns: true, bunting: true });
    for (let i = 0; i < base.texels.length; i += 4)
      if (base.texels[i + 3])
        expect(decorated.texels.slice(i, i + 4)).toEqual(base.texels.slice(i, i + 4));
    for (const time of [0.3, 0.7, 1.5, 3]) {
      updateFixtureFlags(base, { time, strength: 1.5 });
      updateFixtureFlags(decorated, { time, strength: 1.5 });
      for (const at of base.cloth.cells)
        expect(decorated.texels.slice(at, at + 4)).toEqual(base.texels.slice(at, at + 4));
    }
    const lantern = [...decorated.texels].filter(
      (_, i) => i % 4 === 1 && (decorated.texels[i]! & 63) === FixturePart.lantern,
    );
    expect(lantern).toHaveLength(1);
    expect(pack([{ kind: 'season-lantern', lamp }], 16).visibility.seasonal?.lanterns).toBe(false);
    expect(
      pack([{ kind: 'season-bunting', id: 'outside', from: [-30, -30], to: [-20, -20], seed: 7 }])
        .visibility.seasonal?.bunting,
    ).toBe(false);
  });
  it('draws distinct procedural ornaments at small and large cell sizes without touching the flag star', () => {
    for (const [w, h] of [
      [5, 9],
      [10, 18],
      [20, 36],
    ])
      for (const glyph of SEASONAL_GLYPHS) {
        const data = new Uint8Array(w! * h!);
        expect(drawProcedural({ data, stride: w!, x0: 0, y0: 0, w: w!, h: h! }, glyph)).toBe(true);
        expect(data.some((n) => n > 0)).toBe(true);
        expect(data.some((n) => n === 0)).toBe(true);
      }
    expect(
      drawProcedural({ data: new Uint8Array(45), stride: 5, x0: 0, y0: 0, w: 5, h: 9 }, '★'),
    ).toBe(false);
  });
});
