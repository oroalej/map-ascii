import { expect, it } from 'vitest';
import type { FeatureCollection } from 'geojson';
import { assignFrontages, frontageOf } from './frontage';
import { classify, variantOf, treeKind } from './classify';
it('identifies food, services, retail and fallback commercial frontages', () => {
  expect(frontageOf({ amenity: 'cafe', shop: 'convenience' })).toBe('food');
  expect(frontageOf({ craft: 'tailor' })).toBe('service');
  expect(frontageOf({ shop: 'pharmacy' })).toBe('service');
  expect(frontageOf({ shop: 'florist' })).toBe('retail');
  expect(frontageOf({ building: 'retail' })).toBe('commercial');
  expect(frontageOf({ building: 'yes' })).toBeUndefined();
});
it('assigns nodes inside buildings, respects priority, suppresses their markers, and leaves holes outside', () => {
  const osm: FeatureCollection = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [0, 0],
              [0.001, 0],
              [0.001, 0.001],
              [0, 0.001],
              [0, 0],
            ],
            [
              [0.0006, 0.0006],
              [0.0008, 0.0006],
              [0.0008, 0.0008],
              [0.0006, 0.0008],
              [0.0006, 0.0006],
            ],
          ],
        },
        properties: { building: 'commercial', shop: 'florist' },
      },
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [0.0002, 0.0002] },
        properties: { amenity: 'cafe' },
      },
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [0.0003, 0.0003] },
        properties: { shop: 'hairdresser' },
      },
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [0.0007, 0.0007] },
        properties: { shop: 'convenience' },
      },
    ],
  };
  const result = assignFrontages(osm).features;
  expect(result[0]!.properties!.frontage).toBe('food');
  expect(classify(result[1]!.properties!, 'point', 10)).toBeNull();
  expect(classify(result[3]!.properties!, 'point', 10)).toBe('furniture');
  expect(variantOf(result[3]!.properties!, 'furniture')).toBe('shop_retail');
  expect(osm.features[0]!.properties!.frontage).toBeUndefined();
});
it('adds mapped vegetation without painting commercial zones', () => {
  for (const natural of ['scrub', 'heath']) expect(classify({ natural }, 'area', 10)).toBe('grass');
  for (const landuse of ['plant_nursery', 'cemetery'])
    expect(classify({ landuse }, 'area', 10)).toBe('grass');
  expect(classify({ landuse: 'orchard' }, 'area', 10)).toBe('trees');
  expect(classify({ landuse: 'commercial' }, 'area', 10)).toBeNull();
  expect(treeKind({ trees: 'palm' })).toBe('palm');
});
it('keeps an embedded supermarket in the market class', () => {
  const fc: FeatureCollection = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [0, 0],
              [0.001, 0],
              [0.001, 0.001],
              [0, 0.001],
              [0, 0],
            ],
          ],
        },
        properties: { building: 'yes' },
      },
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [0.0005, 0.0005] },
        properties: { shop: 'supermarket', name: 'Mapped market' },
      },
    ],
  };
  const result = assignFrontages(fc);
  expect(classify(result.features[0]!.properties!, 'area', 10)).toBe('building_market');
  expect(result.features[0]!.properties!.name).toBe('Mapped market');
});
