import { SignalLayout, SignalStops, type City, type SignalArm } from '@atlas/shared';
import type { Position } from 'geojson';
import type { AtlasFeature } from '../03-normalize';
import { delta, key, lines, point, SIGNAL_STOP_GAP_M, width } from './road-geometry';
import { armPath, pathPoint } from './signal-path';

export type RoadArm = { road: AtlasFeature; bearing: number; toward: Position; forward: boolean };
export type RoadVertex = { p: Position; arms: RoadArm[] };
export type StreetStats = {
  mappedSidewalkKm: number;
  derivedSidewalkKm: number;
  mappedRoadKm: number;
  derivedRoadKm: number;
  onewayWays: number;
  signalizedStopLines: number;
  mappedStopLines: number;
  arrows: number;
  unresolvedStops: number;
  undirectedMidblockStops: number;
  shortApproaches: number;
  shortCrossingArms: number;
};

const road = (f: AtlasFeature) => !f.properties.region && f.properties.class.startsWith('road_');

/** Remove exact sourced road targets and their region copies before deriving other geometry. */
export function applyRoadExclusions(
  features: AtlasFeature[],
  exclusions: NonNullable<City['streets']>['exclusions'],
): AtlasFeature[] {
  if (!exclusions?.length) return features;
  const targets = new Set(exclusions.map((item) => item.osm_id));
  if (targets.size !== exclusions.length) throw new Error('Duplicate road exclusion target');
  const matched = new Set<string>();
  for (const feature of features) {
    const id = feature.properties.id;
    if (!targets.has(id) || feature.properties.region) continue;
    if (!road(feature) || feature.geometry.type !== 'LineString')
      throw new Error(`Road exclusion target is not a road LineString: ${id}`);
    matched.add(id);
  }
  for (const id of targets)
    if (!matched.has(id)) throw new Error(`Road exclusion target not found in detail data: ${id}`);
  return features.filter((feature) => !targets.has(feature.properties.id));
}

/** Apply sourced city corrections before resolving junction approaches and arrow anchors. */
export function applyRoadDirections(
  features: AtlasFeature[],
  directions: NonNullable<City['streets']>['directions'],
): AtlasFeature[] {
  if (!directions?.length) return features;
  const overrides = new Map(directions.map((item) => [item.osm_id, item]));
  if (overrides.size !== directions.length) throw new Error('Duplicate road direction target');
  const matched = new Set<string>();
  const result = features.map((feature) => {
    const override = overrides.get(feature.properties.id);
    if (!override || feature.properties.region) return feature;
    if (!road(feature) || feature.geometry.type !== 'LineString')
      throw new Error(`Road direction target is not a road LineString: ${override.osm_id}`);
    matched.add(override.osm_id);
    const properties = { ...feature.properties, oneway_source: override.source };
    if (override.oneway === 0) delete properties.oneway;
    else properties.oneway = override.oneway;
    return { ...feature, properties };
  });
  for (const id of overrides.keys())
    if (!matched.has(id)) throw new Error(`Road direction target not found in detail data: ${id}`);
  return result;
}

export function deriveSidewalks(features: AtlasFeature[], enabled = true): AtlasFeature[] {
  if (!enabled) return features;
  return features.map((f) =>
    road(f) &&
    ['road_major', 'road_mid'].includes(f.properties.class) &&
    f.properties.sidewalk === undefined
      ? {
          ...f,
          properties: {
            ...f.properties,
            sidewalk: 'both',
            sidewalk_width: 2,
            sidewalk_src: 'derived',
          },
        }
      : f,
  );
}

/** Arrow centers are baked from complete segments, never re-phased at a clipped tile edge. */
export function onewayArrows(features: readonly AtlasFeature[]): AtlasFeature[] {
  const out: AtlasFeature[] = [];
  const radius = 6378137;
  for (const f of features) {
    if (!road(f) || !f.properties.oneway) continue;
    lines(f).forEach((line, lineIndex) => {
      for (let segment = 1; segment < line.length; segment++) {
        let a = line[segment - 1]!,
          b = line[segment]!;
        if (f.properties.oneway === -1) [a, b] = [b, a];
        // One ground-metre projection for both endpoints and the entire segment's phase.
        const scale = Math.cos((((a[1]! + b[1]!) / 2) * Math.PI) / 180);
        const project = (p: Position) =>
          [
            ((radius * p[0]! * Math.PI) / 180) * scale,
            radius * Math.log(Math.tan(Math.PI / 4 + (p[1]! * Math.PI) / 360)) * scale,
          ] as const;
        const [ax, ay] = project(a),
          [bx, by] = project(b);
        const length = Math.hypot(bx - ax, by - ay);
        if (!Number.isFinite(length) || length < 16) continue;
        const dx = (bx - ax) / length,
          dy = (by - ay) / length;
        const phase = ax * dx + ay * dy;
        const first = Math.ceil((phase + 8) / 30);
        for (let slot = first; slot * 30 - phase <= length - 8; slot++) {
          const t = slot * 30 - phase;
          const p = [
            (((ax + dx * t) / scale / radius) * 180) / Math.PI,
            ((2 * Math.atan(Math.exp((ay + dy * t) / scale / radius)) - Math.PI / 2) * 180) /
              Math.PI,
          ];
          out.push(
            point(`${f.properties.id}:oneway:${lineIndex}:${segment}:${slot}`, p, {
              variant: 'oneway_arrow',
              arrow_road: f.properties.class,
              arrow_width: Math.min(width(f), 3),
              arrow_bearing: ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360,
              source: `Direction from ${f.properties.oneway_source ?? 'OpenStreetMap'}; illustrative arrow spacing`,
            }),
          );
        }
      }
    });
  }
  return out;
}

export function streetStats(features: readonly AtlasFeature[]): StreetStats {
  const stats: StreetStats = {
    mappedSidewalkKm: 0,
    derivedSidewalkKm: 0,
    mappedRoadKm: 0,
    derivedRoadKm: 0,
    onewayWays: 0,
    signalizedStopLines: 0,
    mappedStopLines: 0,
    arrows: 0,
    unresolvedStops: 0,
    undirectedMidblockStops: 0,
    shortApproaches: 0,
    shortCrossingArms: 0,
  };
  for (const f of features) {
    const p = f.properties;
    if (road(f)) {
      if (p.oneway) stats.onewayWays++;
      const sides =
        p.sidewalk === 'both' ? 2 : p.sidewalk === 'left' || p.sidewalk === 'right' ? 1 : 0;
      if (sides && p.sidewalk_src) {
        let km = 0;
        for (const line of lines(f))
          for (let i = 1; i < line.length; i++)
            km += Math.hypot(...delta(line[i - 1]!, line[i]!)) / 1000;
        stats[p.sidewalk_src === 'mapped' ? 'mappedSidewalkKm' : 'derivedSidewalkKm'] += km * sides;
        stats[p.sidewalk_src === 'mapped' ? 'mappedRoadKm' : 'derivedRoadKm'] += km;
      }
    }
    if (p.stop_src) stats[p.stop_src === 'mapped' ? 'mappedStopLines' : 'signalizedStopLines']++;
    if (p.variant === 'oneway_arrow') stats.arrows++;
  }
  return stats;
}

/** The same inbound stop geometry is used by paint, hardware, and vehicle control. */
export function signalStop(
  p: Position,
  arm: RoadArm,
  setback: number,
  vertices?: ReadonlyMap<string, RoadVertex>,
) {
  const direction = arm.forward ? -1 : 1;
  if (arm.road.properties.oneway && arm.road.properties.oneway !== direction) return;
  const path = armPath(p, arm, vertices),
    at = path && pathPoint(path.points, setback);
  if (!at) return;
  const bearing = (at.bearing + 180) % 360;
  const tx = Math.sin((bearing * Math.PI) / 180),
    ty = Math.cos((bearing * Math.PI) / 180);
  const q = [...at.position];
  const segment = path.segments[at.segment]!;
  const stopDirection: -1 | 1 = segment.forward ? -1 : 1;
  const w = width(segment.road),
    offset = segment.road.properties.oneway ? 0 : w / 4;
  q[0]! += (ty * offset) / (111320 * Math.cos((q[1]! * Math.PI) / 180));
  q[1]! -= (tx * offset) / 111320;
  const stopWidth = segment.road.properties.oneway ? w : w / 2;
  const metadata =
    segment.road.properties.id !== arm.road.properties.id ||
    stopDirection !== direction ||
    w !== width(arm.road)
      ? {
          stop_road_id: segment.road.properties.id,
          stop_direction: stopDirection,
          stop_road_width: w,
        }
      : {};
  return { position: q as [number, number], bearing, width: stopWidth, metadata };
}

/** Resolve stop approaches before tiling; driving side currently defaults to right. */
export function mergeStreetDetails(
  features: AtlasFeature[],
  signals: readonly AtlasFeature[],
  vertices: ReadonlyMap<string, RoadVertex>,
  policy?: City['streets'],
): { features: AtlasFeature[]; stats: StreetStats } {
  const stops = new Map<string, AtlasFeature>();
  const signalArms = new Map<AtlasFeature, SignalArm[]>();
  const controlledStops = new Map<string, SignalArm>();
  const stopIdentity = (roadId: string, junction: Position, toward: Position) =>
    JSON.stringify([roadId, key(junction), key(toward)]);
  for (const signal of signals) {
    const arms = signal.properties.signal_layout
      ? SignalLayout.parse(JSON.parse(signal.properties.signal_layout)).arms
      : signal.properties.signal_stops
        ? SignalStops.parse(JSON.parse(signal.properties.signal_stops))
        : [];
    signalArms.set(signal, arms);
    for (const arm of arms) {
      if (!arm.stop) continue;
      const identity = stopIdentity(arm.road_id, arm.junction, arm.toward);
      if (!controlledStops.has(identity)) controlledStops.set(identity, arm);
    }
  }
  let unresolvedStops = 0,
    undirectedMidblockStops = 0,
    shortApproaches = 0;
  const radius = (v: RoadVertex) => Math.max(3, ...v.arms.map((a) => width(a.road) / 2)) + 1;
  function stop(p: Position, arm: RoadArm, setback: number, mapped: boolean, id: string) {
    const direction = arm.forward ? -1 : 1;
    if (arm.road.properties.oneway && arm.road.properties.oneway !== direction) return;
    const controlled = mapped
      ? controlledStops.get(stopIdentity(arm.road.properties.id, p, arm.toward))
      : undefined;
    const resolved =
      controlled?.stop && controlled.stop_width
        ? {
            position: controlled.stop,
            width: controlled.stop_width,
            bearing: controlled.stop_bearing ?? controlled.bearing,
          }
        : signalStop(p, arm, setback, vertices);
    if (!resolved) {
      shortApproaches++;
      return;
    }
    const { position: q, bearing, width: stopWidth } = resolved;
    const k = `${q[0].toFixed(7)},${q[1].toFixed(7)}:${bearing.toFixed(2)}:${stopWidth}`;
    if (stops.has(k) && (!mapped || stops.get(k)!.properties.stop_src === 'mapped')) return;
    stops.set(
      k,
      point(`${id}:stop:${arm.road.properties.id}:${key(arm.toward)}`, q, {
        variant: 'stop_line',
        stop_road: arm.road.properties.class,
        stop_width: stopWidth,
        stop_bearing: bearing,
        stop_src: mapped ? 'mapped' : 'signalized',
        source: mapped ? 'OpenStreetMap stop node' : 'Derived stop line at a resolved signal',
      }),
    );
  }
  for (const signal of signals) {
    if (signal.geometry.type !== 'Point') continue;
    if (signal.properties.signal_layout || signal.properties.signal_stops) {
      const arms = signalArms.get(signal)!;
      for (const arm of arms) {
        if (!arm.inbound) continue;
        if (!arm.stop || !arm.stop_width) {
          shortApproaches++;
          continue;
        }
        const feature = features.find(
          (f) => f.properties.id === arm.road_id && !f.properties.region,
        )!;
        const localBearing = arm.stop_bearing ?? arm.bearing;
        const k = `${arm.stop[0].toFixed(7)},${arm.stop[1].toFixed(7)}:${localBearing.toFixed(2)}:${arm.stop_width}`;
        stops.set(
          k,
          point(`${signal.properties.id}:stop:${arm.road_id}:${key(arm.toward)}`, arm.stop, {
            variant: 'stop_line',
            stop_road: feature.properties.class,
            stop_width: arm.stop_width,
            stop_bearing: localBearing,
            stop_src: 'signalized',
            source: 'Derived stop line at a resolved signal',
          }),
        );
      }
      continue;
    }
    const v = vertices.get(key(signal.geometry.coordinates));
    for (const arm of v?.arms ?? [])
      stop(
        v!.p,
        arm,
        (signal.properties.signal_radius ?? radius(v!)) + SIGNAL_STOP_GAP_M,
        false,
        signal.properties.id,
      );
  }
  for (const f of features) {
    if (f.properties.variant !== 'traffic_stop' || f.geometry.type !== 'Point') continue;
    const v = vertices.get(key(f.geometry.coordinates));
    if (!v) {
      unresolvedStops++;
      continue;
    }
    const direction = f.properties.stop_direction;
    if (!direction && v.arms.length < 3) {
      undirectedMidblockStops++;
      continue;
    }
    const rank = (a: RoadArm) =>
      ({ road_major: 0, road_mid: 1, road_minor: 2 })[a.road.properties.class as 'road_major'] ?? 2;
    const lowest = Math.max(...v.arms.map(rank));
    const candidates = v.arms.filter((a) =>
      direction ? a.forward === (direction === 'backward') : rank(a) === lowest,
    );
    // A directed sign denotes one approach. At an ambiguous shared node, prefer the lowest
    // road rank, then narrower road and stable id, rather than inventing additional signs.
    const arms = direction
      ? candidates
          .sort(
            (a, b) =>
              rank(b) - rank(a) ||
              width(a.road) - width(b.road) ||
              a.road.properties.id.localeCompare(b.road.properties.id),
          )
          .slice(0, 1)
      : candidates;
    for (const arm of arms)
      stop(v.p, arm, v.arms.length >= 3 ? radius(v) + SIGNAL_STOP_GAP_M : 0, true, f.properties.id);
  }
  const base = deriveSidewalks(
    features.filter((f) => f.properties.variant !== 'traffic_stop'),
    policy?.sidewalks?.derive !== false,
  );
  const out = [...base, ...stops.values(), ...onewayArrows(base)];
  const stats = streetStats(out);
  Object.assign(stats, { unresolvedStops, undirectedMidblockStops, shortApproaches });
  return { features: out, stats };
}
