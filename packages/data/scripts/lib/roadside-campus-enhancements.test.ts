import { Landcover, Landmark, SiteDetail, DetailSelectionSchema } from '@atlas/shared';
import type { ContentBundle } from '@atlas/content';
import type { Polygon, MultiPolygon, LineString } from 'geojson';
import inside from '@turf/boolean-point-in-polygon';
import { describe, expect, it } from 'vitest';
import type { AtlasFeature } from '../03-normalize';
import { mergeContent } from '../04-merge-content';
import { localFrame } from './geo';
import { mergeSiteDetails } from './site-detail';
import {
  assertPointClear,
  clearanceAssertions,
  effectiveTrees,
  mappedFootprints,
  distanceMeters as distance,
  readFixture,
  readPack as pack,
} from './landmark-detail.geometry';
import { landcoverFeatures } from './landcover';

// Declare disk-read content dependencies so targeted runs include this test on pack edits.
import.meta.glob(
  '../../../content/cities/naga/{details,landcover,landmarks}/{triangulo-elementary-school,mariners-polytechnic-colleges-naga,sti-college-naga,jose-rizal-elementary-school,naga-city-school-of-arts-and-trades}.json',
);
import.meta.glob('../../../content/cities/naga/landcover/magsaysay-avenue.json');

const slugs = [
  'triangulo-elementary-school',
  'mariners-polytechnic-colleges-naga',
  'jose-rizal-elementary-school',
  'naga-city-school-of-arts-and-trades',
];
const source = readFixture('roadside-campus-parents.json') as AtlasFeature[];
const reference = readFixture('roadside-campus-reference.json') as {
  roadside_report: { added: { at: [number, number] }[] };
};
const details = slugs.map((slug) => SiteDetail.parse(pack('details', slug)));
const covers = slugs.map((slug) => Landcover.parse(pack('landcover', slug)));
const projection = localFrame([0, 0], 13.628);
const xy = (point: readonly number[]) => projection.toMeters([point[0]!, point[1]!]);

const audit = clearanceAssertions(
  source.find((f) => f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon')!
    .geometry as Polygon | MultiPolygon,
);
const intersects = audit.overlaps;
const obstacles = mappedFootprints(source, { water: true });

describe('additional roadside and campus references', () => {
  it('keeps distinct source anchors and canonical selection for school approaches', () => {
    const landmarks = slugs.map((slug) => Landmark.parse(pack('landmarks', slug)));
    expect(new Set(landmarks.map((l) => l.osm_id)).size).toBe(4);
    const input = mergeContent(structuredClone(source), { landmarks } as ContentBundle);
    const output = mergeSiteDetails(input, details).features;
    for (const f of source)
      expect(output.find((o) => o.properties.id === f.properties.id)!.geometry).toEqual(f.geometry);
    for (const [i, detail] of details.entries()) {
      const surfaces = output.filter((f) =>
        f.properties.id.startsWith(`detail:${slugs[i]}/structure-`),
      );
      expect(surfaces.length).toBeGreaterThanOrEqual(3);
      for (const f of surfaces)
        expect(
          DetailSelectionSchema.parse(JSON.parse(f.properties.detail_selection!) as unknown)
            .landmarkId,
        ).toBe(`landmark/${slugs[i]}`);
      expect(detail.building_overrides).toEqual([]);
      expect(detail.roof_overrides).toEqual([]);
    }
  });

  it('places trunks, grass and planting within the source sites and clear of roofs and full access widths', () => {
    for (const [i, cover] of covers.entries()) {
      const detail = details[i]!;
      const area = detail.grounds
        ? { type: 'Polygon' as const, coordinates: [detail.grounds] }
        : (source.find((f) => f.properties.id === detail.osm_id)!.geometry as Polygon);
      const visible = effectiveTrees(source, [cover]).filter((tree) =>
        inside(tree.geometry.coordinates, area),
      );
      expect(visible.length).toBeGreaterThanOrEqual(8);
      expect(visible.length).toBeLessThanOrEqual(30);
      expect(cover.status).toBe('draft');
      expect(detail.status).toBe('draft');
      expect(cover.areas.some((a) => a.cover === 'grass')).toBe(true);
      expect(cover.areas.some((a) => a.cover === 'planting')).toBe(true);
      for (const [j, tree] of cover.trees.entries()) {
        expect(inside(tree.at, area)).toBe(true);
        assertPointClear(tree.at, obstacles, cover.id);
        for (const other of cover.trees.slice(j + 1))
          expect(distance(tree.at, other.at)).toBeGreaterThan(4);
      }
      for (const patch of cover.areas)
        for (const obstacle of obstacles)
          expect(
            intersects({ type: 'Polygon', coordinates: [patch.ring] }, obstacle),
            cover.id,
          ).toBe(false);
    }
    expect(landcoverFeatures(source, covers).warnings.filter((w) => w.includes('tree'))).toEqual(
      [],
    );
  });

  it('keeps the southern Magsaysay segment clear while preserving northern canopies on both sides', () => {
    const cover = Landcover.parse(pack('landcover', 'magsaysay-avenue'));
    const road = source.find((f) => f.properties.id === 'osm:way/252223483')!
      .geometry as LineString;
    const aureus = source.find((f) => f.properties.id === 'osm:way/23519204')!
      .geometry as LineString;
    const junction = road.coordinates.findIndex((p) =>
      aureus.coordinates.some((q) => p[0] === q[0] && p[1] === q[1]),
    );
    expect(junction).toBeGreaterThan(0);
    const atJunction = road.coordinates[junction]!;
    // This monotonic avenue section runs north from the shared Aureus vertex.
    // The owner removed southern planting and the marked northwest bridge-junction tree.
    const removedBridgeTree = [123.194736944, 13.633190353];
    expect(cover.trees.some((tree) => tree.at.every((v, i) => v === removedBridgeTree[i]))).toBe(
      false,
    );
    const canopies = effectiveTrees(source, [cover])
      .filter(
        (tree) =>
          (tree.properties.crown ?? 0) >= 17 && tree.geometry.coordinates[1]! > atJunction[1]!,
      )
      .map((tree) => ({
        at: tree.geometry.coordinates as [number, number],
        crown_m: tree.properties.crown!,
      }));
    for (const sample of reference.roadside_report.added.filter(
      (tree) => tree.at[1] > atJunction[1]!,
    ))
      expect(canopies.some((tree) => distance(tree.at, sample.at) <= tree.crown_m / 2 + 1)).toBe(
        true,
      );
    for (const tree of cover.trees) {
      expect(tree.crown_m).toBeGreaterThanOrEqual(17);
      expect(tree.crown_m).toBeLessThanOrEqual(20);
    }
    expect(cover.status).toBe('draft');
    expect(cover.trees.every((tree) => tree.at[1] > atJunction[1]!)).toBe(true);
    const points = road.coordinates.slice(junction).map(xy);
    const lengths = points
      .slice(1)
      .map((p, i) => Math.hypot(p[0] - points[i]![0], p[1] - points[i]![1]));
    const total = lengths.reduce((a, b) => a + b, 0);
    const located = canopies
      .map((tree) => {
        const p = xy(tree.at);
        let closest = { distance: Infinity, side: 0, chain: 0 };
        let chain = 0;
        for (const [i, b] of points.slice(1).entries()) {
          const a = points[i]!,
            dx = b[0] - a[0],
            dy = b[1] - a[1],
            l = lengths[i]!;
          const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (l * l)));
          const d = Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
          if (d < closest.distance)
            closest = {
              distance: d,
              side: Math.sign(dx * (p[1] - a[1]) - dy * (p[0] - a[0])),
              chain: chain + t * l,
            };
          chain += l;
        }
        return { ...closest, tree };
      })
      .filter((t) => t.distance < 15);
    for (const side of [-1, 1]) {
      const row = located.filter((t) => t.side === side);
      expect(row.length).toBeGreaterThan(15);
      for (let section = 0; section < 3; section++)
        expect(
          row.filter(
            (t) => t.chain >= (total * section) / 3 && t.chain < (total * (section + 1)) / 3,
          ).length,
        ).toBeGreaterThan(2);
      for (const [i, tree] of row.entries()) {
        expect(tree.distance).toBeGreaterThan(5);
        expect(tree.tree.crown_m / 2).toBeGreaterThan(tree.distance - 5);
        for (const other of row.slice(i + 1))
          expect(distance(tree.tree.at, other.tree.at)).toBeGreaterThan(23.9);
      }
    }
    for (const tree of cover.trees) assertPointClear(tree.at, obstacles, tree.at.join(', '));
  });
});
