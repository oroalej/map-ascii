/** Bake small, sourced public-place displays using complete geometry before tile clipping. */
import {
  utilitySeed,
  isRoofBuilding,
  pointInPolygon as inside,
  offsetUtility,
  carnivalRing,
  seasonalAccessRing,
  type SeasonConfig,
  type SeasonalRecord,
  type SeasonalDisplayRecord,
  type SeasonalPoint,
} from '@atlas/shared';
import type { AtlasFeature } from '../03-normalize';
import type { Geometry } from 'geojson';
import { lines } from './road-geometry';
import { localFrame } from './geo';

type Point = SeasonalPoint;
const crownRadius = (f: AtlasFeature) =>
  Math.max(0.5, Math.min(20, Number(f.properties.crown ?? 6) / 2));
const distance = (p: Point, a: Point, b: Point) => {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const t = Math.max(
    0,
    Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)),
  );
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
};
const segmentDistance = (a: Point, b: Point, c: Point, d: Point) => {
  const cross = (p: Point, q: Point, r: Point) =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const overlapping =
    Math.max(Math.min(a[0], b[0]), Math.min(c[0], d[0])) <=
      Math.min(Math.max(a[0], b[0]), Math.max(c[0], d[0])) &&
    Math.max(Math.min(a[1], b[1]), Math.min(c[1], d[1])) <=
      Math.min(Math.max(a[1], b[1]), Math.max(c[1], d[1]));
  if (overlapping && cross(a, b, c) * cross(a, b, d) <= 0 && cross(c, d, a) * cross(c, d, b) <= 0)
    return 0;
  return Math.min(distance(a, c, d), distance(b, c, d), distance(c, a, b), distance(d, a, b));
};
function rings(f: AtlasFeature): Point[][] {
  if (f.geometry.type === 'Polygon') return f.geometry.coordinates as Point[][];
  if (f.geometry.type === 'MultiPolygon') return f.geometry.coordinates.flat() as Point[][];
  return [];
}
const edgeDistance = (p: Point, polygon: Point[][]) =>
  Math.min(...polygon.flatMap((r) => r.slice(1).map((b, i) => distance(p, r[i]!, b))));

/** Keep every portion outside the union of tree crowns, including both ends of a crossing. */
function outsideCrowns(a: Point, b: Point, crowns: readonly { at: Point; radius: number }[]) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return [];
  const intervals: [number, number][] = [];
  for (const { at, radius } of crowns) {
    const x = a[0] - at[0],
      y = a[1] - at[1],
      along = x * dx + y * dy,
      discriminant = along * along - lengthSquared * (x * x + y * y - radius * radius);
    if (discriminant <= 0) continue;
    const root = Math.sqrt(discriminant),
      from = Math.max(0, (-along - root) / lengthSquared),
      to = Math.min(1, (-along + root) / lengthSquared);
    if (from < to) intervals.push([from, to]);
  }
  intervals.sort((left, right) => left[0] - right[0]);
  const spans: { start: Point; end: Point; clipped: boolean }[] = [];
  const at = (t: number): Point => [a[0] + dx * t, a[1] + dy * t];
  let cursor = 0;
  for (const [from, to] of intervals) {
    if (from > cursor) spans.push({ start: at(cursor), end: at(from), clipped: true });
    cursor = Math.max(cursor, to);
  }
  if (cursor < 1) spans.push({ start: at(cursor), end: at(1), clipped: cursor !== 0 });
  return spans;
}

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
      const grounds = config.grounds
        ? season.grounds?.find((g) => g.id === config.grounds)
        : undefined;
      const buildingLights =
        config.kind === 'light-string' && config.layout === 'building-perimeter';
      if (buildingLights && (grounds || config.mount))
        throw new Error(`Season installation ${config.id}: building lights cannot use grounds`);
      if (config.grounds && (!grounds || grounds.anchor !== config.anchor))
        throw new Error(`Season installation ${config.id}: missing or mismatched grounds`);
      if (
        !anchor ||
        !(rings(anchor).length || (grounds && lines(anchor).length)) ||
        !(buildingLights
          ? isRoofBuilding(anchor.properties.class) && Number(anchor.properties.height) > 0
          : grounds
            ? anchor.properties.class.startsWith('building') ||
              anchor.properties.class.startsWith('road_') ||
              ['park', 'paving'].includes(anchor.properties.class)
            : ['park', 'paving'].includes(anchor.properties.class))
      )
        throw new Error(
          `Season ${season.id}, installation ${config.id}: missing public area ${config.anchor}`,
        );
      const ll = grounds ? [grounds.ring] : rings(anchor),
        lat = ll[0]![0]![1];
      // Keep the legacy pipeline scale, world lattice and coordinate-derived identities.
      const { toMeters: project, toLngLat: unproject } = localFrame([0, 0], lat);
      const polygon = ll.map((r) => r.map(project));
      if (grounds) {
        const source = [...rings(anchor).flat(), ...(lines(anchor).flat() as Point[])].map(project);
        const center: Point = [
          (Math.min(...source.map((p) => p[0])) + Math.max(...source.map((p) => p[0]))) / 2,
          (Math.min(...source.map((p) => p[1])) + Math.max(...source.map((p) => p[1]))) / 2,
        ];
        if (polygon.flat().some((p) => Math.hypot(p[0] - center[0], p[1] - center[1]) > 200))
          throw new Error(`Season installation ${config.id}: grounds are not near the anchor`);
      }
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
      const access = (season.installations ?? []).flatMap((i) =>
        i.kind === 'access-path' && i.anchor === config.anchor
          ? i.points.slice(1).map((p, n) => ({
              from: project(i.points[n]!),
              to: project(p),
              radius: i.width_m / 2,
            }))
          : [],
      );
      const obstacleDistance = (p: Point, f: AtlasFeature) => {
        if (f.geometry.type === 'Point') {
          const q = project(f.geometry.coordinates);
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
      if (config.kind === 'access-path') {
        if (!grounds) throw new Error(`Season installation ${config.id}: access requires grounds`);
        for (let i = 1; i < config.points.length; i++) {
          const from = config.points[i - 1]!,
            to = config.points[i]!;
          const ring = seasonalAccessRing({
            from,
            to,
            width_m: config.width_m,
            style: config.style,
          }).map(project);
          const edges = ring.slice(1).map((b, n) => [ring[n]!, b] as const);
          if (
            ring.some((p) => !inside(p, polygon)) ||
            polygon.some((r) =>
              r
                .slice(1)
                .some((b, n) => edges.some(([c, d]) => segmentDistance(r[n]!, b, c, d) < 1e-6)),
            )
          )
            throw new Error(`Season installation ${config.id}: access leaves grounds`);
          if (
            local.some((f) => {
              if (f.properties.class.startsWith('building')) {
                const rs = rings(f).map((r) => r.map(project));
                return (
                  ring.some((p) => inside(p, rs)) ||
                  rs.some(
                    (r) =>
                      r.some((p) => inside(p, [ring])) ||
                      r
                        .slice(1)
                        .some((b, n) =>
                          edges.some(([c, d]) => segmentDistance(r[n]!, b, c, d) < 0.1),
                        ),
                  )
                );
              }
              return (
                f.properties.class.startsWith('road_') &&
                lines(f).some((l) =>
                  l
                    .slice(1)
                    .some(
                      (b, n) =>
                        inside(project(l[n] as Point), [ring]) ||
                        inside(project(b), [ring]) ||
                        edges.some(
                          ([c, d]) =>
                            segmentDistance(c, d, project(l[n] as Point), project(b)) <
                            Number(f.properties.width ?? 6) / 2,
                        ),
                    ),
                )
              );
            })
          )
            throw new Error(`Season installation ${config.id}: access overlaps building or road`);
          records.push({
            ...base(`segment-${i}`),
            kind: config.kind,
            style: config.style,
            from,
            to,
            width_m: config.width_m,
          });
        }
      } else if (config.kind === 'carnival') {
        if (!grounds)
          throw new Error(`Season installation ${config.id}: carnival requires grounds`);
        const footprints: Point[][] = [];
        for (const component of config.components) {
          const ring = carnivalRing(component).map(project);
          const edges = ring.slice(1).map((b, i) => [ring[i]!, b] as const);
          if (
            ring.some((p) => !inside(p, polygon)) ||
            polygon.some((r) =>
              r
                .slice(1)
                .some((b, i) => edges.some(([c, d]) => segmentDistance(r[i]!, b, c, d) < 1e-6)),
            )
          )
            throw new Error(
              `Season installation ${config.id}/${component.id}: footprint leaves grounds`,
            );
          const occupied = local.some((f) => {
            if (!(
              f.properties.class.startsWith('building') ||
              f.properties.class.startsWith('road_') ||
              [
                'path',
                'monument',
                'tree',
                'barrier',
                'furniture',
                'seating',
                'shrubs',
                'planting',
              ].includes(f.properties.class)
            ))
              return false;
            if (f.geometry.type === 'Point') {
              const p = project(f.geometry.coordinates);
              return (
                inside(p, [ring]) ||
                ring.some((q) => obstacleDistance(q, f) < 1) ||
                edges.some(
                  ([a, b]) =>
                    distance(p, a, b) <
                    1 + (f.properties.class === 'tree' ? Number(f.properties.crown ?? 6) / 2 : 5),
                )
              );
            }
            const rs = rings(f).map((r) => r.map(project));
            if (rs.length)
              return (
                ring.some((p) => inside(p, rs)) ||
                rs.some((r) => r.some((p) => inside(p, [ring]))) ||
                rs.some((r) =>
                  r
                    .slice(1)
                    .some((b, i) => edges.some(([c, d]) => segmentDistance(r[i]!, b, c, d) < 1)),
                )
              );
            return lines(f).some(
              (l) =>
                l.some((p) => inside(project(p), [ring])) ||
                l
                  .slice(1)
                  .some((b, i) =>
                    edges.some(
                      ([c, d]) =>
                        segmentDistance(project(l[i] as Point), project(b), c, d) <
                        Number(f.properties.width ?? 2) / 2 + 1,
                    ),
                  ),
            );
          });
          if (occupied)
            throw new Error(`Season installation ${config.id}/${component.id}: occupied footprint`);
          if (component.style !== 'midway') {
            if (
              footprints.some(
                (r) =>
                  ring.some((p) => inside(p, [r])) ||
                  r.some((p) => inside(p, [ring])) ||
                  r
                    .slice(1)
                    .some((b, i) => edges.some(([c, d]) => segmentDistance(r[i]!, b, c, d) < 1)),
              )
            )
              throw new Error(
                `Season installation ${config.id}/${component.id}: overlapping carnival footprints`,
              );
            footprints.push(ring);
          }
          records.push({ ...component, ...base(component.id), kind: 'carnival' });
        }
      } else if (config.kind === 'christmas-tree') {
        const obstacles = local.filter(
          (f) =>
            (f !== anchor || grounds !== undefined) &&
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
              ...access.map((a) => distance(p, a.from, a.to) - a.radius),
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
          const radius = crownRadius(f);
          if (
            at &&
            (inside(project(at), polygon) ||
              (config.trees === 'overlapping' && edgeDistance(project(at), polygon) < radius))
          )
            records.push({
              ...base(f.properties.id),
              kind: config.kind,
              at,
              radius_m: radius,
            });
        }
      } else {
        const crowns = config.exclude_tree_crowns
          ? local.flatMap((f) =>
              f.properties.class === 'tree' && f.geometry.type === 'Point'
                ? [
                    {
                      at: project(f.geometry.coordinates),
                      radius: crownRadius(f),
                    },
                  ]
                : [],
            )
          : [];
        const add = (a: Point, b: Point) => {
          if (grounds && access.some((p) => segmentDistance(a, b, p.from, p.to) < p.radius + 0.35))
            return;
          if (
            ![0, 0.25, 0.5, 0.75, 1].every((t) =>
              inside([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], polygon),
            )
          )
            return;
          // Sampling alone can miss a narrow concave notch in a curated property boundary.
          if (
            (grounds || buildingLights) &&
            polygon.some((r) => r.slice(1).some((d, i) => segmentDistance(a, b, r[i]!, d) < 1e-6))
          )
            return;
          if (
            grounds &&
            local.some((f) => {
              if (f.properties.class.startsWith('building')) {
                const rs = rings(f).map((r) => r.map(project));
                return (
                  inside(a, rs) ||
                  inside(b, rs) ||
                  rs.some((r) => r.slice(1).some((d, i) => segmentDistance(a, b, r[i]!, d) < 1))
                );
              }
              if (f.properties.class.startsWith('road_'))
                return lines(f).some((l) =>
                  l
                    .slice(1)
                    .some(
                      (d, i) =>
                        segmentDistance(a, b, project(l[i] as Point), project(d)) <
                        Number(f.properties.width ?? 6) / 2 + 1,
                    ),
                );
              return false;
            })
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
          for (const { start, end, clipped } of outsideCrowns(a, b, crowns)) {
            // Preserve short surviving pieces of a clipped row instead of dropping its ends.
            if (Math.hypot(end[0] - start[0], end[1] - start[1]) < 0.01) continue;
            const from = unproject(start),
              to = unproject(end);
            records.push({
              ...base(
                clipped
                  ? `clipped/${from.join('/')}/${to.join('/')}`
                  : `${from[0].toFixed(7)}/${from[1].toFixed(7)}`,
              ),
              kind: 'light-string',
              from,
              to,
              ...(buildingLights
                ? { mount: 'building' as const }
                : config.mount
                  ? { mount: config.mount }
                  : {}),
              ...(config.bulb_spacing_m === undefined
                ? {}
                : { bulb_spacing_m: config.bulb_spacing_m }),
              ...(config.palette === undefined ? {} : { palette: config.palette }),
            });
          }
        };
        if (config.layout === 'canopy') {
          // Parallel strings follow the longest property edge. Intersections clip each row
          // to the complete polygon, including holes and narrow concave access notches.
          let direction: Point = [1, 0],
            longest = 0;
          for (const ring of polygon)
            for (let i = 1; i < ring.length; i++) {
              const dx = ring[i]![0] - ring[i - 1]![0],
                dy = ring[i]![1] - ring[i - 1]![1];
              const length = Math.hypot(dx, dy);
              if (length > longest) {
                longest = length;
                direction = [dx / length, dy / length];
              }
            }
          const origin = polygon[0]![0]!;
          const along = (p: Point) =>
            (p[0] - origin[0]) * direction[0] + (p[1] - origin[1]) * direction[1];
          const across = (p: Point) =>
            -(p[0] - origin[0]) * direction[1] + (p[1] - origin[1]) * direction[0];
          const at = (s: number, t: number): Point => [
            origin[0] + direction[0] * s - direction[1] * t,
            origin[1] + direction[1] * s + direction[0] * t,
          ];
          const lo = Math.min(...all.map(across)),
            hi = Math.max(...all.map(across));
          if (Math.ceil((hi - lo) / config.spacing_m) > 1000)
            throw new Error(`Season installation ${config.id}: too many canopy rows`);
          for (let t = lo + config.spacing_m / 2; t < hi; t += config.spacing_m) {
            const cuts: number[] = [];
            for (const ring of polygon)
              for (let i = 1; i < ring.length; i++) {
                const a = ring[i - 1]!,
                  b = ring[i]!,
                  ta = across(a),
                  tb = across(b);
                if (ta > t !== tb > t)
                  cuts.push(along(a) + ((along(b) - along(a)) * (t - ta)) / (tb - ta));
              }
            cuts.sort((a, b) => a - b);
            for (let i = 1; i < cuts.length; i += 2)
              add(at(cuts[i - 1]! + 0.35, t), at(cuts[i]! - 0.35, t));
          }
        } else if (buildingLights) {
          // Parallel insets follow every mapped facade, including concave wings and holes.
          // Trimming corners keeps the entire span inside the standing roof footprint.
          for (const ring of polygon)
            for (let i = 1; i < ring.length; i++) {
              const a = ring[i - 1]!,
                b = ring[i]!;
              const dx = b[0] - a[0],
                dy = b[1] - a[1],
                length = Math.hypot(dx, dy);
              if (length < 3.2) continue;
              const nx = -dy / length,
                ny = dx / length;
              const midpoint: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
              const side = inside([midpoint[0] + nx * 0.6, midpoint[1] + ny * 0.6], polygon)
                ? 1
                : -1;
              const from: Point = [
                a[0] + (dx / length) * 0.6 + nx * side * 0.6,
                a[1] + (dy / length) * 0.6 + ny * side * 0.6,
              ];
              const to: Point = [
                b[0] - (dx / length) * 0.6 + nx * side * 0.6,
                b[1] - (dy / length) * 0.6 + ny * side * 0.6,
              ];
              const n = Math.ceil((length - 1.2) / (config.spacing_m * 2));
              for (let j = 0; j < n; j++)
                add(
                  [from[0] + ((to[0] - from[0]) * j) / n, from[1] + ((to[1] - from[1]) * j) / n],
                  [
                    from[0] + ((to[0] - from[0]) * (j + 1)) / n,
                    from[1] + ((to[1] - from[1]) * (j + 1)) / n,
                  ],
                );
            }
        } else if (config.layout === 'perimeter') {
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
  if (r.kind === 'access-path') return { type: 'Polygon', coordinates: [seasonalAccessRing(r)] };
  if (r.kind === 'bunting' || r.kind === 'light-string')
    return { type: 'LineString', coordinates: [r.from, r.to] };
  if (r.kind === 'carnival') return { type: 'Polygon', coordinates: [carnivalRing(r)] };
  const ring: Point[] = [];
  for (let i = 0; i < 32; i++) {
    const a = (i * Math.PI) / 16;
    ring.push(offsetUtility(r.at, Math.cos(a) * r.radius_m, Math.sin(a) * r.radius_m));
  }
  ring.push([...ring[0]!]);
  return { type: 'Polygon', coordinates: [ring] };
}
