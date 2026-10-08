/**
 * Plain values shared by the pipeline and the browser, kept out of `schemas.ts` so the web app
 * and renderer can use them without bundling zod (ARCHITECTURE.md §8 initial JS budget). The
 * schemas build on them, so each value has one source.
 */

/** Shopfront kinds shared without importing build-time validation into the renderer. */
export const FRONTAGE_KINDS = ['food', 'retail', 'service', 'commercial'] as const;
export type FrontageKind = (typeof FRONTAGE_KINDS)[number];

/** Point-shop footprint radius in meters; pipeline anchors and renderer fallback agree. */
export const SHOP_POINT_RADIUS_M = 5;

/** Carriageway width in meters when a road has no width metadata. */
export const DEFAULT_ROAD_WIDTH_M = 6;

/** Stable building variant bytes, shared by the pipeline and renderer. */
export const RoofShape = { flat: 1, gabled: 2, hipped: 3, pyramidal: 4 } as const;
export const foldRoofAngle = (angle: number) => ((angle % Math.PI) + Math.PI) % Math.PI;
export const ROOF_PLAN_MAX_LEAVES = 4;
export const ROOF_PLAN_MAX_NODES = ROOF_PLAN_MAX_LEAVES * 2 - 1;
/** Archive z16 and its loading parent are the first tiles carrying detailed roof plans. */
export const ROOF_PLAN_MIN_TILE_ZOOM = 15;

/** Feature classes the pipeline assigns and the renderer themes (DATA.md §3, SPEC.md §4). */
export const ATLAS_CLASSES = [
  'water_river',
  'water_area',
  'water_sea',
  'coastline',
  'road_major',
  'road_mid',
  'road_minor',
  'path',
  // Inserted mid-list: a line class needs an id under 32 to join its neighbors (glyphs/select.ts
  // class masks). `parking` and `pitch`, never in a mask, moved to the end to make room.
  'rail',
  'building',
  'building_religious',
  'building_school',
  'building_market',
  'park',
  'trees',
  // Inserted mid-list: every class a select-shader mask holds still has an id under 32.
  'grass',
  'farmland',
  'monument',
  'building_part',
  'tree',
  'barrier',
  'entrance',
  'furniture',
  'admin_city',
  'admin_subdivision',
  'place_label',
  // Appended so the classes above keep their renderer ids (glyphs/select.ts class masks).
  'water_stream',
  'parking',
  'pitch',
  'building_station',
  'paving',
  'seating',
  'shrubs',
  'planting',
  'building_woodwork',
  // Terrain has no connectivity mask; moving it here leaves room for the hospital marker.
  'terrain',
  'building_hospital',
] as const;

/** The valid range of each camera field (the `CameraState` schema). */
export const CAMERA_RANGES = {
  lat: [-90, 90],
  lng: [-180, 180],
  zoom: [0, 22],
} as const satisfies Record<string, readonly [number, number]>;

/** The kinds of vehicle the life layer draws (SPEC.md §4 "Life layer"). */
export const VEHICLE_TYPES = [
  'car',
  'motorcycle',
  'tricycle',
  'jeepney',
  'bus',
  'truck',
  'bicycle',
] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];

/** The kinds of boat the life layer draws on rivers. */
export const BOAT_TYPES = ['rowboat', 'motorboat', 'banca'] as const;
export type BoatType = (typeof BOAT_TYPES)[number];

/** The road classes a city's traffic mix is set for. */
export const TRAFFIC_ROADS = ['road_major', 'road_mid', 'road_minor'] as const;
export type TrafficRoad = (typeof TRAFFIC_ROADS)[number];

/**
 * A city's traffic (the `Traffic` schema): per road class, how common each vehicle type is, as
 * relative weights; the same for boats on rivers and canals and for parked vehicles. What it leaves out
 * uses the renderer's default mix.
 */
export type TrafficMix = Partial<
  Record<TrafficRoad | 'parked', Partial<Record<VehicleType, number>>>
> & {
  river?: Partial<Record<BoatType, number>>;
  canal?: Partial<Record<BoatType, number>>;
};

/** The years the content can name (the `Year` schema). */
export const YEAR_RANGE = [1000, 3000] as const;
/** Zod-free event validation and formation defaults, shared by authoring and runtime. */
export const PROCESSION_LIMITS = {
  fluvial: { columns: [1, 6], ranks: [1, 20], escorts: [0, 40], followers: [0, 200] },
  procession: {
    bearers: [4, 64],
    ranks: [1, 20],
    marshals: [0, 32],
    columns: [2, 10],
    images: [1, 3],
  },
  parade: {
    contingents: [1, 100],
    ranks: [1, 10],
    band: [0, 48],
    color_guard: [0, 8],
    bands: [0, 6],
    columns: [2, 10],
  },
  radius: 500,
  actors: 300,
  verge: 6,
  altar: { radius: 20, images: [0, 3], apron: 3 },
  vehicles: 4,
  schedule: { offset_days: [-31, 31], duration_min: [1, 1440] },
} as const;
export const PROCESSION_DEFAULTS = {
  fluvial: { columns: 3, ranks: 8, escorts: 6, followers: 14 },
  procession: { bearers: 8, ranks: 12, marshals: 4, columns: 6, images: 1 },
  parade: { contingents: 3, ranks: 4, band: 12, color_guard: 4, bands: 1, columns: 4 },
} as const;
export const PROCESSION_VEHICLES = ['car', 'truck', 'motorcycle'] as const;
type ActorFormation = Partial<
  Record<
    | 'columns'
    | 'ranks'
    | 'images'
    | 'bearers'
    | 'marshals'
    | 'contingents'
    | 'bands'
    | 'band'
    | 'color_guard'
    | 'escorts'
    | 'followers',
    number
  >
> & { vehicles?: readonly unknown[] };
/** Physical actors only; raster contingent blocks and decorations have no simulated owners. */
export function processionActorCount(
  kind: 'fluvial' | 'procession' | 'parade',
  formation: ActorFormation = {},
) {
  if (kind === 'procession') {
    const f = PROCESSION_DEFAULTS.procession;
    return (
      (formation.images ?? f.images) * ((formation.bearers ?? f.bearers) + 1) +
      (formation.marshals ?? f.marshals) +
      (formation.ranks ?? f.ranks) * (formation.columns ?? f.columns)
    );
  }
  if (kind === 'fluvial') {
    const f = PROCESSION_DEFAULTS.fluvial;
    return (
      1 +
      (formation.columns ?? f.columns) * (formation.ranks ?? f.ranks) +
      (formation.escorts ?? f.escorts) +
      (formation.followers ?? f.followers)
    );
  }
  const f = PROCESSION_DEFAULTS.parade;
  const contingents = formation.contingents ?? f.contingents,
    bands = formation.bands ?? f.bands;
  const groups = bands ? Math.ceil(contingents / Math.ceil(contingents / bands)) : 0;
  return (
    groups * (formation.band ?? f.band) +
    (formation.color_guard ?? f.color_guard) +
    (formation.vehicles?.length ?? 0)
  );
}
/** Physical geometry used by event routing, probes and collision reservations, in metres. */
export const PROCESSION_GEOMETRY = {
  person: { length: 0.9, width: 1 },
  andas: { length: 3, width: 2.4 },
  vehicles: {
    car: { length: 4.4, width: 1.8 },
    truck: { length: 8, width: 2.5 },
    motorcycle: { length: 2, width: 0.8 },
  },
  columnPitch: 0.8,
  rowPitch: 2,
  probePadding: 0.05,
  clearanceMargin: 0.5,
  massCell: 2,
} as const;
export const ALTAR_IMAGE_SPACING_M = 10;
export type ProcessionAltarMember = {
  x: number;
  y: number;
  paint: number;
  prop?: 'platform' | 'table' | 'canopy' | 'support' | 'andas';
  footprint?: { length: number; width: number };
  scenery?: boolean;
};
/** Shared fixed composition supplies actor reservations and complete permission extents. */
export function processionAltarLayout(images: number): ProcessionAltarMember[] {
  const members: ProcessionAltarMember[] = Array.from({ length: 8 }, (_, i) => ({
    x: ((i % 4) - 1.5) * 1.2,
    y: -2 + Math.floor(i / 4) * 1.5,
    paint: i < 5 ? 0 : 7,
  }));
  members.push(
    { x: 0, y: 0, paint: 6, prop: 'platform', footprint: { length: 5, width: 7 }, scenery: true },
    { x: 0, y: 2, paint: 3, prop: 'table', footprint: { length: 1.2, width: 2.4 } },
    { x: 0, y: 0, paint: 3, prop: 'canopy', footprint: { length: 5, width: 6 }, scenery: true },
    { x: -3, y: 2, paint: 6, prop: 'support', footprint: { length: 0.4, width: 0.4 } },
    { x: 3, y: 2, paint: 6, prop: 'support', footprint: { length: 0.4, width: 0.4 } },
  );
  for (let i = 0; i < images; i++)
    members.push({
      x: (i - (images - 1) / 2) * ALTAR_IMAGE_SPACING_M,
      y: -0.5,
      paint: 4,
      prop: 'andas',
      footprint: PROCESSION_GEOMETRY.andas,
    });
  return members;
}
/** A padded radial envelope contains complete members at any heading, plus the audience apron. */
export function processionAltarRadius(radius: number, images: number): number {
  let extent = radius;
  for (const member of processionAltarLayout(images)) {
    const size = member.footprint ?? PROCESSION_GEOMETRY.person;
    extent = Math.max(
      extent,
      Math.hypot(member.x, member.y) +
        Math.hypot(size.length, size.width) / 2 +
        Math.SQRT2 * PROCESSION_GEOMETRY.probePadding,
    );
  }
  return extent + PROCESSION_LIMITS.altar.apron;
}
export function processionFormationWidth(
  kind: 'procession' | 'parade',
  vehicles: readonly (typeof PROCESSION_VEHICLES)[number][] = [],
): number {
  const g = PROCESSION_GEOMETRY;
  // A narrow road may require single file; larger rosters add rows, never drop members.
  const people = g.person.width;
  return (
    Math.max(
      people,
      ...(kind === 'procession'
        ? [g.andas.width]
        : vehicles.map((vehicle) => g.vehicles[vehicle].width)),
    ) +
    2 * (g.probePadding + g.clearanceMargin)
  );
}
export const CLOCK_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
export const TIME_ZONE_PATTERN = /^[A-Za-z_]+(\/[A-Za-z_+-]+)+$/;
export const OSM_ID_PATTERN = /^osm:(node|way|relation)\/\d+$/;
export const OSM_AREA_ID_PATTERN = /^osm:(way|relation)\/\d+$/;
export const OSM_WAY_ID_PATTERN = /^osm:way\/\d+$/;
export const TODO_VERIFY = 'TODO(verify)';

/** Split a string into characters (code points), so box-drawing and emoji-free art counts right. */
export const artChars = (row: string): string[] => [...row];

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => String.fromCodePoint(from + i));

/**
 * Characters landmark art may use: printable ASCII, the box-drawing and block-element ranges,
 * and a few symbols. The renderer's glyph atlas includes all of them.
 */
export const ART_CHARACTERS: ReadonlySet<string> = new Set([
  ...range(0x20, 0x7e),
  ...range(0x2500, 0x257f),
  ...range(0x2580, 0x259f),
  ...'◆◇▲△▼▽○●◦•·†‡¶°∩≡≈♣♠♦☼',
]);
