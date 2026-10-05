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
      for (let i = 1; i < line.length; i++)
        add(
          `${f.properties.id}/${part}/${i}`,
          f.properties.id,
          width(f),
          node(line[i - 1] as SeasonalPoint),
          node(line[i] as SeasonalPoint),
        );
    });
  if (!edges.length) throw new Error(`${label}: empty roads`);

  // Resolve a frontage from complete source geometry, not a tile-owned place sample.
  const endpoint = (id: string | undefined) => {
    if (!id) return undefined;
    const f = byId.get(id);
    if (!f) throw new Error(`${label}: missing endpoint ${id}`);
    const xy = project(centroid(f).geometry.coordinates);
    let best: { edge: Edge; u: number; distance: number } | undefined;
    for (const e of edges) {
      const dx = e.b.xy[0] - e.a.xy[0],
        dy = e.b.xy[1] - e.a.xy[1];
      const u = Math.max(
        0,
        Math.min(1, ((xy[0] - e.a.xy[0]) * dx + (xy[1] - e.a.xy[1]) * dy) / e.length ** 2),
      );
      const distance = Math.hypot(xy[0] - e.a.xy[0] - u * dx, xy[1] - e.a.xy[1] - u * dy);
      if (!best || distance < best.distance) best = { edge: e, u, distance };
    }
    if (!best || best.distance > 200)
      throw new Error(`${label}: endpoint ${id} is not near its roads`);
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
  const from = endpoint(config.from),
    to = endpoint(config.to);
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
