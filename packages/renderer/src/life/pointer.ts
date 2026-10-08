/** Geographic cursor gust; direction is east/south and radius is in physical metres. */
export type CursorGust = {
  lngLat: readonly [number, number];
  dir: readonly [number, number];
  strength: number;
  radiusM: number;
};
