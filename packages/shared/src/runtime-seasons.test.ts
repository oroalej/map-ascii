import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import cityPack from '../../content/cities/naga/city.json';
import { CityLife, RuntimeCityLifeSchema } from './schemas';
import { runtimeCityLife } from './rhythm';
import {
  activeSeason,
  epochDay,
  expandSeasons,
  resolveSeason,
  runtimeSeason,
  type RuntimeSeasonConfig,
} from './seasons';

describe('season client payload', () => {
  const life = CityLife.parse(cityPack.life);
  const runtime = runtimeCityLife(life);

  it('keeps calendar and admission fields while omitting pipeline geometry', () => {
    expect(RuntimeCityLifeSchema.parse(cityPack.life)).toEqual(runtime);
    expect(runtime.schedules).toEqual(life.schedules);
    expect(runtime.rhythm).toEqual(life.rhythm);
    const compactSeasons = life.seasons!.map(runtimeSeason);
    for (const [index, season] of life.seasons!.entries()) {
      const compact = compactSeasons[index]!;
      expect(compact).toMatchObject({
        id: season.id,
        title: season.title,
        window: season.window,
      });
      expect(compact.includes).toEqual(season.includes);
      expect(compact.fireworks).toEqual(season.fireworks);
      expect(compact.lanterns).toEqual(season.lanterns);
      expect(compact.stalls).toEqual(season.stalls);
      expect(compact).not.toHaveProperty('sources');
      expect(compact).not.toHaveProperty('grounds');
      for (const [i, installation] of (season.installations ?? []).entries()) {
        const admitted = compact.installations![i]!;
        expect(admitted).toMatchObject({
          id: installation.id,
          anchor: installation.anchor,
          kind: installation.kind,
          label: installation.label,
        });
        if (installation.kind === 'light-string') {
          expect(admitted.layout).toBe(installation.layout);
          expect(admitted.mount).toBe(installation.mount);
        }
        if (installation.kind === 'access-path') expect(admitted.style).toBe(installation.style);
        for (const field of [
          'sources',
          'grounds',
          'components',
          'points',
          'radius_m',
          'spacing_m',
          'trees',
        ])
          expect(admitted).not.toHaveProperty(field);
      }
      for (const [i, corridor] of (season.bunting?.corridors ?? []).entries()) {
        expect(compact.bunting!.corridors![i]).toEqual({ id: corridor.id, ways: corridor.ways });
      }
    }
    const fullBytes = gzipSync(JSON.stringify(life.seasons)).length;
    const clientBytes = gzipSync(JSON.stringify(runtime.seasons)).length;
    expect(fullBytes - clientBytes).toBeGreaterThan(2_000);
  });

  it('layers the real Christmas runtime decorations onto New Year alongside fireworks', () => {
    const newYear = runtime.seasons!.find((s) => s.id === 'new-year')!;
    const christmas = runtime.seasons!.find((s) => s.id === 'christmas')!;
    expect(newYear.includes).toEqual(['christmas']);
    expect(newYear.fireworks).toEqual(life.seasons!.find((s) => s.id === 'new-year')!.fireworks);
    for (const field of ['lanterns', 'bunting', 'stalls', 'installations'] as const)
      expect(newYear[field]).toEqual(christmas[field]);
    for (const installation of newYear.installations!)
      for (const field of [
        'sources',
        'grounds',
        'components',
        'points',
        'radius_m',
        'spacing_m',
        'trees',
      ])
        expect(installation).not.toHaveProperty(field);
  });

  it('expands groups with own precedence and ordered fallback without changing inputs', () => {
    const base: RuntimeSeasonConfig = {
      id: 'base',
      title: { en: 'Base' },
      window: { from: { month: 12, day: 1 }, to: { month: 1, day: 6 } },
      lanterns: { label: 'Base stars', shape: 'star' },
      bunting: { label: 'Base flags', near: ['worship'], radius_m: 300, spacing_m: 30 },
      stalls: { label: 'Base carts', near: ['worship'], radius_m: 300, per_tile: 12 },
      fireworks: { label: 'Base fireworks', variants: ['ring'] },
      installations: [
        { id: 'base-tree', anchor: 'osm:way/1', kind: 'christmas-tree', label: 'Tree' },
      ],
    };
    const second = {
      ...base,
      id: 'second',
      installations: [{ ...base.installations![0]!, id: 'second-tree' }],
    };
    const own: RuntimeSeasonConfig = {
      id: 'preview',
      title: { en: 'Preview' },
      window: base.window,
      includes: ['base', 'second'],
      lanterns: { label: 'Own stars', shape: 'star' },
      fireworks: { label: 'Own fireworks', variants: ['peony'] },
      installations: [{ ...base.installations![0]!, id: 'own-tree' }],
    };
    const seasons = [own, base, second];
    const before = structuredClone(seasons);
    const expanded = expandSeasons(seasons);
    expect(seasons).toEqual(before);
    expect(expanded[0]).toMatchObject({
      includes: own.includes,
      lanterns: own.lanterns,
      fireworks: own.fireworks,
      bunting: base.bunting,
      stalls: base.stalls,
    });
    expect(expanded[0]!.installations!.map((i) => i.id)).toEqual([
      'own-tree',
      'base-tree',
      'second-tree',
    ]);
    expect(expanded[1]).toEqual(base);
    expect(expanded[1]).not.toBe(base);
    expect(expandSeasons([{ ...own, fireworks: undefined }, base])[0]!.fireworks).toEqual(
      base.fireworks,
    );
  });

  it('preserves Today and explicit previews across every day of the supported calendars', () => {
    for (const year of [2024, 2026, 2030]) {
      for (let day = epochDay(year, 1, 1); day < epochDay(year + 1, 1, 1); day++) {
        expect(activeSeason(runtime.seasons, year, day)?.id).toBe(
          activeSeason(life.seasons, year, day)?.id,
        );
      }
      for (const season of life.seasons!) {
        expect(resolveSeason(runtime.seasons, season.id, year, epochDay(year, 7, 1))?.id).toBe(
          season.id,
        );
      }
    }
  });
});
