import {
  canonicalSignalSeed,
  crossingControllerProperties,
  SignalStops,
  SignalController,
  SignalLayout,
  type SignalArm,
  type City,
  type CityLifeConfig,
} from '@atlas/shared';
import {
  applyRoadDirections,
  mergeStreetDetails,
  signalStop,
  type RoadArm,
  type StreetStats,
} from './streets';
import type { Position } from 'geojson';
import { TILE_ZOOMS, type AtlasFeature } from '../03-normalize';
import { resolveSignalLayout } from './signal-layout';
import { delta, key, lines, point, width, SIGNAL_STOP_GAP_M } from './road-geometry';
import { armKey, armPath, pathDistance, pathPoint } from './signal-path';

type Arm = RoadArm;
type Junction = { p: Position; arms: Arm[] };
const distance = (a: Position, b: Position) => Math.hypot(...delta(a, b));
const bearing = (a: Position, b: Position) => {
  const [x, y] = delta(a, b);
  return ((Math.atan2(x, y) * 180) / Math.PI + 180) % 180;
};
const angle = (a: number, b: number) => Math.min(Math.abs(a - b), 180 - Math.abs(a - b));

/** Exact road vertices only: a geometric intersection may be a bridge. */
function roadVertexArms(features: readonly AtlasFeature[]): Map<string, Junction> {
  const vertices = new Map<string, Junction>();
  for (const road of features) {
    if (road.properties.region || !road.properties.class.startsWith('road_')) continue;
    for (const line of lines(road))
      for (let i = 0; i < line.length; i++) {
        const p = line[i]!;
        const vertex = vertices.get(key(p)) ?? { p, arms: [] };
        for (const j of [i - 1, i + 1])
          if (line[j])
            vertex.arms.push({
              road,
              bearing: bearing(p, line[j]),
              toward: line[j],
              forward: j > i,
            });
        vertices.set(key(p), vertex);
      }
  }
  return vertices;
}

export function roadJunctions(features: readonly AtlasFeature[]): Junction[] {
  return [...roadVertexArms(features).values()].filter((v) => v.arms.length >= 3);
}

/** Add point anchors for stripes, keeping crossing ways as pedestrian geometry. */
export function mergeTraffic(
  features: AtlasFeature[],
  config?: CityLifeConfig['signals'],
  streets?: City['streets'],
  report?: (stats: StreetStats) => void,
): AtlasFeature[] {
  features = applyRoadDirections(features, streets?.directions);
  const roads = features
    .filter((f) => !f.properties.region && f.properties.class.startsWith('road_'))
    .sort((a, b) => a.properties.id.localeCompare(b.properties.id));
  const junctions = roadJunctions(roads);
  const roadVertices = new Map<string, { road: AtlasFeature; bearing: number; line: Position[] }>();
  for (const road of roads)
    for (const line of lines(road))
      line.forEach((p, i) => {
        const other = line[i + 1] ?? line[i - 1];
        if (other && !roadVertices.has(key(p)))
          roadVertices.set(key(p), { road, bearing: bearing(p, other), line });
      });
  const nearestJunction = (p: Position, reach: number) =>
    junctions
      .filter((j) => distance(p, j.p) <= reach)
      .sort((a, b) => distance(p, a.p) - distance(p, b.p))[0];
  const crossings = new Map<string, AtlasFeature>();
  const crossingRoads = new Map<AtlasFeature, { road: AtlasFeature; line: Position[] }>();
  function crossing(
    p: Position,
    road: AtlasFeature,
    axis: number,
    mapped: boolean,
    id: string,
    line: Position[],
  ) {
    const previous = crossings.get(key(p));
    if (previous) return previous;
    const feature = point(id, p, {
      variant: 'crossing',
      crossing_bearing: Math.round(axis * 10) / 10,
      crossing_width: width(road),
      crossing_road: road.properties.class,
      source: mapped ? 'OpenStreetMap' : 'Simulated crossing at a signalized junction',
    });
    crossings.set(key(p), feature);
    crossingRoads.set(feature, { road, line });
    return feature;
  }
  for (const f of features.filter(
    (f) => f.properties.variant === 'crossing' && !f.properties.region,
  )) {
    if (f.geometry.type !== 'Point') {
      for (const line of lines(f))
        for (const p of line) {
          const match = roadVertices.get(key(p));
          if (match)
            crossing(
              p,
              match.road,
              match.bearing,
              true,
              `${f.properties.id}:crossing:${key(p)}`,
              match.line,
            );
        }
      continue;
    }
    const p = f.geometry.coordinates;
    let nearest:
      { p: Position; road: AtlasFeature; axis: number; d: number; line: Position[] } | undefined;
    for (const road of roads)
      for (const line of lines(road))
        for (let i = 1; i < line.length; i++) {
          const a = line[i - 1]!,
            b = line[i]!;
          const [x, y] = delta(a, b),
            [px, py] = delta(a, p);
          const t = Math.max(0, Math.min(1, (px * x + py * y) / (x * x + y * y || 1)));
          const q = [a[0]! + (b[0]! - a[0]!) * t, a[1]! + (b[1]! - a[1]!) * t];
          const d = distance(p, q);
          if (d <= 20 && (!nearest || d < nearest.d))
            nearest = { p: q, road, axis: bearing(a, b), d, line };
        }
    if (nearest)
      crossing(nearest.p, nearest.road, nearest.axis, true, f.properties.id, nearest.line);
  }
  const signals: AtlasFeature[] = [];
  function signal(p: Position, mapped: boolean, id: string, source: string, snap = 30) {
    const j = nearestJunction(p, snap),
      center = j?.p ?? p;
    if (
      signals.some(
        (s) => distance(center, (s.geometry as { coordinates: Position }).coordinates) < 1,
      )
    )
      return;
    const arms = j?.arms ?? [],
      a = arms[0]?.bearing ?? -1;
    const b = arms.find((arm) => angle(arm.bearing, a) >= 45)?.bearing ?? (a + 90) % 180;
    signals.push(
      point(id, center, {
        variant: 'signals',
        life_signal: mapped ? 'mapped' : 'derived',
        signal_a: a,
        signal_b: b,
        signal_radius: Math.max(3, ...arms.map((arm) => width(arm.road) / 2)) + 1,
        signal_seed: canonicalSignalSeed(center[0]!, center[1]!, TILE_ZOOMS.max),
        source,
      }),
    );
  }
  for (const f of features)
    if (f.properties.variant === 'signals' && f.geometry.type === 'Point')
      signal(f.geometry.coordinates, true, f.properties.id, 'OpenStreetMap');
  for (const override of config?.add ?? [])
    signal(override.position, true, `pack:signal:${override.id}`, override.source);
  if (config?.derive !== false)
    for (const j of junctions) {
      if (j.arms.length < 4) continue;
      const a = j.arms[0]!.bearing;
      if (
        ![false, true].every((group) =>
          j.arms.some(
            (arm) =>
              angle(arm.bearing, a) >= 45 === group && arm.road.properties.class !== 'road_minor',
          ),
        )
      )
        continue;
      if (
        signals.some(
          (s) =>
            distance(j.p, (s.geometry as { coordinates: Position }).coordinates) <
            (s.properties.life_signal === 'mapped' ? 50 : 40),
        )
      )
        continue;
      signal(
        j.p,
        false,
        `derived:signal:${key(j.p)}`,
        'Simulated signal at a shared major/mid road junction',
        1,
      );
    }
  const kept = signals.filter(
    (s) =>
      !(config?.remove ?? []).some((r) =>
        r.osm_id
          ? s.properties.id === `osm:node/${r.osm_id}`
          : distance(r.position!, (s.geometry as { coordinates: Position }).coordinates) <= 30,
      ),
  );
  const initialVertices = roadVertexArms(roads);
  for (const s of kept) {
    const p = (s.geometry as { coordinates: Position }).coordinates;
    // Mid-block controllers may lie inside a segment rather than at an OSM vertex.
    if (!initialVertices.has(key(p))) {
      const candidates = roads
        .flatMap((road) =>
          lines(road).flatMap((line) =>
            line.slice(1).map((b, i) => {
              const a = line[i]!,
                [x, y] = delta(a, b),
                [px, py] = delta(a, p);
              const t = (px * x + py * y) / (x * x + y * y || 1);
              return t >= 0 && t <= 1 && Math.hypot(px - t * x, py - t * y) < 0.01
                ? { road, a, b, line }
                : undefined;
            }),
          ),
        )
        .filter((v) => v !== undefined);
      const match = candidates[0];
      if (match) {
        match.line.splice(match.line.indexOf(match.b), 0, p);
      }
    }
  }
  const vertices = roadVertexArms(roads);
  const owned = new Set<string>();
  const resolved = kept.map((s) => {
    const linked = config?.add?.find(
      (a) => s.properties.id === `pack:signal:${a.id}`,
    )?.linked_junctions;
    const layout = resolveSignalLayout(s, vertices, linked);
    for (const p of layout?.members ?? []) {
      if (owned.has(key(p))) throw new Error(`Duplicate signal junction membership: ${key(p)}`);
      owned.add(key(p));
    }
    const p = (s.geometry as { coordinates: Position }).coordinates;
    const external = layout
      ? layout.arms.map((a) => ({
          p: a.junction,
          arm: vertices
            .get(key(a.junction))!
            .arms.find(
              (arm) => arm.road.properties.id === a.road_id && key(arm.toward) === key(a.toward),
            )!,
          group: a.group,
        }))
      : (vertices.get(key(p))?.arms ?? []).map((arm) => ({
          p,
          arm,
          group:
            s.properties.signal_a! < 0 ||
            angle(arm.bearing, s.properties.signal_a!) <= angle(arm.bearing, s.properties.signal_b!)
              ? ('a' as const)
              : ('b' as const),
        }));
    return { s, p, linked, layout, external, setbacks: new Map<string, number>() };
  });
  type Claim = {
    entry: (typeof resolved)[number];
    arm: (typeof resolved)[number]['external'][number];
    crossing: AtlasFeature;
    d: number;
    armId: string;
  };
  const claims: Claim[] = [];
  for (const entry of resolved)
    for (const arm of entry.external) {
      const path = armPath(arm.p, arm.arm, vertices);
      if (!path) continue;
      for (const c of crossings.values()) {
        const match = crossingRoads.get(c)!;
        if (
          !path.segments.some(
            (segment) => segment.road === match.road && segment.line === match.line,
          )
        )
          continue;
        const d = pathDistance(path.points, (c.geometry as { coordinates: Position }).coordinates);
        const mid = entry.s.properties.signal_a! < 0;
        if (
          d === undefined ||
          (mid ? d < 0 : d <= 0) ||
          d > entry.s.properties.signal_radius! + (mid ? 3 : 15)
        )
          continue;
        const inbound =
          !arm.arm.road.properties.oneway ||
          arm.arm.road.properties.oneway === (arm.arm.forward ? -1 : 1);
        if (
          path.length <
          Math.max(
            d + 1.5,
            inbound
              ? Math.max(
                  entry.s.properties.signal_radius! + SIGNAL_STOP_GAP_M,
                  d + 1.5 + SIGNAL_STOP_GAP_M,
                )
              : 0,
          )
        )
          continue;
        claims.push({ entry, arm, crossing: c, d, armId: armKey(arm.p, arm.arm) });
      }
    }
  claims.sort(
    (a, b) =>
      a.d - b.d ||
      a.entry.s.properties.id.localeCompare(b.entry.s.properties.id) ||
      a.armId.localeCompare(b.armId),
  );
  const selected = new Map<string, Claim>(),
    claimed = new Set<AtlasFeature>();
  for (const claim of claims) {
    const k = JSON.stringify([claim.entry.s.properties.id, claim.armId]);
    if (selected.has(k) || claimed.has(claim.crossing)) continue;
    selected.set(k, claim);
    claimed.add(claim.crossing);
  }
  let shortCrossingArms = 0;
  for (const entry of resolved) {
    const { s } = entry;
    const midBlock = s.properties.signal_a! < 0;
    const legacy: SignalArm[] = [];
    for (const external of entry.external) {
      const { p, arm, group } = external,
        k = armKey(p, arm);
      const path = armPath(p, arm, vertices);
      let choice = selected.get(JSON.stringify([s.properties.id, k]));
      if (midBlock && !choice)
        choice = [...selected.values()].find(
          (c) => c.entry === entry && c.arm.arm.road === arm.road,
        );
      const d = choice
        ? choice.armId === k
          ? choice.d
          : -choice.d
        : midBlock
          ? 0
          : s.properties.signal_radius! + 2;
      const inbound =
        !arm.road.properties.oneway || arm.road.properties.oneway === (arm.forward ? -1 : 1);
      const setback = Math.max(
        s.properties.signal_radius! + SIGNAL_STOP_GAP_M,
        d + 1.5 + SIGNAL_STOP_GAP_M,
      );
      if (!path || path.length < Math.max(d + 1.5, inbound ? setback : 0)) {
        shortCrossingArms++;
        entry.setbacks.set(k, Infinity);
        continue;
      }
      let c = choice?.crossing;
      if (!c && !midBlock) {
        const at = pathPoint(path.points, d)!;
        const segment = path.segments[at.segment]!;
        c = crossing(
          at.position,
          segment.road,
          at.bearing % 180,
          false,
          `${s.properties.id}:crossing:${key(arm.toward)}`,
          segment.line,
        );
      }
      if (c)
        Object.assign(
          c.properties,
          crossingControllerProperties({
            id: s.properties.id,
            at: [entry.p[0]!, entry.p[1]!],
            seed: s.properties.signal_seed!,
            midBlock,
            walk: midBlock || group === 'b' ? 'a' : 'b',
          }),
        );
      const stopSetback = setback;
      entry.setbacks.set(k, stopSetback);
      if (!entry.layout && inbound) {
        const stop = signalStop(p, arm, stopSetback, vertices);
        if (stop)
          legacy.push({
            road_id: arm.road.properties.id,
            junction: [p[0]!, p[1]!],
            toward: [arm.toward[0]!, arm.toward[1]!],
            direction: arm.forward ? -1 : 1,
            inbound: true,
            outbound: !arm.road.properties.oneway,
            group,
            bearing: (pathPoint(path.points, 0)!.bearing + 180) % 360,
            width: width(arm.road),
            stop: stop.position,
            stop_width: stop.width,
            stop_bearing: stop.bearing,
            ...stop.metadata,
          });
      }
    }
    if (entry.layout)
      s.properties.signal_layout = JSON.stringify(
        resolveSignalLayout(s, vertices, entry.linked, entry.setbacks),
      );
    else s.properties.signal_stops = JSON.stringify(SignalStops.parse(legacy));
  }
  for (const entry of resolved) {
    const { s, p } = entry;
    const controller = SignalController.parse({
      id: s.properties.id,
      at: p,
      seed: s.properties.signal_seed,
      radius: s.properties.signal_radius,
      a: s.properties.signal_a,
      b: s.properties.signal_b,
      mapped: s.properties.life_signal === 'mapped',
      ...(s.properties.signal_layout
        ? { layout: SignalLayout.parse(JSON.parse(s.properties.signal_layout)) }
        : { stops: SignalStops.parse(JSON.parse(s.properties.signal_stops!)) }),
    });
    for (const c of crossings.values())
      if (c.properties.crossing_signal === s.properties.id)
        c.properties.crossing_signal_control = JSON.stringify(controller);
  }
  const out = features.filter(
    (f) =>
      !(
        f.geometry.type === 'Point' && ['signals', 'crossing'].includes(f.properties.variant ?? '')
      ),
  );
  out.push(...crossings.values(), ...kept);
  const result = mergeStreetDetails(out, kept, vertices, streets);
  result.stats.shortCrossingArms = shortCrossingArms;
  report?.(result.stats);
  return result.features;
}
