import {
  distanceMeters as distance,
  readFixture,
  readPack,
  mappedFootprints,
  pointObstacles,
  assertPointClear,
} from './landmark-detail.geometry';
import { Landcover, type LngLat } from '@atlas/shared';
import inside from '@turf/boolean-point-in-polygon';
import bbox from '@turf/bbox';
import type { Polygon } from 'geojson';
import { intersection } from 'polyclip-ts';
import { describe, expect, it } from 'vitest';
import type { AtlasFeature } from '../03-normalize';
import { landcoverFeatures, SAME_TREE_M } from './landcover';
import { localFrame } from './geo';

// Declare disk-read content dependencies so targeted runs include this test on pack edits.
import.meta.glob(
  '../../../content/cities/naga/landcover/{ateneo-de-naga-university,ateneo-frontage}.json',
);

const packs = ['ateneo-de-naga-university', 'ateneo-frontage'].map((slug) =>
  Landcover.parse(readPack('landcover', slug)),
);
const source = readFixture('landmark-parents.json') as AtlasFeature[];
// Independently traced foliage masks, not circles derived from authored tree positions.
// The gitignored handoff retains the owner image and its OSM registration evidence.
const reference = readFixture('ateneo-vegetation.json') as {
  groups: { id: string; rings: LngLat[][] }[];
  open_ground: { id: string; ring: LngLat[] }[];
};
const campus = source.find((f) => f.properties.id === 'osm:way/222268858')!.geometry as Polygon;
const osmTrees = source.filter(
  (f) =>
    f.properties.class === 'tree' &&
    f.geometry.type === 'Point' &&
    inside(f.geometry.coordinates, campus),
);
const merged = landcoverFeatures(source, packs);
const trees = [...osmTrees, ...merged.features.filter((f) => f.properties.class === 'tree')];
const project = localFrame([123.1845, 13.631]).toMeters;

const crowns = trees.map((f) => {
  if (f.geometry.type !== 'Point') throw Error('expected individual tree points');
  return { at: project(f.geometry.coordinates), radius: f.properties.crown! / 2 };
});
const patches = packs
  .flatMap((p) => p.areas)
  .filter((p) => ['woods', 'shrubs', 'planting'].includes(p.cover))
  .map((p) => ({
    type: 'Polygon' as const,
    coordinates: [p.ring.map(project)],
  }));

describe('Ateneo owner-reference vegetation coverage', () => {
  it('keeps every circled group and the existing sparse central groves in the reference fixture', () => {
    expect(reference.groups.map((g) => g.id)).toEqual([
      'soccer-north',
      'soccer-east',
      'covered-courts-south',
      'alingal-manresa-courtyard',
      'bonoan-burns-grove',
      'madrigal-grove',
      'western-boundary',
      'ignatius-southwest',
      'ignatius-south-edge',
      'adriatico-south',
      'entrepreneur-corner',
      'dolan-junction',
      'pedro-santos-west',
      'pedro-santos-east',
      'chapel-frontage',
      'xavier-grounds',
      'phelan-south',
      'ignatius-north-groves',
      'main-entrance-north',
      'main-entrance-south',
    ]);
  });

  for (const group of reference.groups) {
    it(`${group.id}: covers at least 70% of independently traced visible foliage`, () => {
      const shapes = group.rings.map((r) => ({
        type: 'Polygon' as const,
        coordinates: [r.map(project)],
      }));
      for (const [component, shape] of shapes.entries()) {
        const points = shape.coordinates[0]!;
        const xs = points.map((p) => p[0]);
        const ys = points.map((p) => p[1]);
        let sampled = 0;
        let covered = 0;
        // Half-metre sampling also exercises narrow beds and the two small corner clumps.
        for (let x = Math.min(...xs) + 0.25; x < Math.max(...xs); x += 0.5) {
          for (let y = Math.min(...ys) + 0.25; y < Math.max(...ys); y += 0.5) {
            if (!inside([x, y], shape)) continue;
            sampled++;
            if (
              crowns.some((c) => Math.hypot(x - c.at[0], y - c.at[1]) <= c.radius) ||
              patches.some((p) => inside([x, y], p))
            )
              covered++;
          }
        }
        expect(sampled, 'nonempty independent foliage mask').toBeGreaterThan(0);
        expect(
          covered / sampled,
          `component ${component + 1}: ${covered}/${sampled} samples covered`,
        ).toBeGreaterThanOrEqual(0.7);
      }
    });
  }

  it('preserves ten OSM trees and adds no duplicate trunks across either pack', () => {
    expect(osmTrees).toHaveLength(10);
    expect(merged.warnings).toEqual([]);
    const added = packs.flatMap((p) => p.trees);
    const areas = packs.flatMap((p) => p.areas);
    expect(new Set(areas.map((a) => JSON.stringify(a.ring))).size).toBe(areas.length);
    expect(merged.features.filter((f) => f.properties.class === 'tree')).toHaveLength(added.length);
    for (let i = 0; i < added.length; i++) {
      for (const f of osmTrees) {
        if (f.geometry.type !== 'Point') throw Error('expected mapped tree point');
        expect(distance(added[i]!.at, f.geometry.coordinates as LngLat)).toBeGreaterThan(
          SAME_TREE_M,
        );
      }
      for (let j = i + 1; j < added.length; j++)
        expect(distance(added[i]!.at, added[j]!.at)).toBeGreaterThan(SAME_TREE_M);
    }
    // Landcover merge is additive: mapped facilities, ground surfaces and existing tree
    // geometry remain source records rather than being overwritten by authored vegetation.
    const input = structuredClone(source);
    landcoverFeatures(input, packs);
    expect(input).toEqual(source);
  });

  it('contains campus trunks and separates adjoining vegetation without expanding campus ownership', () => {
    for (const tree of packs[0]!.trees) expect(inside(tree.at, campus)).toBe(true);
    for (const tree of packs[1]!.trees) {
      expect(inside(tree.at, campus)).toBe(false);
      // Independently traced source foliage also bounds the separate frontage pack.
      expect(
        reference.groups.some((g) =>
          g.rings.some((ring) => inside(tree.at, { type: 'Polygon', coordinates: [ring] })),
        ),
      ).toBe(true);
    }
    expect(packs[1]!.trees.length).toBeGreaterThan(0);
  });

  it('keeps the soccer field and central lawn interiors open', () => {
    for (const area of reference.open_ground) {
      const shape: Polygon = { type: 'Polygon', coordinates: [area.ring] };
      expect(
        packs.flatMap((p) => p.trees).filter((t) => inside(t.at, shape)),
        area.id,
      ).toEqual([]);
    }
  });

  it('keeps trunks outside standing buildings and full-width carriageways, allowing crown overhang', () => {
    const siteBounds = bbox(campus) as [number, number, number, number];
    const points = pointObstacles(source, { paths: false });
    const bounded = mappedFootprints(source, { paths: false, bounds: siteBounds });
    for (const pack of packs)
      for (const [i, tree] of pack.trees.entries())
        assertPointClear(tree.at, points, `${pack.id} tree ${i + 1}`);
    for (const area of packs.flatMap((p) => p.areas).filter((a) => a.cover === 'shrubs'))
      for (const obstacle of bounded)
        expect(
          intersection([area.ring], obstacle.coordinates as LngLat[][] | LngLat[][][]),
          'entrance bed',
        ).toEqual([]);
  });
});
