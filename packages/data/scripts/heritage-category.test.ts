import { expect, it } from 'vitest';
import type { ContentBundle } from '@atlas/content';
import type { LandmarkType } from '@atlas/shared';
import { mergeContent } from './04-merge-content';
import type { AtlasFeature } from './03-normalize';

it('adds heritage membership only to heritage landmarks on their existing feature', () => {
  const types: LandmarkType[] = ['heritage', 'church', 'school', 'other'];
  const features: AtlasFeature[] = types.map((type, i) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [i, 0] },
    properties: { id: `osm:node/${i}`, class: 'building' },
    tippecanoe: { layer: 'buildings', minzoom: 12, maxzoom: 16 },
  }));
  const content = {
    landmarks: types.map((type, i) => ({
      id: `landmark/${type}`,
      osm_id: `osm:node/${i}`,
      name: { en: type },
      type,
      certainty: 'unknown',
      sources: [{ title: 'Fixture' }],
    })),
  } as ContentBundle;
  const before = structuredClone(features);
  expect(mergeContent(features, content)).toBe(features);
  expect(features).toHaveLength(types.length);
  features.forEach((feature, i) => {
    expect(feature.geometry).toEqual(before[i]!.geometry);
    expect(feature.properties).toMatchObject({
      id: before[i]!.properties.id,
      class: 'building',
      landmark: true,
      landmark_id: `landmark/${types[i]}`,
    });
    if (i === 0) expect(feature.properties.heritage).toBe(true);
    else expect(feature.properties).not.toHaveProperty('heritage');
  });
  content.landmarks[0]!.type = 'other';
  mergeContent(features, content);
  expect(features[0]!.properties).not.toHaveProperty('heritage');
});
