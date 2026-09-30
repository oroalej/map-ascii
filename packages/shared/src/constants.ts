/**
 * Plain values shared by the pipeline and the browser, kept out of `schemas.ts` so the web app
 * and renderer can use them without bundling zod (ARCHITECTURE.md §8 initial JS budget). The
 * schemas build on them, so each value has one source.
 */

/** Feature classes the pipeline assigns and the renderer themes (DATA.md §3, SPEC.md §4). */
export const ATLAS_CLASSES = [
  'water_river',
  'water_area',
  'water_sea',
  'coastline',
  'terrain',
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

/** Split a string into characters (code points), so box-drawing and emoji-free art counts right. */
export const artChars = (row: string): string[] => [...row];
