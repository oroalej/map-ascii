import { expect, it, vi } from 'vitest';
import { legendEntries } from './legend';
import type * as ThemeModule from './theme';

vi.mock('./theme', async (importOriginal) => {
  const original = await importOriginal<typeof ThemeModule>();
  return {
    ...original,
    CLASS_LABELS: Object.fromEntries(
      Object.keys(original.CLASS_LABELS).map((cls) => [cls, 'Translated category']),
    ),
  };
});

it('merges explicit categories and separates unrelated classes even with identical translated labels', () => {
  const entries = legendEntries('dark', 16, [
    'building_school',
    'marker_school',
    'road_mid',
    'water_river',
  ]);
  const school = entries.find((e) => e.id === 'class:building_school')!;
  expect(school.label).toBe('Translated category');
  expect(school.classes).toEqual(expect.arrayContaining(['building_school', 'marker_school']));
  expect(entries.find((e) => e.id === 'class:road_mid')?.classes).toEqual(['road_mid']);
  expect(entries.find((e) => e.id === 'class:water_river')?.classes).toEqual(['water_river']);
});

it('keeps Life descriptors independent of translated class text', () => {
  const entries = legendEntries('light', 19, undefined, { life: true });
  expect(entries.find((e) => e.id === 'life:people')?.focus?.life).toEqual(['people']);
  expect(entries.find((e) => e.id === 'life:vendors')?.focus?.life).toEqual(['vendors']);
  expect(entries.find((e) => e.id === 'life:pets')?.focus?.life).toEqual(['pets']);
});
