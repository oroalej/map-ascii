import { REGION_TILE_MAX_ZOOM } from '@atlas/shared';
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import { normalize } from './03-normalize';

const square = (w: number, s: number, e: number, n: number): Polygon => ({
  type: 'Polygon',
  coordinates: [
    [
      [w, s],
      [e, s],
      [e, n],
      [w, n],
      [w, s],
    ],
  ],
});

const boundary: Feature<Polygon | MultiPolygon> = {
  type: 'Feature',
  id: 'relation/1',
  properties: { name: 'Test City', boundary: 'administrative', admin_level: '6' },
  geometry: square(0, 0, 0.01, 0.01),
};

const road = (id: string, highway: string, x: number): Feature => ({
  type: 'Feature',
  id,
  properties: { highway },
  geometry: {
    type: 'LineString',
    coordinates: [
      [x, 0],
      [x, 0.01],
    ],
  },
});

const collection = (...features: Feature[]): FeatureCollection => ({
  type: 'FeatureCollection',
  features,
});

describe('normalize: region-only features', () => {
  const { features } = normalize(collection(road('way/1', 'primary', 0.005)), boundary, 10, {
    osm: collection(road('way/1', 'primary', 0.005), road('way/2', 'trunk', 0.5)),
    derived: [
      {
        type: 'Feature',
        properties: { id: 'sea/1', class: 'water_sea' },
        geometry: square(1, 1, 2, 2),
      },
    ],
  });
  const byId = (id: string) => features.find((f) => f.properties.id === id)!;

  it('flags them and tiles them only to the region zoom', () => {
    for (const id of ['osm:way/2', 'sea/1']) {
      expect(byId(id).properties.region).toBe(true);
      expect(byId(id).tippecanoe.maxzoom).toBe(REGION_TILE_MAX_ZOOM);
    }
  });

  it('leaves detail features (even ones the region also has) at full depth', () => {
    const detail = byId('osm:way/1');
    expect(detail.properties.region).toBeUndefined();
    expect(detail.tippecanoe.maxzoom).toBe(16);
    expect(features.filter((f) => f.properties.id === 'osm:way/1')).toHaveLength(1);
  });
});
