import {
  type EmergencyConfig,
  type EmergencyNetwork,
  type EmergencyPoint,
  type EmergencyTarget,
  type EmergencyTargetKind,
} from '@atlas/shared';
import type { AtlasFeature } from '../03-normalize';
import { localFrame } from './geo';
import { lines } from './road-geometry';

type Segment = { a: number; b: number; flow: -1 | 0 | 1; road: string };
type Chain = { vertices: number[]; road: string; flow: -1 | 0 | 1; length: number };
const roads = new Set(['road_major', 'road_mid', 'road_minor']);
const angle = (a: EmergencyPoint, b: EmergencyPoint) => {
  const [x, y] = localFrame(a).toMeters(b);
  return Math.atan2(-y, x) || 0;
};
function components(adjacency: number[][], reverse: number[][]) {
  const seen = new Set<number>(),
    order: number[] = [];
  for (let root = 0; root < adjacency.length; root++) {
    if (seen.has(root)) continue;
    seen.add(root);
    const stack = [{ v: root, at: 0 }];
    while (stack.length) {
      const top = stack[stack.length - 1]!,
        next = adjacency[top.v]![top.at++];
      if (next === undefined) {
        order.push(top.v);
        stack.pop();
      } else if (!seen.has(next)) {
        seen.add(next);
        stack.push({ v: next, at: 0 });
      }
    }
  }
  seen.clear();
  let largest: number[] = [];
  for (const root of order.reverse()) {
    if (seen.has(root)) continue;
    const stack = [root],
      group: number[] = [];
    seen.add(root);
    while (stack.length) {
      const v = stack.pop()!;
      group.push(v);
      for (const next of reverse[v]!)
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
    }
    if (group.length > largest.length) largest = group;
  }
  return new Set(largest);
}

/** Bounded Douglas–Peucker simplification, after exact snapping on the complete chain. */
function simplify(points: EmergencyPoint[], tolerance = 0.5): EmergencyPoint[] {
  if (points.length < 3) return points;
  const frame = localFrame(points[0]!),
    [bx, by] = frame.toMeters(points.at(-1)!);
  const length2 = bx * bx + by * by;
  let score = tolerance * tolerance,
    selected = -1;
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = frame.toMeters(points[i]!);
    const t = length2 ? Math.max(0, Math.min(1, (x * bx + y * by) / length2)) : 0;
    const distance2 = (x - t * bx) ** 2 + (y - t * by) ** 2;
    if (distance2 > score) {
      selected = i;
      score = distance2;
    }
  }
  return selected < 0
    ? [points[0]!, points.at(-1)!]
    : [
        ...simplify(points.slice(0, selected + 1), tolerance).slice(0, -1),
        ...simplify(points.slice(selected), tolerance),
      ];
}
function centroid(feature: AtlasFeature): EmergencyPoint | undefined {
  const g = feature.geometry;
  if (g.type === 'Point') return [g.coordinates[0]!, g.coordinates[1]!];
  const rings =
    g.type === 'Polygon'
      ? [g.coordinates[0]!]
      : g.type === 'MultiPolygon'
        ? g.coordinates.map((p) => p[0]!)
        : [];
  const points = rings.flatMap((ring) => ring.slice(0, -1));
  if (!points.length) return;
  return [
    points.reduce((n, p) => n + p[0]!, 0) / points.length,
    points.reduce((n, p) => n + p[1]!, 0) / points.length,
  ];
}

/** Directed source topology, contracted only through compatible degree-two source vertices. */
export function buildEmergencyGraph(
  features: readonly AtlasFeature[],
  config: EmergencyConfig,
): EmergencyNetwork {
  const points: EmergencyPoint[] = [],
    ids = new Map<string, number>(),
    segments: Segment[] = [];
  const node = (p: readonly number[]) => {
    const key = `${p[0]},${p[1]}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = points.length;
      ids.set(key, id);
      points.push([p[0]!, p[1]!]);
    }
    return id;
  };
  for (const feature of features) {
    if (!roads.has(feature.properties.class)) continue;
    const flow = feature.properties.oneway ?? 0;
    for (const line of lines(feature))
      for (let i = 1; i < line.length; i++) {
        const a = node(line[i - 1]!),
          b = node(line[i]!);
        if (a !== b) segments.push({ a, b, flow, road: feature.properties.id });
      }
  }
  const outgoing = points.map(() => [] as number[]),
    incoming = points.map(() => [] as number[]);
  for (const { a, b, flow } of segments) {
    if (flow >= 0) {
      outgoing[a]!.push(b);
      incoming[b]!.push(a);
    }
    if (flow <= 0) {
      outgoing[b]!.push(a);
      incoming[a]!.push(b);
    }
  }
  const main = components(outgoing, incoming);
  if (main.size < 2) throw new Error('emergency network needs a connected directed road component');
  const kept = segments.filter(({ a, b }) => main.has(a) && main.has(b)),
    adjacent = points.map(() => [] as number[]);
  kept.forEach(({ a, b }, i) => {
    adjacent[a]!.push(i);
    adjacent[b]!.push(i);
  });
  const anchors = new Set<number>();
  for (const v of main) {
    const at = adjacent[v]!;
    if (at.length !== 2) {
      anchors.add(v);
      continue;
    }
    const a = kept[at[0]!]!,
      b = kept[at[1]!]!;
    const directional = (s: Segment) => s.flow * (s.a === v ? 1 : -1);
    // A change of source identity or one-way permissions must survive contraction.
    if (
      a.road !== b.road ||
      (a.flow === 0) !== (b.flow === 0) ||
      (a.flow !== 0 && directional(a) === directional(b))
    )
      anchors.add(v);
  }
  if (!anchors.size) {
    // A stand-alone closed source way still needs two routing anchors.
    const sorted = [...main].sort((a, b) => a - b);
    anchors.add(sorted[0]!);
    anchors.add(sorted[Math.floor(sorted.length / 2)]!);
  }
  const visited = new Set<number>(),
    chains: Chain[] = [];
  for (const start of [...anchors].sort((a, b) => a - b))
    for (const first of adjacent[start]!) {
      if (visited.has(first)) continue;
      const vertices = [start],
        initial = kept[first]!;
      let v = start,
        edge = first,
        length = 0;
      while (!visited.has(edge)) {
        visited.add(edge);
        const s = kept[edge]!,
          next = s.a === v ? s.b : s.a;
        length += Math.hypot(...localFrame(points[v]!).toMeters(points[next]!));
        vertices.push(next);
        v = next;
        if (anchors.has(v)) break;
        edge = adjacent[v]!.find((i) => i !== edge)!;
      }
      chains.push({
        vertices,
        road: initial.road,
        flow: (initial.flow * (initial.a === start ? 1 : -1)) as -1 | 0 | 1,
        length,
      });
    }
  // Morton order makes neighbouring coordinate deltas small without changing connectivity.
  const minX = Math.min(...points.map((p) => p[0])),
    minY = Math.min(...points.map((p) => p[1]));
  const morton = (v: number) => {
    const p = points[v]!,
      x = Math.round((p[0] - minX) * 1e5),
      y = Math.round((p[1] - minY) * 1e5);
    let key = 0;
    for (let bit = 0; bit < 24; bit++)
      key += ((Math.floor(x / 2 ** bit) % 2) + 2 * (Math.floor(y / 2 ** bit) % 2)) * 4 ** bit;
    return key;
  };
  const order = [...anchors].sort((a, b) => morton(a) - morton(b) || a - b),
    index = new Map(order.map((v, i) => [v, i]));
  chains.sort(
    (a, b) =>
      index.get(a.vertices[0]!)! - index.get(b.vertices[0]!)! ||
      index.get(a.vertices.at(-1)!)! - index.get(b.vertices.at(-1)!)! ||
      a.road.localeCompare(b.road),
  );
  const nodes = order.map((v) => points[v]!),
    full = chains.map((c) => c.vertices.map((v) => points[v]!));
  const edges = chains.map((chain, i) => ({
    from: index.get(chain.vertices[0]!)!,
    to: index.get(chain.vertices.at(-1)!)!,
    length: chain.length,
    bearing: [
      angle(full[i]![0]!, full[i]![1]!),
      angle(full[i]!.at(-2)!, full[i]!.at(-1)!),
    ] as EmergencyPoint,
    oneway: chain.flow,
    shape: simplify(full[i]!),
  }));
  const frame = localFrame(nodes[0]!),
    grid = new Map<
      string,
      { edge: number; segment: number; along: number; a: EmergencyPoint; b: EmergencyPoint }[]
    >();
  for (let edge = 0; edge < full.length; edge++) {
    let along = 0;
    const shape = full[edge]!;
    for (let segment = 1; segment < shape.length; segment++) {
      const a = frame.toMeters(shape[segment - 1]!),
        b = frame.toMeters(shape[segment]!);
      const item = { edge, segment, along, a, b };
      for (
        let x = Math.floor(Math.min(a[0], b[0]) / 100);
        x <= Math.floor(Math.max(a[0], b[0]) / 100);
        x++
      )
        for (
          let y = Math.floor(Math.min(a[1], b[1]) / 100);
          y <= Math.floor(Math.max(a[1], b[1]) / 100);
          y++
        ) {
          const key = `${x}/${y}`,
            list = grid.get(key);
          if (list) list.push(item);
          else grid.set(key, [item]);
        }
      along += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
  }
  const snap = (
    feature: AtlasFeature,
    kind: EmergencyTargetKind,
    radius: number,
  ): EmergencyTarget | undefined => {
    const centre = centroid(feature);
    if (!centre) return;
    const [x, y] = frame.toMeters(centre),
      candidates = new Set<NonNullable<ReturnType<typeof grid.get>>[number]>();
    for (let cx = Math.floor((x - radius) / 100); cx <= Math.floor((x + radius) / 100); cx++)
      for (let cy = Math.floor((y - radius) / 100); cy <= Math.floor((y + radius) / 100); cy++)
        for (const item of grid.get(`${cx}/${cy}`) ?? []) candidates.add(item);
    let best = radius * radius,
      target: EmergencyTarget | undefined;
    for (const { edge, along, a, b } of candidates) {
      const dx = b[0] - a[0],
        dy = b[1] - a[1],
        length = Math.hypot(dx, dy);
      if (!length) continue;
      const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (length * length)));
      const qx = a[0] + t * dx,
        qy = a[1] + t * dy,
        distance2 = (x - qx) ** 2 + (y - qy) ** 2;
      if (distance2 >= best) continue;
      best = distance2;
      target = {
        id: feature.properties.id,
        kind,
        at: frame.toLngLat([qx, qy]),
        edge,
        t: Math.max(0, Math.min(1, (along + t * length) / edges[edge]!.length)),
        side: dx * (y - qy) - dy * (x - qx) >= 0 ? 1 : -1,
        road: chains[edge]!.road,
        tangent: [dx / length, dy / length],
      };
    }
    return target;
  };
  const targets: EmergencyTarget[] = [],
    cells = new Set<string>(),
    excluded = new Set(config.exclude);
  for (const feature of [...features].sort((a, b) =>
    a.properties.id.localeCompare(b.properties.id),
  )) {
    if (excluded.has(feature.properties.id)) continue;
    const p = feature.properties;
    const kind: EmergencyTargetKind | undefined =
      p.class === 'building_hospital'
        ? 'hospital'
        : p.kind === 'amenity=police'
          ? 'police'
          : p.kind === 'amenity=fire_station'
            ? 'fire'
            : undefined;
    if (kind) {
      const target = snap(feature, kind, 120);
      if (target) targets.push(target);
    } else if (p.class.startsWith('building')) {
      const at = centroid(feature);
      if (!at) continue;
      const [x, y] = frame.toMeters(at),
        cell = `${Math.floor(x / 100)}/${Math.floor(y / 100)}`;
      if (cells.has(cell)) continue;
      const target = snap(feature, 'building', 30);
      if (target) {
        cells.add(cell);
        targets.push(target);
      }
    }
  }
  for (const [configKind, targetKind] of [
    ['ambulance', 'hospital'],
    ['police', 'police'],
    ['fire', 'fire'],
  ] as const)
    if (config[configKind] && !targets.some((t) => t.kind === targetKind))
      throw new Error(`configured ${configKind} has no reachable ${targetKind} target`);
  if (config.fire && !targets.some((t) => t.kind === 'building'))
    throw new Error('configured fire has no reachable building target');
  return { nodes, edges, targets, source: config.source };
}
