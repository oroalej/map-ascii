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
  /** Buffered mapped commerce centers, used only by separate additive spawn streams. */
  commerce?: Float32Array;
  /** Buffered signal centers, radius in meters, two bearings, mapped flag. */
  signals?: Float32Array;
  /** Stable feature identities for line copies in adjacent tiles. */
  lineIds?: Uint32Array;
  /** Lot boundaries and solid ground obstacles, including polygon holes. */
  areas?: LifeArea[];
  /** Interaction sites: x, y, kind (0 stop, 1 terminal, 2 shelter), mode bits, covered. */
  sites: Float32Array;
  /** Walking obstacles: polyline/polygon coordinates, start offsets and closed flags. */
  obstacles: Float32Array;
  obstacleStarts: Uint32Array;
  obstacleClosed: Uint8Array;
  /** Polyline vertices: x, y in tile units. */
  coords: Float32Array;
  /** The first vertex of each polyline, then one past the last vertex (length = lines + 1). */
  starts: Uint32Array;
  /** Each polyline's `LifeLine` kind. */
  kinds: Uint8Array;
  /** Each polyline's width in meters (roads' carriageways; 0 unknown). */
  widths: Float32Array;
  /** Direction relative to each way (-1, 0, 1); absent means zero. Reserved for future routing. */
  oneway?: Int8Array;
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

export type LifeArea = { kind: 'parking' | 'blocked'; rings: TilePoint[][]; water?: boolean };

export const PLACE_STRIDE = 5;
export const SITE_STRIDE = 5;
export const SIGNAL_STRIDE = 6;

/** A tile's own extent in tile units (raster/geometry.ts `EXTENT`). */
const TILE_EXTENT = 4096;
/** Whether a point is in its own tile, not in the buffer its neighbor owns. */
export const inTile = (p: { x: number; y: number }) =>
  p.x >= 0 && p.x < TILE_EXTENT && p.y >= 0 && p.y < TILE_EXTENT;

/** At most this many parking stalls per tile. */
export const MAX_TILE_SPOTS = 300;
/** Trees per tile birds can land in. */
export const MAX_TILE_PERCHES = 24;
/** Places per tile people gather at. */
export const MAX_TILE_PLACES = 40;
export const MAX_TILE_SHOPS = 150;

export class LifeBuilder {
  private commerce: number[] = [];
  commerceAt(p: TilePoint) {
    if (this.commerce.length / 2 < MAX_TILE_SHOPS) this.commerce.push(p.x, p.y);
  }
  private signals: number[] = [];
  signal(p: TilePoint, radius: number, axisA: number, axisB: number, mapped: boolean) {
    this.signals.push(p.x, p.y, radius, axisA, axisB, mapped ? 1 : 0);
  }
  private lineIds: number[] = [];
  private areas: LifeArea[] = [];
  private sites: number[] = [];
  private obstacles: number[] = [];
  private obstacleStarts: number[] = [];
  private obstacleClosed: number[] = [];

  site(p: TilePoint, kind: number, modes = 0, covered = false) {
    // Sites belong to one tile; its buffer must not duplicate reservations.
    if (!inTile(p) || this.sites.length >= 64 * SITE_STRIDE) return;
    this.sites.push(p.x, p.y, kind, modes, covered ? 1 : 0);
  }

  obstacle(points: readonly TilePoint[], closed: boolean) {
    if (points.length < 2) return;
    this.obstacleStarts.push(this.obstacles.length / 2);
    this.obstacleClosed.push(closed ? 1 : 0);
    for (const p of points) this.obstacles.push(p.x, p.y);
  }
  private coords: number[] = [];
  private starts: number[] = [];
  private kinds: number[] = [];
  private widths: number[] = [];
  private oneways: number[] = [];
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

  line(
    points: readonly TilePoint[],
    kind: LifeLine,
    width = 0,
    id = this.starts.length + 1,
    oneway: -1 | 0 | 1 = 0,
  ) {
    if (points.length < 2) return;
    this.starts.push(this.coords.length / 2);
    this.kinds.push(kind);
    this.widths.push(width);
    this.oneways.push(oneway);
    this.lineIds.push(id);
    for (const p of points) this.coords.push(p.x, p.y);
  }

  area(kind: LifeArea['kind'], rings: readonly (readonly TilePoint[])[], water = false) {
    this.areas.push({ kind, water, rings: rings.map((r) => r.map((p) => ({ ...p }))) });
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
    if (!inTile(p) || this.shops.length / 3 >= MAX_TILE_SHOPS) return;
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
      signals: Float32Array.from(this.signals),
      commerce: Float32Array.from(this.commerce),
      lineIds: Uint32Array.from(this.lineIds),
      areas: this.areas,
      sites: Float32Array.from(this.sites),
      obstacles: Float32Array.from(this.obstacles),
      obstacleStarts: Uint32Array.from([...this.obstacleStarts, this.obstacles.length / 2]),
      obstacleClosed: Uint8Array.from(this.obstacleClosed),
      coords: Float32Array.from(this.coords),
      starts: Uint32Array.from([...this.starts, this.coords.length / 2]),
      kinds: Uint8Array.from(this.kinds),
      widths: Float32Array.from(this.widths),
      oneway: Int8Array.from(this.oneways),
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
  ...(g.signals ? [g.signals.buffer as ArrayBuffer] : []),
  ...(g.commerce ? [g.commerce.buffer as ArrayBuffer] : []),
  ...(g.lineIds ? [g.lineIds.buffer as ArrayBuffer] : []),
  ...(g.oneway ? [g.oneway.buffer as ArrayBuffer] : []),
  g.sites.buffer as ArrayBuffer,
  g.obstacles.buffer as ArrayBuffer,
  g.obstacleStarts.buffer as ArrayBuffer,
  g.obstacleClosed.buffer as ArrayBuffer,
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
