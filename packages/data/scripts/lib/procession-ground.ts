/** Complete-source street and church-ground event geography. */
import {
  pointInPolygon,
  localMetricProjection,
  PROCESSION_LIMITS,
  PROCESSION_GEOMETRY,
  processionAltarRadius,
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
import { seatingFootprint, balancedUnion } from './footprints';
import { safeLattice, compactLattice, bakeCrowdAreas } from './crowd-ground';
const VERGE_MAX_M = PROCESSION_LIMITS.verge;

type Point = [number, number];
type F = Feature<Geometry, Record<string, unknown>>;
type Street = Extract<Procession, { kind: 'procession' | 'parade' }>;
type Mass = Extract<Procession, { kind: 'mass' }>;
const BRIDGE_APPROACH_M = 25,
  BARRIER_HALF_WIDTH_M = 0.5,
  MASS_CORRIDOR_INSET_M = 0.7,
  SIDEWALK_FALLBACK_M = 2,
  ROUTE_BOUNDS_MARGIN_DEG = 0.001,
  MASS_PROXIMITY_MARGIN_M = 20,
  // Misregistered building corners can graze a mapped carriageway; less than one person's
  // footprint inside a route's clearance band does not cut the street.
  BUILDING_SLIVER_M2 = 0.1;
const isExclusion = (f: F) =>
  isStandingBuilding(f as AtlasFeature) ||
  String(f.properties.class).startsWith('water') ||
  f.properties.class === 'barrier' ||
  f.properties.class === 'seating' ||
  !!f.properties.detail_blocked ||
  (f.properties.class === 'building_part' && f.properties.variant === 'pedestal');
const blockedAccess = (v: unknown) => v === 'no' || v === 'private';
const walkable = (tags: Record<string, unknown>) => !blockedAccess(tags.foot ?? tags.access);
const vehicleAllowed = (tags: Record<string, unknown>, vehicle: 'truck' | 'car' | 'motorcycle') =>
  !blockedAccess(
    tags[vehicle === 'truck' ? 'hgv' : vehicle === 'car' ? 'motorcar' : 'motorcycle'] ??
      tags.motor_vehicle ??
      tags.vehicle ??
      tags.access,
  );
function sidewalks(road: AtlasFeature, reversed = false) {
  const tags = road.properties;
  const present = (side: 'left' | 'right') =>
    tags.class !== 'path' &&
    tags.sidewalk_src !== 'derived' &&
    (tags.sidewalk === 'both' || tags.sidewalk === side);
  const measured = (value: number | undefined) =>
    value !== undefined && Number.isFinite(value) && value >= 0 ? value : SIDEWALK_FALLBACK_M;
  const left = present('left') ? measured(tags.sidewalk_left_width ?? tags.sidewalk_width) : 0;
  const right = present('right') ? measured(tags.sidewalk_right_width ?? tags.sidewalk_width) : 0;
  return reversed ? { left: right, right: left } : { left, right };
}
const polygons = (g: Geometry): Position[][][] =>
  g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
const asPoints = (ring: Position[]) => ring.map((p) => [p[0]!, p[1]!] as Point);
const featureBoxes = new WeakMap<F, [number, number, number, number]>();
function featureBox(f: F) {
  const saved = featureBoxes.get(f);
  if (saved) return saved;
  const positions = polygons(f.geometry)
    .flat(2)
    .concat(
      lines(f as AtlasFeature).flat(),
      f.geometry.type === 'Point' ? [f.geometry.coordinates] : [],
    );
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
      const box = featureBox(f);
      if (!box.every(Number.isFinite) || box[0] > box[2] || box[1] > box[3]) continue;
      const x0 = Math.floor(box[0] * 1000),
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
  sliver = 0,
): Point[][] {
  const out: Point[][] = [];
  const area = (ring: Point[]) => {
    const m = ring.map(frame.toMeters);
    let sum = 0;
    for (let i = 1; i < m.length; i++) sum += m[i - 1]![0] * m[i]![1] - m[i]![0] * m[i - 1]![1];
    return Math.abs(sum) / 2;
  };
  for (const f of nearbyFeatures(features, bounds)) {
    const [w, s, e, n] = featureBox(f);
    if (e < bounds[0] || w > bounds[2] || n < bounds[1] || s > bounds[3]) continue;
    const cls = String(f.properties.class);
    if (ignoreWater && cls.startsWith('water')) continue;
    if (
      cls === 'barrier' &&
      (f.properties.variant === 'gate' || f.properties.barrier === 'gate') &&
      walkable(f.properties)
    )
      continue;
    if (isExclusion(f)) {
      const target = cls.startsWith('water') && water ? water : out;
      const tolerated = sliver > 0 && isStandingBuilding(f as AtlasFeature);
      const save = (poly: Point[][]) => {
        if (clip)
          for (const part of intersection(poly, clip)) {
            const ring = asPoints(part[0]!);
            if (!tolerated || area(ring) >= sliver) target.push(ring);
          }
        else target.push(poly[0]!);
      };
      for (const poly of polygons(f.geometry)) save(poly.map(asPoints));
      if (
        f.geometry.type === 'Point' &&
        (cls === 'barrier' || f.properties.detail_blocked || f.properties.variant === 'pedestal')
      ) {
        const at = frame.toMeters(f.geometry.coordinates);
        save([
          Array.from({ length: 17 }, (_, i) =>
            frame.toLngLat([
              at[0] + Math.cos(((i % 16) * Math.PI) / 8) * BARRIER_HALF_WIDTH_M,
              at[1] + Math.sin(((i % 16) * Math.PI) / 8) * BARRIER_HALF_WIDTH_M,
            ]),
          ),
        ]);
      }
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

function assembleExclusions(
  features: readonly F[],
  frame: ReturnType<typeof localFrame>,
  bounds: [number, number, number, number],
  pieces: Point[][][],
  allWater = false,
) {
  const water: Point[][] = [];
  const square: Point[][][] = [
    [
      [
        [bounds[0], bounds[1]],
        [bounds[2], bounds[1]],
        [bounds[2], bounds[3]],
        [bounds[0], bounds[3]],
        [bounds[0], bounds[1]],
      ],
    ],
  ];
  const boxes = pieces.map((poly) => {
    const q = poly.flat();
    return [
      Math.min(...q.map((p) => p[0])),
      Math.min(...q.map((p) => p[1])),
      Math.max(...q.map((p) => p[0])),
      Math.max(...q.map((p) => p[1])),
    ];
  });
  const nearby = [...nearbyFeatures(features, bounds)].filter((f) => {
    const [w, s, e, n] = featureBox(f);
    return boxes.some((b) => w <= b[2]! && e >= b[0]! && s <= b[3]! && n >= b[1]!);
  });
  // Only the part of an obstacle inside the crowd corridor shapes event ground; clipping
  // keeps deep building outlines from inflating the shipped event file.
  const cover = balancedUnion(pieces.map((poly) => [poly]));
  const blocked: Point[][] = [];
  for (const ring of obstacles(nearby, frame, bounds, square, undefined, true)) {
    const w = Math.min(...ring.map((p) => p[0])),
      s = Math.min(...ring.map((p) => p[1])),
      e = Math.max(...ring.map((p) => p[0])),
      n = Math.max(...ring.map((p) => p[1]));
    if (!boxes.some((b) => w <= b[2]! && e >= b[0]! && s <= b[3]! && n >= b[1]!)) continue;
    for (const part of intersection([ring], cover)) blocked.push(asPoints(part[0]!));
  }
  water.push(
    ...obstacles(
      (allWater ? [...nearbyFeatures(features, bounds)] : nearby).filter((f) =>
        String(f.properties.class).startsWith('water'),
      ),
      frame,
      bounds,
      square,
    ),
  );
  return { blocked, water };
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
    if (['steps', 'motorway', 'motorway_link'].includes(String(tags.highway)) || !walkable(tags))
      return false;
    const effective = eventWidth(f as AtlasFeature);
    if (!Number.isFinite(effective) || effective < needed) return false;
    if (p.kind === 'parade' && p.formation?.vehicles.length) {
      if (tags.class === 'path') return false;
      for (const v of p.formation.vehicles) if (!vehicleAllowed(tags, v)) return false;
    }
    return true;
  }) as AtlasFeature[];
  if (!roads.length) throw new Error(`${p.id}: no admissible roads for ${needed} m formation`);
  const byId = new Map(features.map((f) => [String(f.properties.id), f as AtlasFeature]));
  // Reject unsafe graph edges before shortest-path selection, so a roof conflict reroutes
  // rather than silently making the moving formation disappear midway through its path.
  const exclusions = features.filter(isExclusion);
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
  const allows = (road: AtlasFeature, a: Point, b: Point, clearance = needed) => {
    const footprint = seatingFootprint([a, b], clearance).coordinates as Point[][][];
    const points = footprint.flat(2);
    const bounds: [number, number, number, number] = [
      Math.min(...points.map((q) => q[0])),
      Math.min(...points.map((q) => q[1])),
      Math.max(...points.map((q) => q[0])),
      Math.max(...points.map((q) => q[1])),
    ];
    return (
      obstacles(
        exclusions,
        localFrame(a),
        bounds,
        footprint,
        undefined,
        bridgeAllowed(road, a, b),
        BUILDING_SLIVER_M2,
      ).length === 0
    );
  };
  const { path, root, unproject, project } = roadGraph(byId, roads, p.route, p.id, {
    event: { allows },
  });
  const ordered = path.map((step) => step.edge);
  const route: Point[] = [root.at];
  const segments: {
    id: string;
    width_m: number;
    sidewalk_m: number;
    sidewalks_m: { left: number; right: number };
    verge_m: { left: number; right: number };
    clear_m: number;
  }[] = [];
  let length_m = 0;
  for (const { edge: e, from: a, to: b } of path) {
    const count = Math.ceil(e.length / ROUTE_STEP_M);
    const road = byId.get(e.road)!;
    const sidewalks_m = sidewalks(road, a !== e.a);
    const qa = a.at,
      qb = b.at;
    let clear_m = needed;
    for (let candidate = needed + 0.5; candidate < e.width; candidate += 0.5) {
      if (!allows(road, qa, qb, candidate)) break;
      clear_m = candidate;
    }
    if (allows(road, qa, qb, e.width)) clear_m = e.width;
    const local = localFrame(qa),
      end = local.toMeters(qb),
      d = Math.hypot(...end);
    const verge = (side: number) => {
      let clear = 0;
      for (let depth = 0.5; depth <= VERGE_MAX_M; depth += 0.5) {
        const offset = side * (e.width / 2 + depth / 2);
        const shifted = [qa, qb].map((q) => {
          const m = local.toMeters(q);
          return local.toLngLat([m[0] - (end[1] / d) * offset, m[1] + (end[0] / d) * offset]);
        });
        const strip = seatingFootprint(shifted, depth).coordinates as Point[][][];
        if (
          obstacles(
            features,
            local,
            [
              Math.min(...strip.flat(2).map((q) => q[0])),
              Math.min(...strip.flat(2).map((q) => q[1])),
              Math.max(...strip.flat(2).map((q) => q[0])),
              Math.max(...strip.flat(2).map((q) => q[1])),
            ],
            strip,
          ).length
        )
          break;
        clear = depth;
      }
      return clear;
    };
    const verge_m = { left: verge(1), right: verge(-1) };
    for (let k = 1; k <= count; k++) {
      const t = k / count;
      route.push(unproject([a.xy[0] + (b.xy[0] - a.xy[0]) * t, a.xy[1] + (b.xy[1] - a.xy[1]) * t]));
      segments.push({
        clear_m,
        verge_m,
        id: e.road,
        width_m: e.width,
        sidewalk_m: Math.min(sidewalks_m.left, sidewalks_m.right),
        sidewalks_m,
      });
    }
    length_m += e.length;
  }
  if (!length_m) throw new Error(`${p.id}: empty street route`);
  const frame = { toMeters: project, toLngLat: unproject };
  const bounds: [number, number, number, number] = [
    Math.min(...route.map((q) => q[0])) - ROUTE_BOUNDS_MARGIN_DEG,
    Math.min(...route.map((q) => q[1])) - ROUTE_BOUNDS_MARGIN_DEG,
    Math.max(...route.map((q) => q[0])) + ROUTE_BOUNDS_MARGIN_DEG,
    Math.max(...route.map((q) => q[1])) + ROUTE_BOUNDS_MARGIN_DEG,
  ];
  const corridors = ordered.map((e) => {
    const tagged = sidewalks(byId.get(e.road)!);
    const sides = {
      left: Math.max(tagged.left, VERGE_MAX_M),
      right: Math.max(tagged.right, VERGE_MAX_M),
    };
    const dx = e.b.xy[0] - e.a.xy[0],
      dy = e.b.xy[1] - e.a.xy[1];
    const d = Math.hypot(dx, dy),
      offset = (sides.left - sides.right) / 2;
    const shift = (q: Point): Point =>
      unproject([q[0] - (dy / d) * offset, q[1] + (dx / d) * offset]);
    return seatingFootprint([shift(e.a.xy), shift(e.b.xy)], e.width + sides.left + sides.right)
      .coordinates as Point[][][];
  });
  const crowdPolys = (p.crowd_areas ?? []).flatMap((id) => {
    const f = byId.get(id);
    if (!f || !polygons(f.geometry).length) throw new Error(`${p.id}: missing crowd area ${id}`);
    return polygons(f.geometry).map((poly) => poly.map(asPoints));
  });
  for (const q of crowdPolys.flat(2)) {
    bounds[0] = Math.min(bounds[0], q[0]);
    bounds[1] = Math.min(bounds[1], q[1]);
    bounds[2] = Math.max(bounds[2], q[0]);
    bounds[3] = Math.max(bounds[3], q[1]);
  }
  const { blocked, water } = assembleExclusions(features, frame, bounds, [
    ...corridors.flat(),
    ...crowdPolys,
  ]);
  // Excluded grounds keep the roadside and area crowds out; the carriageway must stay open.
  if (p.crowd_exclude?.length) {
    const cover = balancedUnion([...corridors, ...crowdPolys.map((poly) => [poly])]);
    const carriageway = balancedUnion(
      ordered.map((e) => seatingFootprint([e.a.at, e.b.at], e.width).coordinates as Point[][][]),
    );
    for (const id of p.crowd_exclude) {
      const f = byId.get(id);
      if (!f || !polygons(f.geometry).length)
        throw new Error(`${p.id}: missing crowd exclusion ${id}`);
      const area = polygons(f.geometry).map((poly) => poly.map(asPoints));
      if (intersection(area, carriageway).length)
        throw new Error(`${p.id}: crowd exclusion ${id} overlaps the route carriageway`);
      for (const part of intersection(area, cover)) blocked.push(asPoints(part[0]!));
    }
  }
  const bridges = ordered
    .filter((e) => {
      return bridgeAllowed(byId.get(e.road)!, e.a.at, e.b.at);
    })
    .flatMap((e) =>
      seatingFootprint([e.a.at, e.b.at], e.width).coordinates.map((poly) => asPoints(poly[0]!)),
    );
  const crowd_grounds = bakeCrowdAreas(localFrame(route[0]!), crowdPolys, [...blocked, ...water]);
  return { route, length_m, segments, blocked, water, bridges, crowd_grounds };
}

const hardSources = new WeakMap<readonly F[], F[]>();

/** Connected 2 m outdoor cells; row compaction gives small geographic permission polygons. */
export function bakeMassSite(
  features: readonly F[],
  p: Mass,
  images = 0,
): Extract<ProcessionRoute, { kind: 'mass' }>['site'] {
  const byId = new Map(features.map((f) => [String(f.properties.id), f]));
  const church = byId.get(p.site);
  if (!church) throw new Error(`${p.id}: missing church ${p.site}`);
  const location = featurePoint(church);
  const frame = localFrame(location);
  const authoredPolys = p.grounds.flatMap((id) => {
    const f = byId.get(id);
    if (!f || !polygons(f.geometry).length) throw new Error(`${p.id}: missing grounds ${id}`);
    return polygons(f.geometry).map((poly) => poly.map(asPoints));
  });
  const groundPolys = p.crowd_boundary ? [[p.crowd_boundary]] : authoredPolys;
  const boundaryXY = p.crowd_boundary?.map(frame.toMeters);
  const radius_m = boundaryXY
    ? Math.ceil(Math.max(...boundaryXY.map((q) => Math.hypot(...q)))) + 2
    : p.radius_m;
  const a = frame.toLngLat([-radius_m, -radius_m]),
    b = frame.toLngLat([radius_m, radius_m]);
  const square: Point[][][] = [[[a, [b[0], a[1]], b, [a[0], b[1]], a]]];
  let hardSource = hardSources.get(features);
  if (!hardSource) {
    hardSource = features.filter((f) => f.properties.class !== 'seating');
    hardSources.set(features, hardSource);
  }
  const circle = (at: Point, radius: number) => {
    const c = frame.toMeters(at);
    return Array.from({ length: 33 }, (_, i) =>
      frame.toLngLat([
        c[0] + Math.cos(((i % 32) * Math.PI) / 16) * radius,
        c[1] + Math.sin(((i % 32) * Math.PI) / 16) * radius,
      ]),
    );
  };
  const domain = p.crowd_boundary ? [[p.crowd_boundary]] : square;
  const altarRing = p.altar && circle(p.altar.at, processionAltarRadius(p.altar.radius_m, images));
  const obstacleDomain = altarRing ? union(domain, [[altarRing]]) : domain;
  const obstacleBounds: [number, number, number, number] = [a[0], a[1], b[0], b[1]];
  if (altarRing)
    for (const [lng, lat] of altarRing) {
      obstacleBounds[0] = Math.min(obstacleBounds[0], lng);
      obstacleBounds[1] = Math.min(obstacleBounds[1], lat);
      obstacleBounds[2] = Math.max(obstacleBounds[2], lng);
      obstacleBounds[3] = Math.max(obstacleBounds[3], lat);
    }
  const hardBlocked = obstacles(hardSource, frame, obstacleBounds, obstacleDomain);
  const blocked = obstacles(features, frame, obstacleBounds, obstacleDomain);
  if (altarRing) blocked.push(altarRing);
  for (const poly of groundPolys)
    for (const hole of poly.slice(1))
      for (const part of intersection([hole], square)) blocked.push(asPoints(part[0]!));
  const nearby = (line: Position[]) =>
    line.some((q) => Math.hypot(...frame.toMeters(q)) <= radius_m + MASS_PROXIMITY_MARGIN_M);
  const roads = features
    .filter(
      (f) =>
        !f.properties.region &&
        String(f.properties.class).startsWith('road_') &&
        walkable(f.properties),
    )
    .flatMap((f) =>
      lines(f as AtlasFeature)
        .filter(nearby)
        .map((line) => ({ line: asPoints(line), width_m: width(f as AtlasFeature) })),
    );
  const paths = features
    .filter((f) => f.properties.class === 'path' && walkable(f.properties))
    .flatMap((f) =>
      lines(f as AtlasFeature)
        .filter(nearby)
        .map((line) => ({
          line: asPoints(line),
          width_m: eventWidth(f as AtlasFeature),
        })),
    )
    .filter((path) => Number.isFinite(path.width_m) && path.width_m > 0);
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
    if (!p.crowd_boundary && Math.hypot(...xy) > p.radius_m) return false;
    const q = frame.toLngLat(xy);
    return (
      !blocked.some((ring) => pointInPolygon(q, [ring])) &&
      (groundPolys.some((poly) => pointInPolygon(q, poly)) || (!p.crowd_boundary && nearLine(xy)))
    );
  };
  const step = PROCESSION_GEOMETRY.massCell,
    cells = safeLattice(frame, [-radius_m, -radius_m, radius_m, radius_m], safe, blocked, step);
  const key = (x: number, y: number) => `${x}/${y}`;
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
  const grounds = compactLattice(
    frame,
    p.crowd_boundary ? cells : new Map([...cells].filter(([id]) => connected.has(id))),
    step,
  );
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
  const seated_grounds = bakeCrowdAreas(
    frame,
    features
      .filter((f) => f.properties.class === 'seating')
      .flatMap((f) => polygons(f.geometry).map((poly) => poly.map(asPoints)))
      .map((poly) =>
        p.crowd_boundary
          ? intersection(poly, [p.crowd_boundary]).map((p) => p.map(asPoints))
          : intersection(poly, square).map((p) => p.map(asPoints)),
      )
      .flat()
      .flatMap((poly) => seatingFootprint(poly[0]!, 3).coordinates.map((p) => p.map(asPoints)))
      .flatMap((poly) =>
        p.crowd_boundary
          ? intersection(poly, [p.crowd_boundary]).map((p) => p.map(asPoints))
          : intersection(poly, square).map((p) => p.map(asPoints)),
      ),
    hardBlocked,
    0.5,
  );
  const fillFrame = localMetricProjection(p.altar?.at ?? location);
  let extent = 0;
  for (const ring of [...grounds, ...seated_grounds])
    for (const point of ring) extent = Math.max(extent, Math.hypot(...fillFrame.to(point)));
  const crowdRadius = Math.max(p.radius_m, Math.ceil(extent));
  if (crowdRadius > PROCESSION_LIMITS.radius)
    throw new Error(
      `${p.id}: baked crowd extent ${crowdRadius} m exceeds ${PROCESSION_LIMITS.radius} m`,
    );
  return {
    id: p.site,
    location,
    anchor: frame.toLngLat(seed[1]),
    radius_m: crowdRadius,
    ...(p.crowd_boundary && { closure_zone: [p.crowd_boundary] }),
    seated_grounds,
    ...(p.altar && {
      altar: { ...p.altar, images },
      altar_ground: bakeCrowdAreas(frame, [[altarRing!]], hardBlocked, 0.5),
    }),
    grounds,
    blocked: hardBlocked,
    approaches,
    roads: p.crowd_boundary ? [] : roads,
  };
}

/** Spectators stand only along the river sides: from the water's edge to this far inland. */
const RIVERSIDE_M = 8;
/** Riverside bands are the only permissions; water and bridge decks stay clear. */
export function bakeFluvialCrowd(
  features: readonly F[],
  route: Point[],
  banks: [number, number][],
) {
  const frame = localFrame(route[0]!);
  const strips: Point[][][] = [],
    river: Point[][][] = [];
  // Crowd permissions need fewer bank joins than the unchanged 10 m boat route.
  for (let start = 0; start < route.length - 1; start += 3) {
    const i = Math.min(start + 3, route.length - 1);
    const a = frame.toMeters(route[start]!),
      b = frame.toMeters(route[i]!);
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!d) continue;
    const left = Math.max(...banks.slice(start, i + 1).map((p) => p[0])),
      right = Math.max(...banks.slice(start, i + 1).map((p) => p[1]));
    const offset = (left - right) / 2;
    const centre = [a, b].map((q) =>
      frame.toLngLat([q[0] - ((b[1] - a[1]) / d) * offset, q[1] + ((b[0] - a[0]) / d) * offset]),
    );
    river.push(
      ...seatingFootprint(centre, Math.max(1, left + right + 2)).coordinates.map((poly) =>
        poly.map(asPoints),
      ),
    );
    for (const side of [-1, 1]) {
      const index = side > 0 ? 0 : 1;
      // From inside the narrowest bank (mapped water is blocked) to inland of the widest.
      const reach = banks.slice(start, i + 1).map((p) => p[index]);
      const inner = Math.min(...reach) - 2,
        outer = Math.max(...reach) + RIVERSIDE_M;
      const offset = (side * (inner + outer)) / 2;
      const line = [a, b].map((q) =>
        frame.toLngLat([q[0] - ((b[1] - a[1]) / d) * offset, q[1] + ((b[0] - a[0]) / d) * offset]),
      );
      strips.push(
        ...seatingFootprint(line, outer - inner).coordinates.map((poly) => poly.map(asPoints)),
      );
    }
  }
  const points = route;
  const bounds: [number, number, number, number] = [
    Math.min(...points.map((q) => q[0])) - 0.001,
    Math.min(...points.map((q) => q[1])) - 0.001,
    Math.max(...points.map((q) => q[0])) + 0.001,
    Math.max(...points.map((q) => q[1])) + 0.001,
  ];
  const relevant = [...strips, ...river];
  const decks = features
    .filter((f) => f.properties.bridge && f.properties.bridge !== 'no' && walkable(f.properties))
    .flatMap((f) =>
      lines(f as AtlasFeature).flatMap((line) => {
        const deck = seatingFootprint(asPoints(line), width(f as AtlasFeature))
          .coordinates as Point[][][];
        return relevant.flatMap((poly) =>
          intersection(deck, poly).map((part) => asPoints(part[0]!)),
        );
      }),
    );
  const pieces = strips;
  // Balanced union keeps source precision and avoids a sequential growing sweep.
  const groups = pieces.map(
    (p) =>
      [
        p.map((r) =>
          r.map(([x, y]) => [Math.round(x * 1e9) / 1e9, Math.round(y * 1e9) / 1e9] as Point),
        ),
      ] as ReturnType<typeof union>,
  );
  const envelope = balancedUnion(groups);
  const { blocked, water } = assembleExclusions(features, frame, bounds, pieces, true);
  for (const polygon of envelope) for (const hole of polygon.slice(1)) blocked.push(asPoints(hole));
  blocked.push(...decks);
  return { grounds: envelope.map((p) => asPoints(p[0]!)), blocked, water, bridges: [] };
}
