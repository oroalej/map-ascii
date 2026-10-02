import { readFileSync } from 'node:fs';
import { Landcover, SiteDetail, Landmark, DetailSelectionSchema, type LngLat } from '@atlas/shared';
import inside from '@turf/boolean-point-in-polygon';
import { describe, expect, it } from 'vitest';
import type { Polygon, MultiPolygon, Point } from 'geojson';
import type { AtlasFeature } from '../03-normalize';
import { mergeContent } from '../04-merge-content';
import type { ContentBundle } from '@atlas/content';
import { applyLandcoverTreeOverrides, landcoverFeatures } from './landcover';
import { mergeSiteDetails } from './site-detail';

// Declare disk-read content dependencies so targeted runs include this test on pack edits.
import.meta.glob(
  '../../../content/cities/naga/{details,landcover,landmarks}/{naga-city-civic-center,naga-hope-christian-school,naga-city-peoples-mall,universidad-de-santa-isabel,naga-parochial-school}.json',
);
import.meta.glob(
  '../../../content/cities/naga/landcover/universidad-de-santa-isabel-frontage.json',
);

const root = new URL('../../../content/cities/naga/', import.meta.url);
const read = (folder: string, slug: string): unknown =>
  JSON.parse(readFileSync(new URL(`${folder}/${slug}.json`, root), 'utf8')) as unknown;
const source = JSON.parse(
  readFileSync(new URL('../__fixtures__/landmark-parents.json', import.meta.url), 'utf8'),
) as AtlasFeature[];
const slugs = [
  'naga-city-civic-center',
  'naga-hope-christian-school',
  'naga-city-peoples-mall',
  'universidad-de-santa-isabel',
  'naga-parochial-school',
];
const details = slugs.map((slug) => SiteDetail.parse(read('details', slug)));
const covers = slugs
  .filter((slug) => !slug.includes('peoples-mall'))
  .map((slug) => Landcover.parse(read('landcover', slug)));
covers.push(Landcover.parse(read('landcover', 'universidad-de-santa-isabel-frontage')));
mergeContent(source, {
  landmarks: slugs.map((slug) => Landmark.parse(read('landmarks', slug))),
} as ContentBundle);
const adjusted = applyLandcoverTreeOverrides(source, covers);
const authored = landcoverFeatures(adjusted, covers);
const input = [...adjusted, ...authored.features];
const metres = ([x, y]: readonly number[], [lng, lat]: readonly number[]) =>
  Math.hypot((x! - lng!) * 111320 * Math.cos((lat! * Math.PI) / 180), (y! - lat!) * 111320);

describe('five owner-referenced landmark adjustments', () => {
  it('restrains mapped Civic Center crowns without moving or duplicating trunks or changing the pool', () => {
    const cover = covers[0]!;
    expect(cover.tree_overrides).toHaveLength(24);
    for (const tree of cover.tree_overrides) {
      const original = source.find((f) => f.properties.id === tree.osm_id)!;
      const result = adjusted.find((f) => f.properties.id === tree.osm_id)!;
      expect(result.geometry).toEqual(original.geometry);
      expect(result.properties).toEqual({ ...original.properties, crown: tree.crown_m });
      expect(tree.crown_m).toBeGreaterThanOrEqual(8);
      expect(tree.crown_m).toBeLessThanOrEqual(18);
    }
    for (const tree of cover.trees)
      for (const f of source.filter(
        (f) => f.properties.class === 'tree' && f.geometry.type === 'Point',
      ))
        expect(metres(tree.at, (f.geometry as Point).coordinates)).toBeGreaterThan(3);
    expect(adjusted.find((f) => f.properties.id === 'osm:way/222976574')).toEqual(
      source.find((f) => f.properties.id === 'osm:way/222976574'),
    );
    expect(authored.warnings).toEqual([]);
  });

  it('represents Hope basketball geometry and a connected oval with an open lawn infield', () => {
    const pack = details[1]!;
    const court = pack.structures.find((s) => s.id.startsWith('basketball-court'))!;
    const track = pack.structures.find((s) => s.id.startsWith('oval-track'))!;
    expect(court.material).toBe('pitch');
    expect(track.holes).toHaveLength(1);
    const infield = track.holes![0]!;
    const centre = infield
      .slice(0, -1)
      .reduce(
        (a, p) =>
          [a[0] + p[0] / (infield.length - 1), a[1] + p[1] / (infield.length - 1)] as LngLat,
        [0, 0] as LngLat,
      );
    const result = mergeSiteDetails(input, [pack]).features;
    const oval = result.find((f) => f.properties.id.includes('/structure-oval-track'))!;
    expect(inside(centre, oval.geometry as Polygon)).toBe(false);
    expect(
      covers[1]!.areas.some(
        (a) => a.cover === 'grass' && inside(centre, { type: 'Polygon', coordinates: [a.ring] }),
      ),
    ).toBe(true);
    expect(
      pack.structures.filter((s) => s.id.startsWith('court-') || s.id.startsWith('key-')),
    ).toHaveLength(11);
    expect(pack.structures.some((s) => s.id.startsWith('pavilion'))).toBe(false);
  });

  it('keeps new trunks clear of mapped roofs and full-width carriageways', () => {
    const buildings = source.filter(
      (f) =>
        f.properties.class.startsWith('building') &&
        (f.properties.height ?? 0) > 0 &&
        ['Polygon', 'MultiPolygon'].includes(f.geometry.type),
    );
    const roads = source.filter(
      (f) => f.properties.class.startsWith('road') && f.geometry.type === 'LineString',
    );
    for (const cover of covers)
      for (const tree of cover.trees) {
        for (const building of buildings)
          expect(inside(tree.at, building.geometry as Polygon | MultiPolygon), cover.id).toBe(
            false,
          );
        const mx = 111320 * Math.cos((tree.at[1] * Math.PI) / 180);
        const local = (p: readonly number[]) =>
          [(p[0]! - tree.at[0]) * mx, (p[1]! - tree.at[1]) * 111320] as const;
        for (const road of roads) {
          if (road.geometry.type !== 'LineString') continue;
          const points = road.geometry.coordinates.map(local);
          for (let i = 1; i < points.length; i++) {
            const [ax, ay] = points[i - 1]!,
              [bx, by] = points[i]!;
            const dx = bx - ax,
              dy = by - ay;
            const length = dx * dx + dy * dy;
            const t = length ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length)) : 0;
            expect(
              Math.hypot(ax + t * dx, ay + t * dy),
              `${cover.id} / ${road.properties.id}`,
            ).toBeGreaterThan((road.properties.width ?? 6) / 2);
          }
        }
      }
  });

  it('adds market roof rows and both curved features above a flat source roof, preserving its footprint', () => {
    const pack = details[2]!;
    expect(pack.structures.filter((s) => s.roof_shape === 'gabled').length).toBeGreaterThanOrEqual(
      20,
    );
    expect(pack.structures.some((s) => s.id.startsWith('north-curved-ramp'))).toBe(true);
    expect(pack.structures.find((s) => s.id.startsWith('south-round-roof'))!.holes).toHaveLength(1);
    expect(pack.structures.filter((s) => s.id.startsWith('open-deck'))).toHaveLength(4);
    const result = mergeSiteDetails(input, [pack]).features;
    const original = source.find((f) => f.properties.id === pack.osm_id)!;
    const mapped = result.find((f) => f.properties.id === pack.osm_id)!;
    expect(mapped.geometry).toEqual(original.geometry);
    expect(mapped.properties.height).toBe(original.properties.height);
    expect(mapped.properties.variant).toBe('flat');
    for (const s of pack.structures.filter((s) => s.roof_osm_id)) {
      const part = result.find(
        (f) => f.properties.id === `detail:naga-city-peoples-mall/structure-${s.id}`,
      )!;
      expect(part.properties).toMatchObject({
        detail_overhead: true,
        detail_parent: pack.osm_id,
        class: 'building',
      });
      expect(
        DetailSelectionSchema.parse(JSON.parse(part.properties.detail_selection!) as unknown)
          .landmarkId,
      ).toBe('landmark/naga-city-peoples-mall');
    }
  });

  it('keeps USI visual additions in the supplied campus portion and retains Parochial courtyard holes', () => {
    const usi = details[3]!,
      parochial = details[4]!;
    expect(usi.structures.some((s) => s.id.startsWith('lawn-pavilion-roof'))).toBe(true);
    expect(
      usi.structures.filter((s) => s.roof_osm_id === 'osm:relation/2418000').length,
    ).toBeGreaterThanOrEqual(7);
    expect(parochial.structures.filter((s) => s.roof_shape)).toHaveLength(3);
    expect(covers[3]!.trees).toHaveLength(9);
    const result = mergeSiteDetails(input, [usi, parochial]).features;
    for (const id of ['osm:relation/2418000', 'osm:relation/16253275']) {
      expect(result.find((f) => f.properties.id === id)!.geometry).toEqual(
        source.find((f) => f.properties.id === id)!.geometry,
      );
    }
    for (const s of usi.structures)
      expect(Math.max(...s.ring.map((p) => p[1]))).toBeLessThan(13.6296);
    for (const pack of [usi, parochial])
      for (const f of result.filter((f) =>
        f.properties.id.startsWith(`detail:${pack.id.slice(7)}/structure-`),
      ))
        expect(f.properties.detail_parent).toBe(pack.osm_id);
  });

  it('covers separately traced foliage masks with at least 70% nominal canopy', () => {
    const masks = JSON.parse(
      readFileSync(new URL('../__fixtures__/five-site-reference.json', import.meta.url), 'utf8'),
    ) as { site: string; id: string; ring: LngLat[] }[];
    const trees = input.filter((f) => f.properties.class === 'tree' && f.geometry.type === 'Point');
    for (const mask of masks) {
      // Later Civic annotations replace these original grove masks with selective crown edits.
      if (mask.site === 'naga-city-civic-center') continue;
      // The latest annotation explicitly replaces these oversized northern groves.
      if (
        mask.site === 'naga-hope-christian-school' &&
        ['west-court-trees', 'west-courtyard-grove'].includes(mask.id)
      )
        continue;
      const polygon: Polygon = { type: 'Polygon', coordinates: [[...mask.ring, mask.ring[0]!]] };
      const west = Math.min(...mask.ring.map((p) => p[0])),
        east = Math.max(...mask.ring.map((p) => p[0]));
      const south = Math.min(...mask.ring.map((p) => p[1])),
        north = Math.max(...mask.ring.map((p) => p[1]));
      const dx = 0.5 / (111320 * Math.cos((south * Math.PI) / 180)),
        dy = 0.5 / 111320;
      let total = 0,
        covered = 0;
      for (let lat = south; lat <= north; lat += dy)
        for (let lng = west; lng <= east; lng += dx) {
          if (!inside([lng, lat], polygon)) continue;
          total++;
          if (
            trees.some(
              (f) =>
                metres([lng, lat], (f.geometry as Point).coordinates) <= f.properties.crown! / 2,
            )
          )
            covered++;
        }
      expect(total, mask.id).toBeGreaterThan(0);
      expect(covered / total, mask.id).toBeGreaterThanOrEqual(0.7);
    }
  });
});
