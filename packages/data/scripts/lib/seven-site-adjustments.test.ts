import { readFileSync } from 'node:fs';
import { Landcover, Landmark, SiteDetail, DetailSelectionSchema, type LngLat } from '@atlas/shared';
import type { ContentBundle } from '@atlas/content';
import type { Polygon, MultiPolygon, Point, LineString } from 'geojson';
import inside from '@turf/boolean-point-in-polygon';
import { intersection } from 'polyclip-ts';
import { describe, expect, it } from 'vitest';
import type { AtlasFeature } from '../03-normalize';
import { mergeContent } from '../04-merge-content';
import { applyLandcoverTreeOverrides, landcoverFeatures } from './landcover';
import { mergeSiteDetails, seatingFootprint } from './site-detail';

const read = (path: string): unknown =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as unknown;
const pack = (folder: string, slug: string) =>
  read(`../../../content/cities/naga/${folder}/${slug}.json`);
const source = read('../__fixtures__/seven-site-parents.json') as AtlasFeature[];
const campusSlugs = [
  'university-of-nueva-caceres',
  'saint-joseph-school',
  'camarines-sur-national-high-school',
  'bicol-state-campus',
];
const covers = [...campusSlugs, 'naga-city-hall', 'naga-city-civic-center', 'magsaysay-avenue'].map(
  (slug) => Landcover.parse(pack('landcover', slug)),
);
const details = campusSlugs.slice(1).map((slug) => SiteDetail.parse(pack('details', slug)));
const distance = (a: readonly number[], b: readonly number[]) =>
  Math.hypot(
    (a[0]! - b[0]!) * 111320 * Math.cos((b[1]! * Math.PI) / 180),
    (a[1]! - b[1]!) * 111320,
  );
const roofs = source.filter(
  (f) =>
    f.properties.class.startsWith('building') &&
    (f.properties.height ?? 0) > 0 &&
    ['Polygon', 'MultiPolygon'].includes(f.geometry.type),
);
const roads = source
  .filter(
    (f) =>
      (f.properties.class.startsWith('road') || f.properties.class === 'path') &&
      f.geometry.type === 'LineString',
  )
  .map((f) =>
    seatingFootprint(
      (f.geometry as LineString).coordinates as LngLat[],
      f.properties.width ?? (f.properties.class === 'path' ? 2 : 6),
    ),
  );

describe('seven-site planting adjustments', () => {
  it('reduces Civic Center canopy while preserving every mapped tree and sports facility', () => {
    const civic = covers[5]!;
    expect(civic.trees.length).toBeGreaterThan(15);
    expect(civic.trees.length).toBeLessThanOrEqual(30);
    expect(civic.tree_overrides).toHaveLength(24);
    expect([...civic.trees, ...civic.tree_overrides].every((t) => t.crown_m! <= 12)).toBe(true);
    const adjusted = applyLandcoverTreeOverrides(source, [civic]);
    for (const original of source) {
      const result = adjusted.find((f) => f.properties.id === original.properties.id)!;
      expect(result.geometry).toEqual(original.geometry);
      if (civic.tree_overrides.some((t) => t.osm_id === original.properties.id))
        expect(result.properties.height).toBe(original.properties.height);
      else expect(result).toEqual(original);
    }
  });

  it('keeps reference-visible trunks clear of standing roofs, full-width roads, source trees and each other', () => {
    for (const cover of covers) {
      expect(cover.trees.length, cover.id).toBeGreaterThanOrEqual(10);
      for (const [i, tree] of cover.trees.entries()) {
        for (const roof of roofs)
          expect(
            inside(tree.at, roof.geometry as Polygon | MultiPolygon),
            `${cover.id} tree ${i + 1}`,
          ).toBe(false);
        for (const road of roads)
          expect(inside(tree.at, road), `${cover.id} carriageway`).toBe(false);
        for (const mapped of source.filter(
          (f) => f.properties.class === 'tree' && f.geometry.type === 'Point',
        ))
          expect(
            distance(tree.at, (mapped.geometry as Point).coordinates),
            cover.id,
          ).toBeGreaterThan(3);
        for (const other of cover.trees.slice(i + 1))
          expect(distance(tree.at, other.at), cover.id).toBeGreaterThan(4);
      }
    }
    expect(landcoverFeatures(source, covers).warnings.filter((w) => w.includes('tree'))).toEqual(
      [],
    );
  });

  it('adds low planting and leaves the UNC lawn and school sporting spaces open', () => {
    const usi = SiteDetail.parse(pack('details', 'universidad-de-santa-isabel'));
    expect(
      intersection([details[1]!.grounds!], [usi.grounds!]),
      'CSNHS and Santa Isabel retain separate visual envelopes',
    ).toEqual([]);
    for (const cover of covers.slice(0, 5))
      expect(cover.areas.some((a) => a.cover === 'planting' || a.cover === 'shrubs')).toBe(true);
    for (const detail of details) {
      const cover = covers.find((c) => c.id.replace('landcover/', '') === detail.id.slice(7))!;
      for (const pool of detail.structures.filter((p) => p.material === 'water'))
        for (const paving of detail.structures.filter((p) => p.material === 'paving'))
          expect(
            intersection(
              [pool.ring, ...(pool.holes ?? [])],
              [paving.ring, ...(paving.holes ?? [])],
            ),
            `${detail.id}: ${paving.id} must leave ${pool.id} water exposed`,
          ).toEqual([]);
      for (const sport of detail.structures.filter((p) => ['pitch', 'water'].includes(p.material)))
        for (const tree of cover.trees)
          expect(
            inside(tree.at, { type: 'Polygon', coordinates: [sport.ring, ...(sport.holes ?? [])] }),
          ).toBe(false);
    }
    expect(covers[0]!.areas.every((a) => a.cover !== 'woods')).toBe(true);
  });

  it('keeps Magsaysay crowns small and at least 24 metres apart along retained carriageways', () => {
    const cover = covers[6]!;
    expect(cover.trees.length).toBeGreaterThan(20);
    expect(cover.trees.length).toBeLessThan(70);
    for (const [i, tree] of cover.trees.entries()) {
      expect(tree.crown_m).toBe(7);
      for (const other of cover.trees.slice(i + 1))
        expect(distance(tree.at, other.at)).toBeGreaterThan(23.9);
    }
  });

  it('renders the two school pools, courts and approaches with canonical campus selection and original geometry', () => {
    const landmarks = campusSlugs.map((slug) => Landmark.parse(pack('landmarks', slug)));
    const input = structuredClone(source);
    mergeContent(input, { landmarks } as ContentBundle);
    const before = structuredClone(input);
    const output = mergeSiteDetails(input, details).features;
    expect(input).toEqual(before);
    for (const original of before)
      expect(output.find((f) => f.properties.id === original.properties.id)!.geometry).toEqual(
        original.geometry,
      );
    for (const detail of details) {
      const authored = output.filter((f) =>
        f.properties.id.startsWith(`detail:${detail.id.slice(7)}/`),
      );
      expect(authored.length).toBeGreaterThan(4);
      for (const f of authored) {
        expect(f.properties.detail_parent).toBe(detail.osm_id);
        expect(
          DetailSelectionSchema.parse(JSON.parse(f.properties.detail_selection!) as unknown)
            .landmarkId,
        ).toBe(`landmark/${detail.id.slice(7)}`);
        if (!f.properties.detail_overhead)
          for (const roof of roofs)
            expect(
              intersection(
                (f.geometry as Polygon).coordinates as LngLat[][],
                (roof.geometry as Polygon | MultiPolygon).coordinates as LngLat[][] | LngLat[][][],
              ),
            ).toEqual([]);
      }
    }
    const pools = output.filter(
      (f) => f.properties.id.startsWith('detail:') && f.properties.kind === 'leisure=swimming_pool',
    );
    expect(pools).toHaveLength(2);
    expect(
      pools.every((f) => f.properties.class === 'water_area' && f.properties.detail_blocked),
    ).toBe(true);
    expect(
      output.filter((f) => f.properties.class === 'pitch' && f.properties.id.startsWith('detail:')),
    ).toHaveLength(4);
  });
});
