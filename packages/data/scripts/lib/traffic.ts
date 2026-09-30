import type { City, CityLifeConfig } from '@atlas/shared';
import { applyRoadDirections, mergeStreetDetails, type RoadArm, type StreetStats } from './streets';
import type { Position } from 'geojson';
import type { AtlasFeature, AtlasProperties } from '../03-normalize';
import { resolveSignalLayout } from './signal-layout';

type Arm = RoadArm;
type Junction = { p: Position; arms: Arm[] };
const key = (p: Position) => `${p[0]},${p[1]}`;
const delta = (a: Position, b: Position) => [
  (b[0]! - a[0]!) * 111320 * Math.cos((a[1]! * Math.PI) / 180),
  (b[1]! - a[1]!) * 111320,
];
const distance = (a: Position, b: Position) => Math.hypot(...delta(a, b));
const bearing = (a: Position, b: Position) => {
  const [x, y] = delta(a, b);
  return ((Math.atan2(x!, y!) * 180) / Math.PI + 180) % 180;
};
const angle = (a: number, b: number) => Math.min(Math.abs(a - b), 180 - Math.abs(a - b));
const lines = (f: AtlasFeature): Position[][] =>
  f.geometry.type === 'LineString'
    ? [f.geometry.coordinates]
    : f.geometry.type === 'MultiLineString'
      ? f.geometry.coordinates
      : [];
const width = (f: AtlasFeature) =>
  f.properties.width ??
  { road_major: 14, road_mid: 10, road_minor: 6 }[f.properties.class as 'road_major'] ??
  6;
function point(id: string, p: Position, properties: Partial<AtlasProperties>): AtlasFeature {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [...p] },
    properties: { id, class: 'furniture', ...properties },
    tippecanoe: { layer: 'poi', minzoom: 15, maxzoom: 16 },
  };
}

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
  const roads = features.filter(
    (f) => !f.properties.region && f.properties.class.startsWith('road_'),
  );
  const junctions = roadJunctions(roads);
  const roadVertices = new Map<string, { road: AtlasFeature; bearing: number }>();
  for (const road of roads)
    for (const line of lines(road))
      line.forEach((p, i) => {
        const other = line[i + 1] ?? line[i - 1];
        if (other && !roadVertices.has(key(p)))
          roadVertices.set(key(p), { road, bearing: bearing(p, other) });
      });
  const nearestJunction = (p: Position, reach: number) =>
    junctions
      .filter((j) => distance(p, j.p) <= reach)
      .sort((a, b) => distance(p, a.p) - distance(p, b.p))[0];
  const crossings = new Map<string, AtlasFeature>();
  function crossing(p: Position, road: AtlasFeature, axis: number, mapped: boolean, id: string) {
    if (crossings.has(key(p))) return;
    crossings.set(
      key(p),
      point(id, p, {
        variant: 'crossing',
        crossing_bearing: Math.round(axis * 10) / 10,
        crossing_width: width(road),
        crossing_road: road.properties.class,
        source: mapped ? 'OpenStreetMap' : 'Simulated crossing at a signalized junction',
      }),
    );
  }
  for (const f of features.filter(
    (f) => f.properties.variant === 'crossing' && !f.properties.region,
  )) {
    if (f.geometry.type !== 'Point') {
      for (const line of lines(f))
        for (const p of line) {
          const match = roadVertices.get(key(p));
          if (match) crossing(p, match.road, match.bearing, true, `${f.properties.id}:crossing`);
        }
      continue;
    }
    const p = f.geometry.coordinates;
    let nearest: { p: Position; road: AtlasFeature; axis: number; d: number } | undefined;
    for (const road of roads)
      for (const line of lines(road))
        for (let i = 1; i < line.length; i++) {
          const a = line[i - 1]!,
            b = line[i]!;
          const [x, y] = delta(a, b),
            [px, py] = delta(a, p);
          const t = Math.max(0, Math.min(1, (px! * x! + py! * y!) / (x! * x! + y! * y! || 1)));
          const q = [a[0]! + (b[0]! - a[0]!) * t, a[1]! + (b[1]! - a[1]!) * t];
          const d = distance(p, q);
          if (d <= 20 && (!nearest || d < nearest.d))
            nearest = { p: q, road, axis: bearing(a, b), d };
        }
    if (nearest) crossing(nearest.p, nearest.road, nearest.axis, true, f.properties.id);
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
  const vertices = roadVertexArms(roads);
  const owned = new Set<string>();
  for (const s of kept) {
    const linked = config?.add?.find(
      (a) => s.properties.id === `pack:signal:${a.id}`,
    )?.linked_junctions;
    const layout = resolveSignalLayout(s, vertices, linked);
    if (layout) {
      for (const p of layout.members) {
        if (owned.has(key(p))) throw new Error(`Duplicate signal junction membership: ${key(p)}`);
        owned.add(key(p));
      }
      s.properties.signal_layout = JSON.stringify(layout);
    }
    const p = (s.geometry as { coordinates: Position }).coordinates,
      j = nearestJunction(p, 1);
    const external = layout
      ? layout.arms.map((a) => ({
          p: a.junction,
          arm: vertices
            .get(key(a.junction))!
            .arms.find(
              (arm) => arm.road.properties.id === a.road_id && key(arm.toward) === key(a.toward),
            )!,
        }))
      : (j?.arms ?? []).map((arm) => ({ p, arm }));
    for (const { p, arm } of external) {
      const d = distance(p, arm.toward),
        shift = s.properties.signal_radius! + 2;
      if (d < shift) continue;
      const q = [
        p[0]! + ((arm.toward[0]! - p[0]!) * shift) / d,
        p[1]! + ((arm.toward[1]! - p[1]!) * shift) / d,
      ];
      if (
        [...crossings.values()].some(
          (c) =>
            c.properties.source === 'OpenStreetMap' &&
            distance(q, (c.geometry as { coordinates: Position }).coordinates) < 20,
        )
      )
        continue;
      crossing(q, arm.road, arm.bearing, false, `${s.properties.id}:crossing:${key(arm.toward)}`);
    }
  }
  const out = features.filter(
    (f) =>
      !(
        f.geometry.type === 'Point' && ['signals', 'crossing'].includes(f.properties.variant ?? '')
      ),
  );
  out.push(...crossings.values(), ...kept);
  const result = mergeStreetDetails(out, kept, vertices, streets);
  report?.(result.stats);
  return result.features;
}
