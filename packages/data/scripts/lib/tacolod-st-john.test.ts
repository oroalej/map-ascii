import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Polygon } from 'geojson';
import bbox from '@turf/bbox';
import { City, type BBox, type LngLat } from '@atlas/shared';
import { bboxesOverlap, bufferBbox, localFrame } from './geo';
import { covers, details, source, areaFor } from './landmark-detail.fixtures';
import { clearanceAssertions, mappedFootprints, distanceMeters } from './landmark-detail.geometry';
import { landcoverFeatures } from './landcover';
import { mergeSiteDetails, seatingFootprint } from './site-detail';

const sites = [
  ['tacolod-elementary-school-annex', 'osm:way/880725922'],
  ['tacolod-elementary-school-main', 'osm:way/880722105'],
] as const;

import.meta.glob('../../../content/cities/naga/city.json');

describe('Tacolod school grounds', () => {
  it('includes both complete school grounds within the configured map region', () => {
    const city = City.parse(
      JSON.parse(
        readFileSync(new URL('../../../content/cities/naga/city.json', import.meta.url), 'utf8'),
      ),
    );
    if (!('bbox' in city.region)) throw Error('expected the Naga region bbox');
    for (const [slug] of sites) {
      const detail = details.find((d) => d.id === `detail/${slug}`)!;
      const [west, south, east, north] = bbox(areaFor(detail));
      expect(west).toBeGreaterThanOrEqual(city.region.bbox[0]);
      expect(south).toBeGreaterThanOrEqual(city.region.bbox[1]);
      expect(east).toBeLessThanOrEqual(city.region.bbox[2]);
      expect(north).toBeLessThanOrEqual(city.region.bbox[3]);
    }
  });
  for (const [slug, parentId] of sites) {
    const detail = details.find((d) => d.id === `detail/${slug}`)!;
    const cover = covers.find((c) => c.id === `landcover/${slug}`)!;
    const audit = clearanceAssertions(areaFor(detail));
    const bounds = bufferBbox(bbox(areaFor(detail)) as BBox, 0.015);
    const input = source.filter((f) => bboxesOverlap(bounds, bbox(f) as BBox));
    const paths = detail.walks.map((w) => seatingFootprint(w.line, w.width_m));
    const obstacles = mappedFootprints(input, {
      water: true,
      bounds: bbox(areaFor(detail)) as BBox,
    });

    it(`${slug}: keeps full planting and crowns clear of roofs, roads and walks`, () => {
      expect(cover.trees.length).toBeGreaterThanOrEqual(3);
      expect(new Set(cover.areas.map((p) => p.cover))).toEqual(
        new Set(['grass', 'planting', 'shrubs']),
      );
      for (const patch of cover.areas) {
        const shape: Polygon = { type: 'Polygon', coordinates: [patch.ring] };
        expect(audit.contains(shape), patch.cover).toBe(true);
        audit.clear(shape, [...obstacles, ...paths], patch.cover);
      }
      for (const tree of cover.trees) {
        const frame = localFrame(tree.at);
        const radius = tree.crown_m! / 2;
        const ring: LngLat[] = Array.from({ length: 32 }, (_, i) => {
          const angle = (i * 2 * Math.PI) / 32;
          return frame.toLngLat([radius * Math.cos(angle), radius * Math.sin(angle)]);
        });
        ring.push(ring[0]!);
        const shape: Polygon = { type: 'Polygon', coordinates: [ring] };
        expect(audit.contains(shape), 'full crown inside grounds').toBe(true);
        audit.clear(shape, [...obstacles, ...paths], 'tree crown');
        for (const other of cover.trees) {
          if (other === tree) continue;
          expect(distanceMeters(tree.at, other.at)).toBeGreaterThanOrEqual(
            (tree.crown_m! + other.crown_m!) / 2,
          );
        }
      }
    });

    it(`${slug}: connects all walking routes through visible paving and retains selection`, () => {
      const reached = new Set([0]);
      for (let previous = -1; previous !== reached.size;) {
        previous = reached.size;
        paths.forEach((path, index) => {
          if ([...reached].some((known) => audit.overlaps(path, paths[known]!))) reached.add(index);
        });
      }
      expect(reached.size).toBe(paths.length);
      const addedCover = landcoverFeatures(input, [cover]);
      expect(addedCover.warnings).toEqual([]);
      const before = structuredClone(input);
      const result = mergeSiteDetails(
        [...structuredClone(input), ...addedCover.features],
        [detail],
      );
      expect(result.warnings).toEqual([]);
      for (const original of before)
        expect(
          result.features.find((f) => f.properties.id === original.properties.id)?.geometry,
        ).toEqual(original.geometry);
      const paving = result.features.filter((f) =>
        f.properties.id.startsWith(`detail:${slug}/structure-`),
      );
      expect(paving.length).toBeGreaterThan(0);
      expect(
        paving.every(
          (f) => f.properties.class === 'paving' && f.properties.detail_parent === parentId,
        ),
      ).toBe(true);
      const surfaces = paving.map((f) => f.geometry as Polygon);
      for (const path of paths) {
        expect(audit.contains(path)).toBe(true);
        audit.clear(path, obstacles, 'full path width and ends');
        expect(clearanceAssertions(audit.union(surfaces)).contains(path)).toBe(true);
      }
      for (const f of addedCover.features) {
        const merged = result.features.find(
          (candidate) => candidate.properties.id === f.properties.id,
        )!;
        expect(merged).toEqual(f);
      }
      expect(detail.status).toBe('draft');
      expect(cover.status).toBe('draft');
    });
  }

  it('leaves the Main school reference-visible central covered area free of new detail', () => {
    const detail = details.find((d) => d.id === 'detail/tacolod-elementary-school-main')!;
    const cover = covers.find((c) => c.id === 'landcover/tacolod-elementary-school-main')!;
    // A conservative reserved envelope, rather than an invented standing roof.
    const angle = (29 * Math.PI) / 180;
    const frame = localFrame([123.17022, 13.6315]);
    const at = ([x, y]: LngLat): LngLat =>
      frame.toLngLat([
        x * Math.cos(angle) - y * Math.sin(angle),
        x * Math.sin(angle) + y * Math.cos(angle),
      ]);
    const canopy: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [3, -6],
          [23, -6],
          [23, 10],
          [3, 10],
          [3, -6],
        ].map((p) => at(p as LngLat)),
      ],
    };
    const audit = clearanceAssertions(areaFor(detail));
    for (const part of detail.structures)
      expect(
        audit.overlaps(canopy, {
          type: 'Polygon',
          coordinates: [part.ring, ...(part.holes ?? [])],
        }),
      ).toBe(false);
    for (const patch of cover.areas)
      expect(audit.overlaps(canopy, { type: 'Polygon', coordinates: [patch.ring] })).toBe(false);
    expect(detail.building_overrides).toEqual([]);
    expect(detail.roof_overrides).toEqual([]);
  });
});
