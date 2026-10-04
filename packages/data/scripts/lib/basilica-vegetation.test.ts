import { distanceMeters as distance, readFixture, readPack } from './landmark-detail.geometry';
import { Landcover, type LngLat } from '@atlas/shared';
import inside from '@turf/boolean-point-in-polygon';
import bbox from '@turf/bbox';
import type { Polygon, MultiPolygon } from 'geojson';
import { intersection } from 'polyclip-ts';
import { describe, expect, it } from 'vitest';
import type { AtlasFeature } from '../03-normalize';
import { landcoverFeatures, SAME_TREE_M } from './landcover';
import { seatingFootprint } from './site-detail';
import { bboxesOverlap, clearanceWidth, localFrame } from './geo';

// Declare disk-read content dependencies so targeted runs include this test on pack edits.
import.meta.glob('../../../content/cities/naga/landcover/penafrancia-basilica.json');

const pack = Landcover.parse(readPack('landcover', 'penafrancia-basilica'));
const source = readFixture('landmark-parents.json') as AtlasFeature[];
// Masks are traced from visible foliage independently of the authored points/crown sizes.
const reference = readFixture('basilica-vegetation.json') as {
  groups: { id: string; rings: LngLat[][] }[];
  palm_rows: { id: string; tree_indices: number[] }[];
  isolated_palms: { id: string; at: LngLat }[];
  open_ground: { id: string; ring: LngLat[] }[];
};
const grounds = source.find((f) => f.properties.id === 'osm:way/838935827')!.geometry as Polygon;
const project = localFrame([123.2, 13.632]).toMeters;

const merged = landcoverFeatures(source, [pack]);
const crowns = pack.trees.map((t) => ({ at: project(t.at), radius: t.crown_m! / 2 }));

describe('Basilica owner-reference vegetation', () => {
  it('retains every circled foliage group in the independent reference', () => {
    expect(reference.groups.map((g) => g.id)).toEqual([
      'western-outer-grove',
      'western-inner-palms',
      'northern-inner-palms',
      'eastern-inner-palms',
      'eastern-outer-palms',
      'northwest-lawn-tree',
      'northwest-lawn-palm',
      'pavilion-northeast-palm',
      'pavilion-southwest-palm',
      'pavilion-southeast-palm',
      'forecourt-east-grove',
      'parking-east-grove',
    ]);
  });

  for (const group of reference.groups) {
    // The owner superseded the displaced aerial rows with columns on both sides of the road.
    // Independent road clearances are tested in placement-correction.test.ts instead.
    if (
      [
        'western-outer-grove',
        'western-inner-palms',
        'northern-inner-palms',
        'eastern-inner-palms',
        'eastern-outer-palms',
      ].includes(group.id)
    )
      continue;
    it(`${group.id}: covers at least 70% of visible foliage`, () => {
      for (const ring of group.rings) {
        const shape: Polygon = { type: 'Polygon', coordinates: [ring.map(project)] };
        const [west, south, east, north] = bbox(shape);
        let samples = 0;
        let covered = 0;
        for (let x = west + 0.25; x < east; x += 0.5)
          for (let y = south + 0.25; y < north; y += 0.5) {
            if (!inside([x, y], shape)) continue;
            samples++;
            if (crowns.some((c) => Math.hypot(x - c.at[0], y - c.at[1]) <= c.radius)) covered++;
          }
        expect(samples).toBeGreaterThan(0);
        expect(covered / samples, `${covered}/${samples} foliage samples`).toBeGreaterThanOrEqual(
          0.7,
        );
      }
    });
  }

  it('uses separate tall palm crowns with regular spacing and broader isolated trees', () => {
    expect(pack.rows).toEqual([]);
    for (const row of reference.palm_rows) {
      const trees = row.tree_indices.map((i) => pack.trees[i - 1]!);
      expect(trees.length, row.id).toBeGreaterThanOrEqual(8);
      for (const tree of trees) {
        expect(tree.kind, row.id).toBe('palm');
        expect(tree.height_m).toBe(18);
        expect(tree.crown_m).toBeGreaterThanOrEqual(5);
        expect(tree.crown_m).toBeLessThanOrEqual(6.5);
      }
      for (let i = 1; i < trees.length; i++)
        // The corrected road-dividers leave gaps at crossing approaches.
        expect(distance(trees[i - 1]!.at, trees[i]!.at), row.id).toBeLessThan(18);
    }
    for (const palm of reference.isolated_palms) {
      const tree = pack.trees.find((t) => distance(t.at, palm.at) < 1);
      expect(tree?.kind, palm.id).toBe('palm');
      expect(tree?.height_m).toBe(14);
    }
    const broad = pack.trees.filter((t) => t.kind === 'broadleaved');
    expect(broad.length).toBeGreaterThan(10);
    expect(broad.some((t) => t.crown_m === 16)).toBe(true);
    expect(pack.trees.every((t) => (t.crown_m ?? 0) <= 16)).toBe(true);
  });

  it('keeps all trunks in the grounds, deduplicates and preserves mapped facilities', () => {
    expect(merged.warnings).toEqual([]);
    expect(merged.features.filter((f) => f.properties.class === 'tree')).toHaveLength(
      pack.trees.length,
    );
    const mappedTrees = source.filter(
      (f) => f.properties.class === 'tree' && f.geometry.type === 'Point',
    );
    for (let i = 0; i < pack.trees.length; i++) {
      expect(inside(pack.trees[i]!.at, grounds)).toBe(true);
      for (let j = i + 1; j < pack.trees.length; j++)
        expect(distance(pack.trees[i]!.at, pack.trees[j]!.at)).toBeGreaterThan(SAME_TREE_M);
      for (const tree of mappedTrees) {
        if (tree.geometry.type !== 'Point') throw Error('expected tree point');
        expect(distance(pack.trees[i]!.at, tree.geometry.coordinates as LngLat)).toBeGreaterThan(
          SAME_TREE_M,
        );
      }
    }
    const input = structuredClone(source);
    landcoverFeatures(input, [pack]);
    expect(input).toEqual(source);
    for (const id of ['osm:way/23670362', 'osm:way/230802633', 'osm:way/606888523'])
      expect(input.some((f) => f.properties.id === id)).toBe(true);
  });

  it('keeps lawns, crosswalks and pavilion approaches free of invented groves', () => {
    for (const area of reference.open_ground) {
      const shape: Polygon = { type: 'Polygon', coordinates: [area.ring] };
      expect(
        pack.trees.filter((t) => inside(t.at, shape)),
        area.id,
      ).toEqual([]);
      for (const bed of pack.areas)
        expect(intersection([bed.ring], [area.ring]), area.id).toEqual([]);
    }
    // A strip can split into several polygons when clipped clear of a mapped drive.
    expect(pack.areas.length).toBeGreaterThanOrEqual(4);
    expect(pack.areas.every((a) => a.cover === 'planting' && !a.raised)).toBe(true);
  });

  it('keeps trunks and ground planting outside standing buildings and full road widths', () => {
    const nearby = source.filter((f) =>
      bboxesOverlap(
        bbox(grounds) as [number, number, number, number],
        bbox(f) as [number, number, number, number],
      ),
    );
    const obstacles = nearby.flatMap<{ id: string; shape: Polygon | MultiPolygon }>((f) => {
      if (
        f.geometry.type === 'Polygon' &&
        f.properties.class.startsWith('building') &&
        (f.properties.height ?? 0) > 0
      )
        return [{ id: f.properties.id, shape: f.geometry }];
      if (f.geometry.type === 'LineString' && f.properties.class.startsWith('road'))
        return [
          {
            id: f.properties.id,
            shape: seatingFootprint(
              f.geometry.coordinates as LngLat[],
              clearanceWidth(f.properties),
            ),
          },
        ];
      return [];
    });
    const violations: string[] = [];
    for (const [i, tree] of pack.trees.entries())
      for (const o of obstacles)
        if (inside(tree.at, o.shape)) violations.push(`tree ${i + 1} / ${o.id}`);
    expect(violations).toEqual([]);
    for (const [i, bed] of pack.areas.entries())
      for (const o of obstacles)
        expect(
          intersection([bed.ring], o.shape.coordinates as LngLat[][] | LngLat[][][]),
          `bed ${i + 1} / ${o.id}`,
        ).toEqual([]);
  });

  it('records the supplied references without inventing dates or surveyed dimensions', () => {
    expect(pack.status).toBe('draft');
    expect(pack.sources.some((s) => s.title.includes('Street View'))).toBe(true);
    expect(pack.sources.some((s) => s.note?.includes('imagery/capture date unknown'))).toBe(true);
    expect(pack.sources.some((s) => s.note?.includes('not surveyed'))).toBe(true);
    expect(pack.sources.some((s) => s.note?.includes('No satellite or Google Maps'))).toBe(false);
  });
});
