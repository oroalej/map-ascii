import {
  featureZoomBand,
  DetailSelectionSchema,
  tileZoomRange,
  type LngLat,
  type SiteDetail,
  type SubdivisionArea,
  isRoofBuilding,
} from '@atlas/shared';
import inside from '@turf/boolean-point-in-polygon';
import bbox from '@turf/bbox';
import { difference, intersection, union } from 'polyclip-ts';
import type { Polygon, MultiPolygon, Position } from 'geojson';
import { TILE_ZOOMS, type AtlasFeature, type AtlasProperties } from '../03-normalize';
import { layerFor } from './classify';
import { bboxesOverlap } from './geo';

const METERS = 111_320;
type MultiPoly = ReturnType<typeof union>;
const frame = ([lng, lat]: LngLat) => {
  const mx = METERS * Math.cos((lat * Math.PI) / 180);
  return {
    local: ([x, y]: Position): LngLat => [(x! - lng) * mx, (y! - lat) * METERS],
    world: ([x, y]: LngLat): LngLat => [lng + x / mx, lat + y / METERS],
  };
};
const distance = (a: Position, b: Position) => Math.hypot(...frame(a as LngLat).local(b));

function strokePieces(points: LngLat[], width: number): LngLat[][][] {
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
  return pieces;
}

/** Union rim and wider bench sections in one meter frame, retaining the planted hole. */
export function seatingFootprint(
  line: LngLat[],
  width: number,
  spans: SiteDetail['seating'][number]['bench_spans'] = [],
): MultiPolygon {
  const f = frame(line[0]!);
  const points = line.map(f.local);
  const pieces = strokePieces(points, width);
  for (const span of spans)
    pieces.push(...strokePieces(points.slice(span.start, span.end + 1), span.width_m));
  // A balanced union avoids thousands of near-coincident edges in one sweep.
  // Round local coordinates to micrometers before clipping (far below tile precision).
  let merged: MultiPoly[] = pieces.map((piece) => [
    piece.map((ring) =>
      ring.map(([x, y]) => [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6] as LngLat),
    ),
  ]);
  while (merged.length > 1) {
    const next: MultiPoly[] = [];
    for (let i = 0; i < merged.length; i += 2)
      next.push(i + 1 < merged.length ? union(merged[i]!, merged[i + 1]!) : merged[i]!);
    merged = next;
  }
  return {
    type: 'MultiPolygon',
    coordinates: merged[0]!.map((p) => p.map((r) => r.map((p) => f.world(p)))),
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

const isArea = (g: AtlasFeature['geometry']): g is Polygon | MultiPolygon =>
  g.type === 'Polygon' || g.type === 'MultiPolygon';
const clip = (g: Polygon | MultiPolygon) =>
  (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).map((p) =>
    p.map((r) => r.map(([lng, lat]): LngLat => [lng!, lat!])),
  );
const contained = (g: AtlasFeature['geometry'], area: Polygon | MultiPolygon) =>
  g.type === 'Point'
    ? inside(g.coordinates, area)
    : isArea(g) && difference(clip(g), clip(area)).length === 0;

/** OSM grounds can stop at a church's facade; allow a small boundary gap, not a remote alias. */
function selectionNear(g: AtlasFeature['geometry'], area: Polygon | MultiPolygon): boolean {
  if (contained(g, area)) return true;
  if (!isArea(g)) return false;
  if (intersection(clip(g), clip(area)).length) return true;
  const rings = clip(area).flat();
  return clip(g)
    .flat()
    .some((ring) =>
      ring.some((point) => {
        const f = frame(point);
        return rings.some((boundary) =>
          boundary.slice(1).some((b, i) => {
            const [ax, ay] = f.local(boundary[i]!);
            const [bx, by] = f.local(b);
            const dx = bx - ax,
              dy = by - ay;
            const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy)));
            return Math.hypot(ax + t * dx, ay + t * dy) <= 5;
          }),
        );
      }),
    );
}

/** Enrich a site's ground without replacing its buildings or canonical landmark identity. */
export function mergeSiteDetails(
  input: AtlasFeature[],
  packs: readonly SiteDetail[],
  subdivisions: readonly SubdivisionArea[] = [],
) {
  const features = input.map((f) => ({ ...f, properties: { ...f.properties } }));
  const warnings: string[] = [];
  const parents = new Set<string>();
  const relocated = new Set<string>();
  const roofTargets = new Set<string>();
  const buildingTargets = new Set<string>();
  // Validate every anchor before mutation; overlap decisions must not depend on pack order.
  const sites = packs.map((pack) => {
    const parent = features.find((f) => f.properties.id === pack.osm_id);
    if (
      !parent ||
      (!isArea(parent.geometry) && !(pack.grounds && parent.geometry.type === 'Point'))
    )
      throw new Error(`${pack.id}: parent ${pack.osm_id} must be an existing OSM area`);
    if (parents.has(pack.osm_id))
      throw new Error(`${pack.id}: duplicate detail parent ${pack.osm_id}`);
    parents.add(pack.osm_id);
    if (parent.properties.height && !pack.grounds)
      throw new Error(`${pack.id}: a building parent needs curated grounds`);
    const area = pack.grounds
      ? { type: 'Polygon' as const, coordinates: [pack.grounds] }
      : (parent.geometry as Polygon | MultiPolygon);
    if (pack.grounds && !contained(parent.geometry, area))
      throw new Error(`${pack.id}: grounds must contain parent ${pack.osm_id}`);
    const selectionId = pack.selection_osm_id ?? pack.osm_id;
    const target = features.find((f) => f.properties.id === selectionId);
    if (
      !target ||
      (pack.selection_osm_id &&
        (!target.properties.landmark_id || !selectionNear(target.geometry, area)))
    )
      throw new Error(
        `${pack.id}: selection target must be an existing curated landmark inside or adjacent to the site`,
      );
    if (
      target.properties.detail_parent ||
      packs.some(
        (p) => p.osm_id === selectionId && p.selection_osm_id && p.selection_osm_id !== selectionId,
      )
    )
      throw new Error(`${pack.id}: selection targets cannot form alias chains`);
    const p = target.properties;
    const metadata =
      pack.surface === 'keep' || pack.grounds || pack.selection_osm_id
        ? JSON.stringify(
            DetailSelectionSchema.parse({
              id: selectionId,
              class: p.class,
              ...(p.name !== undefined && { name: p.name }),
              ...(p.landmark_id !== undefined && { landmarkId: p.landmark_id }),
              ...(p.subdivision !== undefined && { subdivision: p.subdivision }),
              ...(p.subdivision_approx !== undefined && {
                subdivisionApprox: p.subdivision_approx,
              }),
              ...(p.kind !== undefined && { kind: p.kind }),
              ...(p.height && { height: p.height }),
            }),
          )
        : undefined;
    return { pack, parent, area, selectionId, metadata };
  });
  for (let i = 0; i < sites.length; i++) {
    const a = sites[i]!;
    for (const b of sites.slice(i + 1))
      if ((a.pack.grounds || b.pack.grounds) && intersection(clip(a.area), clip(b.area)).length)
        throw new Error(`${a.pack.id}: grounds overlap ${b.pack.id}`);
  }
  const blocked = input
    .filter(
      (f) =>
        !f.properties.detail_overhead &&
        isArea(f.geometry) &&
        (f.properties.detail_blocked ||
          f.properties.class === 'building_part' ||
          (f.properties.class.startsWith('building') && (f.properties.height ?? 0) > 0)),
    )
    .map((f) => ({ feature: f, bounds: bbox(f) as [number, number, number, number] }));
  for (const { pack, parent, area, selectionId, metadata } of sites) {
    const parentClip = clip(area);
    const siteBounds = bbox(area) as [number, number, number, number];
    const requireInside = (points: Position[], item: string) => {
      if (points.some((p) => !inside(p, area)))
        throw new Error(`${pack.id} ${item}: outside parent footprint`);
    };
    const prefix = `detail:${pack.id.slice(7)}`;
    const link = {
      detail_parent: selectionId,
      ...(metadata && { detail_selection: metadata }),
    };
    for (const building of pack.building_overrides) {
      const target = features.find((f) => f.properties.id === building.osm_id);
      if (buildingTargets.has(building.osm_id))
        throw new Error(`${pack.id}: duplicate building override ${building.osm_id}`);
      if (
        !target ||
        !isRoofBuilding(target.properties.class) ||
        !target.properties.height ||
        !isArea(target.geometry) ||
        !contained(target.geometry, area)
      )
        throw new Error(
          `${pack.id}: building override ${building.osm_id} must be a standing building inside the site`,
        );
      buildingTargets.add(building.osm_id);
      target.properties.height = building.height_m;
    }
    for (const roof of pack.roof_overrides) {
      const target = features.find((f) => f.properties.id === roof.osm_id);
      if (roofTargets.has(roof.osm_id))
        throw new Error(`${pack.id}: duplicate roof override ${roof.osm_id}`);
      if (
        !target ||
        !isRoofBuilding(target.properties.class) ||
        !target.properties.height ||
        !isArea(target.geometry) ||
        !contained(target.geometry, area)
      )
        throw new Error(
          `${pack.id}: roof override ${roof.osm_id} must be a standing building inside the site`,
        );
      roofTargets.add(roof.osm_id);
      target.properties.variant = roof.shape;
    }
    if (pack.surface === 'paving') {
      if (pack.grounds)
        features.push(feature(`${prefix}/grounds`, area, { class: 'paving', ...link }));
      else {
        parent.properties.class = 'paving';
        parent.tippecanoe = {
          layer: 'landuse',
          ...tileZoomRange(featureZoomBand('paving'), TILE_ZOOMS),
        };
      }
    }
    if (selectionId !== pack.osm_id) Object.assign(parent.properties, link);
    const seating = pack.seating.map((seat) => ({
      seat,
      shape: seatingFootprint(seat.line, seat.width_m, seat.bench_spans),
    }));
    const structures = pack.structures.map((part) => {
      const rings = [part.ring, ...(part.holes ?? [])];
      const shape: Polygon = { type: 'Polygon', coordinates: rings };
      for (const [i, hole] of (part.holes ?? []).entries()) {
        if (
          difference([hole], [part.ring]).length ||
          (part.holes ?? []).slice(0, i).some((other) => intersection([hole], [other]).length) ||
          difference([part.ring], [hole]).length === 0
        )
          throw new Error(`${pack.id} structure ${part.id}: invalid or overlapping interior`);
      }
      requireInside(part.ring, `structure ${part.id}`);
      // Vertices alone miss a footprint crossing a concavity or covering a parent hole.
      if (difference(rings, parentClip).length > 0)
        throw new Error(`${pack.id} structure ${part.id}: outside parent footprint`);
      if (part.roof_osm_id) {
        const roof = features.find((f) => f.properties.id === part.roof_osm_id);
        if (
          !roof ||
          !isRoofBuilding(roof.properties.class) ||
          !roof.properties.height ||
          !isArea(roof.geometry) ||
          !contained(shape, roof.geometry) ||
          part.height_m <= roof.properties.height
        )
          throw new Error(
            `${pack.id} structure ${part.id}: roof wing must fit above ${part.roof_osm_id}`,
          );
      }
      // Opt-in ground replacements must not paint a court through a standing footprint.
      // Test polygon interiors, including obstacles wholly enclosed by the proposed court.
      if (part.ground_override || ['pitch', 'water'].includes(part.material))
        for (const obstacle of blocked)
          if (
            bboxesOverlap(bbox(shape) as [number, number, number, number], obstacle.bounds) &&
            intersection(rings, clip(obstacle.feature.geometry as Polygon | MultiPolygon)).length
          )
            throw new Error(
              `${pack.id} structure ${part.id}: crosses ${obstacle.feature.properties.id}`,
            );
      if (part.material === 'water')
        for (const water of input.filter(
          (f) => f.properties.class === 'water_area' && isArea(f.geometry),
        ))
          if (intersection(rings, clip(water.geometry as Polygon | MultiPolygon)).length)
            throw new Error(`${pack.id} structure ${part.id}: duplicates ${water.properties.id}`);
      return feature(`${prefix}/structure-${part.id}`, shape, {
        class: part.roof_shape
          ? // Roof surfaces have no independent school/market activity; selection uses link.
            'building'
          : part.material === 'water'
            ? 'water_area'
            : part.material === 'pitch'
              ? 'pitch'
              : part.material === 'paving'
                ? 'paving'
                : part.material === 'wood'
                  ? 'building_woodwork'
                  : 'building_part',
        height: part.height_m,
        ...(part.material === 'water' && { kind: 'leisure=swimming_pool' }),
        variant:
          part.roof_shape ??
          (part.material === 'paving'
            ? part.ground_override
              ? 'terrace_override'
              : 'terrace'
            : 'flat'),
        detail_overhead: part.overhead,
        ...((part.material === 'paving' || metadata) && link),
        ...(!part.overhead &&
          !['paving', 'pitch'].includes(part.material) && { detail_blocked: true }),
      });
    });
    features.push(...structures);
    const obstacles = [
      ...blocked.filter((f) => bboxesOverlap(f.bounds, siteBounds)).map((f) => f.feature),
      ...seating.map(({ seat, shape }) =>
        feature(`${prefix}/seating-${seat.id}`, shape, { detail_blocked: true }),
      ),
      ...structures.filter((f) => f.properties.detail_blocked),
    ];
    const requireClear = (points: Position[], item: string) => {
      requireInside(points, item);
      for (const obstacle of obstacles)
        if (points.some((p) => inside(p, obstacle.geometry as Polygon | MultiPolygon)))
          throw new Error(`${pack.id} ${item}: crosses ${obstacle.properties.id}`);
    };
    for (const pole of pack.flagpoles) {
      if (relocated.has(pole.osm_id))
        throw new Error(`${pack.id}: duplicate flagpole target ${pole.osm_id}`);
      const target = features.find((f) => f.properties.id === pole.osm_id);
      if (
        !target ||
        target.geometry.type !== 'Point' ||
        target.properties.class !== 'furniture' ||
        target.properties.variant !== 'flagpole'
      )
        throw new Error(`${pack.id}: ${pole.osm_id} must be an existing mapped flagpole point`);
      requireClear([pole.at], `flagpole ${pole.osm_id}`);
      relocated.add(pole.osm_id);
      target.geometry = { type: 'Point', coordinates: [...pole.at] };
      const properties = target.properties;
      if (pole.flag !== undefined) properties.flag = pole.flag;
      if (properties.label_lng !== undefined || properties.label_lat !== undefined) {
        [properties.label_lng, properties.label_lat] = pole.at;
      }
      // A correction can cross a subdivision boundary, including an approximate one.
      delete properties.subdivision;
      delete properties.subdivision_approx;
      const containing = subdivisions.filter((s) =>
        inside(pole.at, s.geometry as Polygon | MultiPolygon),
      );
      const subdivision = containing.find((s) => !s.approximate) ?? containing[0];
      if (subdivision) {
        properties.subdivision = subdivision.name;
        if (subdivision.approximate) properties.subdivision_approx = true;
      }
    }
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
          class: 'seating',
          height: seat.height_m,
          variant: 'seating',
          detail_blocked: true,
        }),
      );
      // Sparse pause anchors on the accessible side; bodies do not stand inside the stonework.
      const spans = seat.bench_spans ?? [
        { id: '', start: 0, end: seat.line.length - 1, width_m: seat.width_m },
      ];
      for (const span of spans) {
        let phase = 1.5;
        for (let i = span.start + 1; i <= span.end; i++) {
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
              (dx / length) * phase + nx * (span.width_m / 2 + 0.75),
              (dy / length) * phase + ny * (span.width_m / 2 + 0.75),
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
            const key = `${span.id ? `${span.id}-` : ''}${i}-${Math.round(phase * 100)}`;
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
            lamp_style: lamp.style,
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
