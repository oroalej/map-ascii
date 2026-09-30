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
import { LabelRank, LANDMARK_LABEL_BAND, labelText, MONUMENT_LABEL_BAND } from '../labels';
import {
  CANAL_KIND,
  LifeBuilder,
  LifeLine,
  lifeLineFor,
  lifeTransferables,
  placeFor,
  plazaClasses,
  roostClasses,
  type LifeGeometry,
} from '../life/geometry';
import { ROAD_AREA_ZOOM, ROOF_ZOOM } from '../glyphs/select';
import { FLOOD, SHOP } from '../life/config';
import { habitatOf } from '../life/birds';
import { placeTileLamps, type LitLine } from '../life/lights';

/** The variant code of a flat roof (classes.ts `variantCode`). */
const FLAT_ROOF = 1;

export const EXTENT = 4096;

/** Layers the renderer doesn't draw yet: event pins arrive with the timeline (Phase 4). */
export const skippedLayers: ReadonlySet<string> = new Set(['events']);

export type GeometryArrays = {
  /** x, y per vertex. */
  positions: Int16Array;
  /** class id, height (m, 0–255), flags, variant (or ridge angle) per vertex. */
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

const STREET_MINOR_BANDS: Readonly<Record<string, ZoomBand>> = {
  road_mid: { min: 17.5 },
  road_minor: { min: 18 },
  path: { min: 18.5 },
};

/**
 * How a street's name ranks and when it shows, from its class and OSM kind (`highway=…`): only
 * the key streets are named at the Street level. Major roads show from the District level (z14)
 * and secondary roads from z15.5. Tertiary roads (and middle roads of unknown kind) wait for the
 * Place level (z17.5), other streets for z18, and paths for z18.5.
 */
export function streetLabel(
  className: string,
  kind: unknown,
): { rank: LabelRank; band: ZoomBand } | undefined {
  if (className === 'road_major') return { rank: LabelRank.roadMajor, band: { min: 14 } };
  const highway =
    typeof kind === 'string' && kind.startsWith('highway=')
      ? kind.slice('highway='.length).replace(/_link$/, '')
      : undefined;
  if (className === 'road_mid' && highway === 'secondary') {
    return { rank: LabelRank.street, band: { min: 15.5 } };
  }
  const band = STREET_MINOR_BANDS[className];
  return band && { rank: LabelRank.streetMinor, band };
}

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
  /**
   * Tree crowns, flat, kept apart from the ground: the crown pass draws them again every frame,
   * swaying in the wind (passes.ts `crownPass`). Each vertex's `ridge` is its distance from the
   * trunk in tile units, how far it swings.
   */
  crowns: GeometryArrays & { indices: Uint32Array };
  /**
   * Region-only features (the pipeline's `region` flag), kept apart: they are tiled only to
   * `REGION_TILE_MAX_ZOOM`, and deeper views draw them from that zoom's tile under the
   * view's own tiles.
   */
  region: GroundGeometry;
  labels: TileLabel[];
  /** Lines and places for the life layer's agents (life/geometry.ts). */
  life: LifeGeometry;
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

/** Sides of the polygon a tree's crown is drawn as. */
export const CROWN_SIDES = 24;

/** A 32-bit FNV-1a hash of a string: a feature's seed, the same in every tile. */
export function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** Mulberry32: a small seeded generator of numbers in [0, 1). */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A tree's crown outline: a closed ring of `CROWN_SIDES` points around `center` (its first point
 * repeated last), lobed and a little oval like a real canopy, its shape picked by `seed`. Its
 * mean radius is `radius`, so the crown keeps the tree's diameter.
 */
export function crownRing(center: TilePoint, radius: number, seed: number): TilePoint[] {
  const next = random(seed);
  const lobes = 3 + Math.floor(next() * 3);
  const phase1 = next() * 2 * Math.PI;
  const phase2 = next() * 2 * Math.PI;
  const stretch = 0.88 + next() * 0.24;
  const axis = next() * Math.PI;
  const shape = Array.from({ length: CROWN_SIDES }, (_, i) => {
    const a = (-2 * Math.PI * i) / CROWN_SIDES;
    const lumps =
      1 +
      0.14 * Math.sin(lobes * a + phase1) +
      0.07 * Math.sin((lobes + 2) * a + phase2) +
      0.05 * (next() - 0.5);
    // Stretched along `axis`, squeezed across it.
    const along = Math.cos(a - axis);
    const across = Math.sin(a - axis);
    const oval = Math.hypot(along * stretch, across / stretch);
    return { a, r: lumps * oval };
  });
  const mean = shape.reduce((sum, { r }) => sum + r, 0) / shape.length;
  const ring = shape.map(({ a, r }) => ({
    x: center.x + (radius * r * Math.cos(a)) / mean,
    y: center.y + (radius * r * Math.sin(a)) / mean,
  }));
  return [...ring, ring[0]!];
}

/** Triangles over a closed ring's points (indices into the ring; the lobes aren't convex). */
export const ringTriangles = (ring: readonly TilePoint[]): number[] =>
  earcut(ring.slice(0, -1).flatMap((p) => [p.x, p.y]));

/** Points every `step` along a line, from its start (a tree row's trees). */
export function pointsAlong(line: readonly TilePoint[], step: number): TilePoint[] {
  const out: TilePoint[] = [];
  if (line.length === 0 || !(step > 0)) return out;
  out.push(line[0]!);
  let carry = 0; // distance walked since the last point
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!;
    const b = line[i]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    let at = step - carry;
    while (at <= length) {
      const t = at / length;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      at += step;
    }
    carry = length - (at - step);
  }
  return out;
}

/**
 * A pitched roof's ridge, from the footprint's principal axis through its centroid (the long
 * axis of a rectangle). `distance` is signed so that positive is the slope facing the light,
 * and `angle` is the ridge direction as a byte (0–255 over 0–180°, tile y pointing down).
 */
export function roofRidge(ring: readonly TilePoint[]) {
  const { cx, cy, ux, uy, theta } = principalAxis(ring);
  // The side with positive cross(u, p - c) faces (-uy, ux); flip so that side is the lit one.
  const sign = -uy * LIGHT.x + ux * LIGHT.y >= 0 ? 1 : -1;
  const folded = ((theta % Math.PI) + Math.PI) % Math.PI;
  return {
    distance: (p: TilePoint) => sign * (ux * (p.y - cy) - uy * (p.x - cx)),
    angle: Math.min(255, Math.round((folded / Math.PI) * 255)),
  };
}

/**
 * A ring's principal axis through its vertex centroid (`cx`, `cy`): the unit vector (`ux`, `uy`)
 * along its long side, at angle `theta`.
 */
export function principalAxis(ring: readonly TilePoint[]) {
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
  return { cx, cy, ux: Math.cos(theta), uy: Math.sin(theta), theta };
}

/** Whether `p` is inside a polygon (its outer ring, less its holes), even–odd. */
export function insidePolygon(polygon: readonly (readonly TilePoint[])[], p: TilePoint): boolean {
  let inside = false;
  for (const ring of polygon) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i]!;
      const b = ring[j]!;
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
        inside = !inside;
      }
    }
  }
  return inside;
}

/** A parking lot's stalls: this far apart along a row, and rows this far apart, m. */
export const STALL = { width: 2.7, row: 8 } as const;

/**
 * Stalls over a parking lot for the life layer's parked vehicles: rows along the lot's long
 * axis, centered on it, each stall facing across the row (alternating by row). Only stalls
 * inside the lot and inside the tile (not its buffer) are kept.
 */
export function parkingStalls(
  polygon: readonly (readonly TilePoint[])[],
  unitMeters: number,
): { p: TilePoint; hx: number; hy: number }[] {
  const outer = polygon[0];
  if (!outer || outer.length < 3) return [];
  const { cx, cy, ux, uy } = principalAxis(outer);
  // (vx, vy) is across the rows.
  const [vx, vy] = [-uy, ux];
  let [u0, u1, v0, v1] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const q of outer) {
    const u = (q.x - cx) * ux + (q.y - cy) * uy;
    const v = (q.x - cx) * vx + (q.y - cy) * vy;
    [u0, u1, v0, v1] = [Math.min(u0, u), Math.max(u1, u), Math.min(v0, v), Math.max(v1, v)];
  }
  const du = STALL.width / unitMeters;
  const dv = STALL.row / unitMeters;
  const columns = Math.floor((u1 - u0) / du);
  const rows = Math.max(1, Math.floor((v1 - v0) / dv));
  const out: { p: TilePoint; hx: number; hy: number }[] = [];
  for (let r = 0; r < rows; r++) {
    const v = (v0 + v1) / 2 + (r - (rows - 1) / 2) * dv;
    const facing = r % 2 === 0 ? 1 : -1;
    for (let c = 0; c < columns; c++) {
      const u = (u0 + u1) / 2 + (c - (columns - 1) / 2) * du;
      const p = { x: cx + u * ux + v * vx, y: cy + u * uy + v * vy };
      if (p.x < 0 || p.x >= EXTENT || p.y < 0 || p.y >= EXTENT) continue;
      if (insidePolygon(polygon, p)) out.push({ p, hx: vx * facing, hy: vy * facing });
    }
  }
  return out;
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

/** A place's position in a tile's units (the inverse of `tileToLngLat`). */
export function lngLatToTile({ z, x, y }: TileAddress, lng: number, lat: number): TilePoint {
  const n = 2 ** z;
  const phi = (lat * Math.PI) / 180;
  const wy = (1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2;
  return { x: (((lng + 180) / 360) * n - x) * EXTENT, y: (wy * n - y) * EXTENT };
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
 * - Lines are segments, plus a point at each vertex, so short segments still claim a cell.
 * - Buildings also get a point at their center, so small ones still claim a cell.
 * - Religious, school, and market features, and curated landmarks, get a marker point.
 * - Road strips and roof ridges, which only show zoomed far in, are left out of tiles too coarse
 *   to be drawn there (below the archive's `maxZoom`, or its parent, which stands in while a
 *   tile loads).
 */
export function buildTileGeometry(
  layers: Readonly<Record<string, TileLayerLike>>,
  registry: IdRegistry,
  tile?: TileAddress,
  maxZoom?: number,
): TileGeometry {
  const unitMeters = tile ? metersPerUnit(tile) : undefined;
  const drawnAt = (zoom: number) =>
    !tile || maxZoom === undefined || tile.z >= Math.min(zoom, maxZoom) - 1;
  const strips = drawnAt(ROAD_AREA_ZOOM);
  const ridges = drawnAt(ROOF_ZOOM);
  const ground = () => ({ fills: new Builder(), lines: new Builder(), points: new Builder() });
  const main = ground();
  const regional = ground();
  const crowns = new Builder();
  const labels: TileLabel[] = [];
  const life = new LifeBuilder();
  const inTileAt = (p: TilePoint) => p.x >= 0 && p.x < EXTENT && p.y >= 0 && p.y < EXTENT;
  const litLines: LitLine[] = [];

  for (const [name, layer] of Object.entries(layers)) {
    if (skippedLayers.has(name)) continue;
    const scale = EXTENT / layer.extent;
    for (let f = 0; f < layer.length; f++) {
      const feature = layer.feature(f);
      const className = String(feature.properties.class ?? '');
      const cls = classId(className);
      if (cls === 0) continue;
      const isRegion = feature.properties.region === true;
      const { fills, lines, points } = isRegion ? regional : main;
      const featureId = String(feature.properties.id ?? `${name}/${f}`);
      const id = registry.index(featureId, () =>
        featureInfo(featureId, className, feature.properties),
      );
      const rawHeight = Number(feature.properties.height ?? 0);
      const height = Number.isFinite(rawHeight)
        ? Math.max(0, Math.min(255, Math.round(rawHeight)))
        : 0;
      const landmark = feature.properties.landmark === true;
      const { name: featureName, label_lng: lng, label_lat: lat } = feature.properties;
      // Labels draw the name in the characters the label atlas has (the panel keeps the name).
      const text = typeof featureName === 'string' ? labelText(featureName) : featureName;

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
      const place = isRegion ? undefined : placeFor(className, variant);

      const addPoint = (p: TilePoint, klass: number) =>
        points.vertex(p.x, p.y, klass, height, flags, id, variant);
      const addMarkers = (p: TilePoint) => {
        if (marker) addPoint(p, classId(marker));
        if (landmark) addPoint(p, classId('marker_landmark' satisfies RenderClass));
      };
      // A tree's crown, sized by the pipeline's `crown` diameter in meters. Its trunk's own cell
      // is the `tree` point.
      const crown = Number(feature.properties.crown ?? 0);
      // Shaped by the tree's id (and its place along a tree row), so it is the same tree in
      // every tile that holds it.
      const crownSeed = hashString(featureId);
      const addCrown = (p: TilePoint, index = 0) => {
        if (!unitMeters || !(crown > 0)) return;
        const ring = crownRing(p, crown / 2 / unitMeters, crownSeed + Math.imul(index, 0x9e3779b9));
        const triangles = ringTriangles(ring);
        const crownCls = classId('tree_crown' satisfies RenderClass);
        const reach = (q: TilePoint) => Math.hypot(q.x - p.x, q.y - p.y);
        const first = crowns.count;
        for (const q of ring)
          crowns.vertex(q.x, q.y, crownCls, height, flags, id, variant, reach(q));
        for (const i of triangles) crowns.indices.push(first + i);
      };
      const isTree = className === 'tree' && !isRegion;

      const rings = feature
        .loadGeometry()
        .map((ring) => ring.map((p) => ({ x: p.x * scale, y: p.y * scale })));

      if (feature.type === 1) {
        for (const ring of rings) {
          for (const p of ring) {
            if (marker || landmark) addMarkers(p);
            else addPoint(p, cls);
            if (landmark && !isRegion && unitMeters && inTileAt(p)) {
              life.flood(p, FLOOD.pointRadius / 2 / unitMeters);
            }
            if (isTree) addCrown(p);
            // A tree birds can land in, in the tile that holds it.
            const inTile = p.x >= 0 && p.x < EXTENT && p.y >= 0 && p.y < EXTENT;
            if (isTree && inTile) life.perch(p);
            if (className === 'building_station' && !isRegion) life.station(p);
            if (className === 'building_market' && !isRegion) life.market(p);
            if (className === 'building_market' && !isRegion && unitMeters && inTile) {
              life.shop(p, SHOP.pointRadius / 2 / unitMeters);
            }
            if (place && inTile) life.place(p, place, 0);
          }
        }
      } else if (feature.type === 2) {
        const street = streetLabel(className, feature.properties.kind);
        if (street && tile && typeof text === 'string' && text.trim()) {
          const run = rings
            .map(longestRun)
            .reduce((a, b) => (b && (!a || b.length > a.length) ? b : a), null);
          if (run) {
            const [slng, slat] = tileToLngLat(tile, run.mid);
            labels.push({
              id,
              text,
              ...street,
              lng: slng,
              lat: slat,
              angle: run.angle,
            });
          }
        }
        for (const line of rings) {
          // Every vertex's cell too: GL_LINES drops a segment that never leaves one cell's
          // center diamond, so a line of many short segments (a meandering river at City
          // zoom) would break into dashes. Points always cover their cell.
          for (const p of line) points.vertex(p.x, p.y, cls, height, flags, id);
          for (let i = 1; i < line.length; i++) {
            const a = line[i - 1]!;
            const b = line[i]!;
            lines.vertex(a.x, a.y, cls, height, flags, id);
            lines.vertex(b.x, b.y, cls, height, flags, id);
            if (strips && unitMeters && width > 0) {
              addStrip(fills, a, b, width / 2 / unitMeters, (p) =>
                fills.vertex(p.x, p.y, cls, 0, flags | Flags.corridor, id),
              );
            }
          }
        }
        // A tree row: a crown every crown's width along it.
        if (isTree && unitMeters && crown > 0) {
          let index = 0;
          for (const line of rings) {
            for (const p of pointsAlong(line, crown / unitMeters)) addCrown(p, index++);
          }
        }
        const isSiding = className === 'rail' && variant === 1;
        const isCanal = className === 'water_stream' && feature.properties.kind === CANAL_KIND;
        const lifeLine = isRegion
          ? undefined
          : isSiding
            ? LifeLine.siding
            : isCanal
              ? LifeLine.canal
              : lifeLineFor[className];
        if (lifeLine !== undefined) for (const line of rings) life.line(line, lifeLine, width);
        // Streetlights line major and secondary roads (life/lights.ts), placed once all are in.
        if (lifeLine === LifeLine.roadMajor || lifeLine === LifeLine.roadMid) {
          for (const line of rings) litLines.push({ points: line, width });
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
            ridges &&
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
          const outer = polygon[0]!;
          if (!isRegion && plazaClasses.has(className)) life.line(outer, LifeLine.plaza);
          if (!isRegion && className === 'parking' && unitMeters) {
            for (const { p, hx, hy } of parkingStalls(polygon, unitMeters)) life.spot(p, hx, hy);
          }
          const area = Math.abs(signedArea(outer));
          if (!largest || area > largest.area) largest = { ring: outer, area };
        }
        if (largest) {
          const center = ringCentroid(largest.ring);
          if (isBuilding(className)) addPoint(center, cls);
          addMarkers(center);
          // A landmark is floodlit at night, over its whole footprint (life/lights.ts).
          if (!isRegion && landmark && inTileAt(center)) {
            const reach = Math.max(
              ...largest.ring.map((q) => Math.hypot(q.x - center.x, q.y - center.y)),
            );
            life.flood(center, reach);
          }
          // A shop or market glows while it is open (life/lights.ts), from its tile.
          if (!isRegion && className === 'building_market' && inTileAt(center)) {
            const reach = Math.max(
              ...largest.ring.map((q) => Math.hypot(q.x - center.x, q.y - center.y)),
            );
            life.shop(center, reach);
          }
          // A roost belongs to the tile that holds it, not to its neighbors' buffers.
          const inside = center.x >= 0 && center.x < EXTENT && center.y >= 0 && center.y < EXTENT;
          if (!isRegion && inside && roostClasses.has(className)) {
            life.roost(center, habitatOf(className));
          }
          if (!isRegion && className === 'building_station') life.station(center);
          if (!isRegion && className === 'building_market') life.market(center);
          // A place people gather at, owned by the tile that holds its center.
          if (!isRegion && place && inside) {
            // `signedArea` is twice the area; the radius of a circle as big.
            const radius = Math.sqrt(largest.area / 2 / Math.PI);
            life.place(center, place, radius, isBuilding(className) && height > 0);
          }
        }
      }
    }
  }

  if (unitMeters && tile) {
    const origin = { x: tile.x * EXTENT, y: tile.y * EXTENT };
    life.addLamps(placeTileLamps(litLines, unitMeters, EXTENT, origin));
  }

  const finish = (g: ReturnType<typeof ground>): GroundGeometry => ({
    fills: { ...g.fills.finish(), indices: Uint32Array.from(g.fills.indices) },
    lines: g.lines.finish(),
    points: g.points.finish(),
  });
  return {
    ...finish(main),
    crowns: { ...crowns.finish(), indices: Uint32Array.from(crowns.indices) },
    region: finish(regional),
    labels,
    life: life.finish(),
  };
}

/** The buffers to transfer (not copy) from the worker. */
export function transferables(geometry: TileGeometry): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  const { region } = geometry;
  for (const g of [
    geometry.fills,
    geometry.crowns,
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
    geometry.crowns.indices.buffer as ArrayBuffer,
    region.fills.indices.buffer as ArrayBuffer,
    ...lifeTransferables(geometry.life),
  );
  return out;
}
