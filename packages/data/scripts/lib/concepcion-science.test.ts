import { readFileSync } from 'node:fs';
import { Landcover, SiteDetail, type LngLat } from '@atlas/shared';
import { describe, expect, it } from 'vitest';
import type { LineString } from 'geojson';
import { intersection } from 'polyclip-ts';
import type { AtlasFeature } from '../03-normalize';
import { seatingFootprint } from './site-detail';

// Declare disk-read content dependencies so targeted runs include this test on pack edits.
import.meta.glob(
  '../../../content/cities/naga/{details,landcover}/{immaculate-conception-parish,naga-city-science-high-school}.json',
);
import.meta.glob('../../../content/cities/naga/landcover/balatas-road.json');

const root = new URL('../../../content/cities/naga/', import.meta.url);
const read = (path: string): unknown => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const source = JSON.parse(
  readFileSync(new URL('../__fixtures__/concepcion-science-parents.json', import.meta.url), 'utf8'),
) as AtlasFeature[];

describe('Concepcion church, Science High School and Balatas landscaping', () => {
  it('keeps the two parking spaces clear of standing roofs and full-width roads', () => {
    for (const slug of ['immaculate-conception-parish', 'naga-city-science-high-school']) {
      const cover = Landcover.parse(read(`landcover/${slug}.json`));
      const parking = cover.areas.filter((area) => area.cover === 'parking');
      expect(parking).toHaveLength(2);
      const obstacles = source.flatMap((f) =>
        f.geometry.type === 'Polygon' &&
        f.properties.class.startsWith('building') &&
        (f.properties.height ?? 0) > 0
          ? [f.geometry.coordinates as LngLat[][]]
          : f.geometry.type === 'LineString' && f.properties.class.startsWith('road')
            ? (seatingFootprint(f.geometry.coordinates as LngLat[], f.properties.width ?? 6)
                .coordinates as LngLat[][][])
            : [],
      );
      for (const area of parking)
        for (const obstacle of obstacles)
          expect(intersection([area.ring], obstacle), slug).toEqual([]);
      expect(cover.areas.some((area) => area.cover === 'grass')).toBe(true);
      expect(cover.areas.some((area) => area.cover === 'planting')).toBe(true);
      const detail = SiteDetail.parse(read(`details/${slug}.json`));
      expect(detail.walks.length).toBeGreaterThan(0);
      expect(detail.structures.every((part) => part.ground_override)).toBe(true);
    }
  });

  it('leaves spaced smaller crowns on both Balatas verges from Magsaysay to the Basilica', () => {
    const cover = Landcover.parse(read('landcover/balatas-road.json'));
    const road = source.find((f) => f.properties.id === 'osm:way/23521696')!;
    const line = (road.geometry as LineString).coordinates as LngLat[];
    const end = line.findIndex((p) => p[0] === 123.2000138 && p[1] === 13.6334885);
    const section = line.slice(end).reverse();
    const origin = section[0]!;
    const scale = 111320 * Math.cos((origin[1] * Math.PI) / 180);
    const local = (p: LngLat): LngLat => [(p[0] - origin[0]) * scale, (p[1] - origin[1]) * 111320];
    const segments = section.slice(1).map((p, i) => [local(section[i]!), local(p)] as const);
    const sides = new Set<number>();
    const rows = new Map<number, LngLat[]>();
    expect(cover.trees.length).toBeLessThanOrEqual(20);
    expect(cover.trees.length).toBeGreaterThanOrEqual(16);
    for (const tree of cover.trees) {
      const p = local(tree.at);
      const nearest = segments
        .map(([a, b]) => {
          const dx = b[0] - a[0],
            dy = b[1] - a[1];
          const t = Math.max(
            0,
            Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)),
          );
          const distance = Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
          return { distance, side: Math.sign(dx * (p[1] - a[1]) - dy * (p[0] - a[0])) };
        })
        .sort((a, b) => a.distance - b.distance)[0]!;
      sides.add(nearest.side);
      const row = rows.get(nearest.side) ?? [];
      row.push(p);
      rows.set(nearest.side, row);
      expect(nearest.distance).toBeGreaterThan((road.properties.width ?? 6) / 2);
      expect(nearest.distance).toBeLessThanOrEqual(8.6);
      expect(tree.crown_m).toBeGreaterThanOrEqual(11);
      expect(tree.crown_m).toBeLessThanOrEqual(14);
      expect(tree.height_m).toBe(8);
    }
    expect([...sides].sort()).toEqual([-1, 1]);
    for (const row of rows.values()) {
      expect(row.length).toBeGreaterThanOrEqual(7);
      for (const [i, tree] of row.entries())
        for (const other of row.slice(i + 1))
          expect(Math.hypot(tree[0] - other[0], tree[1] - other[1])).toBeGreaterThan(36);
    }
  });
});
