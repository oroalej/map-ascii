import { BBox as BBoxSchema, type BBox } from '@atlas/shared';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import turfBbox from '@turf/bbox';
import type { Feature, Geometry, MultiPolygon, Polygon, Position } from 'geojson';
import { difference, intersection, union, type Geom } from 'polyclip-ts';
import { z } from 'zod';
import { bboxesOverlap, inBbox } from './geo';

const polygon = z.strictObject({
  type: z.literal('MultiPolygon'),
  coordinates: z.array(z.array(z.array(z.array(z.number().finite()).min(2)).min(4)).min(1)),
});
/** Internal pipeline artifact; null geometries retain legacy rectangular behavior. */
export const Territory = z.strictObject({
  regionBounds: BBoxSchema,
  territory: polygon.nullable(),
  void: polygon.nullable(),
});
export type Territory = z.infer<typeof Territory>;

export const bboxPolygon = ([w, s, e, n]: BBox): Polygon => ({
  type: 'Polygon',
  coordinates: [
    [
      [w, s],
      [e, s],
      [e, n],
      [w, n],
      [w, s],
    ],
  ],
});

export function createTerritory(
  regionBounds: BBox,
  boundary: Polygon | MultiPolygon,
  downtown?: BBox,
): Territory {
  if (!downtown) return { regionBounds, territory: null, void: null };
  const coordinates = union(
    bboxPolygon(downtown).coordinates as Geom,
    boundary.coordinates as Geom,
  );
  const empty = difference(bboxPolygon(regionBounds).coordinates as Geom, coordinates);
  return Territory.parse({
    regionBounds,
    territory: { type: 'MultiPolygon', coordinates },
    void: empty.length ? { type: 'MultiPolygon', coordinates: empty } : null,
  });
}

// About 0.01 mm in latitude: shared by point admission and segment boundary tests.
const EPS = 1e-10;
type Edge = { a: Position; b: Position; bbox: BBox };
const edgeList = (geometry: MultiPolygon): Edge[] =>
  geometry.coordinates.flatMap((p) =>
    p.flatMap((r) =>
      r
        .slice(1)
        .map((b, i) => ({
          a: r[i]!,
          b,
          bbox: [
            Math.min(r[i]![0]!, b[0]!),
            Math.min(r[i]![1]!, b[1]!),
            Math.max(r[i]![0]!, b[0]!),
            Math.max(r[i]![1]!, b[1]!),
          ] as BBox,
        })),
    ),
  );
const cache = new WeakMap<
  Territory,
  { bounds: BBox | null; edges: Edge[]; retainedEdges: Edge[] }
>();
const prepared = (t: Territory) => {
  let value = cache.get(t);
  if (!value) {
    value = {
      bounds: t.void ? (turfBbox(t.void) as BBox) : null,
      edges: t.void ? edgeList(t.void) : [],
      retainedEdges: t.territory ? edgeList(t.territory) : [],
    };
    cache.set(t, value);
  }
  return value;
};
const onEdge = (p: Position, { a, b }: Edge) => {
  const dx = b[0]! - a[0]!,
    dy = b[1]! - a[1]!;
  const length2 = dx * dx + dy * dy;
  const u = length2
    ? Math.max(0, Math.min(1, ((p[0]! - a[0]!) * dx + (p[1]! - a[1]!) * dy) / length2))
    : 0;
  return Math.hypot(p[0]! - a[0]! - u * dx, p[1]! - a[1]! - u * dy) <= EPS;
};

/** Closed territory membership, including city/downtown edges and excluding void-only edges. */
export function inTerritory(lng: number, lat: number, t: Territory): boolean {
  if (!inBbox(lng, lat, t.regionBounds)) return false;
  return (
    !t.territory ||
    booleanPointInPolygon([lng, lat], t.territory) ||
    prepared(t).retainedEdges.some((e) => onEdge([lng, lat], e))
  );
}
/** Unlike camera/search admission, subtraction preserves source portions beyond the rectangle. */
export const inVoid = ([lng, lat]: Position, t: Territory) =>
  !!t.void && inBbox(lng!, lat!, t.regionBounds) && !inTerritory(lng!, lat!, t);

const mayMeetVoid = (bounds: BBox, t: Territory) => {
  const data = prepared(t);
  if (!data.bounds || !bboxesOverlap(bounds, data.bounds)) return false;
  const [w, s, e, n] = bounds;
  return (
    [
      [w, s],
      [e, s],
      [e, n],
      [w, n],
    ].some((p) => booleanPointInPolygon(p, t.void!, { ignoreBoundary: true })) ||
    data.edges.some((edge) => bboxesOverlap(bounds, edge.bbox))
  );
};

const cross = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx;
/** Parametric intersections, also retaining endpoints of a collinear boundary overlap. */
function crossings(a: Position, b: Position, edge: Edge): number[] {
  const dx = b[0]! - a[0]!,
    dy = b[1]! - a[1]!;
  const ex = edge.b[0]! - edge.a[0]!,
    ey = edge.b[1]! - edge.a[1]!;
  const qx = edge.a[0]! - a[0]!,
    qy = edge.a[1]! - a[1]!;
  const determinant = cross(dx, dy, ex, ey);
  const length = Math.hypot(dx, dy),
    edgeLength = Math.hypot(ex, ey);
  if (!length) return [];
  if (Math.abs(determinant) <= Number.EPSILON * length * edgeLength * 16) {
    if (Math.abs(cross(qx, qy, dx, dy)) > EPS * length) return [];
    const length2 = length * length;
    return [
      (qx * dx + qy * dy) / length2,
      ((edge.b[0]! - a[0]!) * dx + (edge.b[1]! - a[1]!) * dy) / length2,
    ].filter((u) => u >= 0 && u <= 1);
  }
  const u = cross(qx, qy, ex, ey) / determinant,
    v = cross(qx, qy, dx, dy) / determinant;
  return u >= -EPS && u <= 1 + EPS && v >= -EPS && v <= 1 + EPS
    ? [Math.max(0, Math.min(1, u))]
    : [];
}
const interpolate = (a: Position, b: Position, u: number): Position =>
  u === 0 ? a : u === 1 ? b : a.map((v, i) => v + u * (b[i]! - v));
const same = (a: Position, b: Position) =>
  Math.abs(a[0]! - b[0]!) <= EPS && Math.abs(a[1]! - b[1]!) <= EPS;

function clipLine(line: Position[], t: Territory): { lines: Position[][]; changed: boolean } {
  const lines: Position[][] = [];
  let current: Position[] = [],
    changed = false;
  const flush = () => {
    if (current.length > 1) lines.push(current);
    current = [];
  };
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!,
      b = line[i]!;
    if (same(a, b)) continue;
    const bounds: BBox = [
      Math.min(a[0]!, b[0]!),
      Math.min(a[1]!, b[1]!),
      Math.max(a[0]!, b[0]!),
      Math.max(a[1]!, b[1]!),
    ];
    const cuts = [
      0,
      1,
      ...prepared(t).edges.flatMap((e) =>
        bboxesOverlap(bounds, e.bbox) ? crossings(a, b, e) : [],
      ),
    ]
      .sort((a, b) => a - b)
      .filter((u, i, all) => i === 0 || u - all[i - 1]! > EPS);
    for (let j = 1; j < cuts.length; j++) {
      const start = cuts[j - 1]!,
        end = cuts[j]!;
      if (inVoid(interpolate(a, b, (start + end) / 2), t)) {
        changed = true;
        flush();
        continue;
      }
      const from = interpolate(a, b, start),
        to = interpolate(a, b, end);
      if (current.length && !same(current[current.length - 1]!, from)) flush();
      if (!current.length) current.push(from);
      current.push(to);
    }
  }
  flush();
  return { lines, changed };
}

function clipGeometry(geometry: Geometry, t: Territory): Geometry | undefined {
  switch (geometry.type) {
    case 'Point':
      return inVoid(geometry.coordinates, t) ? undefined : geometry;
    case 'MultiPoint': {
      const coordinates = geometry.coordinates.filter((p) => !inVoid(p, t));
      return coordinates.length === geometry.coordinates.length
        ? geometry
        : coordinates.length
          ? { ...geometry, coordinates }
          : undefined;
    }
    case 'Polygon':
    case 'MultiPolygon': {
      if (!intersection(geometry.coordinates as Geom, t.void!.coordinates as Geom).length)
        return geometry;
      const coordinates = difference(geometry.coordinates as Geom, t.void!.coordinates as Geom);
      return !coordinates.length
        ? undefined
        : coordinates.length === 1
          ? { type: 'Polygon', coordinates: coordinates[0]! }
          : { type: 'MultiPolygon', coordinates };
    }
    case 'LineString':
    case 'MultiLineString': {
      const results = (
        geometry.type === 'LineString' ? [geometry.coordinates] : geometry.coordinates
      ).map((l) => clipLine(l, t));
      if (!results.some((r) => r.changed)) return geometry;
      const coordinates = results.flatMap((r) => r.lines);
      return !coordinates.length
        ? undefined
        : coordinates.length === 1
          ? { type: 'LineString', coordinates: coordinates[0]! }
          : { type: 'MultiLineString', coordinates };
    }
    case 'GeometryCollection': {
      const geometries = geometry.geometries
        .map((g) => clipGeometry(g, t))
        .filter((g): g is Geometry => !!g);
      return !geometries.length
        ? undefined
        : geometries.length === geometry.geometries.length &&
            geometries.every((g, i) => g === geometry.geometries[i])
          ? geometry
          : { ...geometry, geometries };
    }
  }
}

/** Remove only the void, keeping a single identity and all original derivation metadata. */
export function removeVoid<F extends Feature>(feature: F, t: Territory): F | undefined {
  if (!t.void || !mayMeetVoid(turfBbox(feature) as BBox, t)) return feature;
  const geometry = clipGeometry(feature.geometry, t);
  if (!geometry) return undefined;
  if (geometry === feature.geometry) return feature;
  const result = { ...feature, geometry };
  if (feature.bbox) result.bbox = turfBbox(result);
  // All callers use the Geometry union; subtraction may promote a single geometry to a multi.
  return result;
}

export const geometryOutsideVoid = (geometry: Geometry, t: Territory) => {
  if (!t.void) return true;
  const feature: Feature = { type: 'Feature', properties: {}, geometry };
  return removeVoid(feature, t) === feature;
};
