import { readFileSync } from 'node:fs';
import { Landcover, Landmark, SiteDetail, DetailSelectionSchema, type LngLat } from '@atlas/shared';
import type { ContentBundle } from '@atlas/content';
import type { Polygon, MultiPolygon, LineString } from 'geojson';
import inside from '@turf/boolean-point-in-polygon';
import bbox from '@turf/bbox';
import { intersection } from 'polyclip-ts';
import { describe, expect, it } from 'vitest';
import type { AtlasFeature } from '../03-normalize';
import { mergeContent } from '../04-merge-content';
import { mergeSiteDetails, seatingFootprint } from './site-detail';
import { landcoverFeatures } from './landcover';
import { bboxesOverlap } from './geo';

const read = (path: string): unknown =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as unknown;
const pack = (folder: string, slug: string) =>
  read(`../../../content/cities/naga/${folder}/${slug}.json`);
const slugs = [
  'triangulo-elementary-school',
  'mariners-polytechnic-colleges-naga',
  'sti-college-naga',
  'jose-rizal-elementary-school',
  'naga-city-school-of-arts-and-trades',
];
const source = read('../__fixtures__/roadside-campus-parents.json') as AtlasFeature[];
const reference = read('../__fixtures__/roadside-campus-reference.json') as {
  magsaysay_before: Landcover;
  arts_before: Landcover;
};
const details = slugs.map((slug) => SiteDetail.parse(pack('details', slug)));
const covers = slugs.map((slug) => Landcover.parse(pack('landcover', slug)));
const xy = ([lng, lat]: readonly number[]) =>
  [lng! * 111320 * Math.cos((13.628 * Math.PI) / 180), lat! * 111320] as const;
const distance = (a: readonly number[], b: readonly number[]) => {
  const x = xy(a),
    y = xy(b);
  return Math.hypot(x[0] - y[0], x[1] - y[1]);
};
const coords = (g: Polygon | MultiPolygon) => g.coordinates as LngLat[][] | LngLat[][][];
const intersects = (a: Polygon | MultiPolygon, b: Polygon | MultiPolygon) =>
  bboxesOverlap(
    bbox(a) as [number, number, number, number],
    bbox(b) as [number, number, number, number],
  ) && intersection(coords(a), coords(b)).length > 0;
const obstacles = source.flatMap<Polygon | MultiPolygon>((f) => {
  const p = f.properties,
    g = f.geometry;
  if (
    (g.type === 'Polygon' || g.type === 'MultiPolygon') &&
    ((p.class.startsWith('building') && (p.height ?? 0) > 0) || p.class.startsWith('water'))
  )
    return [g];
  if (g.type === 'LineString' && (p.class.startsWith('road') || p.class === 'path'))
    return [seatingFootprint(g.coordinates as LngLat[], p.width ?? (p.class === 'path' ? 2 : 6))];
  return [];
});

describe('additional roadside and campus references', () => {
  it('keeps distinct source anchors and canonical selection for school approaches', () => {
    const landmarks = slugs.map((slug) => Landmark.parse(pack('landmarks', slug)));
    expect(new Set(landmarks.map((l) => l.osm_id)).size).toBe(5);
    expect(details[2]!.osm_id).toBe('osm:node/254753694');
    expect(details[2]!.grounds).toBeDefined();
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
  }, 10000);

  it('places trunks, grass and planting within the source sites and clear of roofs and full access widths', () => {
    for (const [i, cover] of covers.entries()) {
      const detail = details[i]!;
      const area = detail.grounds
        ? { type: 'Polygon' as const, coordinates: [detail.grounds] }
        : (source.find((f) => f.properties.id === detail.osm_id)!.geometry as Polygon);
      expect(cover.trees.length).toBeGreaterThanOrEqual(8);
      expect(cover.trees.length).toBeLessThanOrEqual(26);
      expect(cover.areas.some((a) => a.cover === 'grass')).toBe(true);
      expect(cover.areas.some((a) => a.cover === 'planting')).toBe(true);
      for (const [j, tree] of cover.trees.entries()) {
        expect(inside(tree.at, area)).toBe(true);
        for (const obstacle of obstacles) expect(inside(tree.at, obstacle), cover.id).toBe(false);
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
    const arts = covers[4]!;
    for (const [i, old] of reference.arts_before.trees.entries())
      expect(arts.trees[i]!.at).toEqual(old.at);
    for (const old of reference.arts_before.areas) expect(arts.areas).toContainEqual(old);
    expect(arts.trees.length).toBeGreaterThan(reference.arts_before.trees.length);
  }, 10000);

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
    // The owner removed the southern roadside planting; old northern trunks stay.
    for (const old of reference.magsaysay_before.trees.filter(
      (tree) => tree.at[1] > atJunction[1]!,
    )) {
      const retained = cover.trees.find((tree) => tree.at.every((v, i) => v === old.at[i]));
      expect(retained).toBeDefined();
      expect(retained!.height_m).toBe(old.height_m);
      expect(retained!.crown_m).toBeGreaterThan(old.crown_m!);
    }
    expect(cover.trees.every((tree) => tree.at[1] > atJunction[1]!)).toBe(true);
    const points = road.coordinates.slice(junction).map(xy);
    const lengths = points
      .slice(1)
      .map((p, i) => Math.hypot(p[0] - points[i]![0], p[1] - points[i]![1]));
    const total = lengths.reduce((a, b) => a + b, 0);
    const located = cover.trees
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
        expect(tree.tree.crown_m! / 2).toBeGreaterThan(tree.distance - 5);
        for (const other of row.slice(i + 1))
          expect(distance(tree.tree.at, other.tree.at)).toBeGreaterThan(23.9);
      }
    }
    for (const tree of cover.trees)
      for (const obstacle of obstacles) expect(inside(tree.at, obstacle)).toBe(false);
  });
});
