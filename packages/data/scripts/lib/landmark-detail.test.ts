import { readFileSync, readdirSync } from 'node:fs';
import {
  CLASS_ZOOM,
  SiteDetail,
  Landcover,
  LandmarkPlan,
  Landmark,
  type AtlasClass,
  type LngLat,
} from '@atlas/shared';
import inside from '@turf/boolean-point-in-polygon';
import bbox from '@turf/bbox';
import { difference, intersection } from 'polyclip-ts';
import type { Polygon, MultiPolygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import type { AtlasFeature } from '../03-normalize';
import { mergeContent } from '../04-merge-content';
import type { ContentBundle } from '@atlas/content';
import { bboxesOverlap } from './geo';
import { planParts } from './plan';
import { landcoverFeatures } from './landcover';
import { mergeSiteDetails, seatingFootprint } from './site-detail';

const root = new URL('../../../content/cities/naga/', import.meta.url);
const readCollection = (folder: string): unknown[] =>
  readdirSync(new URL(folder, root))
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(new URL(`${folder}/${name}`, root), 'utf8')) as unknown);
const details = readCollection('details').map((data) => SiteDetail.parse(data));
const covers = readCollection('landcover').map((data) => Landcover.parse(data));
const plans = readCollection('plans').map((data) => LandmarkPlan.parse(data));
const landmarks = readCollection('landmarks').map((data) => Landmark.parse(data));
const source = JSON.parse(
  readFileSync(new URL('../__fixtures__/landmark-parents.json', import.meta.url), 'utf8'),
) as AtlasFeature[];
mergeContent(source, { landmarks } as ContentBundle);
const areaFor = (detail: SiteDetail): Polygon | MultiPolygon => {
  if (detail.grounds) return { type: 'Polygon', coordinates: [detail.grounds] };
  const geometry = source.find((f) => f.properties.id === detail.osm_id)?.geometry;
  if (geometry?.type !== 'Polygon' && geometry?.type !== 'MultiPolygon')
    throw Error(`missing area fixture: ${detail.id}`);
  return geometry;
};
const coordinates = (geometry: Polygon | MultiPolygon) =>
  geometry.coordinates as LngLat[][] | LngLat[][][];
const newDetails = details.filter(
  (d) => !['detail/plaza-rizal', 'detail/plaza-quince-martires'].includes(d.id),
);

describe('landmark detail tier coverage (fast)', () => {
  it('covers three rendered tiers, including Place furniture, for every pack', () => {
    expect(newDetails).toHaveLength(13);
    for (const detail of details) {
      const tiers = new Set<number>();
      const add = (cls: AtlasClass) => tiers.add(CLASS_ZOOM[cls].min);
      if (detail.surface === 'paving') add('paving');
      for (const part of detail.structures)
        add(
          part.material === 'paving'
            ? 'paving'
            : part.material === 'wood'
              ? 'building_woodwork'
              : 'building_part',
        );
      if (detail.seating.length) add('seating');
      if (detail.lamps.length || detail.flagpoles.length) add('furniture');
      const cover = covers.find((c) => c.id === `landcover/${detail.id.slice(7)}`);
      if (cover?.trees.length || cover?.rows.length) add('tree');
      for (const area of cover?.areas ?? []) add(area.cover === 'woods' ? 'trees' : area.cover);
      if (
        plans.some((p) => {
          const target = source.find((f) => f.properties.id === p.osm_id);
          if (!target) return false;
          return target.geometry.type === 'Point'
            ? inside(target.geometry.coordinates, areaFor(detail))
            : p.osm_id === detail.osm_id ||
                p.osm_id === detail.selection_osm_id ||
                (target.geometry.type === 'Polygon' &&
                  inside(target.geometry.coordinates[0]![0]!, areaFor(detail)));
        })
      )
        add('building_part');
      const site = areaFor(detail);
      const siteBounds = bbox(site) as [number, number, number, number];
      for (const f of source) {
        if (f.geometry.type === 'Point' && inside(f.geometry.coordinates, site))
          add(f.properties.class);
        // Kept sites can retain mapped lawns or parking instead of inventing a new surface.
        if (
          ['grass', 'park', 'parking', 'pitch', 'trees'].includes(f.properties.class) &&
          (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon') &&
          bboxesOverlap(siteBounds, bbox(f) as [number, number, number, number]) &&
          intersection(coordinates(site), coordinates(f.geometry)).length
        )
          add(f.properties.class);
      }
      const covered = [...tiers].filter((tier) => [12.5, 16, 17, 18, 19].includes(tier));
      expect(covered.length, detail.id).toBeGreaterThanOrEqual(3);
      expect(tiers.has(18), detail.id).toBe(true);
      expect(detail.status, detail.id).toBe('draft');
      expect(detail.credit, detail.id).not.toBe('');
      expect(
        detail.sources.some((s) => s.url?.startsWith('https://www.openstreetmap.org/')),
        detail.id,
      ).toBe(true);
    }
  });
});

describe('new landmark detail geometry (offline)', () => {
  const input = [
    ...source,
    ...planParts(source, plans).parts,
    ...landcoverFeatures(source, covers).features,
  ];
  for (const detail of newDetails) {
    it(`${detail.id}: contains full footprints and clears standing structures`, () => {
      const area = areaFor(detail);
      const siteBounds = bbox(area) as [number, number, number, number];
      const result = mergeSiteDetails(input, [detail]);
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
        expect(difference(coordinates(shape), coordinates(area)), id).toEqual([]);
        for (const obstacle of obstacles) {
          if (ownSeat && obstacle.properties.id.startsWith(`detail:${detail.id.slice(7)}/seating-`))
            continue;
          expect(
            intersection(
              coordinates(shape),
              coordinates(obstacle.geometry as Polygon | MultiPolygon),
            ),
            `${id} / ${obstacle.properties.id}`,
          ).toEqual([]);
        }
      };
      for (const walk of detail.walks) check(seatingFootprint(walk.line, walk.width_m), walk.id);
      for (const seat of detail.seating)
        check(seatingFootprint(seat.line, seat.width_m, seat.bench_spans), seat.id, true);
      for (const part of detail.structures.filter((part) => part.ground_override)) {
        const shape: MultiPolygon = { type: 'MultiPolygon', coordinates: [[part.ring]] };
        // Benches can stand on paving; standing footprints and carriageways cannot be erased.
        for (const f of source) {
          if (!bboxesOverlap(siteBounds, bbox(f) as [number, number, number, number])) continue;
          const obstacle =
            f.geometry.type === 'Polygon' &&
            f.properties.class.startsWith('building') &&
            (f.properties.height ?? 0) > 0
              ? f.geometry
              : f.geometry.type === 'LineString' && f.properties.class.startsWith('road')
                ? seatingFootprint(f.geometry.coordinates as LngLat[], f.properties.width ?? 6)
                : undefined;
          if (obstacle)
            expect(
              intersection(coordinates(shape), coordinates(obstacle)),
              `${part.id} / ${f.properties.id}`,
            ).toEqual([]);
        }
      }
      const cover = covers.find((c) => c.id === `landcover/${detail.id.slice(7)}`);
      // Existing Cathedral/USI landcover includes frontage beyond the OSM grounds. It is
      // unchanged here; only new landcover must satisfy this stricter site containment check.
      if (
        cover &&
        !['landcover/cathedral-grounds', 'landcover/universidad-de-santa-isabel'].includes(cover.id)
      ) {
        for (const tree of cover.trees) expect(inside(tree.at, area), cover.id).toBe(true);
        for (const row of cover.rows)
          for (const p of row.line) expect(inside(p, area), cover.id).toBe(true);
        for (const patch of cover.areas)
          expect(difference([patch.ring], coordinates(area)), cover.id).toEqual([]);
      }
      const target = detail.selection_osm_id ?? detail.osm_id;
      for (const f of result.features.filter(
        (f) =>
          f.properties.detail_parent && f.properties.id.startsWith(`detail:${detail.id.slice(7)}/`),
      ))
        expect(f.properties.detail_parent).toBe(target);
    }, 10000);
  }
});

describe('source-backed landmark facilities', () => {
  it('retains the mapped Civic Center pool water while placing the rim and deck outside it', () => {
    const detail = details.find((d) => d.id === 'detail/naga-city-civic-center')!;
    const pool = source.find((f) => f.properties.id === 'osm:way/222976574')!;
    expect(pool.properties.class).toBe('water_area');
    if (pool.geometry.type !== 'Polygon') throw Error('expected the mapped pool polygon');
    expect(difference(coordinates(pool.geometry), coordinates(areaFor(detail)))).toEqual([]);
    const rim = detail.structures.filter((s) => s.id.startsWith('pool-rim-'));
    const deck = detail.structures.filter((s) => s.id.startsWith('pool-deck-'));
    expect(rim.length).toBeGreaterThan(0);
    expect(deck.length).toBeGreaterThan(0);
    for (const part of [...rim, ...deck])
      expect(intersection([part.ring], coordinates(pool.geometry)), part.id).toEqual([]);
    for (const part of deck) expect(part.ground_override, part.id).toBe(true);
    const result = mergeSiteDetails(source, [detail]);
    expect(result.features.find((f) => f.properties.id === pool.properties.id)).toEqual(pool);
    for (const part of result.features.filter((f) => f.properties.id.includes('/structure-pool-')))
      expect(part.properties.detail_parent).toBe(detail.osm_id);
  });

  it('fits the three Porta Mariae openings to its mapped footprint and retains the distinct arch', () => {
    const detail = details.find((d) => d.id === 'detail/cathedral-grounds')!;
    const gate = source.find((f) => f.properties.id === 'osm:way/358807129')!.geometry as Polygon;
    const piers = detail.structures.filter((s) => s.id.startsWith('porta-pier-'));
    expect(piers).toHaveLength(4);
    for (const part of [...piers, detail.structures.find((s) => s.id === 'porta-span')!])
      expect(difference([part.ring], coordinates(gate)), part.id).toEqual([]);
    for (let i = 0; i < piers.length - 1; i++)
      expect(intersection([piers[i]!.ring], [piers[i + 1]!.ring])).toEqual([]);
    const result = mergeSiteDetails(source, [detail]);
    for (const id of ['osm:way/358807129', 'osm:way/358808865'])
      expect(result.features.find((f) => f.properties.id === id)).toEqual(
        source.find((f) => f.properties.id === id),
      );
  });

  it('uses mapped perimeter routes for Ateneo canopies and preserves its mapped facilities', () => {
    const detail = details.find((d) => d.id === 'detail/ateneo-de-naga-university')!;
    const area = areaFor(detail);
    const routes = source.filter(
      (f) => f.properties.class === 'path' && f.geometry.type === 'LineString',
    );
    expect(detail.structures.every((s) => s.overhead && s.material === 'roof')).toBe(true);
    for (const part of detail.structures) {
      const route = routes.find((f) =>
        part.id.startsWith(`covered-walk-${f.properties.id.split('/')[1]}-`),
      );
      expect(route, part.id).toBeDefined();
      if (route!.geometry.type !== 'LineString') throw Error('expected a mapped footway');
      expect(
        difference(
          [part.ring],
          // Allow centimetres for curved-corner simplification and coordinate quantization.
          coordinates(seatingFootprint(route!.geometry.coordinates as LngLat[], 2.2)),
        ),
        part.id,
      ).toEqual([]);
    }
    const retained = source.filter(
      (f) =>
        (['parking', 'pitch', 'park'].includes(f.properties.class) &&
          f.geometry.type === 'Polygon' &&
          intersection(coordinates(f.geometry), coordinates(area)).length) ||
        ['osm:way/222404483', 'osm:way/222405530', 'osm:way/222405532'].includes(f.properties.id),
    );
    expect(retained.filter((f) => f.properties.class === 'parking').length).toBeGreaterThan(0);
    const result = mergeSiteDetails(source, [detail]);
    for (const f of retained)
      expect(result.features.find((v) => v.properties.id === f.properties.id)).toEqual(f);
  });
});
