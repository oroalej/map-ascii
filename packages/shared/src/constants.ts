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
  fluvial: { columns: [1, 6], ranks: [1, 20], escorts: [0, 40] },
  procession: { bearers: [4, 24], ranks: [1, 20], marshals: [0, 12] },
  parade: { contingents: [1, 6], ranks: [1, 10], band: [0, 24], color_guard: [0, 8] },
  radius: 500,
  vehicles: 4,
} as const;
export const PROCESSION_DEFAULTS = {
  fluvial: { columns: 3, ranks: 8, escorts: 6 },
  procession: { bearers: 8, ranks: 12, marshals: 4 },
  parade: { contingents: 3, ranks: 4, band: 12, color_guard: 4 },
} as const;
export const PROCESSION_VEHICLES = ['car', 'truck', 'motorcycle'] as const;
export const CLOCK_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
export const TIME_ZONE_PATTERN = /^[A-Za-z_]+(\/[A-Za-z_+-]+)+$/;

/** Split a string into characters (code points), so box-drawing and emoji-free art counts right. */
export const artChars = (row: string): string[] => [...row];
