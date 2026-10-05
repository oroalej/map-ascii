/** Shared full-source road graph, retaining the seasonal lattice and deterministic ties. */
import centroid from '@turf/centroid';
import type { SeasonalPoint } from '@atlas/shared';
import type { AtlasFeature } from '../03-normalize';
import { lines, width } from './road-geometry';
import { localFrame } from './geo';
type Node = { key: string; at: SeasonalPoint; xy: SeasonalPoint; edges: Edge[] };
type Edge = { id: string; road: string; width: number; a: Node; b: Node; length: number };
const pointKey = (p: SeasonalPoint) => `${p[0].toFixed(7)}/${p[1].toFixed(7)}`;

export function roadGraph(
  byId: ReadonlyMap<string, AtlasFeature>,
  roads: readonly AtlasFeature[],
  config: { from?: string; to?: string },
  label: string,
  requireConnected = true,
  allows?: (road: AtlasFeature, a: SeasonalPoint, b: SeasonalPoint) => boolean,
) {
  const positions = roads.flatMap((f) => lines(f).flat());
  const latitude = positions.reduce((n, p) => n + p[1]!, 0) / positions.length;
  // Keep the legacy pipeline scale, world lattice and coordinate-derived identities.
  const { toMeters: project, toLngLat: unproject } = localFrame([0, 0], latitude);
  const nodes = new Map<string, Node>(),
    edges: Edge[] = [];
  const node = (at: SeasonalPoint) => {
    const key = pointKey(at);
    let n = nodes.get(key);
    if (!n) {
      n = { key, at, xy: project(at), edges: [] };
      nodes.set(key, n);
    }
    return n;
  };
  const add = (id: string, road: string, w: number, a: Node, b: Node) => {
    const length = Math.hypot(b.xy[0] - a.xy[0], b.xy[1] - a.xy[1]);
    if (a === b || length < 0.01) return;
    const e = { id, road, width: w, a, b, length };
    edges.push(e);
    a.edges.push(e);
    b.edges.push(e);
  };
  for (const f of roads.slice().sort((a, b) => a.properties.id.localeCompare(b.properties.id)))
    lines(f).forEach((line, part) => {
      for (let i = 1; i < line.length; i++) {
        const a = line[i - 1] as SeasonalPoint,
          b = line[i] as SeasonalPoint;
        const xyA = project(a),
          xyB = project(b);
        const clear = allows?.(f, a, b) ?? true;
        const count = !clear ? Math.ceil(Math.hypot(xyB[0] - xyA[0], xyB[1] - xyA[1]) / 5) : 1;
        for (let k = 0; k < count; k++) {
          const at = (t: number): SeasonalPoint =>
            t === 0 ? a : t === 1 ? b : [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
          const start = at(k / count),
            end = at((k + 1) / count);
          if (!clear && allows && !allows(f, start, end)) continue;
          add(
            `${f.properties.id}/${part}/${i}${allows ? '/' + k : ''}`,
            f.properties.id,
            allows && f.properties.class === 'path'
              ? Number(f.properties.event_path_width ?? 0)
              : width(f),
            node(start),
            node(end),
          );
        }
      }
    });
  if (!edges.length) throw new Error(`${label}: empty roads`);

  // Resolve a frontage from complete source geometry, not a tile-owned place sample.
  const endpoint = (id: string | undefined, reachable?: ReadonlySet<Node>) => {
    if (!id) return undefined;
    const f = byId.get(id);
    if (!f) throw new Error(`${label}: missing endpoint ${id}`);
    const xy = project(centroid(f).geometry.coordinates);
    let best: { edge: Edge; u: number; distance: number } | undefined;
    let nearestAny = Infinity;
    for (const e of edges) {
      const dx = e.b.xy[0] - e.a.xy[0],
        dy = e.b.xy[1] - e.a.xy[1];
      const u = Math.max(
        0,
        Math.min(1, ((xy[0] - e.a.xy[0]) * dx + (xy[1] - e.a.xy[1]) * dy) / e.length ** 2),
      );
      const distance = Math.hypot(xy[0] - e.a.xy[0] - u * dx, xy[1] - e.a.xy[1] - u * dy);
      nearestAny = Math.min(nearestAny, distance);
      if (reachable && !reachable.has(e.a) && !reachable.has(e.b)) continue;
      if (!best || distance < best.distance) best = { edge: e, u, distance };
    }
    // A blocked frontage can move within a nearby block to its safe connected edge. Do not snap
    // across a severed route to a distant surviving stub just because it is within 200 m.
    if (!best || best.distance > 200 || (reachable && best.distance > nearestAny + 50))
      throw new Error(
        `${label}: endpoint ${id} is not near its roads (connected ${best?.distance.toFixed(1) ?? 'none'} m, nearest ${nearestAny.toFixed(1)} m)`,
      );
    const { edge: e, u } = best;
    if (u * e.length < 0.01) return e.a;
    if ((1 - u) * e.length < 0.01) return e.b;
    const n = node(
      unproject([e.a.xy[0] + u * (e.b.xy[0] - e.a.xy[0]), e.a.xy[1] + u * (e.b.xy[1] - e.a.xy[1])]),
    );
    edges.splice(edges.indexOf(e), 1);
    e.a.edges.splice(e.a.edges.indexOf(e), 1);
    e.b.edges.splice(e.b.edges.indexOf(e), 1);
    add(`${e.id}/a`, e.road, e.width, e.a, n);
    add(`${e.id}/b`, e.road, e.width, n, e.b);
    return n;
  };
  const from = endpoint(config.from);
  let reachable: Set<Node> | undefined;
  if (allows && from) {
    reachable = new Set([from]);
    const queue = [from];
    for (let i = 0; i < queue.length; i++)
      for (const edge of queue[i]!.edges) {
        const other = edge.a === queue[i] ? edge.b : edge.a;
        if (!reachable.has(other)) {
          reachable.add(other);
          queue.push(other);
        }
      }
  }
  const to = endpoint(config.to, reachable);
  const leaves = [...nodes.values()]
    .filter((n) => n.edges.length === 1)
    .sort((a, b) => a.xy[0] - b.xy[0] || a.xy[1] - b.xy[1]);
  if ((from || to) && !(from && to) && leaves.length !== 2)
    throw new Error(`${label}: branched route needs both endpoints`);
  let root = from ?? leaves[0] ?? nodes.values().next().value!;

  const distances = (start: Node) => {
    const dist = new Map<Node, number>([[start, 0]]),
      previous = new Map<Node, Edge>();
    const pending = new Set(nodes.values());
    while (pending.size) {
      let next: Node | undefined,
        nearest = Infinity;
      for (const n of pending)
        if ((dist.get(n) ?? Infinity) < nearest) {
          next = n;
          nearest = dist.get(n)!;
        }
      if (!next) break;
      pending.delete(next);
      for (const e of next.edges.slice().sort((a, b) => a.id.localeCompare(b.id))) {
        const other = e.a === next ? e.b : e.a,
          d = nearest + e.length;
        if (d < (dist.get(other) ?? Infinity)) {
          dist.set(other, d);
          previous.set(other, e);
        }
      }
    }
    if (requireConnected && dist.size !== nodes.size)
      throw new Error(`${label}: disconnected roads`);
    return { dist, previous };
  };
  if (to && !from) {
    const { dist } = distances(to);
    root = leaves.reduce((a, b) => (dist.get(a)! > dist.get(b)! ? a : b));
  }
  const { dist, previous } = distances(root);
  let selected = edges;
  if (from || to) {
    const end = to ?? leaves.reduce((a, b) => (dist.get(a)! > dist.get(b)! ? a : b));
    selected = [];
    for (let n = end; n !== root;) {
      const e = previous.get(n);
      if (!e) throw new Error(`${label}: empty endpoint route`);
      selected.push(e);
      n = e.a === n ? e.b : e.a;
    }
  }
  return { selected, dist, root, project, unproject };
}
