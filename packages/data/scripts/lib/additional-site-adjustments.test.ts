import { readFileSync } from 'node:fs';
import { Landcover, Landmark, SiteDetail, type LngLat } from '@atlas/shared';
import type { ContentBundle } from '@atlas/content';
import type { Polygon, MultiPolygon } from 'geojson';
import inside from '@turf/boolean-point-in-polygon';
import { intersection } from 'polyclip-ts';
import { describe, expect, it } from 'vitest';
import type { AtlasFeature } from '../03-normalize';
import { mergeContent } from '../04-merge-content';
import { mergeSiteDetails, seatingFootprint } from './site-detail';
import { parkedVehicleParts } from './parked-vehicles';

// Declare disk-read content dependencies so targeted runs include this test on pack edits.
import.meta.glob(
  '../../../content/cities/naga/{details,landcover,landmarks}/{naga-college-foundation,csnhs-liboton-annex,holy-rosary-minor-seminary,tinago-central-school,naga-central-school-i,naga-central-school-ii,bicol-central-station}.json',
);
import.meta.glob('../../../content/cities/naga/details/bicol-state-campus.json');
import.meta.glob('../../../content/cities/naga/landcover/saint-joseph-school.json');

const read = (path: string): unknown =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as unknown;
const pack = (folder: string, slug: string) =>
  read(`../../../content/cities/naga/${folder}/${slug}.json`);
const source = read('../__fixtures__/additional-site-parents.json') as AtlasFeature[];
const slugs = [
  'naga-college-foundation',
  'csnhs-liboton-annex',
  'holy-rosary-minor-seminary',
  'tinago-central-school',
  'naga-central-school-i',
  'naga-central-school-ii',
];
const details = [...slugs, 'bicol-central-station'].map((slug) =>
  SiteDetail.parse(pack('details', slug)),
);
const covers = [...slugs, 'bicol-central-station'].map((slug) =>
  Landcover.parse(pack('landcover', slug)),
);
const dist = (a: LngLat, b: LngLat) =>
  Math.hypot((a[0] - b[0]) * 111320 * Math.cos((b[1] * Math.PI) / 180), (a[1] - b[1]) * 111320);
const area = (detail: SiteDetail): Polygon | MultiPolygon =>
  detail.extent || detail.grounds
    ? { type: 'Polygon', coordinates: [detail.extent ?? detail.grounds!] }
    : (source.find((f) => f.properties.id === detail.osm_id)!.geometry as Polygon | MultiPolygon);
const coords = (g: Polygon | MultiPolygon) => g.coordinates as LngLat[][] | LngLat[][][];

describe('additional landmark references', () => {
  it('keeps the annex, schools and seminaries distinct with sourced draft selection', () => {
    const landmarks = slugs.map((slug) => Landmark.parse(pack('landmarks', slug)));
    expect(new Set(landmarks.map((l) => l.osm_id)).size).toBe(6);
    expect(landmarks[1]!.osm_id).toBe('osm:way/1060927534');
    expect(landmarks[2]!.osm_id).toBe('osm:way/1205481634');
    expect(landmarks[3]!.osm_id).toBe('osm:relation/10405033');
    const input = structuredClone(source);
    mergeContent(input, { landmarks } as ContentBundle);
    const output = mergeSiteDetails(input, details).features;
    expect(
      output.find((f) => f.properties.id === 'detail:bicol-central-station/grounds'),
    ).toMatchObject({
      properties: { class: 'paving', detail_parent: 'osm:way/293702439' },
    });
    for (const f of input)
      expect(
        output.find((o) => o.properties.id === f.properties.id)?.geometry,
        f.properties.id,
      ).toEqual(f.geometry);
    for (const detail of details)
      for (const f of output.filter(
        (f) =>
          f.properties.id.startsWith(`detail:${detail.id.slice(7)}/`) && f.properties.detail_parent,
      ))
        expect(f.properties.detail_parent).toBe(detail.osm_id);
  });
  it('adds sparse crowns outside full roads, paths, standing roofs and mapped trunks', () => {
    const obstacles = source.flatMap((f) => {
      if (
        (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon') &&
        ((f.properties.class.startsWith('building') && (f.properties.height ?? 0) > 0) ||
          f.properties.class.startsWith('water'))
      )
        return [f.geometry];
      if (
        f.geometry.type === 'LineString' &&
        (f.properties.class.startsWith('road') || f.properties.class === 'path')
      )
        return [
          seatingFootprint(
            f.geometry.coordinates as LngLat[],
            f.properties.width ?? (f.properties.class === 'path' ? 1.5 : 6),
          ),
        ];
      return [];
    });
    for (const [i, cover] of covers.entries()) {
      expect(cover.trees.length, cover.id).toBeGreaterThanOrEqual(i === 0 ? 4 : 6);
      for (const tree of cover.trees) {
        expect(tree.crown_m).toBeLessThanOrEqual(11);
        expect(inside(tree.at, area(details[i]!)), cover.id).toBe(true);
        for (const obstacle of obstacles) expect(inside(tree.at, obstacle), cover.id).toBe(false);
        for (const f of source.filter(
          (f) => f.properties.class === 'tree' && f.geometry.type === 'Point',
        ))
          expect(
            dist(tree.at, (f.geometry as { type: 'Point'; coordinates: LngLat }).coordinates),
          ).toBeGreaterThan(3);
      }
    }
  });
  it('retains open lawns, measured parking silhouettes and the separately detailed field', () => {
    for (const cover of covers.slice(1, 6))
      expect(
        cover.areas.some((a) => a.cover === 'grass'),
        cover.id,
      ).toBe(true);
    expect(details[0]!.parked_vehicles.length).toBeGreaterThanOrEqual(4);
    expect(details[1]!.parked_vehicles.length).toBeGreaterThanOrEqual(6);
    expect(details[6]!.parked_vehicles.length).toBeGreaterThanOrEqual(30);
    expect(details[6]!.parked_vehicles.every((v) => v.kind === 'bus')).toBe(true);
    for (const [i, detail] of details.entries())
      for (const vehicle of detail.parked_vehicles)
        for (const part of parkedVehicleParts(vehicle)) {
          expect(part.ring.every((p) => inside(p, area(detail)))).toBe(true);
          for (const tree of covers[i]!.trees)
            expect(inside(tree.at, { type: 'Polygon', coordinates: [part.ring] })).toBe(false);
        }
    const bicol = SiteDetail.parse(pack('details', 'bicol-state-campus'));
    expect(intersection(coords(area(details[5]!)), [bicol.grounds!])).toEqual([]);
    expect(bicol.structures.find((p) => p.id === 'grandstand-basketball')).toBeDefined();
    const joseph = Landcover.parse(pack('landcover', 'saint-joseph-school'));
    expect(joseph.trees.filter((t) => t.crown_m === 3).length).toBeGreaterThanOrEqual(5);
    expect(joseph.trees.filter((t) => (t.crown_m ?? 0) > 3)).toHaveLength(12);
  });
});
