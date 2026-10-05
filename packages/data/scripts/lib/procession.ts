/**
 * River processions' routes (DATA.md §2 step 07): follow the city's rivers in OSM from a
 * procession's start down to where it lands. OSM draws a waterway in the direction it flows,
 * so "upstream" walks the river's ways backwards.
 */
import {
  LEGACY_LOCAL_METERS_PER_DEGREE,
  resolveProcessionSchedules,
  localMetricProjection,
  pointInPolygon,
  type Procession,
  type ProcessionRoute,
} from '@atlas/shared';
import type { Feature, Geometry, Position } from 'geojson';
import { routeStreet, bakeMassSite } from './procession-ground';

type RiverFeature = Feature<Geometry, { id?: string; class?: string; name?: string }>;

/**
 * A start or end further than this from any river is an error in the pack, m. An end may be a
 * landmark a short walk from the river (e.g. a basilica); the route ends at the river point
 * nearest it.
 */
export const MAX_SNAP_M = 300;

/** Full formation footprint plus a clear margin on both sides, in metres. */
export const PROCESSION_CLEARANCE = {
  andasWidth: 2.4,
  personPitch: 0.8,
  margin: 0.5,
  vehicleWidths: { car: 1.9, truck: 2.5, motorcycle: 0.8 },
} as const;

type Point = [number, number];

/** Meters east and north of an origin, near enough flat over a few kilometers. */
function localMeters(origin: Point) {
  // Preserve existing published route coordinates and bank widths exactly.
  return localMetricProjection(origin, { east: LEGACY_LOCAL_METERS_PER_DEGREE, north: 110_540 });
}

const distance = (a: Point, b: Point) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** One step of a river, in the direction it flows. */
type Segment = { a: number; b: number; name: string; line: number };

/** The rivers as a graph of vertices (meters) and the segments between them. */
export class RiverGraph {
  readonly points: Point[] = [];
  readonly segments: Segment[] = [];
  /** Per line (river way), its length in meters. */
  readonly lineLengths: number[] = [];
  private readonly index = new Map<string, number>();
  /** Per vertex, the segments ending or starting there. */
  private readonly into = new Map<number, number[]>();
  private readonly outOf = new Map<number, number[]>();
  readonly project: ReturnType<typeof localMeters>;

  constructor(features: readonly RiverFeature[], origin: Point) {
    this.project = localMeters(origin);
    for (const feature of features) {
      if (feature.properties?.class !== 'water_river') continue;
      const name = feature.properties.name ?? '';
      const { geometry } = feature;
      const lines =
        geometry.type === 'LineString'
          ? [geometry.coordinates]
          : geometry.type === 'MultiLineString'
            ? geometry.coordinates
            : [];
      for (const coords of lines) {
        const line = this.lineLengths.length;
        let length = 0;
        for (let i = 1; i < coords.length; i++) {
          const a = this.vertex(coords[i - 1]!);
          const b = this.vertex(coords[i]!);
          if (a === b) continue;
          const s = this.segments.length;
          this.segments.push({ a, b, name, line });
          push(this.outOf, a, s);
          push(this.into, b, s);
          length += distance(this.points[a]!, this.points[b]!);
        }
        this.lineLengths.push(length);
      }
    }
  }

  private vertex(p: Position): number {
    const key = `${p[0]!.toFixed(7)},${p[1]!.toFixed(7)}`;
    let i = this.index.get(key);
    if (i === undefined) {
      i = this.points.length;
      this.points.push(this.project.to(p));
      this.index.set(key, i);
    }
    return i;
  }

  /** The nearest point on any river to `p` (meters): its segment, and how far along it (0–1). */
  snap(p: Point): { segment: number; t: number; at: Point; off: number } | undefined {
    let best: { segment: number; t: number; at: Point; off: number } | undefined;
    this.segments.forEach((s, segment) => {
      const a = this.points[s.a]!;
      const b = this.points[s.b]!;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const t = Math.max(
        0,
        Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)),
      );
      const at: Point = [a[0] + dx * t, a[1] + dy * t];
      const off = distance(p, at);
      if (!best || off < best.off) best = { segment, t, at, off };
    });
    return best;
  }

  /**
   * The river path `meters` upstream of a snapped point, in the direction of flow (ending at
   * the point). At a confluence it keeps to the river of the same name, else the longest way.
   */
  upstream(from: { segment: number; at: Point }, meters: number): Point[] {
    const path: Point[] = [from.at];
    let left = meters;
    let segment = this.segments[from.segment]!;
    let here = from.at;
    for (let guard = 0; guard < 100_000 && left > 0; guard++) {
      const back = this.points[segment.a]!;
      const step = distance(here, back);
      if (step >= left) {
        const t = left / step;
        path.push([here[0] + (back[0] - here[0]) * t, here[1] + (back[1] - here[1]) * t]);
        break;
      }
      left -= step;
      path.push(back);
      here = back;
      const options = (this.into.get(segment.a) ?? []).map((i) => this.segments[i]!);
      if (options.length === 0) break;
      const name = segment.name;
      options.sort(
        (x, y) =>
          Number(y.name === name && name !== '') - Number(x.name === name && name !== '') ||
          this.lineLengths[y.line]! - this.lineLengths[x.line]!,
      );
      segment = options[0]!;
    }
    return path.reverse();
  }

  /** The shortest river path between two snapped points, either way along the rivers. */
  between(
    start: { segment: number; at: Point },
    end: { segment: number; at: Point },
  ): Point[] | undefined {
    if (start.segment === end.segment) return [start.at, end.at];
    // Dijkstra over vertices, from the two ends of the start's segment.
    const n = this.points.length;
    const dist = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const done = new Uint8Array(n);
    const s = this.segments[start.segment]!;
    dist[s.a] = distance(start.at, this.points[s.a]!);
    dist[s.b] = distance(start.at, this.points[s.b]!);
    for (;;) {
      let u = -1;
      for (let i = 0; i < n; i++)
        if (!done[i] && dist[i]! < Infinity && (u < 0 || dist[i]! < dist[u]!)) u = i;
      if (u < 0) break;
      done[u] = 1;
      for (const i of [...(this.outOf.get(u) ?? []), ...(this.into.get(u) ?? [])]) {
        const seg = this.segments[i]!;
        const v = seg.a === u ? seg.b : seg.a;
        const d = dist[u]! + distance(this.points[u]!, this.points[v]!);
        if (d < dist[v]!) {
          dist[v] = d;
          prev[v] = u;
        }
      }
    }
    const e = this.segments[end.segment]!;
    const via =
      dist[e.a]! + distance(this.points[e.a]!, end.at) <=
      dist[e.b]! + distance(this.points[e.b]!, end.at)
        ? e.a
        : e.b;
    if (dist[via] === Infinity) return undefined;
    const path: Point[] = [end.at];
    for (let v = via; v >= 0; v = prev[v]!) path.push(this.points[v]!);
    path.push(start.at);
    return path.reverse();
  }
}

/** The water polygons within reach of `path`, in its meters. */
function waterNear(
  features: readonly Feature<Geometry, Record<string, unknown>>[],
  project: (p: Position) => Point,
  path: readonly Point[],
): Point[][][] {
  const pad = BANK_MAX_M + 10;
  const xs = path.map((p) => p[0]);
  const ys = path.map((p) => p[1]);
  const [x0, x1, y0, y1] = [
    Math.min(...xs) - pad,
    Math.max(...xs) + pad,
    Math.min(...ys) - pad,
    Math.max(...ys) + pad,
  ];
  const out: Point[][][] = [];
  for (const f of features) {
    const polygons =
      f.geometry.type === 'Polygon'
        ? [f.geometry.coordinates]
        : f.geometry.type === 'MultiPolygon'
          ? f.geometry.coordinates
          : [];
    for (const polygon of polygons) {
      const rings = polygon.map((ring) => ring.map(project));
      // Keep it if its bbox overlaps the route's: a wide river's vertices may all be far off.
      const rx = rings[0]!.map((p) => p[0]);
      const ry = rings[0]!.map((p) => p[1]);
      if (
        Math.max(...rx) >= x0 &&
        Math.min(...rx) <= x1 &&
        Math.max(...ry) >= y0 &&
        Math.min(...ry) <= y1
      ) {
        out.push(rings);
      }
    }
  }
  return out;
}

function push(map: Map<number, number[]>, key: number, value: number) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** A feature's point: a point's own, else its label anchor, else its vertices' average. */
export function featurePoint(feature: Feature<Geometry, Record<string, unknown>>): Point {
  const { geometry, properties } = feature;
  if (geometry.type === 'Point') return geometry.coordinates as Point;
  const { label_lng, label_lat } = properties ?? {};
  if (typeof label_lng === 'number' && typeof label_lat === 'number') return [label_lng, label_lat];
  const all: Position[] = [];
  const walk = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === 'number') all.push(c as Position);
    else if (Array.isArray(c)) for (const x of c) walk(x);
  };
  walk('coordinates' in geometry ? geometry.coordinates : []);
  return [
    all.reduce((s, p) => s + p[0]!, 0) / all.length,
    all.reduce((s, p) => s + p[1]!, 0) / all.length,
  ];
}

/** Route points are at most this far apart, m, so the banks are known all along it. */
export const ROUTE_STEP_M = 10;
/** Banks are found in steps this long, m, up to `BANK_MAX_M` from the route. */
const BANK_STEP_M = 0.5;
const BANK_MAX_M = 60;

/** `path` with extra points so that none are more than `step` apart. */
export function resample(path: readonly Point[], step: number): Point[] {
  const out: Point[] = [path[0]!];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const n = Math.max(1, Math.ceil(distance(a, b) / step));
    for (let k = 1; k <= n; k++)
      out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

/**
 * How far the water reaches to the left and right of each point of `path` (m, across its
 * direction), from the water polygons (meters, the same projection). Undefined when the path
 * doesn't run through mapped water (a river drawn only as a line). A point outside the water
 * (a gap in the mapping) takes its nearest neighbor's banks.
 */
export function measureBanks(
  path: readonly Point[],
  water: readonly Point[][][],
): [number, number][] | undefined {
  const wet = (p: Point) => water.some((polygon) => pointInPolygon(p, polygon));
  const banks: ([number, number] | undefined)[] = path.map((p, i) => {
    if (!wet(p)) return undefined;
    const a = path[Math.max(0, i - 1)]!;
    const b = path[Math.min(path.length - 1, i + 1)]!;
    const length = distance(a, b) || 1;
    const [tx, ty] = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
    const reach = (nx: number, ny: number) => {
      let d = 0;
      while (
        d < BANK_MAX_M &&
        wet([p[0] + nx * (d + BANK_STEP_M), p[1] + ny * (d + BANK_STEP_M)])
      ) {
        d += BANK_STEP_M;
      }
      return d;
    };
    // Left of the direction of travel (y points north), then right.
    return [reach(-ty, tx), reach(ty, -tx)];
  });
  const known = banks.flatMap((b, i) => (b ? [i] : []));
  if (known.length < path.length / 2) return undefined;
  return banks.map((b, i) => {
    if (b) return b;
    const nearest = known.reduce((best, k) => (Math.abs(k - i) < Math.abs(best - i) ? k : best));
    return banks[nearest]!;
  });
}

/**
 * Resolve each procession's route along the rivers in `features`. Throws when a start or end
 * isn't in the data or isn't near a river, or when no river path joins them.
 */
export function routeProcessions(
  features: readonly Feature<Geometry, Record<string, unknown>>[],
  processions: readonly Extract<Procession, { kind: 'fluvial' }>[],
): { routes: Extract<ProcessionRoute, { kind: 'fluvial' }>[]; warnings: string[] };
export function routeProcessions(
  features: readonly Feature<Geometry, Record<string, unknown>>[],
  processions: readonly Procession[],
): { routes: ProcessionRoute[]; warnings: string[] };
export function routeProcessions(
  features: readonly Feature<Geometry, Record<string, unknown>>[],
  processions: readonly Procession[],
): { routes: ProcessionRoute[]; warnings: string[] } {
  const byId = new Map(features.map((f) => [f.properties?.id as string, f]));
  const rivers = features.filter((f) => f.properties?.class === 'water_river') as RiverFeature[];
  const waterAreas = features.filter(
    (f) =>
      (f.properties?.class === 'water_area' || f.properties?.class === 'water_river') &&
      (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'),
  );
  const routes: ProcessionRoute[] = [];
  const schedules = resolveProcessionSchedules(processions);
  const warnings: string[] = [];
  for (const p of processions) {
    const metadata = {
      id: p.id,
      title: p.title,
      status: p.status,
      schedule: schedules.get(p.id)!,
      ...(p.sources && { sources: p.sources }),
      ...(p.season && { season: p.season }),
      ...(p.label && { label: p.label }),
      ...('follows' in p.schedule && { follows: p.schedule.follows }),
    };
    if (p.kind === 'mass') {
      routes.push({ ...metadata, kind: p.kind, site: bakeMassSite(features, p) });
      continue;
    }
    if (p.kind !== 'fluvial') {
      const geography = routeStreet(features, p);
      if (p.kind === 'procession')
        routes.push({
          ...metadata,
          ...geography,
          kind: p.kind,
          ...(p.formation && { formation: p.formation }),
        });
      else
        routes.push({
          ...metadata,
          ...geography,
          kind: p.kind,
          ...(p.formation && { formation: p.formation }),
        });
      continue;
    }
    const find = (id: string) => {
      const f = byId.get(id);
      if (!f) throw new Error(`${p.id}: ${id} is not in the data`);
      return featurePoint(f);
    };
    const toLngLat = find(p.route.to);
    const graph = new RiverGraph(rivers, toLngLat);
    const snap = (lngLat: Point, what: string) => {
      const s = graph.snap(graph.project.to(lngLat));
      if (!s || s.off > MAX_SNAP_M) {
        throw new Error(`${p.id}: ${what} is ${s ? Math.round(s.off) : '∞'} m from a river`);
      }
      return s;
    };
    const end = snap(toLngLat, p.route.to);
    let path: Point[] | undefined;
    if (p.route.from) {
      path = graph.between(snap(find(p.route.from), p.route.from), end);
      if (!path) throw new Error(`${p.id}: no river joins ${p.route.from} and ${p.route.to}`);
    } else {
      path = graph.upstream(end, p.route.upstream_m!);
    }
    let length = 0;
    for (let i = 1; i < path.length; i++) length += distance(path[i - 1]!, path[i]!);
    path = resample(path, ROUTE_STEP_M);
    const banks = measureBanks(path, waterNear(waterAreas, graph.project.to, path));
    if (p.route.upstream_m && length < p.route.upstream_m - 1) {
      warnings.push(
        `${p.id}: the river ends ${Math.round(length)} m upstream, short of ${p.route.upstream_m} m`,
      );
    }
    routes.push({
      ...metadata,
      kind: p.kind,
      route: path.map((m) => graph.project.from(m).map((v) => Math.round(v * 1e7) / 1e7) as Point),
      length_m: Math.round(length),
      ...(banks
        ? { banks: banks.map(([l, r]) => [Math.round(l * 2) / 2, Math.round(r * 2) / 2]) }
        : {}),
      ...(p.formation ? { formation: p.formation } : {}),
      ...(p.sources ? { sources: p.sources } : {}),
    });
  }
  return { routes, warnings };
}
