/**
 * What the life layer (SPEC.md §4 "Life layer") needs from a tile: the lines its agents move
 * along and the places birds gather over, in tile units. Built in the tile worker next to the
 * render geometry (raster/geometry.ts), and kept on the main thread for the simulation.
 */
import type { PlaceKind } from '@atlas/shared';
import type { TilePoint } from '../raster/geometry';
import { Habitat } from './birds';

/** The kind of a life polyline; agents keep to lines of kinds they can use (life/config.ts). */
export const LifeLine = {
  roadMajor: 0,
  roadMid: 1,
  roadMinor: 2,
  path: 3,
  /** The outline of a park or plaza, which people stroll around. */
  plaza: 4,
  river: 5,
  rail: 6,
  /** A siding, spur, or yard track: trains stand by here, and running trains keep off. */
  siding: 7,
  /** A canal: small boats only. */
  canal: 8,
} as const;
export type LifeLine = (typeof LifeLine)[keyof typeof LifeLine];

/** Line classes agents move along. */
export const lifeLineFor: Readonly<Partial<Record<string, LifeLine>>> = {
  road_major: LifeLine.roadMajor,
  road_mid: LifeLine.roadMid,
  road_minor: LifeLine.roadMinor,
  path: LifeLine.path,
  water_river: LifeLine.river,
  rail: LifeLine.rail,
};

/** The OSM kind of a stream that small boats use (other streams stay empty). */
export const CANAL_KIND = 'waterway=canal';

/** Places people gather at, in `LifeGeometry.places` (rhythm.ts `PLACE_KINDS` order). */
export const PLACE_CODES: readonly PlaceKind[] = [
  'worship',
  'school',
  'pitch',
  'monument',
  'bench',
  'fountain',
  'farm',
];
export const placeCode = (kind: PlaceKind) => PLACE_CODES.indexOf(kind);

/**
 * The place a feature is, if people gather there: churches and schools (their buildings, or
 * their grounds), sports pitches, monuments, benches and fountains (`furniture` variants 1 and
 * 2, classes.ts), and farmland.
 */
export function placeFor(className: string, variant: number): PlaceKind | undefined {
  switch (className) {
    case 'building_religious':
      return 'worship';
    case 'building_school':
      return 'school';
    case 'pitch':
      return 'pitch';
    case 'monument':
      return 'monument';
    case 'farmland':
      return 'farm';
    case 'furniture':
      return variant === 1 ? 'bench' : variant === 2 ? 'fountain' : undefined;
    default:
      return undefined;
  }
}

/** Area classes whose outline people stroll around. */
export const plazaClasses: ReadonlySet<string> = new Set(['park']);

/** Area classes birds gather over (each a life/birds.ts `Habitat`, `habitatOf`). */
export const roostClasses: ReadonlySet<string> = new Set([
  'park',
  'trees',
  'grass',
  'farmland',
  'water_area',
]);

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
  /** Each roost's life/birds.ts `Habitat`, which picks the species that gather there. */
  roostHabitats: Uint8Array;
  /** Trees birds can land in: x, y pairs (tile units). */
  perches: Float32Array;
  /** Parking lots' stalls: x, y, then the heading (a unit vector), in tile units. */
  spots: Float32Array;
  /** Where trains stop: train stations' centers, x, y in tile units. */
  stations: Float32Array;
  /** Markets' centers, where street vendors gather: x, y in tile units. */
  markets: Float32Array;
  /** Streetlights along main roads: x, y (tile units), state, seed (life/lights.ts). */
  lamps: Float32Array;
  /** Floodlit landmarks: center x, y and radius (tile units; life/lights.ts `FLOOD_STRIDE`). */
  floods: Float32Array;
  /** Shops and markets, lit while open: center x, y and radius (tile units, `SHOP_STRIDE`). */
  shops: Float32Array;
  /**
   * Places people gather at (`PLACE_STRIDE` floats each): center x, y (tile units), the place's
   * `placeCode`, its radius (tile units; 0 for a point), and 1 when it is a building (people
   * stand around it, not on it).
   */
  places: Float32Array;
};

export const PLACE_STRIDE = 5;

/** At most this many parking stalls per tile. */
export const MAX_TILE_SPOTS = 300;
/** Trees per tile birds can land in. */
export const MAX_TILE_PERCHES = 24;
/** Places per tile people gather at. */
export const MAX_TILE_PLACES = 40;

export class LifeBuilder {
  private coords: number[] = [];
  private starts: number[] = [];
  private kinds: number[] = [];
  private widths: number[] = [];
  private roosts: number[] = [];
  private roostHabitats: number[] = [];
  private perches: number[] = [];
  private spots: number[] = [];
  private stations: number[] = [];
  private markets: number[] = [];
  private lamps: number[] = [];
  private floods: number[] = [];
  private shops: number[] = [];
  private places: number[] = [];

  line(points: readonly TilePoint[], kind: LifeLine, width = 0) {
    if (points.length < 2) return;
    this.starts.push(this.coords.length / 2);
    this.kinds.push(kind);
    this.widths.push(width);
    for (const p of points) this.coords.push(p.x, p.y);
  }

  roost(p: TilePoint, habitat: Habitat = Habitat.park) {
    this.roosts.push(p.x, p.y);
    this.roostHabitats.push(habitat);
  }

  /** A tree birds can land in. Past `MAX_TILE_PERCHES`, dropped. */
  perch(p: TilePoint) {
    if (this.perches.length / 2 < MAX_TILE_PERCHES) this.perches.push(p.x, p.y);
  }

  /** A parking stall at `p`, facing (`hx`, `hy`). Past `MAX_TILE_SPOTS`, dropped. */
  spot(p: TilePoint, hx: number, hy: number) {
    if (this.spots.length / 4 < MAX_TILE_SPOTS) this.spots.push(p.x, p.y, hx, hy);
  }

  /** A train station, where trains stop. */
  station(p: TilePoint) {
    this.stations.push(p.x, p.y);
  }

  /** A market (or mall), where street vendors gather. */
  market(p: TilePoint) {
    this.markets.push(p.x, p.y);
  }

  /** Streetlights (life/lights.ts `placeTileLamps`, `LAMP_STRIDE` floats each). */
  addLamps(values: readonly number[]) {
    for (const v of values) this.lamps.push(v);
  }

  /** A floodlit landmark centered at `p`, `radius` tile units across. */
  flood(p: TilePoint, radius: number) {
    this.floods.push(p.x, p.y, radius);
  }

  /** A shop or market centered at `p`, `radius` tile units across, lit while it is open. */
  shop(p: TilePoint, radius: number) {
    this.shops.push(p.x, p.y, radius);
  }

  /**
   * A place people gather at, centered at `p`, `radius` tile units across (0 for a point);
   * `building` when people stand around it rather than on it. Past `MAX_TILE_PLACES`, dropped.
   */
  place(p: TilePoint, kind: PlaceKind, radius: number, building = false) {
    if (this.places.length / PLACE_STRIDE >= MAX_TILE_PLACES) return;
    this.places.push(p.x, p.y, placeCode(kind), radius, building ? 1 : 0);
  }

  finish(): LifeGeometry {
    return {
      coords: Float32Array.from(this.coords),
      starts: Uint32Array.from([...this.starts, this.coords.length / 2]),
      kinds: Uint8Array.from(this.kinds),
      widths: Float32Array.from(this.widths),
      roosts: Float32Array.from(this.roosts),
      roostHabitats: Uint8Array.from(this.roostHabitats),
      perches: Float32Array.from(this.perches),
      spots: Float32Array.from(this.spots),
      stations: Float32Array.from(this.stations),
      markets: Float32Array.from(this.markets),
      lamps: Float32Array.from(this.lamps),
      floods: Float32Array.from(this.floods),
      shops: Float32Array.from(this.shops),
      places: Float32Array.from(this.places),
    };
  }
}

export const lifeTransferables = (g: LifeGeometry): ArrayBuffer[] => [
  g.coords.buffer as ArrayBuffer,
  g.starts.buffer as ArrayBuffer,
  g.kinds.buffer as ArrayBuffer,
  g.widths.buffer as ArrayBuffer,
  g.roosts.buffer as ArrayBuffer,
  g.roostHabitats.buffer as ArrayBuffer,
  g.perches.buffer as ArrayBuffer,
  g.spots.buffer as ArrayBuffer,
  g.stations.buffer as ArrayBuffer,
  g.markets.buffer as ArrayBuffer,
  g.lamps.buffer as ArrayBuffer,
  g.floods.buffer as ArrayBuffer,
  g.shops.buffer as ArrayBuffer,
  g.places.buffer as ArrayBuffer,
];
