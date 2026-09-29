import { join } from 'node:path';
import type { ContentBundle } from '@atlas/content';
import type { AtlasFeature } from './03-normalize';
import { readFeatures, writeFeatures } from './lib/io';
import { files, type Step } from './step';

/**
 * Join curated landmarks onto features by `osm_id`. Curated names and dates win over OSM's.
 * Fails if a landmark's feature isn't in the data, or if a landmark has only standalone
 * geometry (supported from Phase 5).
 */
export function mergeContent(features: AtlasFeature[], content: ContentBundle): AtlasFeature[] {
  const standalone = content.landmarks.filter((l) => !l.osm_id).map((l) => l.id);
  if (standalone.length > 0) {
    throw new Error(`Standalone landmark geometry is not supported yet: ${standalone.join(', ')}`);
  }

  const byOsmId = new Map(content.landmarks.map((l) => [l.osm_id!, l]));
  const joined = new Set<string>();
  for (const feature of features) {
    const landmark = byOsmId.get(feature.properties.id);
    if (!landmark) continue;
    joined.add(landmark.id);
    const p = feature.properties;
    p.landmark = true;
    p.landmark_id = landmark.id;
    p.name = landmark.name.en;
    if (landmark.start_year !== undefined || landmark.end_year !== undefined) {
      delete p.start_year;
      delete p.end_year;
      if (landmark.start_year !== undefined) p.start_year = landmark.start_year;
      if (landmark.end_year !== undefined) p.end_year = landmark.end_year;
      if (landmark.certainty !== 'unknown') p.certainty = landmark.certainty;
    }
  }

  const missing = content.landmarks.filter((l) => !joined.has(l.id));
  if (missing.length > 0) {
    const list = missing.map((l) => `${l.id} (${l.osm_id})`).join(', ');
    throw new Error(`Landmarks not found in the OSM data (outside the detail bbox?): ${list}`);
  }
  return features;
}

// Join the city pack's curated content onto features
export const step: Step = {
  name: '04-merge-content',
  async run({ content, buildDir }) {
    const features: AtlasFeature[] = [];
    for await (const f of readFeatures(join(buildDir, files.normalized))) {
      features.push(f as AtlasFeature);
    }
    await writeFeatures(join(buildDir, files.merged), mergeContent(features, content));
    console.log(`  joined ${content.landmarks.length} landmarks`);
  },
};
