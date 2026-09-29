/**
 * River processions' routes (DATA.md §2 step 07): follow the city's rivers in OSM from a
 * procession's start down to where it lands. OSM draws a waterway in the direction it flows,
 * so "upstream" walks the river's ways backwards.
 */
import type { Procession, ProcessionRoute } from '@atlas/shared';
import type { Feature, Geometry, Position } from 'geojson';

type RiverFeature = Feature<Geometry, { id?: string; class?: string; name?: string }>;

/** A start or end further than this from any river is an error in the pack, m. */
export const MAX_SNAP_M = 150;

type Point = [number, number];

/** Meters east and north of an origin, near enough flat over a few kilometers. */
function localMeters([lng0, lat0]: Point) {
  const kx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110_540;
  return {
    to: ([lng, lat]: Position): Point => [(lng! - lng0) * kx, (lat! - lat0) * ky],
    from: ([x, y]: Point): Point => [lng0 + x / kx, lat0 + y / ky],
  };
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

/**
 * Resolve each procession's route along the rivers in `features`. Throws when a start or end
 * isn't in the data or isn't near a river, or when no river path joins them.
 */
export function routeProcessions(
  features: readonly Feature<Geometry, Record<string, unknown>>[],
  processions: readonly Procession[],
): { routes: ProcessionRoute[]; warnings: string[] } {
  const byId = new Map(features.map((f) => [f.properties?.id as string, f]));
  const rivers = features.filter((f) => f.properties?.class === 'water_river') as RiverFeature[];
  const routes: ProcessionRoute[] = [];
  const warnings: string[] = [];
  for (const p of processions) {
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
    if (p.route.upstream_m && length < p.route.upstream_m - 1) {
      warnings.push(
        `${p.id}: the river ends ${Math.round(length)} m upstream, short of ${p.route.upstream_m} m`,
      );
    }
    routes.push({
      id: p.id,
      title: p.title,
      status: p.status,
      kind: p.kind,
      route: path.map((m) => graph.project.from(m).map((v) => Math.round(v * 1e7) / 1e7) as Point),
      length_m: Math.round(length),
      schedule: p.schedule,
      ...(p.formation ? { formation: p.formation } : {}),
      ...(p.sources ? { sources: p.sources } : {}),
    });
  }
  return { routes, warnings };
}
