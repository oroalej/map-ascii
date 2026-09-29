/**
 * What the life layer (SPEC.md §4 "Life layer") needs from a tile: the lines its agents move
 * along and the places birds gather over, in tile units. Built in the tile worker next to the
 * render geometry (raster/geometry.ts), and kept on the main thread for the simulation.
 */
import type { TilePoint } from '../raster/geometry';

/** The kind of a life polyline; agents keep to lines of kinds they can use (life/config.ts). */
export const LifeLine = {
  roadMajor: 0,
  roadMid: 1,
  roadMinor: 2,
  path: 3,
  /** The outline of a park or plaza, which people stroll around. */
  plaza: 4,
  river: 5,
} as const;
export type LifeLine = (typeof LifeLine)[keyof typeof LifeLine];

/** Line classes agents move along. */
export const lifeLineFor: Readonly<Partial<Record<string, LifeLine>>> = {
  road_major: LifeLine.roadMajor,
  road_mid: LifeLine.roadMid,
  road_minor: LifeLine.roadMinor,
  path: LifeLine.path,
  water_river: LifeLine.river,
};

/** Area classes whose outline people stroll around. */
export const plazaClasses: ReadonlySet<string> = new Set(['park']);

/** Area classes birds gather over. */
export const roostClasses: ReadonlySet<string> = new Set(['park', 'trees', 'grass', 'water_area']);

export type LifeGeometry = {
  /** Polyline vertices: x, y in tile units. */
  coords: Float32Array;
  /** The first vertex of each polyline, then one past the last vertex (length = lines + 1). */
  starts: Uint32Array;
  /** Each polyline's `LifeLine` kind. */
  kinds: Uint8Array;
  /** Each polyline's width in meters (roads' carriageways; 0 unknown). */
  widths: Float32Array;
  /** Where birds gather: x, y in tile units. */
  roosts: Float32Array;
  /** Trees birds can land in: x, y pairs (tile units). */
  perches: Float32Array;
  /** Parking lots' stalls: x, y, then the heading (a unit vector), in tile units. */
  spots: Float32Array;
};

/** At most this many parking stalls per tile. */
export const MAX_TILE_SPOTS = 300;
/** Trees per tile birds can land in. */
export const MAX_TILE_PERCHES = 24;

export class LifeBuilder {
  private coords: number[] = [];
  private starts: number[] = [];
  private kinds: number[] = [];
  private widths: number[] = [];
  private roosts: number[] = [];
  private perches: number[] = [];
  private spots: number[] = [];

  line(points: readonly TilePoint[], kind: LifeLine, width = 0) {
    if (points.length < 2) return;
    this.starts.push(this.coords.length / 2);
    this.kinds.push(kind);
    this.widths.push(width);
    for (const p of points) this.coords.push(p.x, p.y);
  }

  roost(p: TilePoint) {
    this.roosts.push(p.x, p.y);
  }

  /** A tree birds can land in. Past `MAX_TILE_PERCHES`, dropped. */
  perch(p: TilePoint) {
    if (this.perches.length / 2 < MAX_TILE_PERCHES) this.perches.push(p.x, p.y);
  }

  /** A parking stall at `p`, facing (`hx`, `hy`). Past `MAX_TILE_SPOTS`, dropped. */
  spot(p: TilePoint, hx: number, hy: number) {
    if (this.spots.length / 4 < MAX_TILE_SPOTS) this.spots.push(p.x, p.y, hx, hy);
  }

  finish(): LifeGeometry {
    return {
      coords: Float32Array.from(this.coords),
      starts: Uint32Array.from([...this.starts, this.coords.length / 2]),
      kinds: Uint8Array.from(this.kinds),
      widths: Float32Array.from(this.widths),
      roosts: Float32Array.from(this.roosts),
      perches: Float32Array.from(this.perches),
      spots: Float32Array.from(this.spots),
    };
  }
}

export const lifeTransferables = (g: LifeGeometry): ArrayBuffer[] => [
  g.coords.buffer as ArrayBuffer,
  g.starts.buffer as ArrayBuffer,
  g.kinds.buffer as ArrayBuffer,
  g.widths.buffer as ArrayBuffer,
  g.roosts.buffer as ArrayBuffer,
  g.perches.buffer as ArrayBuffer,
  g.spots.buffer as ArrayBuffer,
];
