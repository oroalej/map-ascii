import { SiteDetail } from '@atlas/shared';
import { describe, expect, it } from 'vitest';
import type { AtlasFeature } from '../03-normalize';
import { mergeSiteDetails } from './site-detail';

const p = (x: number, y: number): [number, number] => [x / 111320, y / 111320];
const ring = (x: number, y: number, w: number, h: number) => [
  p(x, y),
  p(x + w, y),
  p(x + w, y + h),
  p(x, y + h),
  p(x, y),
];
const parent: AtlasFeature = {
  type: 'Feature',
  geometry: { type: 'Polygon', coordinates: [ring(0, 0, 50, 50)] },
  properties: { id: 'osm:way/1', class: 'park', name: 'Test plaza', landmark: true },
  tippecanoe: { layer: 'landuse', minzoom: 12, maxzoom: 16 },
};
const detail = SiteDetail.parse({
  id: 'detail/test',
  osm_id: parent.properties.id,
  title: 'Test',
  surface: 'paving',
  walks: [{ id: 'under-beam', line: [p(5, 5), p(45, 5)], width_m: 2 }],
  structures: [
    { id: 'beam', ring: ring(20, 4, 10, 2), material: 'wood', height_m: 3, overhead: true },
  ],
  status: 'draft',
  credit: 'Survey',
  sources: [{ title: 'Survey' }],
});

describe('site structure merge', () => {
  it('keeps terraces and stairs walkable, preserves fractional heights and points selection to the plaza', () => {
    const terrace = {
      ...detail.structures[0]!,
      id: 'terrace',
      material: 'paving' as const,
      height_m: 0.6,
      overhead: false,
    };
    const features = mergeSiteDetails([parent], [{ ...detail, structures: [terrace] }]).features;
    const surface = features.find((f) => f.properties.id === 'detail:test/structure-terrace')!;
    expect(surface.properties).toMatchObject({
      class: 'paving',
      height: 0.6,
      variant: 'terrace',
      detail_parent: parent.properties.id,
      detail_overhead: false,
    });
    expect(surface.properties.detail_blocked).toBeUndefined();
    expect(features.some((f) => f.properties.detail_route)).toBe(true);
  });
  it('keeps a walking route underneath overhead cover and preserves the landmark', () => {
    const before = structuredClone(parent);
    const features = mergeSiteDetails([parent], [detail]).features;
    expect(parent).toEqual(before);
    expect(features[0]?.properties).toMatchObject({
      id: parent.properties.id,
      class: 'paving',
      landmark: true,
    });
    const beam = features.find((f) => f.properties.id === 'detail:test/structure-beam')!;
    expect(beam.properties).toMatchObject({
      class: 'building_woodwork',
      height: 3,
      detail_overhead: true,
      variant: 'flat',
    });
    expect(beam.properties.detail_blocked).toBeUndefined();
    expect(beam.tippecanoe).toMatchObject({ layer: 'buildings', minzoom: 16 });
    expect(features.some((f) => f.properties.detail_route)).toBe(true);
  });

  it('rejects routes through supports and platforms even underneath an overhead roof', () => {
    for (const material of ['wood', 'stone'] as const) {
      const ground = { ...detail.structures[0]!, id: 'support', material, overhead: false };
      expect(() =>
        mergeSiteDetails([parent], [{ ...detail, structures: [...detail.structures, ground] }]),
      ).toThrow('crosses detail:test/structure-support');
    }
  });

  it('rejects structures spanning holes and concavities that vertex containment misses', () => {
    const hole: AtlasFeature = {
      ...parent,
      geometry: {
        type: 'Polygon',
        coordinates: [ring(0, 0, 50, 50), ring(22, 22, 2, 2).reverse()],
      },
    };
    const crossing = {
      ...detail,
      walks: [],
      structures: [{ ...detail.structures[0]!, ring: ring(20, 20, 10, 10) }],
    };
    expect(() => mergeSiteDetails([hole], [crossing])).toThrow('outside parent footprint');
    const concave: AtlasFeature = {
      ...parent,
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            p(0, 0),
            p(50, 0),
            p(50, 50),
            p(30, 50),
            p(30, 20),
            p(20, 20),
            p(20, 50),
            p(0, 50),
            p(0, 0),
          ],
        ],
      },
    };
    const bridge = {
      ...crossing,
      structures: [{ ...crossing.structures[0]!, ring: ring(15, 30, 20, 5) }],
    };
    expect(() => mergeSiteDetails([concave], [bridge])).toThrow('outside parent footprint');
  });
});
