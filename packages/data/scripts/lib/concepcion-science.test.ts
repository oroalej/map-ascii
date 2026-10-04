import { Landcover, SiteDetail, type LngLat, type BBox } from '@atlas/shared';
import bbox from '@turf/bbox';
import { describe, expect, it } from 'vitest';
import type { LineString } from 'geojson';
import type { AtlasFeature } from '../03-normalize';
import {
  clearanceAssertions,
  mappedFootprints,
  readFixture,
  readPack,
} from './landmark-detail.geometry';
import { clearanceWidth, localFrame } from './geo';

// Declare disk-read content dependencies so targeted runs include this test on pack edits.
import.meta.glob(
  '../../../content/cities/naga/{details,landcover}/{immaculate-conception-parish,naga-city-science-high-school}.json',
);
import.meta.glob('../../../content/cities/naga/landcover/balatas-road.json');

const source = readFixture('concepcion-science-parents.json') as AtlasFeature[];

describe('Concepcion church, Science High School and Balatas landscaping', () => {
  it('keeps the two parking spaces clear of standing roofs and full-width roads', () => {
    const sites = ['immaculate-conception-parish', 'naga-city-science-high-school'].map((slug) => ({
      slug,
      cover: Landcover.parse(readPack('landcover', slug)),
    }));
    const shapes = sites.flatMap(({ cover }) =>
      cover.areas
        .filter((a) => a.cover === 'parking')
        .map((area) => ({ type: 'Polygon' as const, coordinates: [area.ring] })),
    );
    const bounds = bbox({ type: 'GeometryCollection', geometries: shapes }) as BBox;
    const obstacles = mappedFootprints(source, { paths: false, bounds });
    const audit = clearanceAssertions(shapes[0]!);
    for (const { slug, cover } of sites) {
      const parking = cover.areas.filter((area) => area.cover === 'parking');
      expect(parking).toHaveLength(2);
      for (const area of parking)
        audit.clear({ type: 'Polygon', coordinates: [area.ring] }, obstacles, slug);
      expect(cover.areas.some((area) => area.cover === 'grass')).toBe(true);
      expect(cover.areas.some((area) => area.cover === 'planting')).toBe(true);
      const detail = SiteDetail.parse(readPack('details', slug));
      expect(detail.walks.length).toBeGreaterThan(0);
      expect(detail.structures.every((part) => part.ground_override)).toBe(true);
    }
  });

  it('leaves spaced smaller crowns on both Balatas verges from Magsaysay to the Basilica', () => {
    const cover = Landcover.parse(readPack('landcover', 'balatas-road'));
    const road = source.find((f) => f.properties.id === 'osm:way/23521696')!;
    const line = (road.geometry as LineString).coordinates as LngLat[];
    const end = line.findIndex((p) => p[0] === 123.2000138 && p[1] === 13.6334885);
    const section = line.slice(end).reverse();
    const origin = section[0]!;
    const local = localFrame(origin).toMeters;
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
      expect(nearest.distance).toBeGreaterThan(clearanceWidth(road.properties) / 2);
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
