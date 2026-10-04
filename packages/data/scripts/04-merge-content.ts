import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ContentBundle } from '@atlas/content';
import { SubdivisionAreas, type BBox } from '@atlas/shared';
import turfCentroid from '@turf/centroid';
import type { Geography } from './02-convert';
import type { AtlasFeature } from './03-normalize';
import { placeArt } from './lib/art';
import { planParts } from './lib/plan';
import { enrichRoofs } from './lib/roofs';
import { landcoverFeatures, applyLandcoverTreeOverrides } from './lib/landcover';
import { mergeCemeteries } from './lib/cemeteries';
import { finalizeDetailSelections, mergeSiteDetails } from './lib/site-detail';
import { mergeLifeSites } from './lib/life-sites';
import { mergeTraffic } from './lib/traffic';
import { applyRoadExclusions } from './lib/streets';
import { readFeatures, readJson, writeFeatures, writeJson } from './lib/io';
import { files, type Step } from './step';
import { writeDetailLayouts } from './lib/detail-layout';

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

/**
 * Problems with the city's tours against its data: steps that select or highlight a feature
 * that isn't there, or whose camera is outside the region (where the atlas can't go).
 */
export function checkTours(
  features: readonly AtlasFeature[],
  tours: ContentBundle['tours'],
  [west, south, east, north]: BBox,
): string[] {
  const ids = new Set(features.map((f) => f.properties.id));
  const problems: string[] = [];
  for (const tour of tours) {
    tour.steps.forEach((step, i) => {
      const where = `${tour.id} step ${i + 1}`;
      const { lng, lat } = step.camera;
      if (lng < west || lng > east || lat < south || lat > north) {
        problems.push(`${where}: camera ${lat}, ${lng} is outside the region`);
      }
      for (const id of [...(step.select ? [step.select] : []), ...(step.highlight ?? [])]) {
        if (!ids.has(id)) problems.push(`${where}: ${id} is not in the data`);
      }
    });
  }
  return problems;
}

// Join the city pack's curated content onto features
export const step: Step = {
  name: '04-merge-content',
  async run(ctx) {
    const { city, content, buildDir, outDir } = ctx;
    let features: AtlasFeature[] = [];
    for await (const f of readFeatures(join(buildDir, files.normalized))) {
      features.push(f as AtlasFeature);
    }
    features = applyRoadExclusions(features, city.streets?.exclusions);
    const { regionBounds } = await readJson<Geography>(join(buildDir, files.geography));
    const merged = applyLandcoverTreeOverrides(
      mergeTraffic(
        mergeLifeSites(mergeContent(features, content), city.life?.sites, regionBounds),
        city.life?.signals,
        city.streets,
        (stats) => console.log(`  streets: ${JSON.stringify(stats)}`),
      ),
      content.landcover,
    );
    const tourProblems = checkTours(merged, content.tours, regionBounds);
    if (tourProblems.length > 0) {
      throw new Error(`Tours don't match the data:\n  ${tourProblems.join('\n  ')}`);
    }
    // Plan-view landmark parts (belfries, domes, tiered bases) as their own small footprints.
    const { parts, warnings } = planParts(merged, content.plans);
    // Curated trees and land cover that OSM doesn't have yet.
    const landcover = landcoverFeatures(merged, content.landcover);
    const subdivisions = SubdivisionAreas.parse(await readJson(join(buildDir, files.subdivisions)));
    // Standing detail parts and approaches reserve their ground before representative
    // burial rows are placed, including memorials added inside a mapped cemetery.
    const detail = mergeSiteDetails(
      [...merged, ...parts, ...landcover.features],
      content.details,
      subdivisions,
    );
    const cemeteries = mergeCemeteries(detail.features, content.cemeteries);
    if (cemeteries.stats.length) console.log(`  cemeteries: ${JSON.stringify(cemeteries.stats)}`);
    for (const warning of [...warnings, ...landcover.warnings, ...detail.warnings]) {
      console.warn(`  warning: ${warning}`);
    }
    const roofs = enrichRoofs(cemeteries.features);
    finalizeDetailSelections(cemeteries.features);
    console.log(`  roofs: ${JSON.stringify(roofs)}`);
    await writeFeatures(join(buildDir, files.merged), cemeteries.features);
    console.log(
      `  joined ${content.landmarks.length} landmarks; ${parts.length} landmark parts; ` +
        `${landcover.features.length} curated trees and areas; checked ${content.tours.length} tours`,
    );

    // Landmark art, placed on its features, for the renderer (<city>.art.json).
    const art = placeArt(features, content.art);
    await mkdir(outDir, { recursive: true });
    await writeJson(join(outDir, `${city.slug}.art.json`), art);
    await writeDetailLayouts(ctx);
    const drafts = art.pieces.filter((p) => p.status === 'draft').length;
    console.log(`  placed ${art.pieces.length} art pieces (${drafts} draft)`);
  },
};
