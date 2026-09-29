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
  'building',
  'building_religious',
  'building_school',
  'building_market',
  'park',
  'trees',
  'farmland',
  'monument',
  'building_part',
  'tree',
  'barrier',
  'entrance',
  'furniture',
  'parking',
  'pitch',
  'admin_city',
  'admin_subdivision',
  'place_label',
  // Appended so the classes above keep their renderer ids (glyphs/select.ts class masks).
  'water_stream',
] as const;

/** The valid range of each camera field (the `CameraState` schema). */
export const CAMERA_RANGES = {
  lat: [-90, 90],
  lng: [-180, 180],
  zoom: [0, 22],
  pitch: [0, 60],
  bearing: [-180, 180],
} as const satisfies Record<string, readonly [number, number]>;

/** The years the content can name (the `Year` schema). */
export const YEAR_RANGE = [1000, 3000] as const;

/** Split a string into characters (code points), so box-drawing and emoji-free art counts right. */
export const artChars = (row: string): string[] => [...row];
