/** Bake selected seasonal corridors before tiling; no city geography lives in the renderer. */
import centroid from '@turf/centroid';
import {
  utilitySeed,
  type BuntingCorridor,
  type SeasonConfig,
  type SeasonalPoint,
  type SeasonalBuntingRecord,
} from '@atlas/shared';
import type { AtlasFeature } from '../03-normalize';
import { lines, width } from './road-geometry';

type Node = { key: string; at: SeasonalPoint; xy: SeasonalPoint; edges: Edge[] };
type Edge = { id: string; road: string; width: number; a: Node; b: Node; length: number };
const pointKey = (p: SeasonalPoint) => `${p[0].toFixed(7)}/${p[1].toFixed(7)}`;

function bakeCorridor(features: readonly AtlasFeature[], season: string, config: BuntingCorridor) {
  if (!Number.isFinite(config.spacing_m) || config.spacing_m < 3 || config.spacing_m > 80)
    throw new Error(`Season ${season}, corridor ${config.id}: invalid spacing`);
  const byId = new Map(
    features.filter((f) => !f.properties.region).map((f) => [f.properties.id, f]),
  );
  const roads = config.ways.map((id) => {
    const f = byId.get(id);
    if (!f || !f.properties.class.startsWith('road_') || !lines(f).length)
      throw new Error(`Season ${season}, corridor ${config.id}: missing road ${id}`);
    return f;
  });
  const positions = roads.flatMap((f) => lines(f).flat());
  const latitude = positions.reduce((n, p) => n + p[1]!, 0) / positions.length;
  const mx = 111320 * Math.cos((latitude * Math.PI) / 180),
    my = 111320;
  const project = (p: SeasonalPoint): SeasonalPoint => [p[0] * mx, p[1] * my];
  const unproject = (p: SeasonalPoint): SeasonalPoint => [p[0] / mx, p[1] / my];
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
  if (!edges.length) throw new Error(`Season ${season}, corridor ${config.id}: empty roads`);

  // Resolve a frontage from complete source geometry, not a tile-owned place sample.
  const endpoint = (id: string | undefined) => {
    if (!id) return undefined;
    const f = byId.get(id);
    if (!f) throw new Error(`Season ${season}, corridor ${config.id}: missing endpoint ${id}`);
    const xy = project(centroid(f).geometry.coordinates as SeasonalPoint);
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
      throw new Error(
        `Season ${season}, corridor ${config.id}: endpoint ${id} is not near its roads`,
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
  const from = endpoint(config.from),
    to = endpoint(config.to);
  const leaves = [...nodes.values()]
    .filter((n) => n.edges.length === 1)
    .sort((a, b) => a.xy[0] - b.xy[0] || a.xy[1] - b.xy[1]);
  if ((from || to) && !(from && to) && leaves.length !== 2)
    throw new Error(`Season ${season}, corridor ${config.id}: branched route needs both endpoints`);
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
    if (dist.size !== nodes.size)
      throw new Error(`Season ${season}, corridor ${config.id}: disconnected roads`);
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
      if (!e) throw new Error(`Season ${season}, corridor ${config.id}: empty endpoint route`);
      selected.push(e);
      n = e.a === n ? e.b : e.a;
    }
  }
  const records = new Map<string, SeasonalBuntingRecord>();
  for (const e of selected.slice().sort((a, b) => a.id.localeCompare(b.id))) {
    const a = dist.get(e.a)! <= dist.get(e.b)! ? e.a : e.b,
      b = a === e.a ? e.b : e.a;
    const start = dist.get(a)!,
      nx = -(b.xy[1] - a.xy[1]) / e.length,
      ny = (b.xy[0] - a.xy[0]) / e.length;
    for (
      let d = Math.ceil((start - 1e-7) / config.spacing_m) * config.spacing_m;
      d < start + e.length - 1e-7;
      d += config.spacing_m
    ) {
      const u = Math.max(0, (d - start) / e.length),
        x = a.xy[0] + (b.xy[0] - a.xy[0]) * u,
        y = a.xy[1] + (b.xy[1] - a.xy[1]) * u;
      const at = unproject([x, y]),
        id = `season:${season}/${config.id}/${pointKey(at)}`;
      const reach = e.width / 2 + 0.5;
      records.set(id, {
        version: 1,
        kind: 'bunting',
        id,
        season,
        corridor: config.id,
        road: e.road,
        from: unproject([x - nx * reach, y - ny * reach]),
        to: unproject([x + nx * reach, y + ny * reach]),
        segment: [a.at, b.at],
        seed: utilitySeed(id),
      });
      if (records.size > 20000)
        throw new Error(`Season ${season}, corridor ${config.id}: too many rows`);
    }
  }
  if (!records.size) throw new Error(`Season ${season}, corridor ${config.id}: no bunting rows`);
  return { records: [...records.values()], meters: selected.reduce((n, e) => n + e.length, 0) };
}

export function generateSeasonalBunting(
  features: readonly AtlasFeature[],
  seasons?: readonly SeasonConfig[],
) {
  const records: SeasonalBuntingRecord[] = [],
    stats: { season: string; corridor: string; ways: number; meters: number; rows: number }[] = [];
  for (const season of seasons ?? [])
    for (const corridor of season.bunting?.corridors ?? []) {
      const baked = bakeCorridor(features, season.id, corridor);
      records.push(...baked.records);
      stats.push({
        season: season.id,
        corridor: corridor.id,
        ways: corridor.ways.length,
        meters: Math.round(baked.meters),
        rows: baked.records.length,
      });
    }
  records.sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(records.map((r) => r.id)).size !== records.length)
    throw new Error('Duplicate seasonal row identities');
  return { records, stats };
}
