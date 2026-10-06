/** Complete-source street and church-ground event geography. */
import {
  pointInPolygon,
  PROCESSION_GEOMETRY,
  processionFormationWidth,
  type Procession,
  type ProcessionRoute,
} from '@atlas/shared';
import type { Feature, Geometry, Position } from 'geojson';
import type { AtlasFeature } from '../03-normalize';
import { localFrame } from './geo';
import { lines, width, eventWidth } from './road-geometry';
import { roadGraph } from './road-graph';
import { featurePoint, ROUTE_STEP_M } from './procession';
import { isStandingBuilding } from './obstacles';
import { intersection, union } from 'polyclip-ts';
import { seatingFootprint } from './footprints';

type Point = [number, number];
type F = Feature<Geometry, Record<string, unknown>>;
type Street = Extract<Procession, { kind: 'procession' | 'parade' }>;
type Mass = Extract<Procession, { kind: 'mass' }>;
const BRIDGE_APPROACH_M = 25,
  BARRIER_HALF_WIDTH_M = 0.5,
  MASS_CORRIDOR_INSET_M = 0.7;
const blockedAccess = (v: unknown) => v === 'no' || v === 'private';
const sidewalkWidth = (road: AtlasFeature) =>
  road.properties.class === 'path' || road.properties.sidewalk === 'none'
    ? 0
    : Number(road.properties.sidewalk_width ?? 1);
const polygons = (g: Geometry): Position[][][] =>
  g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
const asPoints = (ring: Position[]) => ring.map((p) => [p[0]!, p[1]!] as Point);
const featureBoxes = new WeakMap<F, [number, number, number, number]>();
function featureBox(f: F) {
  const saved = featureBoxes.get(f);
  if (saved) return saved;
  const positions = polygons(f.geometry)
    .flat(2)
    .concat(lines(f as AtlasFeature).flat());
  const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const q of positions) {
    box[0] = Math.min(box[0], q[0]!);
    box[1] = Math.min(box[1], q[1]!);
    box[2] = Math.max(box[2], q[0]!);
    box[3] = Math.max(box[3], q[1]!);
  }
  featureBoxes.set(f, box);
  return box;
}
const sourceIndexes = new WeakMap<readonly F[], { bins: Map<string, F[]>; large: F[] }>();
function nearbyFeatures(features: readonly F[], bounds: [number, number, number, number]) {
  let index = sourceIndexes.get(features);
  if (!index) {
    index = { bins: new Map(), large: [] };
    for (const f of features) {
      const box = featureBox(f),
        x0 = Math.floor(box[0] * 1000),
        y0 = Math.floor(box[1] * 1000),
        x1 = Math.floor(box[2] * 1000),
        y1 = Math.floor(box[3] * 1000);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 1024) {
        index.large.push(f);
        continue;
      }
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const key = `${x}/${y}`;
          let bin = index.bins.get(key);
          if (!bin) index.bins.set(key, (bin = []));
          bin.push(f);
        }
    }
    sourceIndexes.set(features, index);
  }
  const selected = new Set(index.large);
  for (let y = Math.floor(bounds[1] * 1000); y <= Math.floor(bounds[3] * 1000); y++)
    for (let x = Math.floor(bounds[0] * 1000); x <= Math.floor(bounds[2] * 1000); x++)
      for (const f of index.bins.get(`${x}/${y}`) ?? []) selected.add(f);
  return selected;
}

export function requiredFormationWidth(p: Street): number {
  return processionFormationWidth(p.kind, p.kind === 'parade' ? p.formation?.vehicles : []);
}

/** Polygon holes and linear barriers become explicit exclusion rings. */
function obstacles(
  features: readonly F[],
  frame: ReturnType<typeof localFrame>,
  bounds: [number, number, number, number],
  clip?: ReturnType<typeof union>,
  water?: Point[][],
  ignoreWater = false,
): Point[][] {
  const out: Point[][] = [];
  for (const f of nearbyFeatures(features, bounds)) {
    const [w, s, e, n] = featureBox(f);
    if (e < bounds[0] || w > bounds[2] || n < bounds[1] || s > bounds[3]) continue;
    const cls = String(f.properties.class);
    if (ignoreWater && cls.startsWith('water')) continue;
    if (
      isStandingBuilding(f as AtlasFeature) ||
      cls.startsWith('water') ||
      cls === 'barrier' ||
      f.properties.detail_blocked
    ) {
      const target = cls.startsWith('water') && water ? water : out;
      const save = (poly: Point[][]) => {
        if (clip) for (const part of intersection(poly, clip)) target.push(asPoints(part[0]!));
        else target.push(poly[0]!);
      };
      for (const poly of polygons(f.geometry)) save(poly.map(asPoints));
      if (cls === 'barrier' || f.properties.detail_blocked)
        for (const line of lines(f as AtlasFeature))
          for (let i = 1; i < line.length; i++) {
            const a = frame.toMeters(line[i - 1]!),
              b = frame.toMeters(line[i]!);
            const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
            if (!d) continue;
            const nx = (-(b[1] - a[1]) / d) * BARRIER_HALF_WIDTH_M,
              ny = ((b[0] - a[0]) / d) * BARRIER_HALF_WIDTH_M;
            const ring: Point[] = [
              [a[0] + nx, a[1] + ny],
              [b[0] + nx, b[1] + ny],
              [b[0] - nx, b[1] - ny],
              [a[0] - nx, a[1] - ny],
              [a[0] + nx, a[1] + ny],
            ];
            save([ring.map(frame.toLngLat)]);
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
    const effective = eventWidth(f as AtlasFeature);
    if (!Number.isFinite(effective) || effective < needed) return false;
    if (p.kind === 'parade' && p.formation?.vehicles.length) {
      if (
        tags.class === 'path' ||
        blockedAccess(tags.access) ||
        blockedAccess(tags.vehicle) ||
        blockedAccess(tags.motor_vehicle)
      )
        return false;
      for (const v of p.formation.vehicles)
        if (blockedAccess(tags[v === 'truck' ? 'hgv' : v === 'car' ? 'motorcar' : 'motorcycle']))
          return false;
    }
    return true;
  }) as AtlasFeature[];
  if (!roads.length) throw new Error(`${p.id}: no admissible roads for ${needed} m formation`);
  const byId = new Map(features.map((f) => [String(f.properties.id), f as AtlasFeature]));
  // Reject unsafe graph edges before shortest-path selection, so a roof conflict reroutes
  // rather than silently making the moving formation disappear midway through its path.
  const exclusions = features.filter(
    (f) =>
      isStandingBuilding(f as AtlasFeature) ||
      String(f.properties.class).startsWith('water') ||
      f.properties.class === 'barrier' ||
      f.properties.detail_blocked,
  );
  const bridgeEnds = roads
    .filter((r) => r.properties.bridge && r.properties.bridge !== 'no')
    .flatMap((r) => lines(r).flatMap((line) => [line[0]!, line.at(-1)!]));
  const bridgeAllowed = (road: AtlasFeature, a: Point, b: Point) => {
    if (road.properties.bridge && road.properties.bridge !== 'no') return true;
    // OSM water banks can extend just beyond the tagged deck. Only a directly connected
    // approach's first 25 m receives the same bounded carriageway permission.
    return bridgeEnds.some(
      (end) =>
        lines(road).some((line) =>
          [line[0]!, line.at(-1)!].some((q) => q[0] === end[0] && q[1] === end[1]),
        ) &&
        [a, b].every(
          (q) => Math.hypot(...localFrame(end as Point).toMeters(q)) <= BRIDGE_APPROACH_M,
        ),
    );
  };
  const allows = (road: AtlasFeature, a: Point, b: Point) => {
    const footprint = seatingFootprint([a, b], needed).coordinates as Point[][][];
    const points = footprint.flat(2);
    const bounds: [number, number, number, number] = [
      Math.min(...points.map((q) => q[0])),
      Math.min(...points.map((q) => q[1])),
      Math.max(...points.map((q) => q[0])),
      Math.max(...points.map((q) => q[1])),
    ];
    return (
      obstacles(exclusions, localFrame(a), bounds, footprint, undefined, bridgeAllowed(road, a, b))
        .length === 0
    );
  };
  const { selected, dist, root, unproject, project } = roadGraph(byId, roads, p.route, p.id, {
    event: { allows },
  });
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
    const count = Math.ceil(e.length / ROUTE_STEP_M);
    const road = byId.get(e.road)!;
    const sidewalk_m = sidewalkWidth(road);
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
  const corridors = ordered.map(
    (e) =>
      seatingFootprint([e.a.at, e.b.at], e.width + 2 * sidewalkWidth(byId.get(e.road)!))
        .coordinates as Point[][][],
  );
  // Balance clipping, rounding far below source precision, as seatingFootprint does.
  let merged = corridors.map((poly) =>
    poly.map((p) =>
      p.map((r) =>
        r.map(([x, y]) => [Math.round(x * 1e9) / 1e9, Math.round(y * 1e9) / 1e9] as Point),
      ),
    ),
  );
  while (merged.length > 1) {
    const next: ReturnType<typeof union>[] = [];
    for (let i = 0; i < merged.length; i += 2)
      next.push(i + 1 < merged.length ? union(merged[i]!, merged[i + 1]!) : merged[i]!);
    merged = next;
  }
  const corridor = merged[0]!;
  const water: Point[][] = [];
  const blocked = obstacles(features, frame, bounds, corridor, water);
  const bridges = ordered
    .filter((e) => {
      return bridgeAllowed(byId.get(e.road)!, e.a.at, e.b.at);
    })
    .flatMap((e) =>
      seatingFootprint([e.a.at, e.b.at], e.width).coordinates.map((poly) => asPoints(poly[0]!)),
    );
  return { route, length_m, segments, blocked, water, bridges };
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
  const square: Point[][][] = [[[a, [b[0], a[1]], b, [a[0], b[1]], a]]];
  const blocked = obstacles(features, frame, [a[0], a[1], b[0], b[1]], square);
  for (const poly of groundPolys)
    for (const hole of poly.slice(1))
      for (const part of intersection([hole], square)) blocked.push(asPoints(part[0]!));
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
        .map((line) => ({
          line: asPoints(line),
          width_m: Number(f.properties.event_path_width ?? 2),
        })),
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
        return (
          Math.hypot(q[0] - a[0] - u * dx, q[1] - a[1] - u * dy) <
          r.width_m / 2 - MASS_CORRIDOR_INSET_M
        );
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
  const step = PROCESSION_GEOMETRY.massCell,
    radius = Math.ceil(p.radius_m / step),
    cells = new Map<string, Point>();
  const exclusions = blocked.map((ring) => {
    const xy = ring.map(frame.toMeters);
    return {
      xy,
      w: Math.min(...xy.map((q) => q[0])),
      e: Math.max(...xy.map((q) => q[0])),
      s: Math.min(...xy.map((q) => q[1])),
      n: Math.max(...xy.map((q) => q[1])),
    };
  });
  const clearCell = ([x, y]: Point) => {
    const h = step / 2;
    const ring: Point[] = [
      [x - h, y - h],
      [x + h, y - h],
      [x + h, y + h],
      [x - h, y + h],
      [x - h, y - h],
    ];
    return !exclusions.some(
      (r) =>
        r.w <= x + h &&
        r.e >= x - h &&
        r.s <= y + h &&
        r.n >= y - h &&
        intersection([ring], [r.xy]).length > 0,
    );
  };
  const key = (x: number, y: number) => `${x}/${y}`;
  for (let y = -radius; y <= radius; y++)
    for (let x = -radius; x <= radius; x++) {
      const xy: Point = [x * step, y * step];
      if (
        [
          [0, 0],
          [-step / 2, -step / 2],
          [-step / 2, step / 2],
          [step / 2, -step / 2],
          [step / 2, step / 2],
        ].every(([dx, dy]) => safe([xy[0] + dx!, xy[1] + dy!])) &&
        clearCell(xy)
      )
        cells.set(key(x, y), xy);
    }
  // The closest safe cell can be an isolated sliver beside a facade. Choose a usable
  // connected gathering region first, then its nearest outdoor church-facing anchor.
  const visited = new Set<string>();
  let largest: string[] = [];
  const anchor = p.gathering_anchor && frame.toMeters(p.gathering_anchor);
  const nearest =
    anchor &&
    [...cells.keys()].sort((a, b) => {
      const distance = (id: string) =>
        Math.hypot(cells.get(id)![0] - anchor[0], cells.get(id)![1] - anchor[1]);
      return distance(a) - distance(b);
    })[0];
  if (
    anchor &&
    (!nearest ||
      Math.hypot(cells.get(nearest)![0] - anchor[0], cells.get(nearest)![1] - anchor[1]) > step)
  )
    throw new Error(`${p.id}: gathering_anchor is not on safe exterior ground`);
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
    if (nearest ? component.includes(nearest) : component.length > largest.length)
      largest = component;
  }
  const seedId =
    nearest ??
    largest.sort((a, b) => Math.hypot(...cells.get(a)!) - Math.hypot(...cells.get(b)!))[0];
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
