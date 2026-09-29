/**
 * Decoded vector tile → typed arrays for the cell pass. Runs in the tile worker; kept free of
 * worker and GL APIs so it can be unit-tested.
 *
 * Positions stay tile-local (0–EXTENT, with tippecanoe's buffer beyond) as Int16, and the cell
 * pass maps them with a per-tile matrix computed in float64, so precision holds at z19.
 */
import earcut from 'earcut';
import { classId, Flags, markerFor, type RenderClass } from '../classes';

export const EXTENT = 4096;

/** Layers the Phase 1 renderer doesn't draw: admin outlines and labels arrive in Phase 2. */
export const skippedLayers: ReadonlySet<string> = new Set(['admin', 'labels', 'events']);

export type GeometryArrays = {
  /** x, y per vertex. */
  positions: Int16Array;
  /** class id, height (m, 0–255), flags, 0 per vertex. */
  meta: Uint8Array;
  /** Feature index (1-based; 0 = none) per vertex. */
  ids: Uint32Array;
};

export type TileGeometry = {
  fills: GeometryArrays & { indices: Uint32Array };
  lines: GeometryArrays;
  points: GeometryArrays;
};

/** Structural subset of `@mapbox/vector-tile`, so tests can pass plain objects. */
export type TilePoint = { x: number; y: number };
export type TileFeatureLike = {
  type: 0 | 1 | 2 | 3;
  properties: Record<string, string | number | boolean>;
  loadGeometry(): TilePoint[][];
};
export type TileLayerLike = {
  extent: number;
  length: number;
  feature(i: number): TileFeatureLike;
};

/** Assigns each feature id string a stable 1-based index, shared across tiles. */
export function createIdRegistry() {
  const indices = new Map<string, number>();
  let fresh: string[] = [];
  return {
    index(id: string): number {
      let i = indices.get(id);
      if (i === undefined) {
        i = indices.size + 1;
        indices.set(id, i);
        fresh.push(id);
      }
      return i;
    },
    /** Ids registered since the last call, in index order. */
    takeNew(): string[] {
      const out = fresh;
      fresh = [];
      return out;
    },
  };
}
export type IdRegistry = ReturnType<typeof createIdRegistry>;

/** Pack a feature index into RGBA bytes (the id buffer's layout) and back. */
export const packId = (i: number): [number, number, number, number] => [
  i & 255,
  (i >>> 8) & 255,
  (i >>> 16) & 255,
  (i >>> 24) & 255,
];
export const unpackId = ([r, g, b, a]: readonly number[]): number =>
  ((r ?? 0) | ((g ?? 0) << 8) | ((b ?? 0) << 16) | ((a ?? 0) << 24)) >>> 0;

class Builder {
  positions: number[] = [];
  meta: number[] = [];
  ids: number[] = [];
  indices: number[] = [];

  get count() {
    return this.positions.length / 2;
  }

  vertex(x: number, y: number, cls: number, height: number, flags: number, id: number) {
    this.positions.push(Math.round(x), Math.round(y));
    this.meta.push(cls, height, flags, 0);
    this.ids.push(id);
  }

  finish(): GeometryArrays {
    return {
      positions: Int16Array.from(this.positions, (v) => Math.max(-32768, Math.min(32767, v))),
      meta: Uint8Array.from(this.meta),
      ids: Uint32Array.from(this.ids),
    };
  }
}

/** Shoelace sum; the sign tells ring orientation (as in `@mapbox/vector-tile`). */
export function signedArea(ring: readonly TilePoint[]): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const p1 = ring[i]!;
    const p2 = ring[j]!;
    sum += (p2.x - p1.x) * (p1.y + p2.y);
  }
  return sum;
}

/**
 * Group rings into polygons: a ring with the first ring's orientation starts a polygon, the
 * other orientation is a hole in the current one. Degenerate rings are dropped.
 */
export function classifyRings(rings: readonly TilePoint[][]): TilePoint[][][] {
  const polygons: TilePoint[][][] = [];
  let current: TilePoint[][] | undefined;
  let ccw: boolean | undefined;
  for (const ring of rings) {
    const area = signedArea(ring);
    if (area === 0) continue;
    ccw ??= area < 0;
    if (ccw === area < 0) {
      current = [ring];
      polygons.push(current);
    } else {
      current?.push(ring);
    }
  }
  return polygons;
}

/** Area-weighted centroid of a ring, or its vertex average when it has no area. */
export function ringCentroid(ring: readonly TilePoint[]): TilePoint {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const p = ring[j]!;
    const q = ring[i]!;
    const cross = p.x * q.y - q.x * p.y;
    a += cross;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
  }
  if (a !== 0) return { x: cx / (3 * a), y: cy / (3 * a) };
  const n = Math.max(1, ring.length);
  return {
    x: ring.reduce((s, p) => s + p.x, 0) / n,
    y: ring.reduce((s, p) => s + p.y, 0) / n,
  };
}

const isBuilding = (cls: string) => cls.startsWith('building');

/**
 * Convert a tile's layers into fill triangles, line segments, and points.
 * - Polygons are triangulated with earcut.
 * - Buildings also get a point at their center, so small ones still claim a cell.
 * - Religious, school, and market features, and curated landmarks, get a marker point.
 */
export function buildTileGeometry(
  layers: Readonly<Record<string, TileLayerLike>>,
  registry: IdRegistry,
): TileGeometry {
  const fills = new Builder();
  const lines = new Builder();
  const points = new Builder();

  for (const [name, layer] of Object.entries(layers)) {
    if (skippedLayers.has(name)) continue;
    const scale = EXTENT / layer.extent;
    for (let f = 0; f < layer.length; f++) {
      const feature = layer.feature(f);
      const className = String(feature.properties.class ?? '');
      const cls = classId(className);
      if (cls === 0) continue;
      const id = registry.index(String(feature.properties.id ?? `${name}/${f}`));
      const rawHeight = Number(feature.properties.height ?? 0);
      const height = Number.isFinite(rawHeight)
        ? Math.max(0, Math.min(255, Math.round(rawHeight)))
        : 0;
      const landmark = feature.properties.landmark === true;
      const flags = landmark ? Flags.landmark : 0;
      const marker = markerFor[className as keyof typeof markerFor];

      const addPoint = (p: TilePoint, klass: number) =>
        points.vertex(p.x, p.y, klass, height, flags, id);
      const addMarkers = (p: TilePoint) => {
        if (marker) addPoint(p, classId(marker));
        if (landmark) addPoint(p, classId('marker_landmark' satisfies RenderClass));
      };

      const rings = feature
        .loadGeometry()
        .map((ring) => ring.map((p) => ({ x: p.x * scale, y: p.y * scale })));

      if (feature.type === 1) {
        for (const ring of rings) {
          for (const p of ring) {
            if (marker || landmark) addMarkers(p);
            else addPoint(p, cls);
          }
        }
      } else if (feature.type === 2) {
        for (const line of rings) {
          for (let i = 1; i < line.length; i++) {
            const a = line[i - 1]!;
            const b = line[i]!;
            lines.vertex(a.x, a.y, cls, height, flags, id);
            lines.vertex(b.x, b.y, cls, height, flags, id);
          }
        }
        const first = rings[0];
        if (landmark && first && first.length > 0) addMarkers(first[Math.floor(first.length / 2)]!);
      } else if (feature.type === 3) {
        let largest: { ring: TilePoint[]; area: number } | undefined;
        for (const polygon of classifyRings(rings)) {
          const base = fills.count;
          const coords: number[] = [];
          const holes: number[] = [];
          for (const [r, ring] of polygon.entries()) {
            if (r > 0) holes.push(coords.length / 2);
            for (const p of ring) {
              coords.push(p.x, p.y);
              fills.vertex(p.x, p.y, cls, height, flags, id);
            }
          }
          for (const i of earcut(coords, holes.length > 0 ? holes : null, 2)) {
            fills.indices.push(base + i);
          }
          const outer = polygon[0]!;
          const area = Math.abs(signedArea(outer));
          if (!largest || area > largest.area) largest = { ring: outer, area };
        }
        if (largest) {
          const center = ringCentroid(largest.ring);
          if (isBuilding(className)) addPoint(center, cls);
          addMarkers(center);
        }
      }
    }
  }

  return {
    fills: { ...fills.finish(), indices: Uint32Array.from(fills.indices) },
    lines: lines.finish(),
    points: points.finish(),
  };
}

/** The buffers to transfer (not copy) from the worker. */
export function transferables(geometry: TileGeometry): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const g of [geometry.fills, geometry.lines, geometry.points]) {
    out.push(
      g.positions.buffer as ArrayBuffer,
      g.meta.buffer as ArrayBuffer,
      g.ids.buffer as ArrayBuffer,
    );
  }
  out.push(geometry.fills.indices.buffer as ArrayBuffer);
  return out;
}
