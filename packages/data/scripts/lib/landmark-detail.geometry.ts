import type { LngLat } from '@atlas/shared';
import inside from '@turf/boolean-point-in-polygon';
import bbox from '@turf/bbox';
import type { Polygon, MultiPolygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import type { AtlasFeature } from '../03-normalize';
import { bboxesOverlap } from './geo';
import { geometryAudit } from './geometry-audit';
import { mergeSiteDetails, seatingFootprint } from './site-detail';
import { covers, source, areaFor, newDetails, nearby } from './landmark-detail.fixtures';

/** Register each site's unchanged geometry assertions in exactly one deterministic shard. */
export function geometrySuite(shard: number, of: number) {
  // The source roads are immutable; reuse their exact footprints across ground-surface checks.
  const roadFootprints = new Map<AtlasFeature, MultiPolygon>();
  const roadFootprint = (feature: AtlasFeature) => {
    let shape = roadFootprints.get(feature);
    if (!shape) {
      if (feature.geometry.type !== 'LineString') throw Error('expected a mapped road');
      shape = seatingFootprint(
        feature.geometry.coordinates as LngLat[],
        feature.properties.width ?? 6,
      );
      roadFootprints.set(feature, shape);
    }
    return shape;
  };
  const selected = [...newDetails]
    .sort((a, b) => a.id.localeCompare(b.id))
    .filter((_, index) => index % of === shard - 1);
  describe('new landmark detail geometry (offline)', () => {
    for (const detail of selected) {
      const area = areaFor(detail);
      const siteBounds = bbox(area) as [number, number, number, number];
      const audit = geometryAudit(area);
      // Keep complete nearby features, including adjacent selection targets and crowns.
      // Growing city fixtures should not make each site merge unrelated distant content.
      const margin = 15 / 111320;
      const longitudeMargin = margin / Math.cos(((siteBounds[1] + siteBounds[3]) * Math.PI) / 360);
      const neighborhood: [number, number, number, number] = [
        siteBounds[0] - longitudeMargin,
        siteBounds[1] - margin,
        siteBounds[2] + longitudeMargin,
        siteBounds[3] + margin,
      ];
      const input = nearby(neighborhood);
      let result: ReturnType<typeof mergeSiteDetails> | undefined;
      const merged = () => (result ??= mergeSiteDetails(input, [detail]));
      it(`${detail.id}: merges and preserves canonical selection`, () => {
        expect(merged().warnings, detail.id).toEqual([]);
        const target = detail.selection_osm_id ?? detail.osm_id;
        for (const f of merged().features.filter(
          (f) =>
            f.properties.detail_parent &&
            f.properties.id.startsWith(`detail:${detail.id.slice(7)}/`),
        ))
          expect(f.properties.detail_parent).toBe(target);
      });
      it(`${detail.id}: contains full walks and seats and clears standing structures`, () => {
        const obstacles = merged().features.filter(
          (f) =>
            (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon') &&
            !f.properties.detail_overhead &&
            (f.properties.detail_blocked ||
              f.properties.class === 'building_part' ||
              (f.properties.class.startsWith('building') && (f.properties.height ?? 0) > 0)) &&
            bboxesOverlap(siteBounds, bbox(f) as [number, number, number, number]),
        );
        const check = (shape: MultiPolygon, id: string, ownSeat = false) => {
          expect(audit.contains(shape), id).toBe(true);
          for (const obstacle of obstacles) {
            if (
              ownSeat &&
              obstacle.properties.id.startsWith(`detail:${detail.id.slice(7)}/seating-`)
            )
              continue;
            expect(
              audit.overlaps(shape, obstacle.geometry as Polygon | MultiPolygon),
              `${id} / ${obstacle.properties.id}`,
            ).toBe(false);
          }
        };
        for (const walk of detail.walks) check(seatingFootprint(walk.line, walk.width_m), walk.id);
        for (const seat of detail.seating)
          check(seatingFootprint(seat.line, seat.width_m, seat.bench_spans), seat.id, true);
      });
      it(`${detail.id}: preserves mapped carriageways and contains landcover`, () => {
        for (const part of detail.structures.filter((part) => part.ground_override)) {
          const shape: MultiPolygon = {
            type: 'MultiPolygon',
            coordinates: [[part.ring, ...(part.holes ?? [])]],
          };
          // Benches can stand on paving; standing footprints and carriageways cannot be erased.
          for (const f of source) {
            if (!bboxesOverlap(siteBounds, bbox(f) as [number, number, number, number])) continue;
            const obstacle =
              f.geometry.type === 'Polygon' &&
              f.properties.class.startsWith('building') &&
              (f.properties.height ?? 0) > 0
                ? f.geometry
                : f.geometry.type === 'LineString' && f.properties.class.startsWith('road')
                  ? roadFootprint(f)
                  : undefined;
            if (obstacle)
              expect(audit.overlaps(shape, obstacle), `${part.id} / ${f.properties.id}`).toBe(
                false,
              );
          }
        }
        const cover = covers.find((c) => c.id === `landcover/${detail.id.slice(7)}`);
        // Existing Cathedral landcover includes unchanged frontage beyond its OSM grounds.
        // USI's new content must fit its explicit visual envelope; adjoining crowns are separate.
        if (cover && cover.id !== 'landcover/cathedral-grounds') {
          for (const tree of cover.trees) expect(inside(tree.at, area), cover.id).toBe(true);
          for (const row of cover.rows)
            for (const p of row.line) expect(inside(p, area), cover.id).toBe(true);
          for (const patch of cover.areas)
            expect(audit.contains({ type: 'Polygon', coordinates: [patch.ring] }), cover.id).toBe(
              true,
            );
        }
      });
    }
  });
}
