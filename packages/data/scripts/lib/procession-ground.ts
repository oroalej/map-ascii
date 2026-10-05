/** Complete-source street and church-ground event geography. */
import { pointInPolygon, type Procession, type ProcessionRoute } from '@atlas/shared';
import type { Feature, Geometry, Position } from 'geojson';
import type { AtlasFeature } from '../03-normalize';
import { localFrame } from './geo';
import { lines, width } from './road-geometry';
import { roadGraph } from './road-graph';
import { featurePoint, PROCESSION_CLEARANCE } from './procession';
import { isStandingBuilding } from './obstacles';

type Point = [number, number];
type F = Feature<Geometry, Record<string, unknown>>;
type Street = Extract<Procession, { kind: 'procession' | 'parade' }>;
type Mass = Extract<Procession, { kind: 'mass' }>;
const blockedAccess = (v: unknown) => v === 'no' || v === 'private';
const polygons = (g: Geometry): Position[][][] =>
  g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
const asPoints = (ring: Position[]) => ring.map((p) => [p[0]!, p[1]!] as Point);

export function requiredFormationWidth(p: Street): number {
  if (p.kind === 'procession') {
    const bearers = p.formation?.bearers ?? 8;
    return (
      Math.max(
        PROCESSION_CLEARANCE.andasWidth,
        Math.min(4, Math.ceil(bearers / 2)) * PROCESSION_CLEARANCE.personPitch,
      ) +
      2 * PROCESSION_CLEARANCE.margin
    );
  }
  const vehicles = p.formation?.vehicles ?? [];
  return (
    Math.max(
      4 * PROCESSION_CLEARANCE.personPitch,
      ...vehicles.map((v) => PROCESSION_CLEARANCE.vehicleWidths[v]),
    ) +
    2 * PROCESSION_CLEARANCE.margin
  );
}

/** Polygon holes and linear barriers become explicit exclusion rings. */
function obstacles(
  features: readonly F[],
  frame: ReturnType<typeof localFrame>,
  bounds: [number, number, number, number],
): Point[][] {
  const out: Point[][] = [];
  for (const f of features) {
    const positions = polygons(f.geometry)
      .flat(2)
      .concat(lines(f as AtlasFeature).flat());
    if (!positions.length) continue;
    let w = Infinity,
      s = Infinity,
      e = -Infinity,
      n = -Infinity;
    for (const q of positions) {
      w = Math.min(w, q[0]!);
      s = Math.min(s, q[1]!);
      e = Math.max(e, q[0]!);
      n = Math.max(n, q[1]!);
    }
    if (e < bounds[0] || w > bounds[2] || n < bounds[1] || s > bounds[3]) continue;
    const cls = String(f.properties.class);
    if (
      isStandingBuilding(f as AtlasFeature) ||
      cls.startsWith('water') ||
      cls === 'barrier' ||
      f.properties.detail_blocked
    ) {
      for (const poly of polygons(f.geometry)) out.push(asPoints(poly[0]!));
      if (cls === 'barrier' || f.properties.detail_blocked)
        for (const line of lines(f as AtlasFeature))
          for (let i = 1; i < line.length; i++) {
            const a = frame.toMeters(line[i - 1]!),
              b = frame.toMeters(line[i]!);
            const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
            if (!d) continue;
            const nx = (-(b[1] - a[1]) / d) * 0.5,
              ny = ((b[0] - a[0]) / d) * 0.5;
            const ring: Point[] = [
              [a[0] + nx, a[1] + ny],
              [b[0] + nx, b[1] + ny],
              [b[0] - nx, b[1] - ny],
              [a[0] - nx, a[1] - ny],
              [a[0] + nx, a[1] + ny],
            ];
            out.push(ring.map(frame.toLngLat));
          }
    }
  }
  return out;
}

export function routeStreet(features: readonly F[], p: Street) {
  const needed = requiredFormationWidth(p);
  const roads = features.filter((f) => {
    const tags = f.properties;
    if (
      tags.region ||
      !lines(f as AtlasFeature).length ||
      !(String(tags.class).startsWith('road_') || tags.class === 'path')
    )
      return false;
    if (p.route.via && !p.route.via.includes(String(tags.id))) return false;
    if (
      ['steps', 'motorway', 'motorway_link'].includes(String(tags.highway)) ||
      blockedAccess(tags.foot) ||
      (blockedAccess(tags.access) && tags.foot !== 'yes')
    )
      return false;
    const effective = tags.class === 'path' ? Number(tags.width ?? 0) : width(f as AtlasFeature);
    if (!Number.isFinite(effective) || effective < needed) return false;
    if (p.kind === 'parade' && p.formation?.vehicles.length) {
      if (tags.class === 'path' || blockedAccess(tags.motor_vehicle)) return false;
      for (const v of p.formation.vehicles)
        if (blockedAccess(tags[v === 'truck' ? 'hgv' : v === 'car' ? 'motorcar' : 'motorcycle']))
          return false;
    }
    return true;
  }) as AtlasFeature[];
  if (!roads.length) throw new Error(`${p.id}: no admissible roads for ${needed} m formation`);
  const byId = new Map(features.map((f) => [String(f.properties.id), f as AtlasFeature]));
  const { selected, dist, root, unproject, project } = roadGraph(byId, roads, p.route, p.id, false);
  const ordered = selected
    .slice()
    .sort(
      (a, b) => Math.min(dist.get(a.a)!, dist.get(a.b)!) - Math.min(dist.get(b.a)!, dist.get(b.b)!),
    );
  const route: Point[] = [root.at];
  const segments: { id: string; width_m: number; sidewalk_m: number }[] = [];
  let length_m = 0;
  for (const e of ordered) {
    const a = dist.get(e.a)! <= dist.get(e.b)! ? e.a : e.b;
    const b = a === e.a ? e.b : e.a;
    const count = Math.ceil(e.length / 10);
    const road = byId.get(e.road)!;
    const sidewalk_m =
      road.properties.sidewalk === 'none' ? 0 : Number(road.properties.sidewalk_width ?? 1);
    for (let k = 1; k <= count; k++) {
      const t = k / count;
      route.push(unproject([a.xy[0] + (b.xy[0] - a.xy[0]) * t, a.xy[1] + (b.xy[1] - a.xy[1]) * t]));
      segments.push({ id: e.road, width_m: e.width, sidewalk_m });
    }
    length_m += e.length;
  }
  if (!length_m) throw new Error(`${p.id}: empty street route`);
  const frame = { toMeters: project, toLngLat: unproject };
  const bounds: [number, number, number, number] = [
    Math.min(...route.map((q) => q[0])) - 0.001,
    Math.min(...route.map((q) => q[1])) - 0.001,
    Math.max(...route.map((q) => q[0])) + 0.001,
    Math.max(...route.map((q) => q[1])) + 0.001,
  ];
  return { route, length_m, segments, blocked: obstacles(features, frame, bounds) };
}

/** Connected 2 m outdoor cells; row compaction gives small geographic permission polygons. */
export function bakeMassSite(
  features: readonly F[],
  p: Mass,
): Extract<ProcessionRoute, { kind: 'mass' }>['site'] {
  const byId = new Map(features.map((f) => [String(f.properties.id), f]));
  const church = byId.get(p.site);
  if (!church) throw new Error(`${p.id}: missing church ${p.site}`);
  const location = featurePoint(church);
  const frame = localFrame(location);
  const groundPolys = p.grounds.flatMap((id) => {
    const f = byId.get(id);
    if (!f || !polygons(f.geometry).length) throw new Error(`${p.id}: missing grounds ${id}`);
    return polygons(f.geometry).map((poly) => poly.map(asPoints));
  });
  const a = frame.toLngLat([-p.radius_m, -p.radius_m]),
    b = frame.toLngLat([p.radius_m, p.radius_m]);
  const blocked = obstacles(features, frame, [a[0], a[1], b[0], b[1]]);
  for (const poly of groundPolys) blocked.push(...poly.slice(1));
  const nearby = (line: Position[]) =>
    line.some((q) => Math.hypot(...frame.toMeters(q)) <= p.radius_m + 20);
  const roads = features
    .filter((f) => !f.properties.region && String(f.properties.class).startsWith('road_'))
    .flatMap((f) =>
      lines(f as AtlasFeature)
        .filter(nearby)
        .map((line) => ({ line: asPoints(line), width_m: width(f as AtlasFeature) })),
    );
  const paths = features
    .filter(
      (f) =>
        f.properties.class === 'path' &&
        !blockedAccess(f.properties.foot) &&
        !blockedAccess(f.properties.access),
    )
    .flatMap((f) =>
      lines(f as AtlasFeature)
        .filter(nearby)
        .map((line) => ({ line: asPoints(line), width_m: Number(f.properties.width ?? 2) })),
    );
  const corridors = [...roads, ...paths].map((r) => ({ ...r, xy: r.line.map(frame.toMeters) }));
  const nearLine = (q: Point) =>
    corridors.some((r) =>
      r.xy.slice(1).some((b, i) => {
        const a = r.xy[i]!,
          dx = b[0] - a[0],
          dy = b[1] - a[1],
          d = dx * dx + dy * dy;
        const u = d ? Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / d)) : 0;
        return Math.hypot(q[0] - a[0] - u * dx, q[1] - a[1] - u * dy) < r.width_m / 2 - 0.7;
      }),
    );
  const safe = (xy: Point) => {
    if (Math.hypot(...xy) > p.radius_m) return false;
    const q = frame.toLngLat(xy);
    return (
      !blocked.some((ring) => pointInPolygon(q, [ring])) &&
      (groundPolys.some((poly) => pointInPolygon(q, poly)) || nearLine(xy))
    );
  };
  const step = 2,
    radius = Math.ceil(p.radius_m / step),
    cells = new Map<string, Point>();
  const key = (x: number, y: number) => `${x}/${y}`;
  for (let y = -radius; y <= radius; y++)
    for (let x = -radius; x <= radius; x++) {
      const xy: Point = [x * step, y * step];
      if (
        [
          [0, 0],
          [-0.9, -0.9],
          [-0.9, 0.9],
          [0.9, -0.9],
          [0.9, 0.9],
        ].every(([dx, dy]) => safe([xy[0] + dx!, xy[1] + dy!]))
      )
        cells.set(key(x, y), xy);
    }
  // The closest safe cell can be an isolated sliver beside a facade. Choose a usable
  // connected gathering region first, then its nearest outdoor church-facing anchor.
  const visited = new Set<string>();
  let largest: string[] = [];
  for (const start of cells.keys()) {
    if (visited.has(start)) continue;
    const component = [start];
    visited.add(start);
    for (let i = 0; i < component.length; i++) {
      const [x, y] = component[i]!.split('/').map(Number);
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const next = key(x! + dx!, y! + dy!);
        if (cells.has(next) && !visited.has(next)) {
          visited.add(next);
          component.push(next);
        }
      }
    }
    if (component.length > largest.length) largest = component;
  }
  const seedId = largest.sort(
    (a, b) => Math.hypot(...cells.get(a)!) - Math.hypot(...cells.get(b)!),
  )[0];
  const seed = seedId ? ([seedId, cells.get(seedId)!] as const) : undefined;
  if (!seed) throw new Error(`${p.id}: no safe outdoor gathering area`);
  const connected = new Map<string, string | undefined>([[seed[0], undefined]]),
    queue = [seed[0]];
  for (let i = 0; i < queue.length; i++) {
    const [x, y] = queue[i]!.split('/').map(Number);
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const next = key(x! + dx!, y! + dy!);
      if (cells.has(next) && !connected.has(next)) {
        connected.set(next, queue[i]);
        queue.push(next);
      }
    }
  }
  const grounds: Point[][] = [];
  for (let y = -radius; y <= radius; y++) {
    for (let x = -radius; x <= radius; x++)
      if (connected.has(key(x, y))) {
        const start = x;
        while (x + 1 <= radius && connected.has(key(x + 1, y))) x++;
        const a = (start - 0.5) * step,
          b = (x + 0.5) * step,
          c = (y - 0.5) * step,
          d = (y + 0.5) * step;
        grounds.push(
          [
            [a, c],
            [b, c],
            [b, d],
            [a, d],
            [a, c],
          ].map((q) => frame.toLngLat(q as Point)),
        );
      }
  }
  const approaches: Point[][] = [];
  for (let sector = 0; sector < 8; sector++) {
    const theta = (sector * Math.PI) / 4;
    const end = queue.reduce((a, b) => {
      const score = (id: string) => {
        const q = cells.get(id)!;
        return q[0] * Math.cos(theta) + q[1] * Math.sin(theta);
      };
      return score(b) > score(a) ? b : a;
    });
    const path: Point[] = [];
    for (let id: string | undefined = end; id !== undefined; id = connected.get(id))
      path.push(frame.toLngLat(cells.get(id)!));
    if (path.length >= 2) approaches.push(path);
  }
  if (!approaches.length) throw new Error(`${p.id}: no connected outdoor approach`);
  return {
    id: p.site,
    location,
    anchor: frame.toLngLat(seed[1]),
    radius_m: p.radius_m,
    grounds,
    blocked,
    approaches,
    roads,
  };
}
