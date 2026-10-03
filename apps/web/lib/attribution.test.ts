// @vitest-environment node
import { expect, it } from 'vitest';
import { additionalCredits } from './attribution';

it('removes repeated footer licensing while retaining additional sources and notes', () => {
  expect(
    additionalCredits([
      'Survey. Geometry: © OpenStreetMap contributors (ODbL). Draft, undated estimates.',
      'Survey. Draft, undated estimates.',
      '© OpenStreetMap contributors (ODbL).',
      'Imagery © Other provider; OSM geometry © OpenStreetMap contributors; owner survey.',
      'OpenStreetMap survey notes; © Other provider.',
    ]),
  ).toEqual([
    'Survey. Draft, undated estimates.',
    'Imagery © Other provider; owner survey.',
    'OpenStreetMap survey notes; © Other provider.',
  ]);
});
