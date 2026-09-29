import { join } from 'node:path';
import type { ContentBundle } from '@atlas/content';
import {
  searchOptions,
  SearchIndexFile,
  type BBox,
  type SearchEntry,
  type SearchType,
  type SubdivisionArea,
} from '@atlas/shared';
import turfBbox from '@turf/bbox';
import turfCentroid from '@turf/centroid';
import type { Feature, Geometry, Position } from 'geojson';
import MiniSearch from 'minisearch';
import type { AtlasFeature, AtlasProperties } from './03-normalize';
import { readFeatures, readJson, writeJson } from './lib/io';
import { files, type Step } from './step';

/** How far apart (degrees, ~220 m) two same-named ways can be and still be one street. */
const STREET_GAP = 0.002;

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Zoom that fits a bbox of this many degrees in about 800 px (512-px tiles). */
export const zoomForSpan = (span: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, Math.round(Math.log2(562.5 / Math.max(span, 1e-6)) * 10) / 10));

const typeOf = (p: AtlasProperties): SearchType | null => {
  if (p.landmark) return 'landmark';
  switch (p.class) {
    case 'building_school':
      return 'school';
    case 'building_religious':
      return 'worship';
    case 'building_market':
      return 'market';
    case 'monument':
      return 'monument';
    case 'place_label':
      return p.place === 'province' ? null : 'place';
    case 'road_major':
    case 'road_mid':
    case 'road_minor':
    case 'path':
      return 'street';
    default:
      return null;
  }
};

const zoomHints: Record<SearchType, number> = {
  landmark: 17.5,
  subdivision: 15,
  street: 16,
  school: 17,
  worship: 17.5,
  market: 17,
  monument: 18.5,
  place: 13,
};

const altNamesOf = (p: AtlasProperties): string[] =>
  [p.alt_name, p.old_name, p.official_name, p.osm_name]
    .flatMap((v) => v?.split(';') ?? [])
    .map((v) => v.trim())
    .filter((v) => v && v !== p.name);

/** A point on the feature: a point's own position, a line's middle vertex, an area's centroid. */
function pointOn(geometry: Geometry, feature: Feature): Position {
  if (geometry.type === 'Point') return geometry.coordinates;
  const line =
    geometry.type === 'LineString'
      ? geometry.coordinates
      : geometry.type === 'MultiLineString'
        ? geometry.coordinates.reduce((a, b) => (b.length > a.length ? b : a), [])
        : null;
  if (line && line.length > 0) return line[Math.floor(line.length / 2)]!;
  return turfCentroid(feature).geometry.coordinates;
}

const overlaps = (a: BBox, b: BBox, gap: number) =>
  a[0] - gap <= b[2] && b[0] - gap <= a[2] && a[1] - gap <= b[3] && b[1] - gap <= a[3];

const join2 = (a: BBox, b: BBox): BBox => [
  Math.min(a[0], b[0]),
  Math.min(a[1], b[1]),
  Math.max(a[2], b[2]),
  Math.max(a[3], b[3]),
];

type Candidate = { feature: AtlasFeature; bbox: BBox; type: SearchType };

/**
 * A search entry's bbox, rounded, or nothing when it has no area (a point, or a way running
 * exactly east–west or north–south): the entry's point is enough to fly to then.
 */
export function entryBbox(bbox: BBox): { bbox: BBox } | Record<string, never> {
  const [west, south, east, north] = bbox.map(round6) as BBox;
  return west < east && south < north ? { bbox: [west, south, east, north] } : {};
}

/** Cluster same-named features that lie within `gap` of each other. */
function cluster(candidates: Candidate[], gap: number): Candidate[][] {
  const groups: { bbox: BBox; members: Candidate[] }[] = [];
  for (const c of candidates) {
    const hits = groups.filter((g) => overlaps(g.bbox, c.bbox, gap));
    const merged = { bbox: c.bbox, members: [c] };
    for (const hit of hits) {
      merged.bbox = join2(merged.bbox, hit.bbox);
      merged.members.push(...hit.members);
      groups.splice(groups.indexOf(hit), 1);
    }
    groups.push(merged);
  }
  return groups.map((g) => g.members);
}

/**
 * Search entries (ARCHITECTURE.md §7): landmarks, streets (same-named ways grouped), the
 * subdivisions, schools, places of worship, markets, monuments, and named places. Ids are
 * unique; a landmark isn't listed again under its building type.
 */
export function searchEntries(
  features: readonly AtlasFeature[],
  areas: readonly SubdivisionArea[],
  content: ContentBundle,
): SearchEntry[] {
  const entries = new Map<string, SearchEntry>();
  const landmarks = new Map(content.landmarks.map((l) => [l.id, l]));
  const byName = new Map<string, Candidate[]>();
  const placeNodes = new Map<string, AtlasFeature>();

  for (const feature of features) {
    const p = feature.properties;
    if (!p.name) continue;
    if (p.subdivision_label) placeNodes.set(p.name, feature);
    const type = typeOf(p);
    if (!type || (type === 'place' && p.subdivision_label)) continue;
    const key = `${type}\u0000${p.name}`;
    const list = byName.get(key) ?? [];
    list.push({ feature, bbox: turfBbox(feature) as BBox, type });
    byName.set(key, list);
  }

  for (const list of byName.values()) {
    const gap = list[0]!.type === 'street' ? STREET_GAP : STREET_GAP / 2;
    for (const group of cluster(list, gap)) {
      // Represent the group by its largest member (the longest way, the grounds over a hall).
      const size = (c: Candidate) => (c.bbox[2] - c.bbox[0]) * 1e3 + (c.bbox[3] - c.bbox[1]);
      const main = group.reduce((a, b) => (size(b) > size(a) ? b : a));
      const p = main.feature.properties;
      if (entries.has(p.id)) continue;
      const bbox = group.map((c) => c.bbox).reduce(join2);
      const [lng, lat] = pointOn(main.feature.geometry, main.feature) as [number, number];
      const landmark = p.landmark_id ? landmarks.get(p.landmark_id) : undefined;
      const localized = landmark
        ? Object.entries(landmark.name)
            .filter(([lang]) => lang !== 'en')
            .map(([, name]) => name)
        : [];
      const span = Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]);
      entries.set(p.id, {
        id: p.id,
        name: p.name!,
        altNames: [...new Set([...altNamesOf(p), ...localized])],
        type: main.type,
        ...(p.subdivision && { subdivision: p.subdivision }),
        ...(p.subdivision_approx && { approximate: true }),
        lat: round6(lat),
        lng: round6(lng),
        zoomHint: main.type === 'street' ? zoomForSpan(span, 14, 17) : zoomHints[main.type],
        ...entryBbox(bbox),
        ...(group.length > 1 && { featureIds: group.map((c) => c.feature.properties.id) }),
      });
    }
  }

  for (const area of areas) {
    const feature: Feature = {
      type: 'Feature',
      properties: {},
      geometry: area.geometry as Geometry,
    };
    const node = placeNodes.get(area.name);
    const outline = features.find(
      (f) => f.properties.class === 'admin_subdivision' && f.properties.name === area.name,
    );
    const id = node?.properties.id ?? outline?.properties.id ?? `subdivision/${area.name}`;
    if (entries.has(id)) continue;
    const [lng, lat] = (
      node ? pointOn(node.geometry, node) : turfCentroid(feature).geometry.coordinates
    ) as [number, number];
    entries.set(id, {
      id,
      name: area.name,
      altNames: [],
      type: 'subdivision',
      subdivision: area.name,
      ...(area.approximate && { approximate: true }),
      lat: round6(lat),
      lng: round6(lng),
      zoomHint: zoomHints.subdivision,
      ...entryBbox(turfBbox(feature) as BBox),
    });
  }
  return [...entries.values()];
}

/** The search index file: entries plus a MiniSearch index built with the shared options. */
export function buildSearchIndex(entries: SearchEntry[]): SearchIndexFile {
  const index = new MiniSearch<SearchEntry>(searchOptions);
  index.addAll(entries);
  return SearchIndexFile.parse({ version: 1, entries, index: index.toJSON() });
}

// Build <city>.search-index.json
export const step: Step = {
  name: '06-search-index',
  async run({ city, content, buildDir, outDir }) {
    const features: AtlasFeature[] = [];
    for await (const f of readFeatures(join(buildDir, files.merged))) {
      features.push(f as AtlasFeature);
    }
    const areas = await readJson<SubdivisionArea[]>(join(buildDir, files.subdivisions));
    const entries = searchEntries(features, areas, content);
    const counts = new Map<string, number>();
    for (const e of entries) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
    await writeJson(join(outDir, `${city.slug}.search-index.json`), buildSearchIndex(entries));
    console.log(
      `  ${entries.length} entries (${[...counts].map(([t, n]) => `${t} ${n}`).join(', ')})`,
    );
  },
};
