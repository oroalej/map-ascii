/** City-pack annotations for mapped or independently sourced interaction sites. */
export const TRANSIT_MODES = ['bus', 'jeepney', 'tricycle'] as const;
export type TransitMode = (typeof TRANSIT_MODES)[number];
export const TRANSIT_BITS: Readonly<Record<TransitMode, number>> = {
  bus: 1,
  jeepney: 2,
  tricycle: 4,
};
export const LIFE_SITE_KINDS = ['stop', 'terminal', 'shelter'] as const;
export type LifeSiteKind = (typeof LIFE_SITE_KINDS)[number];
export type LifeSiteConfig = {
  id: string;
  kind: LifeSiteKind;
  osm_id?: string;
  /** A sourced location absent from OSM, [longitude, latitude]. */
  position?: [number, number];
  modes?: TransitMode[];
  covered?: boolean;
  source: string;
};
export const transitMask = (modes: readonly TransitMode[]) =>
  modes.reduce((bits, mode) => bits | TRANSIT_BITS[mode], 0);
