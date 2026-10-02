import type { LngLat } from '@atlas/shared';
import inside from '@turf/boolean-point-in-polygon';
import bbox from '@turf/bbox';
import { difference, intersection } from 'polyclip-ts';
import type { Polygon, MultiPolygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import type { AtlasFeature } from '../03-normalize';
import { bboxesOverlap } from './geo';
import { planParts } from './plan';
import { landcoverFeatures } from './landcover';
import { mergeSiteDetails, seatingFootprint } from './site-detail';
import { covers, plans, source, areaFor, newDetails } from './landmark-detail.fixtures';

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
    const input = [
      ...source,
      ...planParts(source, plans).parts,
      ...landcoverFeatures(source, covers).features,
    ];
    for (const detail of selected) {
      // Retain the existing 10 s limit: the dense station case can exceed 5 s locally.
      it(`${detail.id}: contains full footprints and clears standing structures`, () => {
        const area = areaFor(detail);
        const siteBounds = bbox(area) as [number, number, number, number];
        const meters = 111320;
        const mx = meters * Math.cos(((siteBounds[1] + siteBounds[3]) * Math.PI) / 360);
        // Local meters avoid slow robust clipping of tiny details near longitude 123°.
        // Each shape is checked against many walks; its unchanged meter coordinates need one pass.
        const localShapes = new Map<Polygon | MultiPolygon, LngLat[][][]>();
        const local = (shape: Polygon | MultiPolygon): LngLat[][][] => {
          const cached = localShapes.get(shape);
          if (cached) return cached;
          const coordinates = (
            shape.type === 'Polygon' ? [shape.coordinates] : shape.coordinates
          ).map((p) =>
            p.map((r) =>
              r.map(([x, y]): LngLat => [
                Math.round((x! - siteBounds[0]) * mx * 1e6) / 1e6,
                Math.round((y! - siteBounds[1]) * meters * 1e6) / 1e6,
              ]),
            ),
          );
          localShapes.set(shape, coordinates);
          return coordinates;
        };
        const areaClip = local(area);
        // Keep complete nearby features, including adjacent selection targets and crowns.
        // Growing city fixtures should not make each site merge unrelated distant content.
        const margin = 15 / 111320;
        const longitudeMargin =
          margin / Math.cos(((siteBounds[1] + siteBounds[3]) * Math.PI) / 360);
        const neighborhood: [number, number, number, number] = [
          siteBounds[0] - longitudeMargin,
          siteBounds[1] - margin,
          siteBounds[2] + longitudeMargin,
          siteBounds[3] + margin,
        ];
        const result = mergeSiteDetails(
          input.filter((f) =>
            bboxesOverlap(neighborhood, bbox(f) as [number, number, number, number]),
          ),
          [detail],
        );
        expect(result.warnings, detail.id).toEqual([]);
        const obstacles = result.features.filter(
          (f) =>
            (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon') &&
            !f.properties.detail_overhead &&
            (f.properties.detail_blocked ||
              f.properties.class === 'building_part' ||
              (f.properties.class.startsWith('building') && (f.properties.height ?? 0) > 0)) &&
            bboxesOverlap(siteBounds, bbox(f) as [number, number, number, number]),
        );
        const check = (shape: MultiPolygon, id: string, ownSeat = false) => {
          expect(difference(local(shape), areaClip), id).toEqual([]);
          for (const obstacle of obstacles) {
            if (
              ownSeat &&
              obstacle.properties.id.startsWith(`detail:${detail.id.slice(7)}/seating-`)
            )
              continue;
            expect(
              intersection(local(shape), local(obstacle.geometry as Polygon | MultiPolygon)),
              `${id} / ${obstacle.properties.id}`,
            ).toEqual([]);
          }
        };
        for (const walk of detail.walks) check(seatingFootprint(walk.line, walk.width_m), walk.id);
        for (const seat of detail.seating)
          check(seatingFootprint(seat.line, seat.width_m, seat.bench_spans), seat.id, true);
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
              expect(
                intersection(local(shape), local(obstacle)),
                `${part.id} / ${f.properties.id}`,
              ).toEqual([]);
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
            expect(
              difference(local({ type: 'Polygon', coordinates: [patch.ring] }), areaClip),
              cover.id,
            ).toEqual([]);
        }
        const target = detail.selection_osm_id ?? detail.osm_id;
        for (const f of result.features.filter(
          (f) =>
            f.properties.detail_parent &&
            f.properties.id.startsWith(`detail:${detail.id.slice(7)}/`),
        ))
          expect(f.properties.detail_parent).toBe(target);
      }, 10000);
    }
  });
}
