import { expect, it } from 'vitest';
import type { Feature, FeatureCollection, Polygon } from 'geojson';
import { assignFrontages, frontageOf, interiorPoint, shopAnchor } from './frontage';
import inside from '@turf/boolean-point-in-polygon';
import { classify, variantOf, treeKind } from './classify';

const rectangle = (lo: number, hi: number): Polygon => ({
  type: 'Polygon',
  coordinates: [
    [
      [lo, lo],
      [hi, lo],
      [hi, hi],
      [lo, hi],
      [lo, lo],
    ],
  ],
});
const building = (id: string, lo: number, hi: number): Feature => ({
  type: 'Feature',
  id,
  properties: { building: 'yes' },
  geometry: rectangle(lo, hi),
});
it('selects the smallest containing building with stable ID ties in any input order', () => {
  const a = building('way/a', 0.0001, 0.0009),
    b = building('way/b', 0.0001, 0.0009),
    large = building('way/c', 0, 0.001);
  const point: Feature = {
    type: 'Feature',
    id: 'node/1',
    properties: { amenity: 'cafe' },
    geometry: { type: 'Point', coordinates: [0.0005, 0.0005] },
  };
  for (const features of [
    [large, b, a, point],
    [point, a, b, large],
  ]) {
    const result = assignFrontages({ type: 'FeatureCollection', features });
    expect(result.features.filter((f) => f.properties!.frontage).map((f) => f.id)).toEqual([
      'way/a',
    ]);
  }
});
it('anchors courtyard multipolygons inside the largest component and outside hole boundaries', () => {
  const donut = rectangle(0, 0.002);
  donut.coordinates.push(rectangle(0.0005, 0.0015).coordinates[0]!);
  const geometry = {
    type: 'MultiPolygon' as const,
    coordinates: [rectangle(0.01, 0.0101).coordinates, donut.coordinates],
  };
  const p = interiorPoint(geometry);
  expect(inside(p, donut, { ignoreBoundary: true })).toBe(true);
  const b: Feature = {
    type: 'Feature',
    id: 'way/donut',
    properties: { building: 'yes' },
    geometry,
  };
  const point: Feature = {
    type: 'Feature',
    properties: { shop: 'florist' },
    geometry: { type: 'Point', coordinates: [0.0005, 0.001] },
  };
  const result = assignFrontages({ type: 'FeatureCollection', features: [b, point] });
  expect(result.features[1]!.properties!.atlas_in_building).toBeUndefined();
  expect(shopAnchor(b)!.shop_radius_m).toBeGreaterThan(0);
});
it('assigns fully contained shop areas but leaves partly overlapping shops as markers', () => {
  const b = building('way/building', 0, 0.002);
  const shop: Feature = {
    type: 'Feature',
    id: 'way/shop',
    properties: { amenity: 'bank' },
    geometry: rectangle(0.0005, 0.0015),
  };
  const crossing: Feature = { ...shop, id: 'way/crossing', geometry: rectangle(0.001, 0.0025) };
  const result = assignFrontages({ type: 'FeatureCollection', features: [b, shop, crossing] });
  expect(result.features[0]!.properties!.frontage).toBe('service');
  expect(result.features[1]!.properties!.atlas_in_building).toBe('yes');
  expect(result.features[2]!.geometry.type).toBe('Point');
  expect(result.features[2]!.properties!.atlas_in_building).toBeUndefined();
});
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
