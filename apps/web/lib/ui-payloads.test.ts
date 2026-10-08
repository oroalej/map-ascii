// @vitest-environment node
import { expect, it } from 'vitest';
import { CityArt, Landmark, Tour } from '@atlas/shared';
import fixture from './__fixtures__/ui-payloads.json';
import { isCityArt, isCityLandmarks, isCityTours } from './guards';
it('accepts actual pipeline wire formats and their corresponding schemas', () => {
  expect(Landmark.array().safeParse(fixture.landmarks).success).toBe(true);
  expect(Tour.array().safeParse(fixture.tours).success).toBe(true);
  expect(CityArt.safeParse(fixture.art).success).toBe(true);
  expect(isCityLandmarks(fixture.landmarks)).toBe(true);
  expect(isCityTours(fixture.tours)).toBe(true);
  expect(isCityArt(fixture.art)).toBe(true);
  expect(isCityArt(fixture.art.pieces)).toBe(false);
});
it('rejects malformed facts, steps, art colors, palettes and row dimensions', () => {
  expect(isCityLandmarks([{ ...fixture.landmarks[0], sources: [] }])).toBe(false);
  expect(isCityTours([{ ...fixture.tours[0], steps: [{ camera: {} }] }])).toBe(false);
  const piece = fixture.art.pieces[0]!;
  for (const bad of [
    { ...piece, palette: { a: 'unknown' } },
    { ...piece, variants: [{ rows: ['aa', 'a'], colors: ['  ', ' '] }] },
    { ...piece, variants: [{ rows: ['aa'], colors: ['!!'] }], palette: { a: 'stone' } },
    { ...piece, variants: [{ rows: [], colors: [] }] },
  ])
    expect(isCityArt({ pieces: [bad] })).toBe(false);
});
