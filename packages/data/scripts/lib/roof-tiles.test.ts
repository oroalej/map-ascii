import { expect, it } from 'vitest';
import type { AtlasFeature } from '../03-normalize';
import { roofTileRecords } from './roof-tiles';

const feature: AtlasFeature = {
  type: 'Feature',
  properties: { id: 'osm:way/1', class: 'building', height: 6, roof_plan: 'plan', name: 'roof' },
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0],
      ],
    ],
  },
  tippecanoe: { layer: 'buildings', minzoom: 12, maxzoom: 16 },
};
it('keeps exactly one unchanged footprint per zoom and roof metadata only in detailed tiles', () => {
  const before = structuredClone(feature),
    records = roofTileRecords(feature);
  for (let z = 6; z <= 16; z++) {
    const present = records.filter((f) => f.tippecanoe.minzoom <= z && f.tippecanoe.maxzoom >= z);
    expect(present).toHaveLength(z >= 12 ? 1 : 0);
    for (const f of present) {
      expect(f.geometry).toBe(feature.geometry);
      expect(f.properties.id).toBe(feature.properties.id);
      expect(f.properties.name).toBe('roof');
      expect(f.properties.roof_plan).toBe(z >= 15 ? 'plan' : undefined);
    }
  }
  expect(feature).toEqual(before);
});
it('handles features wholly below or above the threshold and leaves unplanned data intact', () => {
  const below = { ...feature, tippecanoe: { ...feature.tippecanoe, maxzoom: 14 } };
  expect(roofTileRecords(below)).toHaveLength(1);
  expect(roofTileRecords(below)[0]!.properties.roof_plan).toBeUndefined();
  const above = { ...feature, tippecanoe: { ...feature.tippecanoe, minzoom: 15 } };
  expect(roofTileRecords(above)).toEqual([above]);
  const plain = { ...feature, properties: { id: 'plain', class: 'building' as const } };
  expect(roofTileRecords(plain)).toEqual([plain]);
});
