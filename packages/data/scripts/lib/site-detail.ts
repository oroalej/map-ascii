import { featureZoomBand, tileZoomRange, type LngLat, type SiteDetail } from '@atlas/shared';
import inside from '@turf/boolean-point-in-polygon';
import { union } from 'polyclip-ts';
import type { Polygon, MultiPolygon, Position } from 'geojson';
import { TILE_ZOOMS, type AtlasFeature, type AtlasProperties } from '../03-normalize';
import { layerFor } from './classify';

const METERS = 111_320;
const frame = ([lng, lat]: LngLat) => {
  const mx = METERS * Math.cos((lat * Math.PI) / 180);
  return {
    local: ([x, y]: Position): LngLat => [(x! - lng) * mx, (y! - lat) * METERS],
    world: ([x, y]: LngLat): LngLat => [lng + x / mx, lat + y / METERS],
  };
};
const distance = (a: Position, b: Position) => Math.hypot(...frame(a as LngLat).local(b));

/** Rounded, real-width seating footprint, unioned before tiling so bends have no seams. */
export function seatingFootprint(line: LngLat[], width: number): MultiPolygon {
  const f = frame(line[0]!);
  const points = line.map(f.local);
  const half = width / 2;
  const pieces: LngLat[][][] = points.map(([x, y]) => {
    const ring = Array.from({ length: 17 }, (_, i): LngLat => {
      const a = ((i % 16) * Math.PI) / 8;
      return [x + Math.cos(a) * half, y + Math.sin(a) * half];
    });
    return [ring];
  });
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!,
      b = points[i]!;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const nx = (-(b[1] - a[1]) / length) * half,
      ny = ((b[0] - a[0]) / length) * half;
    pieces.push([
      [
        [a[0] + nx, a[1] + ny],
        [b[0] + nx, b[1] + ny],
        [b[0] - nx, b[1] - ny],
        [a[0] - nx, a[1] - ny],
        [a[0] + nx, a[1] + ny],
      ],
    ]);
  }
  const [first, ...rest] = pieces;
  return {
    type: 'MultiPolygon',
    coordinates: union(first!, ...rest).map((p) => p.map((r) => r.map((p) => f.world(p)))),
  };
}

function feature(
  id: string,
  geometry: AtlasFeature['geometry'],
  properties: Partial<AtlasProperties>,
): AtlasFeature {
  const cls = properties.class ?? 'furniture';
  return {
    type: 'Feature',
    geometry,
    properties: { id, class: cls, ...properties },
    tippecanoe: {
      layer: layerFor(
        cls,
        geometry.type === 'Point' ? 'point' : geometry.type === 'LineString' ? 'line' : 'area',
      ),
      ...tileZoomRange(featureZoomBand(cls), TILE_ZOOMS),
    },
  };
}

/** Replace an area's ground material while retaining its OSM identity, labels and selection. */
export function mergeSiteDetails(input: AtlasFeature[], packs: readonly SiteDetail[]) {
  const features = input.map((f) => ({ ...f, properties: { ...f.properties } }));
  const warnings: string[] = [];
  const parents = new Set<string>();
  for (const pack of packs) {
    const parent = features.find((f) => f.properties.id === pack.osm_id);
    if (!parent || (parent.geometry.type !== 'Polygon' && parent.geometry.type !== 'MultiPolygon'))
      throw new Error(`${pack.id}: parent ${pack.osm_id} must be an existing OSM area`);
    if (parents.has(pack.osm_id))
      throw new Error(`${pack.id}: duplicate detail parent ${pack.osm_id}`);
    parents.add(pack.osm_id);
    if (parent.properties.height)
      throw new Error(`${pack.id}: a building cannot be replaced by paving`);
    const area = parent.geometry;
    const requireInside = (points: Position[], item: string) => {
      if (points.some((p) => !inside(p, area)))
        throw new Error(`${pack.id} ${item}: outside parent footprint`);
    };
    parent.properties.class = 'paving';
    parent.tippecanoe = {
      layer: 'landuse',
      ...tileZoomRange(featureZoomBand('paving'), TILE_ZOOMS),
    };
    const prefix = `detail:${pack.id.slice(7)}`;
    const seating = pack.seating.map((seat) => ({
      seat,
      shape: seatingFootprint(seat.line, seat.width_m),
    }));
    const obstacles = [
      ...input.filter(
        (f) =>
          (f.properties.detail_blocked || f.properties.class === 'building_part') &&
          (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'),
      ),
      ...seating.map(({ seat, shape }) =>
        feature(`${prefix}/seating-${seat.id}`, shape, { detail_blocked: true }),
      ),
    ];
    const requireClear = (points: Position[], item: string) => {
      requireInside(points, item);
      for (const obstacle of obstacles)
        if (points.some((p) => inside(p, obstacle.geometry as Polygon | MultiPolygon)))
          throw new Error(`${pack.id} ${item}: crosses ${obstacle.properties.id}`);
    };
    for (const walk of pack.walks) {
      // Sample the whole route, not just its vertices, against the parent and raised obstacles.
      const samples: LngLat[] = [];
      for (let i = 1; i < walk.line.length; i++) {
        const a = walk.line[i - 1]!,
          b = walk.line[i]!;
        const steps = Math.max(1, Math.ceil(distance(a, b) / 0.5));
        for (let j = 0; j <= steps; j++)
          samples.push([a[0] + ((b[0] - a[0]) * j) / steps, a[1] + ((b[1] - a[1]) * j) / steps]);
      }
      requireClear(samples, `walk ${walk.id}`);
      features.push(
        feature(
          `${prefix}/walk-${walk.id}`,
          { type: 'LineString', coordinates: walk.line },
          {
            class: 'path',
            width: walk.width_m,
            detail_route: true,
          },
        ),
      );
    }
    for (const { seat, shape } of seating) {
      requireInside(shape.coordinates.flat(2), `seating ${seat.id}`);
      features.push(
        feature(`${prefix}/seating-${seat.id}`, shape, {
          class: 'building_part',
          height: seat.height_m,
          variant: 'seating',
          detail_blocked: true,
        }),
      );
      // Sparse pause anchors on the accessible side; bodies do not stand inside the stonework.
      let phase = 1.5;
      for (let i = 1; i < seat.line.length; i++) {
        const a = seat.line[i - 1]!,
          b = seat.line[i]!,
          f = frame(a);
        const [dx, dy] = f.local(b),
          length = Math.hypot(dx, dy);
        const side = seat.facing === 'left' ? 1 : -1;
        const nx = (-dy / length) * side,
          ny = (dx / length) * side;
        for (; phase < length; phase += 4) {
          const at = f.world([
            (dx / length) * phase + nx * (seat.width_m / 2 + 0.75),
            (dy / length) * phase + ny * (seat.width_m / 2 + 0.75),
          ]);
          requireClear([at], `seating anchor ${seat.id}`);
          const mapped = input.some(
            (f) =>
              f.properties.class === 'furniture' &&
              f.properties.variant === 'bench' &&
              f.geometry.type === 'Point' &&
              distance(at, f.geometry.coordinates) <= 3,
          );
          if (mapped) {
            warnings.push(`${pack.id}: mapped bench replaces seating anchor ${seat.id}`);
            continue;
          }
          const key = `${i}-${Math.round(phase * 100)}`;
          features.push(
            feature(
              `${prefix}/bench-${seat.id}-${key}`,
              { type: 'Point', coordinates: at },
              {
                variant: 'bench',
                seat_bearing: ((Math.atan2(nx, ny) * 180) / Math.PI + 360) % 360,
              },
            ),
          );
        }
        phase -= length;
      }
    }
    for (const lamp of pack.lamps) {
      requireInside([lamp.at], `lamp ${lamp.id}`);
      const mapped = input.some(
        (f) =>
          f.properties.class === 'furniture' &&
          f.properties.variant === 'lamp' &&
          f.geometry.type === 'Point' &&
          distance(lamp.at, f.geometry.coordinates) <= 3,
      );
      if (mapped) {
        warnings.push(`${pack.id}: mapped lamp replaces ${lamp.id}`);
        continue;
      }
      features.push(
        feature(
          `${prefix}/lamp-${lamp.id}`,
          { type: 'Point', coordinates: lamp.at },
          {
            variant: 'lamp',
            lamp_bearing: lamp.bearing,
            lamp_reach: lamp.reach_m,
            lamp_heads: lamp.heads,
          },
        ),
      );
    }
  }
  return { features, warnings };
}

export const detailCredits = (packs: readonly SiteDetail[]) => [
  ...new Set(packs.map((p) => p.credit)),
];
