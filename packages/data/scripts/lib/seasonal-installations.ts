/** Bake small, sourced public-place displays using complete geometry before tile clipping. */
import {
  utilitySeed,
  type SeasonConfig,
  type SeasonalRecord,
  type SeasonalDisplayRecord,
  type SeasonalPoint,
} from '@atlas/shared';
import type { AtlasFeature } from '../03-normalize';
import type { Geometry } from 'geojson';
import { lines } from './road-geometry';

type Point = SeasonalPoint;
const distance = (p: Point, a: Point, b: Point) => {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const t = Math.max(
    0,
    Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)),
  );
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
};
function rings(f: AtlasFeature): Point[][] {
  if (f.geometry.type === 'Polygon') return f.geometry.coordinates as Point[][];
  if (f.geometry.type === 'MultiPolygon') return f.geometry.coordinates.flat() as Point[][];
  return [];
}
function inside(p: Point, polygon: Point[][]) {
  let hit = false;
  for (const ring of polygon)
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i]!,
        b = ring[j]!;
      if (
        a[1] > p[1] !== b[1] > p[1] &&
        p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
      )
        hit = !hit;
    }
  return hit;
}
const edgeDistance = (p: Point, polygon: Point[][]) =>
  Math.min(...polygon.flatMap((r) => r.slice(1).map((b, i) => distance(p, r[i]!, b))));

export function generateSeasonalInstallations(
  features: readonly AtlasFeature[],
  seasons?: readonly SeasonConfig[],
) {
  const byId = new Map(
    features.filter((f) => !f.properties.region).map((f) => [f.properties.id, f]),
  );
  const records: SeasonalRecord[] = [];
  const stats: { season: string; installation: string; kind: string; records: number }[] = [];
  for (const season of seasons ?? [])
    for (const config of season.installations ?? []) {
      const anchor = byId.get(config.anchor);
      if (!anchor || !['park', 'paving'].includes(anchor.properties.class) || !rings(anchor).length)
        throw new Error(
          `Season ${season.id}, installation ${config.id}: missing public area ${config.anchor}`,
        );
      const ll = rings(anchor),
        lat = ll[0]![0]![1];
      const mx = 111320 * Math.cos((lat * Math.PI) / 180),
        my = 111320;
      const project = (p: Point): Point => [p[0] * mx, p[1] * my];
      const unproject = (p: Point): Point => [p[0] / mx, p[1] / my];
      const polygon = ll.map((r) => r.map(project));
      const all = polygon.flat();
      const x0 = Math.min(...all.map((p) => p[0])),
        x1 = Math.max(...all.map((p) => p[0]));
      const y0 = Math.min(...all.map((p) => p[1])),
        y1 = Math.max(...all.map((p) => p[1]));
      if ((x1 - x0) * (y1 - y0) > 250000)
        throw new Error(`Season installation ${config.id}: area is too large`);
      const local = [...byId.values()].filter((f) => {
        const coords =
          f.geometry.type === 'Point'
            ? [f.geometry.coordinates as Point]
            : ([...rings(f).flat(), ...lines(f).flat()] as Point[]);
        const points = coords.map(project);
        return (
          points.length > 0 &&
          Math.min(...points.map((p) => p[0])) <= x1 + 30 &&
          Math.max(...points.map((p) => p[0])) >= x0 - 30 &&
          Math.min(...points.map((p) => p[1])) <= y1 + 30 &&
          Math.max(...points.map((p) => p[1])) >= y0 - 30
        );
      });
      const monuments = local.filter((f) => f.properties.class === 'monument');
      const obstacleDistance = (p: Point, f: AtlasFeature) => {
        if (f.geometry.type === 'Point') {
          const q = project(f.geometry.coordinates as Point);
          const padding =
            f.properties.class === 'monument'
              ? 5
              : f.properties.class === 'tree'
                ? Number(f.properties.crown ?? 6) / 2
                : 1.5;
          return Math.hypot(p[0] - q[0], p[1] - q[1]) - padding;
        }
        const rs = rings(f).map((r) => r.map(project));
        if (rs.length) return inside(p, rs) ? 0 : edgeDistance(p, rs);
        const segments = lines(f).map((l) => l.map((p) => project(p as Point)));
        return (
          Math.min(...segments.flatMap((l) => l.slice(1).map((b, i) => distance(p, l[i]!, b)))) -
          Number(f.properties.width ?? 2) / 2
        );
      };
      const start = records.length;
      const base = (suffix: string) => {
        const id = `season:${season.id}/${config.id}/${suffix}`;
        return {
          version: 1 as const,
          id,
          season: season.id,
          installation: config.id,
          anchor: config.anchor,
          seed: utilitySeed(id),
        };
      };
      if (config.kind === 'christmas-tree') {
        const obstacles = local.filter(
          (f) =>
            f !== anchor &&
            ([
              'path',
              'monument',
              'tree',
              'barrier',
              'furniture',
              'seating',
              'shrubs',
              'planting',
            ].includes(f.properties.class) ||
              f.properties.class.startsWith('building') ||
              f.properties.class.startsWith('road_')),
        );
        let best: { p: Point; score: number } | undefined;
        for (let y = y0 + 1; y < y1; y += 1)
          for (let x = x0 + 1; x < x1; x += 1) {
            const p: Point = [x, y];
            if (!inside(p, polygon)) continue;
            const existing = records
              .filter(
                (r): r is SeasonalDisplayRecord =>
                  r.kind === 'christmas-tree' && r.anchor === config.anchor,
              )
              .map((r) => {
                const at = project(r.at);
                return Math.hypot(p[0] - at[0], p[1] - at[1]) - r.radius_m;
              });
            const clearance = Math.min(
              edgeDistance(p, polygon),
              ...obstacles.map((f) => obstacleDistance(p, f)),
              ...existing,
            );
            if (clearance < config.radius_m + 1) continue;
            const score = clearance - Math.hypot(x - (x0 + x1) / 2, y - (y0 + y1) / 2) * 0.01;
            if (!best || score > best.score) best = { p, score };
          }
        if (!best)
          throw new Error(
            `Season installation ${config.id}: no clear ${config.radius_m} m tree footprint`,
          );
        records.push({
          ...base('tree'),
          kind: config.kind,
          at: unproject(best.p),
          radius_m: config.radius_m,
        });
      } else if (config.kind === 'decorated-canopy') {
        for (const f of local
          .filter((f) => f.properties.class === 'tree' && f.geometry.type === 'Point')
          .sort((a, b) => a.properties.id.localeCompare(b.properties.id))) {
          const at = f.geometry.type === 'Point' ? (f.geometry.coordinates as Point) : undefined;
          if (at && inside(project(at), polygon))
            records.push({
              ...base(f.properties.id),
              kind: config.kind,
              at,
              radius_m: Math.max(0.5, Math.min(20, Number(f.properties.crown ?? 6) / 2)),
            });
        }
      } else {
        const add = (a: Point, b: Point) => {
          if (
            ![0, 0.25, 0.5, 0.75, 1].every((t) =>
              inside([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], polygon),
            )
          )
            return;
          if (
            monuments.some((m) =>
              [a, b, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as Point].some(
                (p) => obstacleDistance(p, m) < 2,
              ),
            )
          )
            return;
          if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 2) return;
          const from = unproject(a),
            to = unproject(b);
          records.push({
            ...base(`${from[0].toFixed(7)}/${from[1].toFixed(7)}`),
            kind: 'light-string',
            from,
            to,
          });
        };
        if (config.layout === 'perimeter') {
          // A small inset keeps boundary strolls visible beneath the overhead strings.
          const center: Point = [(x0 + x1) / 2, (y0 + y1) / 2];
          for (const ring of polygon)
            for (let i = 1; i < ring.length; i++) {
              const inset = (p: Point): Point => {
                const d = Math.hypot(center[0] - p[0], center[1] - p[1]) || 1;
                return [p[0] + (center[0] - p[0]) / d, p[1] + (center[1] - p[1]) / d];
              };
              const a = inset(ring[i - 1]!),
                b = inset(ring[i]!);
              const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (config.spacing_m * 2));
              for (let j = 0; j < n; j++)
                add(
                  [a[0] + ((b[0] - a[0]) * j) / n, a[1] + ((b[1] - a[1]) * j) / n],
                  [a[0] + ((b[0] - a[0]) * (j + 1)) / n, a[1] + ((b[1] - a[1]) * (j + 1)) / n],
                );
            }
        } else {
          for (const f of local.filter((f) => f.properties.class === 'path'))
            for (const line of lines(f)) {
              let traveled = 0;
              for (let i = 1; i < line.length; i++) {
                const a = project(line[i - 1] as Point),
                  b = project(line[i] as Point),
                  dx = b[0] - a[0],
                  dy = b[1] - a[1],
                  length = Math.hypot(dx, dy);
                if (!length) continue;
                const reach = Math.max(2, Math.min(5, Number(f.properties.width ?? 2) / 2 + 1.5));
                for (
                  let d = Math.ceil((traveled + 1e-7) / config.spacing_m) * config.spacing_m;
                  d < traveled + length;
                  d += config.spacing_m
                ) {
                  const t = (d - traveled) / length,
                    p: Point = [a[0] + dx * t, a[1] + dy * t],
                    nx = -dy / length,
                    ny = dx / length;
                  if (!inside(p, polygon)) continue;
                  const from: Point = [p[0] - nx * reach, p[1] - ny * reach],
                    to: Point = [p[0] + nx * reach, p[1] + ny * reach];
                  if (inside(from, polygon) && inside(to, polygon)) add(from, to);
                }
                traveled += length;
              }
            }
        }
      }
      const count = records.length - start;
      if (!count) throw new Error(`Season installation ${config.id}: no ${config.kind} geometry`);
      if (count > 1000) throw new Error(`Season installation ${config.id}: too many records`);
      stats.push({ season: season.id, installation: config.id, kind: config.kind, records: count });
    }
  records.sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(records.map((r) => r.id)).size !== records.length)
    throw new Error('Duplicate seasonal installation identities');
  return { records, stats };
}

/** Full display envelopes retain neighboring tile coverage, while payload coordinates stay exact. */
export function seasonalRecordGeometry(r: SeasonalRecord): Geometry {
  if (r.kind === 'bunting' || r.kind === 'light-string')
    return { type: 'LineString', coordinates: [r.from, r.to] };
  const mx = 111320 * Math.cos((r.at[1] * Math.PI) / 180);
  const ring: Point[] = [];
  for (let i = 0; i < 32; i++) {
    const a = (i * Math.PI) / 16;
    ring.push([
      r.at[0] + (Math.cos(a) * r.radius_m) / mx,
      r.at[1] + (Math.sin(a) * r.radius_m) / 111320,
    ]);
  }
  ring.push([...ring[0]!]);
  return { type: 'Polygon', coordinates: [ring] };
}
