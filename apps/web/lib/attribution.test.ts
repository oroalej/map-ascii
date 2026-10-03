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

it('cleans real OSM punctuation fragments without removing the remaining provenance', () => {
  expect(
    additionalCredits([
      'Ateneo vegetation — OSM geometry © OpenStreetMap contributors; owner annotated Google Maps overhead reference. Draft estimates; imagery date unknown.',
      'Owner supplied overhead correction; © Google and imagery providers. Geometry © OpenStreetMap contributors (ODbL). Representative draft burial layout.',
    ]),
  ).toEqual([
    'Ateneo vegetation — owner annotated Google Maps overhead reference. Draft estimates; imagery date unknown.',
    'Owner supplied overhead correction; © Google and imagery providers. Representative draft burial layout.',
  ]);
});

it('puts licences and provider credits first, preserving full contributors, links and unfamiliar notes', () => {
  const owner = 'Owner reference; © Google and imagery providers. Draft, date unknown.';
  const commons =
    'Reference: Dominic McArthur, CC BY-SA 3.0 (https://creativecommons.org/licenses/by-sa/3.0/), Wikimedia Commons. Schematic plan adaptation.';
  const imagery = 'Imagery © Esri, Maxar and Earthstar Geographics.';
  const unfamiliar = 'Unfamiliar provider and source format; retain this wording.';
  expect(additionalCredits([owner, unfamiliar, commons, imagery, commons])).toEqual([
    commons,
    imagery,
    owner,
    unfamiliar,
  ]);
});
