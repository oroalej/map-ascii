import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ContentBundle } from '@atlas/content';
import turfCentroid from '@turf/centroid';
import type { AtlasFeature } from './03-normalize';
import { placeArt } from './lib/art';
import { planParts } from './lib/plan';
import { readFeatures, writeFeatures, writeJson } from './lib/io';
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
    if (p.name && p.name !== landmark.name.en) p.osm_name = p.name;
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

  for (const feature of features) addLabelAnchor(feature);
  return features;
}

/**
 * Give named landmarks, monuments, and places a label anchor: a point's own position, or an
 * area's centroid. It is computed once from the full geometry, before tiling clips it, so the
 * label lands in the same place whichever tile the renderer reads it from. (Street names follow
 * their street's geometry instead.)
 */
export function addLabelAnchor(feature: AtlasFeature) {
  const p = feature.properties;
  if (!p.name || !(p.landmark || p.class === 'monument' || p.class === 'place_label')) return;
  const [lng, lat] = turfCentroid(feature).geometry.coordinates as [number, number];
  p.label_lng = Math.round(lng * 1e7) / 1e7;
  p.label_lat = Math.round(lat * 1e7) / 1e7;
}

// Join the city pack's curated content onto features
export const step: Step = {
  name: '04-merge-content',
  async run({ city, content, buildDir, outDir }) {
    const features: AtlasFeature[] = [];
    for await (const f of readFeatures(join(buildDir, files.normalized))) {
      features.push(f as AtlasFeature);
    }
    const merged = mergeContent(features, content);
    // Plan-view landmark parts (belfries, domes, tiered bases) as their own small footprints.
    const { parts, warnings } = planParts(merged, content.plans);
    for (const warning of warnings) console.warn(`  warning: ${warning}`);
    await writeFeatures(join(buildDir, files.merged), [...merged, ...parts]);
    console.log(`  joined ${content.landmarks.length} landmarks; ${parts.length} landmark parts`);

    // Landmark art, placed on its features, for the renderer (<city>.art.json).
    const art = placeArt(features, content.art);
    await mkdir(outDir, { recursive: true });
    await writeJson(join(outDir, `${city.slug}.art.json`), art);
    const drafts = art.pieces.filter((p) => p.status === 'draft').length;
    console.log(`  placed ${art.pieces.length} art pieces (${drafts} draft)`);
  },
};
