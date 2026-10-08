import { expect, it } from 'vitest';
import type { RuntimeCityLife } from '@atlas/shared';
import { runtimeFolklore } from './folklore-config';

it('projects only folklore and its referenced window without changing seasons', () => {
  const window = { from: { month: 10, day: 31 }, to: { month: 11, day: 2 } };
  const life: RuntimeCityLife = {
    source: 'example',
    seasons: [{ id: 'undas', title: { en: 'Undas' }, window, installations: [] }],
    folklore: {
      hours: { from: 1320, to: 240 },
      ghosts: {
        sites: ['cemetery'],
        per_cemetery: [1, 2],
        undas_per_cemetery: [3, 6],
        undas_season: 'undas',
        site_share: 0.5,
        range_m: [30, 50],
      },
      manananggal: { window, night_chance: 0.35 },
      sources: [{ title: 'example' }],
    },
  };
  const before = structuredClone(life);
  expect(runtimeFolklore(life)).toEqual({
    hours: life.folklore!.hours,
    ghosts: life.folklore!.ghosts,
    manananggal: life.folklore!.manananggal,
    undasWindow: window,
  });
  expect(life).toEqual(before);
  expect(runtimeFolklore(undefined)).toBeUndefined();
  expect(runtimeFolklore({ ...life, seasons: [] })).toBeUndefined();
});
