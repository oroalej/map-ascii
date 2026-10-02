import { readFileSync } from 'node:fs';
import { Cemetery, DetailSelectionSchema, Landmark, Landcover, type LngLat } from '@atlas/shared';
import type { ContentBundle } from '@atlas/content';
import inside from '@turf/boolean-point-in-polygon';
import bbox from '@turf/bbox';
import type { Polygon, MultiPolygon } from 'geojson';
import { intersection } from 'polyclip-ts';
import { describe, expect, it } from 'vitest';
import type { AtlasFeature } from '../03-normalize';
import { mergeCemeteries } from './cemeteries';
import { landcoverFeatures, SAME_TREE_M } from './landcover';
import { seatingFootprint } from './site-detail';
import { bboxesOverlap } from './geo';
import { mergeContent } from '../04-merge-content';

// Declare disk-read content dependencies so targeted runs include this test on pack edits.
import.meta.glob(
  '../../../content/cities/naga/{cemeteries,landmarks}/{santo-nino-memorial-park,eternal-gardens}.json',
);
import.meta.glob('../../../content/cities/naga/landcover/basilica-cemeteries.json');

const read = (p: string): unknown =>
  JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8')) as unknown;
const packs = ['santo-nino-memorial-park', 'eternal-gardens'].map((s) =>
  Cemetery.parse(read(`../../../content/cities/naga/cemeteries/${s}.json`)),
);
const trees = Landcover.parse(
  read('../../../content/cities/naga/landcover/basilica-cemeteries.json'),
);
const source = read('../__fixtures__/cemetery-parents.json') as AtlasFeature[];
const landmarks = ['santo-nino-memorial-park', 'eternal-gardens'].map((s) =>
  Landmark.parse(read(`../../../content/cities/naga/landmarks/${s}.json`)),
);
const joined = mergeContent(
  structuredClone(source.filter((f) => packs.some((p) => p.osm_id === f.properties.id))),
  { landmarks } as ContentBundle,
);
const namedSource = source.map((f) => joined.find((p) => p.properties.id === f.properties.id) ?? f);
const reference = read('../__fixtures__/cemetery-sections.json') as {
  groups: { id: string; cemetery: string; kind: string; ring: LngLat[] }[];
};
const cover = landcoverFeatures(source, [trees]);
const result = mergeCemeteries([...namedSource, ...cover.features], packs);
const plots = result.features.filter((f) => f.properties.id.startsWith('cemetery:'));
const centre = (f: AtlasFeature): LngLat => {
  const ring = (f.geometry as Polygon).coordinates[0]!;
  return [
    ring.slice(0, 4).reduce((v, p) => v + p[0]!, 0) / 4,
    ring.slice(0, 4).reduce((v, p) => v + p[1]!, 0) / 4,
  ];
};
const distance = (a: LngLat, b: LngLat) =>
  Math.hypot((a[0] - b[0]) * 108185, (a[1] - b[1]) * 111320);
const obstacles = source.flatMap<{
  shape: Polygon | MultiPolygon;
  bounds: [number, number, number, number];
}>((f) => {
  const g = f.geometry,
    p = f.properties;
  let shape: Polygon | MultiPolygon;
  if (
    (g.type === 'Polygon' || g.type === 'MultiPolygon') &&
    ((p.class.startsWith('building') && (p.height ?? 0) > 0) || p.class.startsWith('water'))
  )
    shape = g;
  else if (g.type === 'LineString' && (p.class.startsWith('road') || p.class === 'path'))
    shape = seatingFootprint(g.coordinates as LngLat[], p.width ?? (p.class === 'path' ? 2 : 6));
  else return [];
  return [{ shape, bounds: bbox(shape) as [number, number, number, number] }];
});

describe('Basilica cemetery reference correction', () => {
  it('models both river-bend burial areas and every Eternal Gardens lawn section', () => {
    expect(reference.groups).toHaveLength(23);
    for (const group of reference.groups) {
      const selected = plots.filter(
        (f) =>
          f.properties.detail_parent ===
            packs.find((p) => p.id === `cemetery/${group.cemetery}`)!.osm_id &&
          inside(centre(f), { type: 'Polygon', coordinates: [group.ring] }),
      );
      expect(selected.length, group.id).toBeGreaterThanOrEqual(15);
      expect(
        selected.every((f) => f.properties.kind === `burial=${group.kind}`),
        group.id,
      ).toBe(true);
    }
    expect(plots.filter((f) => f.properties.kind === 'burial=vault').length).toBeGreaterThan(900);
    const eternal = plots.filter((f) => f.properties.detail_parent === 'osm:way/177077165');
    expect(
      eternal.filter((f) => f.properties.kind === 'burial=flush').length / eternal.length,
    ).toBeGreaterThan(0.85);
  });
  it('keeps whole markers inside mapped cemeteries and out of roads, roofs and water', () => {
    for (const pack of packs) {
      const parent = source.find((f) => f.properties.id === pack.osm_id)!.geometry as Polygon;
      const children = plots.filter((f) => f.properties.detail_parent === pack.osm_id);
      expect(children.length).toBeGreaterThan(1500);
      for (const [i, f] of children.entries()) {
        const g = f.geometry as Polygon;
        expect(
          g.coordinates[0]!.every((p) => inside(p, parent)),
          f.properties.id,
        ).toBe(true);
        const bounds = bbox(f) as [number, number, number, number];
        for (const o of obstacles.filter((o) => bboxesOverlap(bounds, o.bounds))) {
          expect(
            [...g.coordinates[0]!, centre(f)].some((p) => inside(p, o.shape)),
            f.properties.id,
          ).toBe(false);
          // Independent full polygon clipping samples complement the generic edge/hole tests
          // without repeating thousands of expensive robust intersections in CI.
          if (i % 100 === 0)
            expect(
              intersection(
                g.coordinates as LngLat[][],
                o.shape.coordinates as LngLat[][] | LngLat[][][],
              ),
              f.properties.id,
            ).toEqual([]);
        }
      }
    }
  }, 60_000);
  it('preserves source facilities, trees and cemetery boundaries without duplicate features', () => {
    const input = structuredClone(source);
    expect(mergeCemeteries(input, []).features).toEqual(source);
    expect(input).toEqual(source);
    for (const f of source) {
      const final = result.features.find((p) => p.properties.id === f.properties.id)!;
      expect(final.geometry).toEqual(f.geometry);
      if (packs.some((p) => p.osm_id === f.properties.id))
        expect(
          inside(
            [final.properties.label_lng!, final.properties.label_lat!],
            final.geometry as Polygon,
          ),
        ).toBe(true);
      if (!packs.some((p) => p.osm_id === f.properties.id)) expect(final).toEqual(f);
    }
    expect(new Set(result.features.map((f) => f.properties.id)).size).toBe(result.features.length);
    for (const f of plots)
      expect(
        DetailSelectionSchema.parse(JSON.parse(f.properties.detail_selection!)).landmarkId,
      ).toBe(`landmark/${packs.find((p) => p.osm_id === f.properties.detail_parent)!.id.slice(9)}`);
    for (const id of ['osm:way/226529998', 'osm:way/951577160', 'osm:node/13990479932'])
      expect(result.features.some((f) => f.properties.id === id)).toBe(true);
  });
  it('adds scattered crowns with safe trunks rather than replacing lawn plots with woodland', () => {
    expect(trees.areas).toEqual([]);
    expect(trees.rows).toEqual([]);
    expect(trees.trees.length).toBeGreaterThanOrEqual(60);
    expect(cover.warnings).toEqual([]);
    const parents = source.filter((f) => packs.some((p) => p.osm_id === f.properties.id));
    const mapped = source.filter(
      (f) => f.properties.class === 'tree' && f.geometry.type === 'Point',
    );
    for (const [i, t] of trees.trees.entries()) {
      expect(parents.some((f) => inside(t.at, f.geometry as Polygon))).toBe(true);
      expect(
        obstacles.some((o) => inside(t.at, o.shape)),
        `tree ${i + 1}`,
      ).toBe(false);
      for (const other of trees.trees.slice(i + 1))
        expect(distance(t.at, other.at)).toBeGreaterThan(SAME_TREE_M);
      for (const other of mapped)
        if (other.geometry.type === 'Point')
          expect(distance(t.at, other.geometry.coordinates as LngLat)).toBeGreaterThan(SAME_TREE_M);
    }
    expect(
      plots
        .filter((f) => f.properties.kind === 'burial=flush')
        .every((f) => f.properties.height === 0),
    ).toBe(true);
  });
});
