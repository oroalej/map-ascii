import { readFileSync } from 'node:fs';
import {
  Cemetery,
  Landcover,
  Landmark,
  SiteDetail,
  DetailSelectionSchema,
  type LngLat,
} from '@atlas/shared';
import type { ContentBundle } from '@atlas/content';
import type { Polygon, MultiPolygon } from 'geojson';
import inside from '@turf/boolean-point-in-polygon';
import { intersection } from 'polyclip-ts';
import { describe, expect, it } from 'vitest';
import type { AtlasFeature } from '../03-normalize';
import { mergeContent } from '../04-merge-content';
import { mergeSiteDetails, seatingFootprint } from './site-detail';
import { mergeCemeteries } from './cemeteries';
import { geometryAudit, polygonComponents } from './geometry-audit';
import { clearanceWidth } from './geo';
import { lineDistance as distances } from './landmark-detail.geometry';

// Declare disk-read content dependencies so targeted runs include this test on pack edits.
import.meta.glob(
  '../../../content/cities/naga/{details,landcover,landmarks}/{naga-hope-christian-school,penafrancia-basilica}.json',
);
import.meta.glob(
  '../../../content/cities/naga/{cemeteries,landmarks}/penafrancia-catholic-cemetery.json',
);

const read = (path: string): unknown =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as unknown;
const source = read('../__fixtures__/placement-correction-parents.json') as Record<
  'hope' | 'basilica' | 'cemetery',
  AtlasFeature[]
>;
const pack = (folder: string, name: string) =>
  read(`../../../content/cities/naga/${folder}/${name}.json`);
const hope = SiteDetail.parse(pack('details', 'naga-hope-christian-school'));
const trees = Landcover.parse(pack('landcover', 'naga-hope-christian-school'));
const palms = Landcover.parse(pack('landcover', 'penafrancia-basilica'));
const cemetery = Cemetery.parse(pack('cemeteries', 'penafrancia-catholic-cemetery'));

describe('owner placement corrections', () => {
  it('places Basilica tree columns on opposite sides of the marked roads, preserving the roads', () => {
    const loop = source.basilica.find((f) => f.properties.id === 'osm:way/20301218')!;
    const north = source.basilica.find((f) => f.properties.id === 'osm:way/1203053274')!;
    if (loop.geometry.type !== 'LineString' || north.geometry.type !== 'LineString')
      throw Error('source lanes');
    // Select the authored roadside columns by their tree dimensions, not array positions.
    const columns = palms.trees.filter(
      (t) => t.height_m === 18 || (t.height_m === 10 && t.crown_m === 7.5),
    );
    const sides = new Set<number>();
    expect(columns.length).toBeGreaterThan(0);
    for (const tree of columns) {
      const loopDistance = distances(tree.at, loop.geometry.coordinates);
      const northDistance = distances(tree.at, north.geometry.coordinates);
      const northern = northDistance < loopDistance;
      expect(
        Math.min(loopDistance, northDistance),
        `tree at ${tree.at.join(', ')}`,
      ).toBeGreaterThan(northern ? 3 : 3.5);
      expect(Math.min(loopDistance, northDistance), `tree at ${tree.at.join(', ')}`).toBeLessThan(
        12.5,
      );
      if (!northern) sides.add(Math.sign(distances(tree.at, loop.geometry.coordinates, true)));
    }
    expect([...sides].sort()).toEqual([-1, 1]);
    const before = structuredClone(source.basilica);
    const input = structuredClone(source.basilica);
    mergeContent(input, {
      landmarks: [Landmark.parse(pack('landmarks', 'penafrancia-basilica'))],
    } as ContentBundle);
    const detail = SiteDetail.parse(pack('details', 'penafrancia-basilica'));
    expect(detail.structures.some((s) => s.id.startsWith('plaza-edge-'))).toBe(false);
    mergeSiteDetails(input, [detail]);
    expect(source.basilica).toEqual(before);
  });

  it('keeps Hope courts distinct, small red-strip trunks outside both, and canopy below classroom roofs', () => {
    const court = hope.structures.find((s) => s.id === 'north-basketball-surface')!;
    const existing = hope.structures.find((s) => s.id === 'basketball-court-0')!;
    expect(intersection([court.ring], [existing.ring])).toEqual([]);
    expect(hope.structures.filter((s) => s.id.startsWith('north-basketball-'))).toHaveLength(6);
    for (const point of [
      [123.198497066, 13.62072914],
      [123.198478193, 13.620680267],
      [123.198466581, 13.620634728],
    ] as LngLat[]) {
      const tree = trees.trees.find(
        (t) => Math.hypot((t.at[0] - point[0]) * 108185, (t.at[1] - point[1]) * 111320) < 1,
      )!;
      expect(tree).toBeDefined();
      expect(tree.height_m).toBe(5);
      expect(inside(tree.at, { type: 'Polygon', coordinates: [court.ring] })).toBe(false);
      expect(inside(tree.at, { type: 'Polygon', coordinates: [existing.ring] })).toBe(false);
    }
    // Independently bounded annotated purple courtyard: density and crown diameter matter,
    // rather than requiring the superseded broad foliage mask to be completely filled.
    const courtyard: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [123.198, 13.62025],
          [123.1985, 13.62025],
          [123.1985, 13.62056],
          [123.198, 13.62056],
          [123.198, 13.62025],
        ],
      ],
    };
    const northern = trees.trees.filter((t) => inside(t.at, courtyard));
    expect(northern.length).toBeLessThanOrEqual(6);
    expect(northern.every((t) => t.crown_m! <= 7 && t.height_m === 5)).toBe(true);
    const result = mergeSiteDetails(source.hope, [hope]).features;
    for (const override of hope.building_overrides) {
      const original = source.hope.find((f) => f.properties.id === override.osm_id)!;
      const building = result.find((f) => f.properties.id === override.osm_id)!;
      expect(building.geometry).toEqual(original.geometry);
      expect(building.properties).toEqual({ ...original.properties, height: override.height_m });
    }
    expect(result.find((f) => f.properties.id === 'osm:way/276457436')!.properties.height).toBe(9);
    expect(result.find((f) => f.properties.id === 'osm:way/276457432')!.properties.height).toBe(6);
    const corridor = result.find((f) =>
      f.properties.id.endsWith('/structure-covered-entry-walkway'),
    )!;
    expect(corridor.properties).toMatchObject({
      detail_overhead: true,
      height: 3.2,
      detail_parent: hope.osm_id,
    });
  });

  // Build the same deterministic cemetery once; bound each exhaustive burial check.
  const landmark = Landmark.parse(pack('landmarks', 'penafrancia-catholic-cemetery'));
  const input = structuredClone(source.cemetery);
  mergeContent(input, { landmarks: [landmark] } as ContentBundle);
  const result = mergeCemeteries(input, [cemetery]);
  const parts = result.features
    .filter((f) => f.properties.id.startsWith('cemetery:'))
    .flatMap((f) =>
      polygonComponents(f.geometry as Polygon | MultiPolygon).map((geometry) => ({
        ...f,
        geometry,
      })),
    );
  const parent = input.find((f) => f.properties.id === cemetery.osm_id)!;
  const audit = geometryAudit(parent.geometry as Polygon | MultiPolygon);
  const obstacles = input.flatMap((f) => {
    if (f.geometry.type === 'LineString' && f.properties.class.startsWith('road'))
      return [seatingFootprint(f.geometry.coordinates as LngLat[], clearanceWidth(f.properties))];
    if (
      ['Polygon', 'MultiPolygon'].includes(f.geometry.type) &&
      f.properties.class.startsWith('building') &&
      (f.properties.height ?? 0) > 0
    )
      return [f.geometry as Polygon | MultiPolygon];
    return [];
  });

  it('makes the separate Catholic cemetery dense raised burials, leaving source roads/buildings and canonical selection intact', () => {
    expect(parts.length).toBeGreaterThan(1800);
    expect(
      parts.filter((f) => f.properties.kind === 'burial=vault').length / parts.length,
    ).toBeGreaterThan(0.8);
    for (const original of source.cemetery)
      expect(
        result.features.find((f) => f.properties.id === original.properties.id)!.geometry,
      ).toEqual(original.geometry);
  });

  for (let start = 0; start < parts.length; start += 250) {
    it(`keeps Catholic cemetery burials ${start + 1}-${Math.min(start + 250, parts.length)} clear and selectable`, () => {
      for (const part of parts.slice(start, start + 250)) {
        const shape = part.geometry;
        expect(audit.contains(shape)).toBe(true);
        for (const obstacle of obstacles) expect(audit.overlaps(shape, obstacle)).toBe(false);
        expect(
          DetailSelectionSchema.parse(JSON.parse(part.properties.detail_selection!) as unknown),
        ).toMatchObject({ id: cemetery.osm_id, landmarkId: landmark.id });
      }
    });
  }
});
