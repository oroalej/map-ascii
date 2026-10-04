import {
  assertPointClear,
  distanceMeters as distance,
  readFixture,
  readPack as pack,
} from './landmark-detail.geometry';
import { DetailSelectionSchema, Landcover, Landmark, SiteDetail, type LngLat } from '@atlas/shared';
import type { ContentBundle } from '@atlas/content';
import type { Polygon, MultiPolygon } from 'geojson';
import inside from '@turf/boolean-point-in-polygon';
import bbox from '@turf/bbox';
import { describe, expect, it } from 'vitest';
import type { AtlasFeature } from '../03-normalize';
import { mergeContent } from '../04-merge-content';
import { mergeSiteDetails, seatingFootprint } from './site-detail';
import { landcoverFeatures } from './landcover';
import { geometryAudit } from './geometry-audit';
import { clearanceWidth } from './geo';

// Declare disk-read content dependencies so targeted runs include this test on pack edits.
import.meta.glob(
  '../../../content/cities/naga/{details,landcover,landmarks}/{julian-b-meliton-elementary-school,our-lady-of-mount-carmel-monastery,mac-mariano-elementary-school,sta-cruz-national-high-school,mabolo-elementary-school}.json',
);

const slugs = [
  'julian-b-meliton-elementary-school',
  'our-lady-of-mount-carmel-monastery',
  'mac-mariano-elementary-school',
  'sta-cruz-national-high-school',
  'mabolo-elementary-school',
];
const source = readFixture('five-landscaped-grounds.json') as AtlasFeature[];
const details = slugs.map((slug) => SiteDetail.parse(pack('details', slug)));
const covers = slugs.map((slug) => Landcover.parse(pack('landcover', slug)));
const landmarks = slugs.map((slug) => Landmark.parse(pack('landmarks', slug)));
const area = (i: number) =>
  source.find((f) => f.properties.id === details[i]!.osm_id)!.geometry as Polygon;

const intersects = geometryAudit(area(0)).overlaps;
const obstacles = source.flatMap<Polygon | MultiPolygon>((f) => {
  const p = f.properties,
    g = f.geometry;
  if (
    (g.type === 'Polygon' || g.type === 'MultiPolygon') &&
    ((p.class.startsWith('building') && (p.height ?? 0) > 0) ||
      p.class.startsWith('water') ||
      p.class.startsWith('pitch'))
  )
    return [g];
  if (
    g.type === 'LineString' &&
    (p.class.startsWith('road') || p.class === 'path' || p.class.startsWith('water'))
  )
    return [
      seatingFootprint(
        g.coordinates as LngLat[],
        p.class.startsWith('water') ? (p.width ?? 4) : clearanceWidth(p),
      ),
    ];
  return [];
});
const approaches = (detail: SiteDetail): Polygon[] =>
  detail.structures.map((s) => ({
    type: 'Polygon',
    coordinates: [s.ring, ...(s.holes ?? [])],
  }));

describe('five landscaped grounds', () => {
  it('preserves complete source identities and links new approaches to their own landmarks', () => {
    expect(new Set(landmarks.map((l) => l.osm_id)).size).toBe(5);
    // The full religious grounds are distinct from the standing monastery building.
    expect(details[1]!.osm_id).toBe('osm:way/1232848182');
    expect(source.some((f) => f.properties.id === 'osm:relation/2417997')).toBe(true);
    const input = mergeContent(structuredClone(source), { landmarks } as ContentBundle);
    const output = mergeSiteDetails(input, details).features;
    for (const f of source)
      expect(output.find((o) => o.properties.id === f.properties.id)!.geometry).toEqual(f.geometry);
    for (const [i, detail] of details.entries()) {
      expect(detail.grounds).toBeUndefined();
      expect(detail.extent).toBeUndefined();
      expect(detail.surface).toBe('keep');
      expect(detail.roof_overrides).toEqual([]);
      expect(detail.building_overrides).toEqual([]);
      expect(detail.status).toBe('draft');
      expect(landmarks[i]!.start_year).toBeUndefined();
      const parts = output.filter((f) =>
        f.properties.id.startsWith(`detail:${slugs[i]}/structure-`),
      );
      expect(parts.length).toBeGreaterThanOrEqual(3);
      for (const f of parts)
        expect(
          DetailSelectionSchema.parse(JSON.parse(f.properties.detail_selection!) as unknown)
            .landmarkId,
        ).toBe(`landmark/${slugs[i]}`);
    }
  });

  it('keeps trunks and low planting off standing roofs, full access widths and new paving', () => {
    for (const [i, cover] of covers.entries()) {
      const parent = area(i),
        detail = details[i]!;
      const paths = approaches(detail);
      for (const [j, tree] of cover.trees.entries()) {
        expect(inside(tree.at, parent)).toBe(true);
        assertPointClear(tree.at, [...obstacles, ...paths], cover.id);
        for (const other of cover.trees.slice(j + 1))
          expect(distance(tree.at, other.at)).toBeGreaterThan(7.5);
        for (const mapped of source.filter(
          (f) => f.properties.class === 'tree' && f.geometry.type === 'Point',
        ))
          if (mapped.geometry.type === 'Point')
            expect(distance(tree.at, mapped.geometry.coordinates)).toBeGreaterThan(3);
      }
      for (const patch of cover.areas) {
        const shape: Polygon = { type: 'Polygon', coordinates: [patch.ring] };
        expect(patch.ring.every((p) => inside(p, parent))).toBe(true);
        for (const obstacle of [...obstacles, ...paths])
          expect(intersects(shape, obstacle), cover.id).toBe(false);
      }
      for (const path of paths)
        for (const obstacle of obstacles) expect(intersects(path, obstacle), detail.id).toBe(false);
      expect(cover.status).toBe('draft');
      expect(cover.rows).toEqual([]);
      expect(cover.areas.some((a) => a.cover === 'grass')).toBe(true);
      expect(cover.areas.some((a) => a.cover === 'planting')).toBe(true);
      expect(cover.areas.some((a) => a.cover === 'woods')).toBe(false);
    }
    expect(landcoverFeatures(source, covers).warnings.filter((w) => w.includes('tree'))).toEqual(
      [],
    );
  });

  it('covers the whole monastery north and south while leaving Sta. Cruz lawn mostly open', () => {
    const monastery = covers[1]!,
      bounds = bbox(area(1));
    const latSpan = bounds[3] - bounds[1];
    expect(monastery.trees.filter((t) => t.at[1] > bounds[3] - latSpan / 3).length).toBeGreaterThan(
      8,
    );
    expect(monastery.trees.filter((t) => t.at[1] < bounds[1] + latSpan / 3).length).toBeGreaterThan(
      15,
    );
    const pavedBounds = bbox({
      type: 'MultiPolygon',
      coordinates: approaches(details[1]!).map((p) => p.coordinates),
    });
    expect(pavedBounds[1]).toBeLessThan(bounds[1] + latSpan / 5);
    expect(pavedBounds[3]).toBeGreaterThan(bounds[3] - latSpan / 5);
    const openSchool = covers[3]!;
    expect(openSchool.trees.length).toBeGreaterThanOrEqual(4);
    expect(openSchool.trees.length).toBeLessThanOrEqual(10);
    expect(openSchool.trees.every((t) => t.crown_m! <= 7)).toBe(true);
    // A useful clear lawn area survives between the classroom wings.
    expect(
      openSchool.areas.some(
        (a) =>
          a.cover === 'grass' &&
          inside([123.180892, 13.629202], { type: 'Polygon', coordinates: [a.ring] }),
      ),
    ).toBe(true);
  });
});
