/**
 * Decoded vector tile â†’ typed arrays for the cell pass. Runs in the tile worker; kept free of
 * worker and GL APIs so it can be unit-tested.
 *
 * Positions stay tile-local (0â€“EXTENT, with tippecanoe's buffer beyond) as Int16, and the cell
 * pass maps them with a per-tile matrix computed in float64, so precision holds at z19.
 */
import {
  parseUtilityRecord,
  parseDetailSelection,
  isLitRoad,
  TILE_EXTENT as EXTENT,
  MERCATOR_METERS,
  metersPerUnit,
  tileToLngLat,
  lngLatToTile,
  type UtilityRecord,
  featureZoomBand,
  LIFE_SITE_KINDS,
  type ZoomBand,
  FRONTAGE_KINDS,
  type FrontageKind,
} from '@atlas/shared';
import { parseSignalLayout } from '@atlas/shared';
import {
  parseControllerSeed,
  parseSignalStops,
  decodeCrossingController,
  decodeCrossingSignal,
} from '@atlas/shared';
import earcut from 'earcut';
import {
  isResidentialBuilding,
  isResidentialStreet,
  isRoofCandidate,
  isCompactRoof,
  neighborhoodSites,
  residentialSite,
  packResidentialSites,
  type ResidentialSite,
  type ResidentialSites,
} from '../fireworks-sites';
import { isRoofBuilding, parseRoofPlan, roofFrame } from '@atlas/shared';
import {
  foldRoofAngle,
  roofAngleByte,
  roofBounds,
  roofParameters,
  packRoofSurface,
  RoofShape,
  partitionRoofTriangles,
  plannedRoofFrame,
  type RoofSurfaceFrame,
} from './roofs';
import {
  classId,
  Flags,
  Marking,
  markingByte,
  markerFor,
  variantCode,
  type RenderClass,
} from '../classes';
import { LabelRank, LANDMARK_LABEL_BAND, labelText, MONUMENT_LABEL_BAND } from '../labels';
import {
  CANAL_KIND,
  LifeBuilder,
  graveSeed,
  LifeLine,
  lifeLineFor,
  lifeTransferables,
  encodeSeasonalPayload,
  placeFor,
  plazaClasses,
  roostClasses,
  type LifeGeometry,
  type SeasonalPayload,
} from '../life/geometry';
import { ROAD_AREA_ZOOM, ROOF_ZOOM, SWAY } from '../glyphs/select';
import { RoadAccess, stripRing } from '../life/terrain';
import {
  finalizeControlledCrossings,
  controlledCrossingConnectors,
} from '../life/crossing-geometry';
import { WIND_PRESETS, WIND_VARIATION } from '../life/wind';
import {
  CROSSING_WALK_PAST_M,
  DEFAULT_ROAD_WIDTH_M,
  FLOOD,
  SHOP,
  ROAD_SPLIT_CLEARANCE_M,
  LIFE_TILE_MIN_ZOOM,
} from '../life/config';
import { habitatOf } from '../life/birds';
import { LampState, placeSeed, placeTileLamps, type LitLine } from '../life/lights';

const CROWN_SWEEP_FACTOR =
  1 +
  Math.max(...Object.values(WIND_PRESETS)) *
    (1 + WIND_VARIATION.breathe) *
    Math.hypot(SWAY.bend, SWAY.flutter * 0.8);

export {
  TILE_EXTENT as EXTENT,
  MERCATOR_METERS,
  metersPerUnit,
  tileToLngLat,
  lngLatToTile,
} from '@atlas/shared';

/** Layers the renderer doesn't draw yet: event pins arrive with the timeline (Phase 4). */
export const skippedLayers: ReadonlySet<string> = new Set(['events']);

export type GeometryArrays = {
  /** Crown (2 Float32) or roof (4 Int16, with float fallback) components per vertex. */
  surface?: Float32Array | Int16Array;
  surfaceSize?: 2 | 4;
  /** Distance step in meters for packed roof surfaces; endScale uses 1/32767. */
  surfaceScale?: number;
  /** x, y per vertex. */
  positions: Int16Array;
  /** class id, height (m, 0â€“255), flags, variant (or ridge angle) per vertex. */
  meta: Uint8Array;
  /** Feature index (1-based; 0 = none) per vertex. */
  ids: Uint32Array;
  /** Crown reach from the trunk in tile units; zero for roofs and other ground geometry. */
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
  /** Straight-run endpoints, so a label is never longer than the road beneath it. */
  run?: readonly [readonly [number, number], readonly [number, number]];
};

const STREET_MINOR_BANDS: Readonly<Record<string, ZoomBand>> = {
  road_mid: { min: 17.5 },
  road_minor: { min: 18 },
  path: { min: 18.5 },
};

/** A crossing's walkable cut reaches this far past each side of its mapped width, m. */
const CROSSING_CUT_M = 1.5;

/**
 * How a street's name ranks and when it shows, from its class and OSM kind (`highway=â€¦`): only
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
type Run = { mid: TilePoint; angle: number; length: number; from: TilePoint; to: TilePoint };
export function longestRun(line: readonly TilePoint[]): Run | null {
  let best: Run | null = null;
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
      best = {
        mid: { x: (a.x + last.x) / 2, y: (a.y + last.y) / 2 },
        angle,
        length,
        from: a,
        to: last,
      };
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
  /** Mapped home anchors for atmospheric fireworks, independent of Life simulation. */
  residential?: ResidentialSites;
  /** Static hardware stays outside Life so it is never cloned to the simulation worker. */
  utilities?: readonly UtilityRecord[];
  seasonal?: SeasonalPayload;
  /**
   * Tree crowns, flat, kept apart from the ground: the crown pass draws them again every frame,
   * swaying in the wind (passes.ts `crownPass`). Each vertex's `ridge` is its distance from the
   * trunk in tile units, how far it swings.
   */
  crowns: GeometryArrays & { indices: Uint32Array; surface: Float32Array };
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

/** Offset a mapped sidewalk's continuous center line, including its bends. */
export function sidewalkLine(line: readonly TilePoint[], offset: number): TilePoint[] {
  const points = line.filter((p, i) => i === 0 || p.x !== line[i - 1]!.x || p.y !== line[i - 1]!.y);
  if (points.length < 2) return points.map((p) => ({ ...p }));
  const normal = (a: TilePoint, b: TilePoint) => {
    const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: (b.y - a.y) / length, y: -(b.x - a.x) / length };
  };
  return points.flatMap((p, i) => {
    const before = normal(points[Math.max(0, i - 1)]!, points[Math.max(1, i)]!);
    const after = normal(
      points[Math.min(i, points.length - 2)]!,
      points[Math.min(i + 1, points.length - 1)]!,
    );
    const x = before.x + after.x,
      y = before.y + after.y;
    const dot = x * after.x + y * after.y;
    const scale = dot > 0 ? offset / dot : Infinity;
    if (dot > 0 && Math.hypot(x * scale, y * scale) <= 2 * Math.abs(offset))
      return [{ x: p.x + x * scale, y: p.y + y * scale }];
    return [before, after].map((n) => ({ x: p.x + n.x * offset, y: p.y + n.y * offset }));
  });
}
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
  /** Walkable detail surfaces resolve pointer selection to this parent area. */
  parentId?: string;
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
  if (typeof p.detail_parent === 'string') info.parentId = p.detail_parent;
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
  surface: Float32Array | undefined;
  positions: number[] = [];
  meta: number[] = [];
  ids: number[] = [];
  ridge: number[] | undefined;
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
    frame?: RoofSurfaceFrame,
  ) {
    const roundedX = Math.round(x),
      roundedY = Math.round(y);
    if (ridge) {
      this.ridge ??= [];
      this.ridge[this.count] = ridge;
    }
    if (frame) {
      const offset = this.count * 4;
      if (!this.surface || this.surface.length < offset + 4) {
        const next = new Float32Array(Math.max(offset + 4, (this.surface?.length ?? 128) * 2));
        if (this.surface) next.set(this.surface);
        this.surface = next;
      }
      const px = roundedX - frame.cx,
        py = roundedY - frame.cy;
      this.surface[offset] = (px * frame.ux + py * frame.uy) * frame.unit;
      this.surface[offset + 1] = (py * frame.ux - px * frame.uy) * frame.unit;
      this.surface[offset + 2] = frame.ridgeHalf;
      this.surface[offset + 3] = frame.endScale;
    }
    this.positions.push(roundedX, roundedY);
    this.meta.push(cls, height, flags, variant);
    this.ids.push(id);
  }

  finish(): GeometryArrays {
    const packed = this.surface ? packRoofSurface(this.surface, this.count) : undefined;
    const positions = new Int16Array(this.positions.length);
    for (let i = 0; i < positions.length; i++)
      positions[i] = Math.max(-32768, Math.min(32767, this.positions[i]!));
    // Only crowns have nonzero ridge reach. Ground meshes need no temporary JS ridge array.
    const ridge = new Int16Array(this.count);
    if (this.ridge)
      for (let i = 0; i < ridge.length; i++)
        ridge[i] = Math.max(-32768, Math.min(32767, Math.round(this.ridge[i] ?? 0)));
    return {
      ...(packed ? { ...packed, surfaceSize: 4 as const } : {}),
      positions,
      meta: new Uint8Array(this.meta),
      ids: new Uint32Array(this.ids),
      ridge,
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

/** Sides of the polygon a tree's crown is drawn as. */
export const CROWN_SIDES = 24;
const CROWN_CIRCUMSCRIPTION = 1 / Math.cos(Math.PI / CROWN_SIDES);

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
 * A pitched roof's frame, from its principal axis and oriented bounds. Physical distances
 * are written directly to the surface buffer; `angle` is the ridge direction byte.
 */
export function roofRidge(
  ring: readonly TilePoint[],
  shape: number = RoofShape.gabled,
  unitMeters = 1,
): RoofSurfaceFrame {
  let folded = foldRoofAngle(principalAxis(ring).theta);
  let box = roofBounds(ring, folded);
  if (box.halfWidth > box.halfLength) {
    folded = foldRoofAngle(folded + Math.PI / 2);
    box = roofBounds(ring, folded);
  }
  const ux = Math.cos(folded),
    uy = Math.sin(folded);
  const parameters = roofParameters(
    Math.max(0.001, box.halfLength),
    Math.max(0.001, box.halfWidth),
    shape,
  );
  return {
    cx: box.center.x,
    cy: box.center.y,
    ux,
    uy,
    unit: unitMeters,
    ridgeHalf: parameters.ridgeHalf * unitMeters,
    endScale: parameters.endScale,
    angle: roofAngleByte(folded),
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
  let cx = 0,
    cy = 0;
  for (let i = 0; i < n; i++) {
    cx += ring[i]!.x / n;
    cy += ring[i]!.y / n;
  }
  let sxx = 0,
    syy = 0,
    sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = ring[i]!.x - cx,
      dy = ring[i]!.y - cy;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { cx, cy, ux: Math.cos(theta), uy: Math.sin(theta), theta };
}

/** Whether `p` is inside a polygon (its outer ring, less its holes), evenâ€“odd. */
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

/**
 * Add a road segment as a strip `2 Ã— half` units wide, extended by `half` past each end so
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

/** Side of the way in downward-positive tile Y: left is (dy, -dx). */
function addSideStrip(
  fills: Builder,
  a: TilePoint,
  b: TilePoint,
  inner: number,
  outer: number,
  side: number,
  vertex: (p: TilePoint) => void,
) {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (!length) return;
  const dx = (b.x - a.x) / length,
    dy = (b.y - a.y) / length;
  const nx = dy * side,
    ny = -dx * side;
  const base = fills.count;
  for (const [end, along, across] of [
    [a, -inner, inner],
    [a, -inner, outer],
    [b, inner, outer],
    [b, inner, inner],
  ] as const)
    vertex({ x: end.x + dx * along + nx * across, y: end.y + dy * along + ny * across });
  fills.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/** Exact dimensions; marking quads must not inherit road strips' extended caps. */
function addMarkingQuad(
  fills: Builder,
  p: TilePoint,
  bearing: number,
  length: number,
  width: number,
  vertex: (p: TilePoint) => void,
) {
  const theta = (bearing * Math.PI) / 180,
    dx = Math.sin(theta),
    dy = -Math.cos(theta);
  const base = fills.count;
  for (const [along, across] of [
    [-length / 2, -width / 2],
    [-length / 2, width / 2],
    [length / 2, width / 2],
    [length / 2, -width / 2],
  ])
    vertex({ x: p.x + dx * along! - dy * across!, y: p.y + dy * along! + dx * across! });
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
  fireworks = true,
  folklore = false,
): TileGeometry {
  const unitMeters = tile ? metersPerUnit(tile) : undefined;
  const folkloreSidecars = folklore && !!tile && tile.z >= LIFE_TILE_MIN_ZOOM;
  const memorials = !!tile && tile.z === maxZoom;
  const drawnAt = (zoom: number) =>
    !tile || maxZoom === undefined || tile.z >= Math.min(zoom, maxZoom) - 1;
  const strips = drawnAt(ROAD_AREA_ZOOM);
  const ridges = drawnAt(ROOF_ZOOM);
  const ground = () => ({ fills: new Builder(), lines: new Builder(), points: new Builder() });
  const main = ground();
  const regional = ground();
  const crowns = new Builder();
  const crownSurface: number[] = [];
  const labels: TileLabel[] = [];
  const life = new LifeBuilder();
  // Append new walking lines after the original lines to retain their stable indices/seeds.
  const walkingLines: { points: TilePoint[]; width: number; id: number }[] = [];
  const inTileAt = (p: TilePoint) => p.x >= 0 && p.x < EXTENT && p.y >= 0 && p.y < EXTENT;
  const litLines: LitLine[] = [];
  const utilities: UtilityRecord[] = [];
  const rawSeasonal: string[] = [];
  const residential: ResidentialSite[] = [];
  const compactRoofs: ResidentialSite[] = [];
  const residentialStreets: TilePoint[][] = [];
  // Burial rows repeat one parent descriptor thousands of times. Keep this cache
  // local to a decode, including failed parses, so archives cannot grow it forever.
  const selections = new Map<string, ReturnType<typeof parseDetailSelection>>();

  for (const [name, layer] of Object.entries(layers)) {
    if (name === 'seasons') {
      if (tile && tile.z === maxZoom)
        for (let i = 0; i < layer.length; i++) {
          const raw = layer.feature(i).properties.seasonal;
          if (typeof raw === 'string') rawSeasonal.push(raw);
        }
      continue;
    }
    if (name === 'utilities') {
      if (tile && tile.z === maxZoom)
        for (let i = 0; i < layer.length; i++) {
          const record = parseUtilityRecord(layer.feature(i).properties.utility);
          if (record) utilities.push(record);
        }
      continue;
    }
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
      let burialHash: number | undefined;
      // A site's building or monument may be in another tile on a cold direct-URL load.
      // Register its real metadata without assigning its id to the surface's outline.
      const descriptor = feature.properties.detail_selection;
      if (typeof descriptor === 'string' && !selections.has(descriptor))
        selections.set(descriptor, parseDetailSelection(descriptor));
      const selection = typeof descriptor === 'string' ? selections.get(descriptor) : undefined;
      if (selection && selection.id === feature.properties.detail_parent)
        registry.index(selection.id, () => selection);
      const id = registry.index(featureId, () =>
        featureInfo(featureId, className, feature.properties),
      );
      const rawHeight = Number(feature.properties.height ?? 0);
      const height = Number.isFinite(rawHeight)
        ? Math.max(rawHeight > 0 ? 1 : 0, Math.min(255, Math.round(rawHeight)))
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
      let flags = landmark ? Flags.landmark : 0;
      const frontage = FRONTAGE_KINDS.indexOf(feature.properties.frontage as FrontageKind);
      if (frontage >= 0 && isBuilding(className))
        flags |=
          Flags.frontage |
          (frontage & 1 ? Flags.frontageLow : 0) |
          (frontage & 2 ? Flags.frontageHigh : 0);
      const variant = variantCode(className, feature.properties.variant);
      const { shop_lng, shop_lat, shop_radius_m } = feature.properties;
      const shopPosition =
        tile &&
        typeof shop_lng === 'number' &&
        typeof shop_lat === 'number' &&
        Number.isFinite(shop_lng) &&
        Number.isFinite(shop_lat) &&
        typeof shop_radius_m === 'number' &&
        Number.isFinite(shop_radius_m) &&
        shop_radius_m > 0
          ? lngLatToTile(tile, shop_lng, shop_lat)
          : undefined;
      const addShop = (fallback: TilePoint, radius: number, commerce = true) => {
        const p = shopPosition ?? fallback;
        if (commerce) life.commerceAt(p, featureId);
        life.shop(
          p,
          shopPosition && unitMeters ? Number(shop_radius_m) / unitMeters : radius,
          featureId,
        );
      };
      const width = Number(feature.properties.width ?? 0);
      const marker = markerFor[className as keyof typeof markerFor];
      const place = isRegion ? undefined : placeFor(className, variant);
      const siteKind = LIFE_SITE_KINDS.indexOf(
        feature.properties.life_site as (typeof LIFE_SITE_KINDS)[number],
      );
      if (
        !isRegion &&
        tile &&
        siteKind >= 0 &&
        typeof feature.properties.life_lng === 'number' &&
        typeof feature.properties.life_lat === 'number'
      ) {
        const p = lngLatToTile(tile, feature.properties.life_lng, feature.properties.life_lat);
        life.site(
          p,
          siteKind,
          Number(feature.properties.life_modes ?? 0),
          !!feature.properties.life_covered,
        );
      }

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
        // A conservative swept crown envelope: branches lean and flutter in any wind direction.
        // The flutter bound follows swayOffset, including its wake term, independently of cells.
        const radius = Math.max(...ring.map((q) => Math.hypot(q.x - p.x, q.y - p.y)));
        const sweptRadius = radius * CROWN_SWEEP_FACTOR;
        const envelope = Array.from({ length: CROWN_SIDES + 1 }, (_, i) => {
          const angle = (i * 2 * Math.PI) / CROWN_SIDES;
          const r = sweptRadius * CROWN_CIRCUMSCRIPTION;
          return { x: p.x + Math.cos(angle) * r, y: p.y + Math.sin(angle) * r };
        });
        life.area('parking-exclusion', [envelope]);
        const crownCls = classId('tree_crown' satisfies RenderClass);
        const reach = (q: TilePoint) => Math.hypot(q.x - p.x, q.y - p.y);
        const first = crowns.count;
        // A center vertex gives both wind reach and canopy lighting an interior, rather
        // than interpolating only between rim vertices. The radial outline is star-shaped.
        crowns.vertex(p.x, p.y, crownCls, height, flags, id, variant, 0);
        crownSurface.push(0, 0);
        for (const q of ring.slice(0, -1)) {
          const r = reach(q);
          crowns.vertex(q.x, q.y, crownCls, height, flags, id, variant, r);
          crownSurface.push((q.x - p.x) / (r || 1), (q.y - p.y) / (r || 1));
        }
        for (let i = 0; i < CROWN_SIDES; i++)
          crowns.indices.push(first, first + 1 + i, first + 1 + ((i + 1) % CROWN_SIDES));
      };
      const isTree = className === 'tree' && !isRegion;

      const rings = feature
        .loadGeometry()
        .map((ring) => ring.map((p) => ({ x: p.x * scale, y: p.y * scale })));

      if (!isRegion && feature.properties.detail_route) {
        for (const line of rings) life.line(line, LifeLine.path, width, id);
        continue;
      }

      if (feature.type === 1) {
        for (const ring of rings) {
          for (const p of ring) {
            if (
              !isRegion &&
              className === 'furniture' &&
              variant === 3 &&
              feature.properties.flag === 'PH'
            ) {
              life.flagpole(p, 1);
            }
            if (className === 'furniture' && variant === 14 && unitMeters && tile) {
              if (!isRegion && inTileAt(p)) {
                const heads = Math.max(1, Math.min(4, Number(feature.properties.lamp_heads ?? 1)));
                const reach = Number(feature.properties.lamp_reach ?? 0.7) / unitMeters;
                const worldScale = MERCATOR_METERS / (EXTENT * 2 ** tile.z);
                const seed =
                  (placeSeed(
                    (tile.x * EXTENT + p.x) * worldScale,
                    (tile.y * EXTENT + p.y) * worldScale,
                  ) >>>
                    8) &
                  31;
                for (let h = 0; h < heads; h++) {
                  const angle =
                    ((Number(feature.properties.lamp_bearing ?? 0) + (h * 360) / heads) * Math.PI) /
                    180;
                  const x = p.x + Math.sin(angle) * reach,
                    y = p.y - Math.cos(angle) * reach;
                  life.addLamps(
                    [p.x, p.y, LampState.working, seed, x, y, p.x, p.y],
                    true,
                    feature.properties.lamp_style === 'lantern' ? 'lantern' : 'streetlight',
                  );
                }
              }
              continue;
            }
            if (className === 'furniture' && (variant === 12 || variant === 13)) {
              if (strips && unitMeters && !isRegion) {
                const stop = variant === 12;
                const bearing = Number(
                  feature.properties[stop ? 'stop_bearing' : 'arrow_bearing'] ?? 0,
                );
                const road = classId(
                  String(feature.properties[stop ? 'stop_road' : 'arrow_road'] ?? 'road_minor'),
                );
                const width = Number(feature.properties[stop ? 'stop_width' : 'arrow_width'] ?? 3);
                addMarkingQuad(
                  fills,
                  p,
                  bearing,
                  (stop ? 0.5 : 3) / unitMeters,
                  width / unitMeters,
                  (q) =>
                    fills.vertex(
                      q.x,
                      q.y,
                      road,
                      0,
                      Flags.corridor | Flags.crossing,
                      id,
                      markingByte(stop ? Marking.stop : Marking.arrow, bearing),
                    ),
                );
              }
              continue;
            }
            if (className === 'furniture' && variant === 7) {
              const controller = decodeCrossingController(feature.properties);
              if (unitMeters && !isRegion) {
                const theta = (Number(feature.properties.crossing_bearing ?? 0) * Math.PI) / 180;
                const halfWidth = Number(feature.properties.crossing_width ?? 6) / 2 / unitMeters;
                const along = 1.5 / unitMeters;
                if (controller) {
                  life.controlledCrossing({
                    id: featureId,
                    controller,
                    anchor: p,
                    bearing: Number(feature.properties.crossing_bearing ?? 0),
                    width: Number(feature.properties.crossing_width ?? 6),
                    lineId: hashString(`${featureId}/crossing`),
                  });
                  const signal = decodeCrossingSignal(feature.properties, controller);
                  if (signal && tile)
                    life.signal(
                      lngLatToTile(tile, ...signal.at),
                      signal.radius,
                      signal.a,
                      signal.b,
                      signal.mapped,
                      signal.layout,
                      { id: signal.id, seed: signal.seed, stops: signal.stops, fallback: true },
                    );
                }
                const a = { x: p.x - Math.sin(theta) * along, y: p.y + Math.cos(theta) * along };
                const b = { x: p.x + Math.sin(theta) * along, y: p.y - Math.cos(theta) * along };
                // The walkable cut runs past the mapped width: the carriageway's corners and
                // inferred widths can reach further, which would strand walkers mid-crossing.
                life.area(
                  'crossing',
                  [stripRing(a, b, halfWidth + CROSSING_CUT_M / unitMeters)],
                  false,
                  [stripRing(a, b, halfWidth)],
                );
                // Give a whole group room to clear the road before turning at an unattached end.
                const reach = halfWidth + (CROSSING_CUT_M + CROSSING_WALK_PAST_M) / unitMeters;
                walkingLines.push({
                  points: [
                    { x: p.x - Math.cos(theta) * reach, y: p.y - Math.sin(theta) * reach },
                    { x: p.x + Math.cos(theta) * reach, y: p.y + Math.sin(theta) * reach },
                  ],
                  width: 3,
                  id: hashString(`${featureId}/crossing`),
                });
              }
              if (strips && unitMeters) {
                const bearing = Number(feature.properties.crossing_bearing ?? 0);
                const theta = (bearing * Math.PI) / 180;
                const reach = 1.5 / unitMeters;
                const a = { x: p.x - Math.sin(theta) * reach, y: p.y + Math.cos(theta) * reach };
                const b = { x: p.x + Math.sin(theta) * reach, y: p.y - Math.cos(theta) * reach };
                const road = classId(String(feature.properties.crossing_road ?? 'road_minor'));
                addStrip(
                  fills,
                  a,
                  b,
                  Number(feature.properties.crossing_width ?? 6) / 2 / unitMeters,
                  (q) =>
                    fills.vertex(
                      q.x,
                      q.y,
                      road,
                      0,
                      Flags.corridor | Flags.crossing,
                      id,
                      markingByte(Marking.crosswalk, bearing),
                    ),
                );
              }
              continue;
            }
            if (className === 'furniture' && variant === 8) {
              if (!isRegion)
                life.signal(
                  p,
                  Number(feature.properties.signal_radius ?? 4),
                  Number(feature.properties.signal_a ?? -1),
                  Number(feature.properties.signal_b ?? 90),
                  feature.properties.life_signal === 'mapped',
                  feature.properties.signal_layout === undefined
                    ? undefined
                    : parseSignalLayout(JSON.parse(String(feature.properties.signal_layout))),
                  {
                    id: featureId,
                    seed:
                      feature.properties.signal_seed === undefined
                        ? undefined
                        : parseControllerSeed(feature.properties.signal_seed),
                    stops:
                      feature.properties.signal_stops === undefined
                        ? undefined
                        : parseSignalStops(JSON.parse(String(feature.properties.signal_stops))),
                  },
                );
              continue;
            }
            if (marker || landmark) addMarkers(p);
            else if (!Number.isFinite(Number(feature.properties.seat_bearing))) addPoint(p, cls);
            if (landmark && !isRegion && unitMeters && inTileAt(p)) {
              life.flood(p, FLOOD.pointRadius / 2 / unitMeters);
            }
            if (isTree) addCrown(p);
            // A tree birds can land in, in the tile that holds it.
            const inTile = p.x >= 0 && p.x < EXTENT && p.y >= 0 && p.y < EXTENT;
            if (isTree && inTile) life.perch(p);
            if (className === 'building_station' && !isRegion) life.station(p);
            if (className === 'building_market' && !isRegion) life.market(p);
            if (folkloreSidecars && className === 'building_hospital' && !isRegion)
              life.hospital(featureId, p, 0);
            if (
              !isRegion &&
              className === 'furniture' &&
              variant >= 9 &&
              variant <= 11 &&
              unitMeters
            ) {
              addShop(p, SHOP.pointRadius / 2 / unitMeters);
            }
            if (className === 'building_market' && !isRegion && unitMeters) {
              addShop(p, SHOP.pointRadius / 2 / unitMeters, !!shopPosition);
            }
            if (place && inTile)
              life.place(
                p,
                place,
                0,
                false,
                Number(feature.properties.seat_bearing ?? NaN),
                typeof feature.properties.landmark_id === 'string'
                  ? feature.properties.landmark_id
                  : undefined,
                featureId,
              );
          }
        }
      } else if (feature.type === 2) {
        if (fireworks && !isRegion && isResidentialStreet(className, feature.properties.kind))
          residentialStreets.push(...rings);
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
              run: [tileToLngLat(tile, run.from), tileToLngLat(tile, run.to)],
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
              const sidewalk = feature.properties.sidewalk;
              for (const side of ['left', 'right'] as const) {
                if (sidewalk !== 'both' && sidewalk !== side) continue;
                const sidewalkWidth = Number(
                  feature.properties[`sidewalk_${side}_width`] ??
                    feature.properties.sidewalk_width ??
                    2,
                );
                if (sidewalkWidth > 0)
                  addSideStrip(
                    fills,
                    a,
                    b,
                    width / 2 / unitMeters,
                    (width / 2 + sidewalkWidth) / unitMeters,
                    side === 'left' ? 1 : -1,
                    (p) =>
                      fills.vertex(
                        p.x,
                        p.y,
                        classId('path'),
                        0,
                        flags | Flags.corridor | Flags.sidewalk,
                        id,
                      ),
                  );
              }
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
        if (!isRegion && unitMeters && lifeLine !== undefined && lifeLine <= LifeLine.roadMinor) {
          for (const line of rings) {
            for (let i = 1; i < line.length; i++) {
              const ring = stripRing(
                line[i - 1]!,
                line[i]!,
                (width || DEFAULT_ROAD_WIDTH_M) / 2 / unitMeters,
              );
              if (ring.length) life.area('carriageway', [ring]);
            }
            if (feature.properties.sidewalk_src === 'derived') continue;
            for (const side of ['left', 'right'] as const) {
              if (feature.properties.sidewalk !== 'both' && feature.properties.sidewalk !== side)
                continue;
              const sidewalkWidth = Number(
                feature.properties[`sidewalk_${side}_width`] ??
                  feature.properties.sidewalk_width ??
                  2,
              );
              if (!(sidewalkWidth > 0)) continue;
              walkingLines.push({
                points: sidewalkLine(
                  line,
                  (((width || DEFAULT_ROAD_WIDTH_M) / 2 + sidewalkWidth / 2) / unitMeters) *
                    (side === 'left' ? 1 : -1),
                ),
                width: sidewalkWidth,
                id: hashString(`${featureId}/sidewalk-${side}`),
              });
            }
          }
        }
        if (lifeLine !== undefined) {
          const oneway =
            feature.properties.oneway === -1 ? -1 : feature.properties.oneway === 1 ? 1 : 0;
          for (const line of rings) life.line(line, lifeLine, width, hashString(featureId), oneway);
        }
        if (
          !isRegion &&
          (className === 'barrier' || className === 'water_river' || className === 'water_stream')
        ) {
          for (const line of rings) life.obstacle(line, false);
        }
        // Streetlights line major and secondary roads (life/lights.ts), placed once all are in.
        if (isLitRoad(className, isRegion)) {
          for (const line of rings) litLines.push({ points: line, width });
        }
        const first = rings[0];
        if (landmark && first && first.length > 0) addMarkers(first[Math.floor(first.length / 2)]!);
      } else if (feature.type === 3) {
        let largest: { ring: TilePoint[]; area: number } | undefined;
        const plan =
          ridges && tile && isRoofBuilding(className) && height > 0 && variant !== RoofShape.flat
            ? parseRoofPlan(feature.properties.roof_plan)
            : undefined;
        const planOrigin = plan && tile ? lngLatToTile(tile, ...plan.origin) : undefined;
        const planUnit =
          plan && tile ? roofFrame(plan.origin).metersPerTileUnit(tile.z) : undefined;
        // What walkers and parked cars keep out of: solid buildings (not grounds) and water.
        const overhead = feature.properties.detail_overhead === true;
        const walkableStep =
          !overhead &&
          feature.properties.detail_blocked === true &&
          className === 'building_part' &&
          !String(feature.properties.kind).startsWith('burial=') &&
          rawHeight > 0 &&
          rawHeight <= 0.2;
        const solid = !overhead && !walkableStep && isBuilding(className) && height > 0;
        const standingWater = className === 'water_area' || className === 'water_sea';
        const obstacle =
          !walkableStep &&
          (!!feature.properties.detail_blocked ||
            solid ||
            standingWater ||
            (!overhead && className === 'building_part') ||
            className === 'water_river' ||
            className === 'water_stream');
        const polygons = classifyRings(rings).map((polygon) => {
          const points: TilePoint[] = [];
          const coords: number[] = [];
          const holes: number[] = [];
          for (let r = 0; r < polygon.length; r++) {
            if (r > 0) holes.push(points.length);
            for (const p of polygon[r]!) {
              points.push(p);
              coords.push(p.x, p.y);
            }
          }
          const triangles = earcut(coords, holes.length ? holes : null, 2);
          const pieces =
            plan && planOrigin && tile
              ? partitionRoofTriangles(points, triangles, plan, planOrigin, tile.z)
              : undefined;
          return { polygon, points, triangles, pieces };
        });
        // One corrupt/degenerate fragment falls back for the entire feature, before emitting buffers.
        const usePlan = !!plan && polygons.every((p) => p.pieces !== undefined);
        for (const { polygon, points, triangles, pieces: partition } of polygons) {
          if (
            fireworks &&
            !isRegion &&
            className === 'building' &&
            isResidentialBuilding(feature.properties.kind)
          ) {
            const site = residentialSite(id, points, triangles, EXTENT);
            if (site) residential.push(site);
          }
          if (
            fireworks &&
            !isRegion &&
            unitMeters &&
            isRoofCandidate(className, feature.properties.kind, height, landmark) &&
            isCompactRoof(points, triangles, unitMeters)
          ) {
            const site = residentialSite(id, points, triangles, EXTENT);
            if (site) compactRoofs.push(site);
          }
          if (!isRegion) {
            if (className === 'parking') life.area('parking', polygon);
            // A curb ring encloses its island: vehicles keep off all of it, not just the curb.
            else if (walkableStep) life.area('vehicle-blocked', [polygon[0]!]);
            else if (solid || standingWater || feature.properties.detail_blocked)
              life.area('blocked', polygon, standingWater, undefined, className === 'seating');
            else if (className === 'trees') life.area('parking-exclusion', polygon);
          }
          const base = fills.count;
          const ridge =
            !usePlan &&
            ridges &&
            isRoofBuilding(className) &&
            height > 0 &&
            variant !== RoofShape.flat
              ? roofRidge(polygon[0]!, variant, unitMeters ?? 1)
              : undefined;
          const pieces = usePlan ? partition : undefined;
          if (pieces && plan && planOrigin && tile) {
            const frames = new Map<(typeof pieces)[number]['leaf'], RoofSurfaceFrame>();
            for (const piece of pieces) {
              let frame = frames.get(piece.leaf);
              if (!frame) {
                frame = plannedRoofFrame(piece.leaf, planOrigin, planUnit!, variant);
                frames.set(piece.leaf, frame);
              }
              const start = fills.count;
              for (const p of piece.points) {
                fills.vertex(
                  p.x,
                  p.y,
                  cls,
                  height,
                  flags | Flags.ridged,
                  id,
                  frame.angle,
                  0,
                  frame,
                );
              }
              fills.indices.push(start, start + 1, start + 2);
            }
          } else {
            for (const p of points) {
              if (ridge) {
                fills.vertex(
                  p.x,
                  p.y,
                  cls,
                  height,
                  flags | Flags.ridged,
                  id,
                  ridge.angle,
                  0,
                  ridge,
                );
              } else {
                fills.vertex(p.x, p.y, cls, height, flags, id, variant);
              }
            }
            for (const i of triangles) fills.indices.push(base + i);
          }
          const outer = polygon[0]!;
          // These footprints are read-only folklore inputs, never population or obstacles.
          if (folkloreSidecars && !isRegion && (className === 'grass' || className === 'farmland'))
            life.field(featureId, className, polygon);
          if (folkloreSidecars && !isRegion && className === 'building_hospital') {
            const center = ringCentroid(outer);
            // signedArea is the doubled shoelace area, so divide by two before finding a radius.
            life.hospital(featureId, center, Math.sqrt(Math.abs(signedArea(outer)) / 2 / Math.PI));
          }
          if (
            folkloreSidecars &&
            !isRegion &&
            isBuilding(className) &&
            className !== 'building_part' &&
            height > 0
          ) {
            let anchor = ringCentroid(outer);
            if (!insidePolygon(polygon, anchor))
              for (let t = 0; t < triangles.length; t += 3) {
                const a = points[triangles[t]!]!,
                  b = points[triangles[t + 1]!]!,
                  c = points[triangles[t + 2]!]!;
                const p = { x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3 };
                if (insidePolygon(polygon, p)) {
                  anchor = p;
                  break;
                }
              }
            if (insidePolygon(polygon, anchor)) life.roof(featureId, polygon, anchor);
          }
          if (!isRegion && memorials) {
            if (
              className === 'grass' &&
              ['landuse=cemetery', 'amenity=grave_yard'].includes(String(feature.properties.kind))
            ) {
              life.cemeteryArea(featureId, polygon);
            }
            if (
              className === 'building_part' &&
              String(feature.properties.kind).startsWith('burial=')
            ) {
              if (typeof feature.properties.detail_parent === 'string')
                life.burialParent(feature.properties.detail_parent);
              const center = ringCentroid(outer);
              const wx = Math.round(tile.x * EXTENT + center.x),
                wy = Math.round(tile.y * EXTENT + center.y);
              burialHash ??= hashString(featureId);
              life.grave(center, featureId, graveSeed(burialHash, wx, wy), [wx, wy]);
            }
          }
          if (!isRegion && obstacle) life.obstacle(outer, true);
          if (!isRegion && plazaClasses.has(className)) life.line(outer, LifeLine.plaza);
          if (!isRegion && className === 'parking' && unitMeters) {
            for (const { p, hx, hy } of parkingStalls(polygon, unitMeters)) life.spot(p, hx, hy);
          }
          const area = Math.abs(signedArea(outer));
          if (!largest || area > largest.area) largest = { ring: outer, area };
        }
        if (largest) {
          const center = ringCentroid(largest.ring);
          if (
            !isRegion &&
            className === 'grass' &&
            ['landuse=cemetery', 'amenity=grave_yard'].includes(String(feature.properties.kind))
          ) {
            life.cemetery(center, Math.sqrt(largest.area / 2 / Math.PI));
          }
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
          if (!isRegion && (className === 'building_market' || frontage >= 0)) {
            const reach = Math.max(
              ...largest.ring.map((q) => Math.hypot(q.x - center.x, q.y - center.y)),
            );
            addShop(center, reach);
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
            life.place(
              center,
              place,
              radius,
              isBuilding(className) && height > 0,
              NaN,
              typeof feature.properties.landmark_id === 'string'
                ? feature.properties.landmark_id
                : undefined,
              featureId,
            );
          }
        }
      }
    }
  }

  for (const line of walkingLines) life.line(line.points, LifeLine.path, line.width, line.id);
  if (unitMeters && life.crossingAnchors.length) {
    const access = new RoadAccess(life.roadPolygons, life.crossingCuts);
    finalizeControlledCrossings(life.crossingAnchors, life.roadPolygons, 1 / unitMeters, access);
    const routes = controlledCrossingConnectors(
      life.crossingAnchors,
      life.walkingLinesView,
      life.roadPolygons,
      life.crossingCuts,
      life.walkingObstacles(1 / unitMeters, stripRing),
      1 / unitMeters,
      hashString,
      access,
    );
    life.joinWalking(routes.joins, routes.connectors);
    if (strips)
      for (const crossing of life.crossingAnchors)
        for (const side of crossing.sides ?? [])
          for (const pad of side.pads) {
            const vertices = pad.slice(0, -1),
              base = main.fills.count;
            for (const p of vertices)
              main.fills.vertex(
                p.x,
                p.y,
                classId('path'),
                0,
                Flags.corridor | Flags.sidewalk,
                registry.index(crossing.id),
                0,
              );
            for (const i of earcut(vertices.flatMap((p) => [p.x, p.y])))
              main.fills.indices.push(base + i);
          }
  }
  if (tile) life.splitSignalRoads((p) => lngLatToTile(tile, ...p), hashString);
  if (unitMeters && tile && tile.z >= LIFE_TILE_MIN_ZOOM)
    life.splitRoadJunctions(1 / unitMeters, ROAD_SPLIT_CLEARANCE_M);

  if (unitMeters && tile) {
    if (fireworks)
      residential.push(
        ...neighborhoodSites(compactRoofs, residential, residentialStreets, unitMeters),
      );
    const origin = { x: tile.x * EXTENT, y: tile.y * EXTENT };
    life.addLamps(placeTileLamps(litLines, unitMeters, EXTENT, origin));
  }

  const finish = (g: ReturnType<typeof ground>): GroundGeometry => ({
    fills: { ...g.fills.finish(), indices: Uint32Array.from(g.fills.indices) },
    lines: g.lines.finish(),
    points: g.points.finish(),
  });
  const seasonal = rawSeasonal.length ? encodeSeasonalPayload(rawSeasonal) : undefined;
  return {
    ...finish(main),
    crowns: {
      ...crowns.finish(),
      indices: Uint32Array.from(crowns.indices),
      surface: Float32Array.from(crownSurface),
      surfaceSize: 2,
    },
    region: finish(regional),
    labels,
    life: {
      ...life.finish(),
      ...(seasonal ? { seasonalPayload: seasonal } : {}),
    },
    ...(utilities.length ? { utilities } : {}),
    ...(seasonal ? { seasonal } : {}),
    ...(fireworks ? { residential: packResidentialSites(residential) } : {}),
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
    if (g.surface) out.push(g.surface.buffer as ArrayBuffer);
  }
  out.push(
    geometry.fills.indices.buffer as ArrayBuffer,
    geometry.crowns.indices.buffer as ArrayBuffer,
    region.fills.indices.buffer as ArrayBuffer,
    ...lifeTransferables(geometry.life),
  );
  if (geometry.residential) out.push(geometry.residential.buffer as ArrayBuffer);
  return out;
}

/** Coverage-only requests triangulate roofs without constructing ground, Life or GPU buffers. */
export function buildResidentialSites(
  layers: Readonly<Record<string, TileLayerLike>>,
  registry: IdRegistry,
  tile: TileAddress,
): ResidentialSites {
  const mapped: ResidentialSite[] = [],
    roofs: ResidentialSite[] = [],
    streets: TilePoint[][] = [];
  const meters = metersPerUnit(tile);
  for (const [name, layer] of Object.entries(layers)) {
    const scale = EXTENT / layer.extent;
    for (let i = 0; i < layer.length; i++) {
      const feature = layer.feature(i),
        props = feature.properties;
      if (props.region === true) continue;
      const road = feature.type === 2 && isResidentialStreet(props.class, props.kind);
      const explicit = isResidentialBuilding(props.kind);
      const roof = isRoofCandidate(
        props.class,
        props.kind,
        Number(props.height),
        props.landmark === true,
      );
      if (!road && !(feature.type === 3 && props.class === 'building' && (explicit || roof)))
        continue;
      const rings = feature
        .loadGeometry()
        .map((ring) => ring.map((p) => ({ x: p.x * scale, y: p.y * scale })));
      if (road) {
        streets.push(...rings);
        continue;
      }
      for (const polygon of classifyRings(rings)) {
        const points: TilePoint[] = [],
          coords: number[] = [],
          holes: number[] = [];
        for (let r = 0; r < polygon.length; r++) {
          if (r) holes.push(points.length);
          for (const p of polygon[r]!) {
            points.push(p);
            coords.push(p.x, p.y);
          }
        }
        const triangles = earcut(coords, holes.length ? holes : null, 2);
        if (!explicit && !isCompactRoof(points, triangles, meters)) continue;
        const featureId = String(props.id ?? `${name}/${i}`);
        const id = registry.index(featureId, () => featureInfo(featureId, 'building', props));
        const site = residentialSite(id, points, triangles, EXTENT);
        if (site) (explicit ? mapped : roofs).push(site);
      }
    }
  }
  return packResidentialSites([...mapped, ...neighborhoodSites(roofs, mapped, streets, meters)]);
}
