import { featureZoomBand, tileZoomRange, type Cemetery, type LngLat } from '@atlas/shared';
import bbox from '@turf/bbox';
import centroid from '@turf/centroid';
import inside from '@turf/boolean-point-in-polygon';
import type { Polygon, MultiPolygon } from 'geojson';
import { TILE_ZOOMS, type AtlasFeature } from '../03-normalize';
import { bboxesOverlap, bufferBbox, clearanceWidth, localFrame } from './geo';
import { detailSelectionOf, seatingFootprint } from './site-detail';
import { interiorPoint } from './frontage';

type Segment = { a: LngLat; b: LngLat; bounds: [number, number, number, number] };
const segments = (g: MultiPolygon): Segment[] =>
  g.coordinates.flatMap((p) =>
    p.flatMap((r) =>
      r.slice(1).map((b, i) => ({
        a: r[i] as LngLat,
        b: b as LngLat,
        bounds: [
          Math.min(r[i]![0]!, b[0]!),
          Math.min(r[i]![1]!, b[1]!),
          Math.max(r[i]![0]!, b[0]!),
          Math.max(r[i]![1]!, b[1]!),
        ] as [number, number, number, number],
      })),
    ),
  );

/** Liang–Barsky clipping in a marker's orthogonal frame, including contained boundary holes. */
function boundaryHits(ring: LngLat[], edges: Segment[]): boolean {
  const origin = ring[0]!,
    ex = ring[1]!,
    ey = ring[3]!;
  const width = Math.hypot(ex[0] - origin[0], ex[1] - origin[1]);
  const height = Math.hypot(ey[0] - origin[0], ey[1] - origin[1]);
  const project = (p: LngLat): LngLat => [
    ((p[0] - origin[0]) * (ex[0] - origin[0]) + (p[1] - origin[1]) * (ex[1] - origin[1])) / width,
    ((p[0] - origin[0]) * (ey[0] - origin[0]) + (p[1] - origin[1]) * (ey[1] - origin[1])) / height,
  ];
  const bounds = bbox({ type: 'Polygon', coordinates: [ring] }) as [number, number, number, number];
  return edges.some((edge) => {
    if (!bboxesOverlap(bounds, edge.bounds)) return false;
    const a = project(edge.a),
      b = project(edge.b);
    let lo = 0,
      hi = 1;
    for (const [i, maximum] of [width, height].entries()) {
      const delta = b[i]! - a[i]!;
      if (Math.abs(delta) < 1e-10) {
        if (a[i]! < 0 || a[i]! > maximum) return false;
        continue;
      }
      const t0 = -a[i]! / delta,
        t1 = (maximum - a[i]!) / delta;
      lo = Math.max(lo, Math.min(t0, t1));
      hi = Math.min(hi, Math.max(t0, t1));
      if (lo > hi) return false;
    }
    return true;
  });
}

const prepare = (coordinates: LngLat[][][]) => {
  const shape: MultiPolygon = { type: 'MultiPolygon', coordinates };
  return { shape, edges: segments(shape) };
};

function trunk(at: LngLat): Polygon {
  const frame = localFrame(at);
  const ring = Array.from({ length: 17 }, (_, i): LngLat =>
    frame.toLngLat([Math.cos((i * Math.PI) / 8) * 0.5, Math.sin((i * Math.PI) / 8) * 0.5]),
  );
  return { type: 'Polygon', coordinates: [ring] };
}

/** Explicit burial geometry uses existing stone parts, keeping the renderer city-agnostic. */
export function burialRow(row: Cemetery['rows'][number]): Polygon[] {
  const [start, end] = row.line;
  const frame = localFrame(start);
  const [dx, dy] = frame.toMeters(end);
  const span = Math.hypot(dx, dy);
  if (row.count > 1 && span / (row.count - 1) < row.width_m + 0.1)
    throw new Error(`${row.id}: burial markers overlap along the row`);
  const ux = dx / span,
    uy = dy / span;
  return Array.from({ length: row.count }, (_, i) => {
    const t = row.count === 1 ? 0.5 : i / (row.count - 1);
    const x = dx * t,
      y = dy * t;
    const ring: LngLat[] = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
      [-1, -1],
    ].map(([a, b]) =>
      frame.toLngLat([
        x + (a! * ux * row.width_m) / 2 - (b! * uy * row.length_m) / 2,
        y + (a! * uy * row.width_m) / 2 + (b! * ux * row.length_m) / 2,
      ]),
    );
    return { type: 'Polygon', coordinates: [ring] };
  });
}

/** Keep whole markers clear of cemetery holes, mapped roads/paths, water and standing roofs. */
export function mergeCemeteries(source: readonly AtlasFeature[], packs: readonly Cemetery[]) {
  if (new Set(packs.map((p) => p.osm_id)).size !== packs.length)
    throw new Error('multiple cemetery packs target the same mapped area');
  const features = [...source];
  const stats: { id: string; added: number; outside: number; blocked: number }[] = [];
  for (const pack of packs) {
    const parentIndex = features.findIndex((f) => f.properties.id === pack.osm_id);
    const original = features[parentIndex];
    if (!original || !['Polygon', 'MultiPolygon'].includes(original.geometry.type))
      throw new Error(`${pack.id}: missing cemetery area ${pack.osm_id}`);
    if (!['landuse=cemetery', 'amenity=grave_yard'].includes(original.properties.kind ?? ''))
      throw new Error(`${pack.id}: parent is not a mapped cemetery`);
    const area = original.geometry as Polygon | MultiPolygon;
    const bounds = bbox(area) as [number, number, number, number];
    const [lng, lat] = centroid(area).geometry.coordinates;
    const frame = localFrame([lng!, lat!]);
    // Clip in local metres: degree coordinates near 123° make tiny plaque intersections
    // unnecessarily expensive for the robust polygon arithmetic.
    const clip = (g: Polygon | MultiPolygon): LngLat[][][] =>
      (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).map((p) =>
        p.map((r) => r.map(frame.toMeters)),
      );
    const areaClip = prepare(clip(area));
    const obstacles = source.flatMap<
      ReturnType<typeof prepare> & { bounds: [number, number, number, number] }
    >((f) => {
      const g = f.geometry,
        p = f.properties;
      const near = bbox(f) as [number, number, number, number];
      const padding = clearanceWidth(p, 0.1) / 1000;
      if (!bboxesOverlap(bounds, bufferBbox(near, padding))) return [];
      let shape: Polygon | MultiPolygon;
      if (
        (g.type === 'Polygon' || g.type === 'MultiPolygon') &&
        ((p.class.startsWith('building') && (p.height ?? 0) > 0 && !p.detail_overhead) ||
          p.class.startsWith('water') ||
          (p.detail_parent === pack.osm_id &&
            !p.detail_overhead &&
            (p.class === 'paving' || p.class === 'pitch')))
      )
        shape = g;
      else if (g.type === 'LineString' && (p.class.startsWith('road') || p.class === 'path')) {
        // Capsules cover the complete carriageway, including bends and end caps. Splitting
        // long roads keeps each plot's clipping operation local to a short road segment.
        return g.coordinates.slice(1).flatMap((end, i) => {
          const start = g.coordinates[i]!;
          if (start[0] === end[0] && start[1] === end[1]) return [];
          const segmentBounds = bufferBbox(
            [
              Math.min(start[0]!, end[0]!),
              Math.min(start[1]!, end[1]!),
              Math.max(start[0]!, end[0]!),
              Math.max(start[1]!, end[1]!),
            ],
            padding,
          );
          if (!bboxesOverlap(bounds, segmentBounds)) return [];
          const shape = seatingFootprint([start, end] as LngLat[], clearanceWidth(p, 0.1));
          return [
            { ...prepare(clip(shape)), bounds: bbox(shape) as [number, number, number, number] },
          ];
        });
      } else if (g.type === 'Point' && (p.class === 'tree' || p.class === 'monument'))
        shape = trunk(g.coordinates as LngLat);
      else return [];
      const obstacleBounds = bbox(shape) as [number, number, number, number];
      return bboxesOverlap(bounds, obstacleBounds)
        ? [{ ...prepare(clip(shape)), bounds: obstacleBounds }]
        : [];
    });
    const parent = {
      ...original,
      properties: { ...original.properties, name: pack.title, landmark: true },
    };
    if (original.properties.name && original.properties.name !== pack.title)
      parent.properties.osm_name = original.properties.name;
    const anchor = interiorPoint(area);
    parent.properties.label_lng = anchor[0];
    parent.properties.label_lat = anchor[1];
    features[parentIndex] = parent;
    const selection = detailSelectionOf(parent.properties);
    const result = { id: pack.id, added: 0, outside: 0, blocked: 0 };
    const prefix = pack.id.replace('cemetery/', 'cemetery:');
    // A small spatial grid catches overlaps between authored rows without a quadratic scan.
    const cells = new Map<string, ReturnType<typeof prepare>[]>();
    const keys = (b: [number, number, number, number]) => {
      const out: string[] = [];
      const [west, south] = frame.toMeters([b[0], b[1]]);
      const [east, north] = frame.toMeters([b[2], b[3]]);
      for (let x = Math.floor(west / 10); x <= Math.floor(east / 10); x++)
        for (let y = Math.floor(south / 10); y <= Math.floor(north / 10); y++)
          out.push(`${x}/${y}`);
      return out;
    };
    for (const row of pack.rows) {
      const accepted: Polygon[] = [];
      for (const shape of burialRow(row)) {
        const shapeClip = clip(shape);
        const ring = shapeClip[0]![0]!;
        if (
          !ring.slice(0, 4).every((p) => inside(p, areaClip.shape)) ||
          boundaryHits(ring, areaClip.edges)
        ) {
          result.outside++;
          continue;
        }
        const plotBounds = bbox(shape) as [number, number, number, number];
        if (
          obstacles.some(
            (o) =>
              bboxesOverlap(plotBounds, o.bounds) &&
              (ring.slice(0, 4).some((p) => inside(p, o.shape)) || boundaryHits(ring, o.edges)),
          )
        ) {
          result.blocked++;
          continue;
        }
        const occupied = keys(plotBounds);
        if (
          [...new Set(occupied.flatMap((k) => cells.get(k) ?? []))].some(
            (g) => ring.slice(0, 4).some((p) => inside(p, g.shape)) || boundaryHits(ring, g.edges),
          )
        )
          throw new Error(`${pack.id} ${row.id}: burial rows overlap`);
        const prepared = prepare(shapeClip);
        for (const key of occupied) cells.set(key, [...(cells.get(key) ?? []), prepared]);
        accepted.push(shape);
        result.added++;
      }
      if (accepted.length)
        features.push({
          type: 'Feature',
          geometry: {
            type: 'MultiPolygon',
            coordinates: accepted.map((shape) => shape.coordinates),
          },
          properties: {
            id: `${prefix}/${row.id}`,
            class: 'building_part',
            variant: 'flat',
            kind: `burial=${row.kind}`,
            height: row.height_m,
            detail_blocked: true,
            detail_parent: pack.osm_id,
            detail_selection: JSON.stringify(selection),
          },
          tippecanoe: {
            layer: 'buildings',
            ...tileZoomRange(featureZoomBand('building_part'), TILE_ZOOMS),
          },
        });
    }
    if (!result.added) throw new Error(`${pack.id}: no burial markers fit the cemetery`);
    stats.push(result);
  }
  return { features, stats };
}

export const cemeteryCredits = (packs: readonly Cemetery[]): string[] => [
  ...new Set(packs.map((p) => p.credit)),
];
