import { describe, expect, it } from 'vitest';
import type { Landmark } from '@atlas/shared';
import { City, contentSchemas } from '@atlas/shared/schemas';

const cityFiles = import.meta.glob('../cities/*/city.json', { eager: true, import: 'default' });
const tourFiles = import.meta.glob('../cities/*/tours/*.json', { eager: true, import: 'default' });
const landmarkFiles = import.meta.glob('../cities/*/landmarks/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, Landmark>;
const citySlug = (path: string) => path.split('/')[2]!;
const cities = new Map(
  Object.entries(cityFiles).map(([file, value]) => [citySlug(file), City.parse(value)]),
);
const tours = Object.entries(tourFiles).map(([file, value]) => {
  const city = cities.get(citySlug(file))!;
  return { file, city, tour: contentSchemas(city.languages).Tour.parse(value) };
});

describe('city tour content', () => {
  it.each(tours)(
    '$file references city-local groups and landmarks and cites verified steps',
    ({ file, city, tour }) => {
      if (city.tour_groups) {
        expect(tour.group, file).toBeDefined();
        expect(
          city.tour_groups.map((group) => group.id),
          file,
        ).toContain(tour.group);
      } else expect(tour.group, file).toBeUndefined();
      const landmarks = new Set(
        Object.entries(landmarkFiles)
          .filter(([path]) => citySlug(path) === city.slug)
          .map(([, landmark]) => landmark.id),
      );
      for (const [index, step] of tour.steps.entries()) {
        if (step.select?.startsWith('landmark/'))
          expect(landmarks, `${file} step ${index}`).toContain(step.select);
        if (tour.status === 'verified')
          expect(
            step.sources?.some((source) => {
              if (!source.url) return false;
              const host = new URL(source.url).hostname.toLowerCase();
              return host !== 'openstreetmap.org' && !host.endsWith('.openstreetmap.org');
            }),
            `${file} step ${index} needs a non-OSM source`,
          ).toBe(true);
      }
    },
  );

  it('includes Naga’s two verified route tours with the declared groups', () => {
    for (const [id, group] of [
      ['bridges-and-terminals', 'infrastructure'],
      ['traslacion-route', 'heritage'],
    ]) {
      const entry = tours.find(
        ({ city, tour }) => city.slug === 'naga' && tour.id === `tour/${id}`,
      );
      expect(entry?.tour).toMatchObject({ group, status: 'verified' });
    }
    const naga = tours.filter(({ city }) => city.slug === 'naga');
    expect(naga.filter(({ tour }) => tour.group === 'food')).toHaveLength(5);
    expect(naga.filter(({ tour }) => tour.group === 'heritage')).toHaveLength(2);
    expect(naga.filter(({ tour }) => tour.group === 'infrastructure')).toHaveLength(1);
  });
});
