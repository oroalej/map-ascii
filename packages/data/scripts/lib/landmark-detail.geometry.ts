import { readFileSync } from 'node:fs';
import type { BBox, LngLat, SiteDetail, Landcover } from '@atlas/shared';
import inside from '@turf/boolean-point-in-polygon';
import bbox from '@turf/bbox';
import type { Polygon, MultiPolygon, Point } from 'geojson';
import { describe, expect, it } from 'vitest';
import type { AtlasFeature } from '../03-normalize';
import { bboxesOverlap, bufferBbox, clearanceWidth, localFrame } from './geo';
import { geometryAudit } from './geometry-audit';
import { mergeSiteDetails, seatingFootprint } from './site-detail';
import type * as LandmarkFixtures from './landmark-detail.fixtures';
import { isStandingBuilding, nearbyRoadFootprints } from './obstacles';
import { applyLandcoverTreeOverrides, landcoverFeatures } from './landcover';

/** Visible inventory after OSM replaces retired curated trees. */
export function effectiveTrees(source: readonly AtlasFeature[], covers: readonly Landcover[]) {
  const mapped = applyLandcoverTreeOverrides([...source], covers);
  return [...mapped, ...landcoverFeatures(mapped, covers).features].filter(
    (feature): feature is AtlasFeature & { geometry: Point } =>
      feature.properties.class === 'tree' && feature.geometry.type === 'Point',
  );
}

type Area = Polygon | MultiPolygon;
type Fixtures = Pick<
  typeof LandmarkFixtures,
  'covers' | 'source' | 'areaFor' | 'newDetails' | 'nearby'
>;

/** Lightweight loaders retain each regression file's own explicitly declared inputs. */
export const readPack = (folder: string, slug: string): unknown =>
  JSON.parse(
    readFileSync(
      new URL(`../../../content/cities/naga/${folder}/${slug}.json`, import.meta.url),
      'utf8',
    ),
  ) as unknown;
export const readFixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../__fixtures__/${name}`, import.meta.url), 'utf8')) as unknown;
export function areaFor(detail: SiteDetail, source: readonly AtlasFeature[]): Area {
  if (detail.extent || detail.grounds)
    return { type: 'Polygon', coordinates: [detail.extent ?? detail.grounds!] };
  const geometry = source.find((feature) => feature.properties.id === detail.osm_id)?.geometry;
  if (geometry?.type !== 'Polygon' && geometry?.type !== 'MultiPolygon')
    throw Error(`missing area fixture: ${detail.id}`);
  return geometry;
}
export const coordinates = (geometry: Area) => geometry.coordinates as LngLat[][] | LngLat[][][];

export const distanceMeters = (a: readonly number[], b: readonly number[]) =>
  Math.hypot(...localFrame([a[0]!, a[1]!], (a[1]! + b[1]!) / 2).toMeters([b[0]!, b[1]!]));

/** Nearest segment distance, with the same signed side convention as the placement guards. */
export function lineDistance(at: LngLat, line: number[][], signed = false) {
  const frame = localFrame(at);
  let nearest = Infinity;
  let side = 0;
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = frame.toMeters(line[i - 1]!);
    const [bx, by] = frame.toMeters(line[i]!);
    const dx = bx - ax,
      dy = by - ay,
      length = dx * dx + dy * dy;
    const t = length ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length)) : 0;
    const distance = Math.hypot(ax + t * dx, ay + t * dy);
    if (distance < nearest) {
      nearest = distance;
      side = length ? (-dx * ay + dy * ax) / Math.sqrt(length) : 0;
    }
  }
  return signed ? side : nearest;
}

type ClearanceOptions = { paths?: boolean; water?: boolean; bounds?: BBox };
const areaCache = new WeakMap<readonly AtlasFeature[], Map<string, Area[]>>();
type PointObstacles = {
  areas: Area[];
  roads: { id: string; line: number[][]; radius: number }[];
};
const pointCache = new WeakMap<readonly AtlasFeature[], Map<string, PointObstacles>>();

/** Point guards need segment distances, without constructing polygon corridor unions. */
export function pointObstacles(
  source: readonly AtlasFeature[],
  { paths = true, water = false }: ClearanceOptions = {},
): PointObstacles {
  const key = `${paths}/${water}`;
  let cache = pointCache.get(source);
  if (!cache) pointCache.set(source, (cache = new Map<string, PointObstacles>()));
  const cached = cache.get(key);
  if (cached) return cached;
  const out: PointObstacles = { areas: [], roads: [] };
  for (const feature of source) {
    const g = feature.geometry,
      p = feature.properties;
    if (
      (g.type === 'Polygon' || g.type === 'MultiPolygon') &&
      (isStandingBuilding(feature) || (water && p.class.startsWith('water')))
    )
      out.areas.push(g);
    if (g.type === 'LineString' && (p.class.startsWith('road') || (paths && p.class === 'path')))
      out.roads.push({ id: p.id, line: g.coordinates, radius: clearanceWidth(p) / 2 });
  }
  cache.set(key, out);
  return out;
}

/** Exact area guards prepare only nearby segment capsules, once per immutable source/bounds. */
export function mappedFootprints(
  source: readonly AtlasFeature[],
  { paths = true, water = false, bounds }: ClearanceOptions = {},
): Area[] {
  const key = `${paths}/${water}/${bounds?.join(',') ?? 'all'}`;
  let cache = areaCache.get(source);
  if (!cache) areaCache.set(source, (cache = new Map<string, Area[]>()));
  const cached = cache.get(key);
  if (cached) return cached;
  const areas = pointObstacles(source, { paths, water }).areas.filter(
    (area) => !bounds || bboxesOverlap(bounds, bbox(area) as BBox),
  );
  const roadSource = paths ? source : source.filter((f) => f.properties.class !== 'path');
  const roadBounds = bounds ?? (bbox({ type: 'FeatureCollection', features: [...source] }) as BBox);
  const out = [
    ...areas,
    ...nearbyRoadFootprints(roadSource, roadBounds).map((road) => road.geometry),
  ];
  cache.set(key, out);
  return out;
}

const obstacleBounds = new WeakMap<Area, BBox>();
export const assertPointClear = (
  at: LngLat,
  obstacles: readonly Area[] | PointObstacles,
  context: string,
) => {
  if ('roads' in obstacles)
    for (const road of obstacles.roads)
      expect(lineDistance(at, road.line), `${context} / ${road.id}`).toBeGreaterThan(road.radius);
  for (const obstacle of 'areas' in obstacles ? obstacles.areas : obstacles) {
    let bounds = obstacleBounds.get(obstacle);
    if (!bounds) {
      bounds = bbox(obstacle) as BBox;
      obstacleBounds.set(obstacle, bounds);
    }
    if (at[0] >= bounds[0] && at[0] <= bounds[2] && at[1] >= bounds[1] && at[1] <= bounds[3])
      expect(inside(at, obstacle), context).toBe(false);
  }
};

/** One meter preparation per site, reused across all of its generic footprint assertions. */
export function clearanceAssertions(area: Area) {
  const audit = geometryAudit(area);
  return {
    ...audit,
    clear: (shape: Area, obstacles: readonly (Area | AtlasFeature)[], context: string) => {
      for (const obstacle of obstacles) {
        const g = 'geometry' in obstacle ? obstacle.geometry : obstacle;
        if (g.type !== 'Polygon' && g.type !== 'MultiPolygon')
          throw Error('expected area obstacle');
        const id = 'properties' in obstacle ? obstacle.properties.id : 'footprint';
        expect(audit.overlaps(shape, g), `${context} / ${id}`).toBe(false);
      }
    },
  };
}

/** Register each site's unchanged geometry assertions in exactly one deterministic shard. */
export function geometrySuite(shard: number, of: number, fixtures: Fixtures) {
  const { covers, source, areaFor, newDetails, nearby } = fixtures;
  const selected = [...newDetails]
    .sort((a, b) => a.id.localeCompare(b.id))
    .filter((_, index) => index % of === shard - 1);
  describe('new landmark detail geometry (offline)', () => {
    for (const detail of selected) {
      const area = areaFor(detail);
      const siteBounds = bbox(area) as [number, number, number, number];
      const audit = clearanceAssertions(area);
      const carriageways = mappedFootprints(source, { paths: false, bounds: siteBounds });
      // Keep complete nearby features, including adjacent selection targets and crowns.
      // Growing city fixtures should not make each site merge unrelated distant content.
      const neighborhood = bufferBbox(siteBounds, 0.015);
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
          audit.clear(
            shape,
            obstacles.filter(
              (obstacle) =>
                !(
                  ownSeat &&
                  obstacle.properties.id.startsWith(`detail:${detail.id.slice(7)}/seating-`)
                ),
            ),
            id,
          );
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
          audit.clear(shape, carriageways, part.id);
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
