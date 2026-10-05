import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import cityPack from '../../content/cities/naga/city.json';
import { CityLife, RuntimeCityLifeSchema } from './schemas';
import { runtimeCityLife } from './rhythm';
import { activeSeason, epochDay, resolveSeason } from './seasons';

describe('season client payload', () => {
  const life = CityLife.parse(cityPack.life);
  const runtime = runtimeCityLife(life);

  it('keeps calendar, disclosure and admission fields while omitting pipeline geometry', () => {
    expect(RuntimeCityLifeSchema.parse(cityPack.life)).toEqual(runtime);
    expect(runtime.schedules).toEqual(life.schedules);
    expect(runtime.rhythm).toEqual(life.rhythm);
    for (const [index, season] of life.seasons!.entries()) {
      const compact = runtime.seasons![index]!;
      expect(compact).toMatchObject({
        id: season.id,
        title: season.title,
        status: season.status,
        window: season.window,
      });
      expect(compact.note).toBe(season.note);
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
        for (const field of ['sources', 'grounds', 'components', 'points', 'radius_m', 'spacing_m'])
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
