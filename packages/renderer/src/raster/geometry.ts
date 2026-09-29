/**
 * Decoded vector tile → typed arrays for the cell pass. Runs in the tile worker; kept free of
 * worker and GL APIs so it can be unit-tested.
 *
 * Positions stay tile-local (0–EXTENT, with tippecanoe's buffer beyond) as Int16, and the cell
 * pass maps them with a per-tile matrix computed in float64, so precision holds at z19.
 */
import { featureZoomBand, type ZoomBand } from '@atlas/shared';
import earcut from 'earcut';
import { classId, Flags, markerFor, variantCode, type RenderClass } from '../classes';
import { LabelRank, LANDMARK_LABEL_BAND, MONUMENT_LABEL_BAND } from '../labels';

/** The variant code of a flat roof (classes.ts `variantCode`). */
const FLAT_ROOF = 1;

export const EXTENT = 4096;

/** Layers the renderer doesn't draw yet: event pins arrive with the timeline (Phase 4). */
export const skippedLayers: ReadonlySet<string> = new Set(['events']);

export type GeometryArrays = {
  /** x, y per vertex. */
  positions: Int16Array;
  /** class id, height (m, 0–255), flags, variant (or wall shade, or ridge angle) per vertex. */
  meta: Uint8Array;
  /** Feature index (1-based; 0 = none) per vertex. */
  ids: Uint32Array;
  /** Pitched roofs: signed distance to the ridge in tile units, positive on the lit slope. */
  ridge: Int16Array;
};

/**
 * A name to place: at the pipeline's anchor (`label_lng`/`label_lat`), or at a place label's
 * point. It shows while the zoom is inside `band`.
 */
export type TileLabel = {
  id: number;
  text: string;
  rank: LabelRank;
  lng: number;
  lat: number;
  band: ZoomBand;
  /** Streets: the direction of the run the name sits on (radians, tile y down). */
  angle?: number;
};

/** When street names show: major roads from the District level, others from the Street level. */
export const STREET_LABEL_BANDS: Readonly<Record<string, ZoomBand>> = {
  road_major: { min: 14 },
  road_mid: { min: 15.5 },
  road_minor: { min: 15.5 },
  path: { min: 17 },
};

/** Segments bending less than this (radians) still count as one straight run. */
const RUN_BEND = (15 * Math.PI) / 180;

/**
 * The longest nearly straight run of a line (consecutive segments within `RUN_BEND` of the
 * run's first one): its midpoint, direction, and length, where a street's name goes.
 */
export function longestRun(
  line: readonly TilePoint[],
): { mid: TilePoint; angle: number; length: number } | null {
  let best: { mid: TilePoint; angle: number; length: number } | null = null;
  let start = 0;
  while (start < line.length - 1) {
    const a = line[start]!;
    const b = line[start + 1]!;
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    let end = start + 1;
    while (end < line.length - 1) {
      const p = line[end]!;
      const q = line[end + 1]!;
      let bend = Math.abs(Math.atan2(q.y - p.y, q.x - p.x) - angle);
      if (bend > Math.PI) bend = 2 * Math.PI - bend;
      if (bend > RUN_BEND) break;
      end++;
    }
    const last = line[end]!;
    const length = Math.hypot(last.x - a.x, last.y - a.y);
    if (length > 0 && (!best || length > best.length)) {
      best = { mid: { x: (a.x + last.x) / 2, y: (a.y + last.y) / 2 }, angle, length };
    }
    start = end;
  }
  return best;
}

/** The rank of a place name, by what it names (the pipeline's `place` and subdivision flag). */
export function placeRank(place: unknown, subdivisionLabel: unknown): LabelRank {
  if (place === 'province') return LabelRank.province;
  if (place === 'city' || place === 'town') return LabelRank.city;
  if (subdivisionLabel === true) return LabelRank.subdivision;
  return LabelRank.place;
}

/** Flat features: areas, lines, and points. */
export type GroundGeometry = {
  fills: GeometryArrays & { indices: Uint32Array };
  lines: GeometryArrays;
  points: GeometryArrays;
};

export type TileGeometry = GroundGeometry & {
  /** Buildings as 3D walls and roofs (the variant byte holds the face's shade). */
  extrusions: GeometryArrays & { indices: Uint32Array };
  /**
   * Region-only features (the pipeline's `region` flag), kept apart: they are tiled only to
   * `REGION_TILE_MAX_ZOOM`, and deeper views draw them from that zoom's tile under the
   * view's own tiles.
   */
  region: GroundGeometry;
  labels: TileLabel[];
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

/**
 * What the renderer tells the app about a feature under the pointer: enough for a tooltip and
 * the info panel's basics, without keeping whole tiles on the main thread.
 */
export type FeatureInfo = {
  /** Feature id, e.g. `osm:way/123`. */
  id: string;
  class: string;
  name?: string;
  subdivision?: string;
  /** The subdivision comes from an approximate area, not a mapped boundary. */
  subdivisionApprox?: boolean;
  /** The curated landmark (`landmark/<slug>`) joined to this feature. */
  landmarkId?: string;
  /** OSM kind, e.g. `amenity=school`. */
  kind?: string;
  height?: number;
};

/** A feature's info from its tile properties. */
export function featureInfo(
  id: string,
  className: string,
  p: Record<string, string | number | boolean>,
): FeatureInfo {
  const info: FeatureInfo = { id, class: className };
  if (typeof p.name === 'string') info.name = p.name;
  if (typeof p.subdivision === 'string') info.subdivision = p.subdivision;
  if (p.subdivision_approx === true) info.subdivisionApprox = true;
  if (typeof p.landmark_id === 'string') info.landmarkId = p.landmark_id;
  if (typeof p.kind === 'string') info.kind = p.kind;
  if (typeof p.height === 'number' && p.height > 0) info.height = p.height;
  return info;
}

/** Assigns each feature id string a stable 1-based index, shared across tiles. */
export function createIdRegistry() {
  const indices = new Map<string, number>();
  let fresh: FeatureInfo[] = [];
  return {
    /** The feature's index; `info` describes it the first time it is seen. */
    index(id: string, info: () => FeatureInfo = () => ({ id, class: '' })): number {
      let i = indices.get(id);
      if (i === undefined) {
        i = indices.size + 1;
        indices.set(id, i);
        fresh.push(info());
      }
      return i;
    },
    /** Features registered since the last call, in index order. */
    takeNew(): FeatureInfo[] {
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
export const unpackId = ([r, g, b, a]: ArrayLike<number> & Iterable<number>): number =>
  ((r ?? 0) | ((g ?? 0) << 8) | ((b ?? 0) << 16) | ((a ?? 0) << 24)) >>> 0;

class Builder {
  positions: number[] = [];
  meta: number[] = [];
  ids: number[] = [];
  ridge: number[] = [];
  indices: number[] = [];

  get count() {
    return this.positions.length / 2;
  }

  vertex(
    x: number,
    y: number,
    cls: number,
    height: number,
    flags: number,
    id: number,
    variant = 0,
    ridge = 0,
  ) {
    this.positions.push(Math.round(x), Math.round(y));
    this.meta.push(cls, height, flags, variant);
    this.ids.push(id);
    this.ridge.push(ridge);
  }

  finish(): GeometryArrays {
    return {
      positions: Int16Array.from(this.positions, (v) => Math.max(-32768, Math.min(32767, v))),
      meta: Uint8Array.from(this.meta),
      ids: Uint32Array.from(this.ids),
      ridge: Int16Array.from(this.ridge, (v) => Math.max(-32768, Math.min(32767, Math.round(v)))),
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

/** Direction the light comes from, in tile coordinates (y down): from the south-east. */
const LIGHT = { x: 0.45, y: 0.89 };

/** A wall's shade byte (0–255) from its outward normal: lit faces are brighter. */
export function wallShade(nx: number, ny: number): number {
  const length = Math.hypot(nx, ny) || 1;
  const lit = (nx * LIGHT.x + ny * LIGHT.y) / length;
  return Math.round((0.5 + 0.5 * lit) * 254);
}

/** Twice the ring's area with the standard shoelace sign (positive: interior on the left). */
const shoelace = (ring: readonly TilePoint[]) => {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % ring.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a;
};

/**
 * Add a building's walls (a quad per ring edge, from the ground to its height) and its roof
 * (the footprint's triangles at its height) to `out`.
 */
function addExtrusion(
  out: Builder,
  polygon: readonly TilePoint[][],
  roof: readonly number[],
  vertex: (p: TilePoint, flags: number, shade: number) => void,
) {
  for (const ring of polygon) {
    const outwardLeft = shoelace(ring) < 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const a = ring[i]!;
      const b = ring[i + 1]!;
      const [dx, dy] = [b.x - a.x, b.y - a.y];
      if (dx === 0 && dy === 0) continue;
      const shade = outwardLeft ? wallShade(-dy, dx) : wallShade(dy, -dx);
      const base = out.count;
      vertex(a, Flags.extruded, shade);
      vertex(b, Flags.extruded, shade);
      vertex(b, Flags.extruded | Flags.top, shade);
      vertex(a, Flags.extruded | Flags.top, shade);
      out.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const base = out.count;
  for (const ring of polygon) {
    for (const p of ring) vertex(p, Flags.extruded | Flags.top | Flags.roof, 255);
  }
  for (const i of roof) out.indices.push(base + i);
}

/**
 * A pitched roof's ridge, from the footprint's principal axis through its centroid (the long
 * axis of a rectangle). `distance` is signed so that positive is the slope facing the light,
 * and `angle` is the ridge direction as a byte (0–255 over 0–180°, tile y pointing down).
 */
export function roofRidge(ring: readonly TilePoint[]) {
  const n =
    ring.length > 1 && ring[0]!.x === ring.at(-1)!.x && ring[0]!.y === ring.at(-1)!.y
      ? ring.length - 1
      : ring.length;
  let [cx, cy] = [0, 0];
  for (let i = 0; i < n; i++) [cx, cy] = [cx + ring[i]!.x / n, cy + ring[i]!.y / n];
  let [sxx, syy, sxy] = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const [dx, dy] = [ring[i]!.x - cx, ring[i]!.y - cy];
    [sxx, syy, sxy] = [sxx + dx * dx, syy + dy * dy, sxy + dx * dy];
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const [ux, uy] = [Math.cos(theta), Math.sin(theta)];
  // The side with positive cross(u, p - c) faces (-uy, ux); flip so that side is the lit one.
  const sign = -uy * LIGHT.x + ux * LIGHT.y >= 0 ? 1 : -1;
  const folded = ((theta % Math.PI) + Math.PI) % Math.PI;
  return {
    distance: (p: TilePoint) => sign * (ux * (p.y - cy) - uy * (p.x - cx)),
    angle: Math.min(255, Math.round((folded / Math.PI) * 255)),
  };
}

/** Which tile is being built; the worker passes it for real-world sizes and positions. */
export type TileAddress = { z: number; x: number; y: number };

/** [lng, lat] of a tile-local point (tile units, 0–EXTENT, y down). */
export function tileToLngLat({ z, x, y }: TileAddress, p: TilePoint): [number, number] {
  const n = 2 ** z;
  const wx = (x + p.x / EXTENT) / n;
  const wy = (y + p.y / EXTENT) / n;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * wy))) * 180) / Math.PI;
  return [wx * 360 - 180, lat];
}

/** Meters per tile unit (EXTENT per tile) at the tile's center latitude. */
export function metersPerUnit({ z, y }: TileAddress): number {
  const n = Math.PI - (2 * Math.PI * (y + 0.5)) / 2 ** z;
  const lat = Math.atan(Math.sinh(n));
  return (40_075_016.686 * Math.cos(lat)) / 2 ** z / EXTENT;
}

/**
 * Add a road segment as a strip `2 × half` units wide, extended by `half` past each end so
 * consecutive segments overlap into square joins.
 */
function addStrip(
  fills: Builder,
  a: TilePoint,
  b: TilePoint,
  half: number,
  vertex: (p: TilePoint) => void,
) {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length === 0) return;
  const [dx, dy] = [((b.x - a.x) / length) * half, ((b.y - a.y) / length) * half];
  const base = fills.count;
  for (const p of [
    { x: a.x - dx - dy, y: a.y - dy + dx },
    { x: a.x - dx + dy, y: a.y - dy - dx },
    { x: b.x + dx + dy, y: b.y + dy - dx },
    { x: b.x + dx - dy, y: b.y + dy + dx },
  ]) {
    vertex(p);
  }
  fills.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/**
 * Convert a tile's layers into fill triangles, line segments, and points.
 * - Polygons are triangulated with earcut.
 * - Buildings also get a point at their center, so small ones still claim a cell.
 * - Religious, school, and market features, and curated landmarks, get a marker point.
 */
export function buildTileGeometry(
  layers: Readonly<Record<string, TileLayerLike>>,
  registry: IdRegistry,
  tile?: TileAddress,
): TileGeometry {
  const unitMeters = tile ? metersPerUnit(tile) : undefined;
  const ground = () => ({ fills: new Builder(), lines: new Builder(), points: new Builder() });
  const main = ground();
  const regional = ground();
  const extrusions = new Builder();
  const labels: TileLabel[] = [];

  for (const [name, layer] of Object.entries(layers)) {
    if (skippedLayers.has(name)) continue;
    const scale = EXTENT / layer.extent;
    for (let f = 0; f < layer.length; f++) {
      const feature = layer.feature(f);
      const className = String(feature.properties.class ?? '');
      const cls = classId(className);
      if (cls === 0) continue;
      const { fills, lines, points } = feature.properties.region === true ? regional : main;
      const featureId = String(feature.properties.id ?? `${name}/${f}`);
      const id = registry.index(featureId, () =>
        featureInfo(featureId, className, feature.properties),
      );
      const rawHeight = Number(feature.properties.height ?? 0);
      const height = Number.isFinite(rawHeight)
        ? Math.max(0, Math.min(255, Math.round(rawHeight)))
        : 0;
      const landmark = feature.properties.landmark === true;
      const { name: text, label_lng: lng, label_lat: lat } = feature.properties;

      // Place names are only labels: a point per place, never drawn as cells.
      if (className === 'place_label') {
        const point = feature.type === 1 ? feature.loadGeometry()[0]?.[0] : undefined;
        if (typeof text === 'string' && point && tile) {
          const [plng, plat] = tileToLngLat(tile, { x: point.x * scale, y: point.y * scale });
          const { place, subdivision_label: subdivisionLabel } = feature.properties;
          labels.push({
            id,
            text,
            rank: placeRank(place, subdivisionLabel),
            lng: plng,
            lat: plat,
            band: featureZoomBand('place_label', {
              place: typeof place === 'string' ? place : undefined,
              subdivision_label: subdivisionLabel === true,
            }),
          });
        }
        continue;
      }

      const curated = landmark
        ? { rank: LabelRank.landmark, band: LANDMARK_LABEL_BAND }
        : className === 'monument'
          ? { rank: LabelRank.monument, band: MONUMENT_LABEL_BAND }
          : undefined;
      if (
        curated &&
        typeof text === 'string' &&
        typeof lng === 'number' &&
        typeof lat === 'number'
      ) {
        labels.push({ id, text, lng, lat, ...curated });
      }
      const flags = landmark ? Flags.landmark : 0;
      const variant = variantCode(className, feature.properties.variant);
      const width = Number(feature.properties.width ?? 0);
      const marker = markerFor[className as keyof typeof markerFor];

      const addPoint = (p: TilePoint, klass: number) =>
        points.vertex(p.x, p.y, klass, height, flags, id, variant);
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
        const streetBand = STREET_LABEL_BANDS[className];
        if (streetBand && tile && typeof text === 'string' && text.trim()) {
          const run = rings
            .map(longestRun)
            .reduce((a, b) => (b && (!a || b.length > a.length) ? b : a), null);
          if (run) {
            const [slng, slat] = tileToLngLat(tile, run.mid);
            labels.push({
              id,
              text,
              rank: className === 'road_major' ? LabelRank.roadMajor : LabelRank.street,
              lng: slng,
              lat: slat,
              band: streetBand,
              angle: run.angle,
            });
          }
        }
        for (const line of rings) {
          for (let i = 1; i < line.length; i++) {
            const a = line[i - 1]!;
            const b = line[i]!;
            lines.vertex(a.x, a.y, cls, height, flags, id);
            lines.vertex(b.x, b.y, cls, height, flags, id);
            if (unitMeters && width > 0) {
              addStrip(fills, a, b, width / 2 / unitMeters, (p) =>
                fills.vertex(p.x, p.y, cls, 0, flags | Flags.corridor, id),
              );
            }
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
          // Pitched roofs (buildings with a height, unless tagged flat) get a ridge; landmark
          // parts (domes, belfries, tiered bases) are round or small, so they don't.
          const ridge =
            isBuilding(className) &&
            className !== 'building_part' &&
            height > 0 &&
            variant !== FLAT_ROOF
              ? roofRidge(polygon[0]!)
              : undefined;
          for (const [r, ring] of polygon.entries()) {
            if (r > 0) holes.push(coords.length / 2);
            for (const p of ring) {
              coords.push(p.x, p.y);
              if (ridge) {
                fills.vertex(
                  p.x,
                  p.y,
                  cls,
                  height,
                  flags | Flags.ridged,
                  id,
                  ridge.angle,
                  ridge.distance(p),
                );
              } else {
                fills.vertex(p.x, p.y, cls, height, flags, id, variant);
              }
            }
          }
          const triangles = earcut(coords, holes.length > 0 ? holes : null, 2);
          for (const i of triangles) fills.indices.push(base + i);
          if (isBuilding(className) && height > 0) {
            addExtrusion(extrusions, polygon, triangles, (p, extra, shade) =>
              extrusions.vertex(p.x, p.y, cls, height, flags | extra, id, shade),
            );
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

  const finish = (g: ReturnType<typeof ground>): GroundGeometry => ({
    fills: { ...g.fills.finish(), indices: Uint32Array.from(g.fills.indices) },
    lines: g.lines.finish(),
    points: g.points.finish(),
  });
  return {
    ...finish(main),
    extrusions: { ...extrusions.finish(), indices: Uint32Array.from(extrusions.indices) },
    region: finish(regional),
    labels,
  };
}

/** The buffers to transfer (not copy) from the worker. */
export function transferables(geometry: TileGeometry): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  const { region } = geometry;
  for (const g of [
    geometry.fills,
    geometry.extrusions,
    geometry.lines,
    geometry.points,
    region.fills,
    region.lines,
    region.points,
  ]) {
    out.push(
      g.positions.buffer as ArrayBuffer,
      g.meta.buffer as ArrayBuffer,
      g.ids.buffer as ArrayBuffer,
      g.ridge.buffer as ArrayBuffer,
    );
  }
  out.push(
    geometry.fills.indices.buffer as ArrayBuffer,
    geometry.extrusions.indices.buffer as ArrayBuffer,
    region.fills.indices.buffer as ArrayBuffer,
  );
  return out;
}
