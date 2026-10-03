import type { AtlasClass } from './schemas';

/** Zoom units over which a class fades in or out (SPEC.md §2: ~0.5, no popping). */
export const ZOOM_FADE = 0.5;

/** Human moments and their optional speech appear at this detail level. */
export const SPEECH_ZOOM = 18;

/**
 * When a class is shown. It fades in over `[min − ZOOM_FADE, min]` and, with a `max`, fades out
 * over `[max, max + ZOOM_FADE]`.
 */
export type ZoomBand = { min: number; max?: number };

/** Static overhead hardware and seeded close-up ornament detail. */
export const UTILITY_ZOOM: ZoomBand = { min: 18.5 };
export const UTILITY_DETAIL_ZOOM: ZoomBand = { min: 19.5 };

/**
 * The one table of when each class shows (SPEC.md §2 zoom levels). The pipeline derives each
 * feature's tile zoom range from it, and the renderer its crossfades.
 */
export const CLASS_ZOOM: Readonly<Record<AtlasClass, ZoomBand>> = {
  // Region
  terrain: { min: 0, max: 9.5 },
  water_sea: { min: 0 },
  coastline: { min: 0 },
  water_area: { min: 0 },
  road_major: { min: 0 },
  rail: { min: 0 },
  // City. Rivers start here: at Region zoom the region's thousands of rivers, each a line of
  // water glyphs, would cover the land.
  water_river: { min: 9.5 },
  admin_city: { min: 9.5 },
  admin_subdivision: { min: 11, max: 16 },
  road_mid: { min: 11 },
  // District
  water_stream: { min: 12.5 },
  park: { min: 12.5 },
  paving: { min: 12.5 },
  trees: { min: 12.5 },
  grass: { min: 12.5 },
  farmland: { min: 12.5 },
  road_minor: { min: 13 },
  building: { min: 13 },
  building_religious: { min: 13 },
  building_school: { min: 13 },
  building_hospital: { min: 13 },
  building_market: { min: 13 },
  building_station: { min: 13 },
  // Street
  path: { min: 15.5 },
  parking: { min: 16 },
  pitch: { min: 16 },
  // Place
  monument: { min: 17 },
  building_part: { min: 17 },
  tree: { min: 17 },
  barrier: { min: 17 },
  entrance: { min: 18 },
  furniture: { min: 18 },
  seating: { min: 18 },
  shrubs: { min: 19 },
  planting: { min: 18 },
  building_woodwork: { min: 18 },
  // Labels have their own zoom bands (the renderer's labels.ts).
  place_label: { min: 0 },
};

/** What decides a single feature's band beyond its class (the pipeline's properties). */
export type BandProps = { place?: string; subdivision_label?: boolean };

/**
 * A feature's band: its class's, except place labels, which show by what they name. Provinces
 * belong to the Region level, cities and towns until the District level, subdivision names
 * from the City level through the Street level, and smaller places from the District level.
 */
export function featureZoomBand(cls: AtlasClass, props: BandProps = {}): ZoomBand {
  if (cls === 'place_label') {
    if (props.place === 'province') return { min: 0, max: 9.5 };
    if (props.place === 'city' || props.place === 'town') return { min: 0, max: 13 };
    if (props.subdivision_label) return { min: 10.5, max: 16 };
    return { min: 13.5 };
  }
  return CLASS_ZOOM[cls];
}

/**
 * Deepest tile zoom for region-only features (the region download and what is derived from
 * it: the sea, terrain, province labels). Deeper, the renderer draws them from their z11 tile
 * (DATA.md §2 step 05: Region layers z6–z11, overzoomed in the client), so the region isn't
 * tiled at street zooms.
 */
export const REGION_TILE_MAX_ZOOM = 11;

/** Visibility of a band at `zoom`, from 0 (hidden) to 1 (fully shown). */
export function bandVisibility(band: ZoomBand, zoom: number): number {
  const fadeIn = Math.min(1, Math.max(0, (zoom - (band.min - ZOOM_FADE)) / ZOOM_FADE));
  const fadeOut =
    band.max === undefined
      ? 1
      : Math.min(1, Math.max(0, (band.max + ZOOM_FADE - zoom) / ZOOM_FADE));
  return Math.min(fadeIn, fadeOut);
}

/**
 * The tile zooms a band needs, for tippecanoe's per-feature `minzoom`/`maxzoom`. The renderer
 * draws tiles at `floor(zoom)`, so a class that starts fading in at 12.5 must be in z12 tiles.
 */
export function tileZoomRange(
  band: ZoomBand,
  tiles: { min: number; max: number },
): { minzoom: number; maxzoom: number } {
  const minzoom = Math.max(tiles.min, Math.floor(band.min - ZOOM_FADE));
  const maxzoom =
    band.max === undefined ? tiles.max : Math.min(tiles.max, Math.ceil(band.max + ZOOM_FADE));
  return { minzoom: Math.min(minzoom, maxzoom), maxzoom };
}

/** The named zoom levels (SPEC.md §2), for the HUD. */
export const ZOOM_LEVELS = [
  { name: 'Region', min: 0 },
  { name: 'City', min: 9.5 },
  { name: 'District', min: 13 },
  { name: 'Street', min: 15.5 },
  { name: 'Place', min: 17.5 },
] as const;

export type ZoomLevelName = (typeof ZOOM_LEVELS)[number]['name'];

/** The named level a zoom falls in. */
export function zoomLevel(zoom: number): ZoomLevelName {
  let level: ZoomLevelName = ZOOM_LEVELS[0].name;
  for (const l of ZOOM_LEVELS) if (zoom >= l.min) level = l.name;
  return level;
}
