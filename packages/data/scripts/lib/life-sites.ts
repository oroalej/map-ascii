import {
  transitMask,
  type LifeSiteConfig,
  type LifeSiteKind,
  type TransitMode,
} from '@atlas/shared';
import turfCentroid from '@turf/centroid';
import type { AtlasFeature } from '../03-normalize';
import type { Tags } from './classify';

export function siteOfTags(
  tags: Tags,
): { kind: LifeSiteKind; modes: number; covered: boolean } | undefined {
  const covered = tags.covered === 'yes' || tags.shelter === 'yes' || tags.amenity === 'shelter';
  if (tags.amenity === 'shelter' || (tags.entrance && covered))
    return { kind: 'shelter', modes: 0, covered: true };
  const terminal = tags.amenity === 'bus_station' || tags.amenity === 'taxi';
  const stop =
    tags.highway === 'bus_stop' ||
    (['platform', 'stop_position'].includes(tags.public_transport ?? '') &&
      !['train', 'tram', 'subway', 'ferry', 'light_rail'].some((mode) => tags[mode] === 'yes') &&
      tags.railway !== 'platform');
  if (!terminal && !stop) return undefined;
  const modes: TransitMode[] = [];
  if (/tricycl/i.test(tags.name ?? '')) modes.push('tricycle');
  if (/jeepney/i.test(tags.name ?? '') || tags.share_taxi === 'yes') modes.push('jeepney');
  if (
    tags.bus === 'yes' ||
    tags.highway === 'bus_stop' ||
    tags.amenity === 'bus_station' ||
    (stop && modes.length === 0)
  )
    modes.push('bus');
  // An ordinary taxi rank is not evidence of a tricycle terminal.
  if (modes.length === 0) return undefined;
  return { kind: terminal ? 'terminal' : 'stop', modes: transitMask(modes), covered };
}

/** Rounded like label anchors (04-merge-content.ts `addLabelAnchor`). */
const round7 = (v: number) => Math.round(v * 1e7) / 1e7;

/**
 * Stamp a feature as an interaction site, anchored at `center` (computed from the full geometry,
 * so every tile agrees). Transit geometry is needed before the furniture glyphs become visible.
 */
export function markSite(
  feature: AtlasFeature,
  site: { kind: LifeSiteKind; modes: number; covered: boolean },
  [lng, lat]: readonly number[],
) {
  Object.assign(feature.properties, {
    life_site: site.kind,
    life_modes: site.modes,
    life_covered: site.covered,
    life_lng: round7(lng!),
    life_lat: round7(lat!),
  });
  feature.tippecanoe.minzoom = Math.min(feature.tippecanoe.minzoom, 13);
}

/**
 * Annotate matched OSM features or add independently sourced point sites. Pack values override
 * what the pipeline derived from OSM tags; anything the pack leaves out keeps the OSM value.
 */
export function mergeLifeSites(
  features: AtlasFeature[],
  sites: readonly LifeSiteConfig[] = [],
  [west, south, east, north]: readonly [number, number, number, number] = [-180, -90, 180, 90],
) {
  const byId = new Map(features.map((f) => [f.properties.id, f]));
  for (const site of sites) {
    let feature = site.osm_id ? byId.get(site.osm_id) : undefined;
    if (site.osm_id && !feature)
      throw new Error(`Life site ${site.id}: ${site.osm_id} is missing from OSM data`);
    if (feature?.properties.region)
      throw new Error(`Life site ${site.id}: ${site.osm_id} is outside the detailed area`);
    if (feature && !isSiteClass(feature.properties.class))
      throw new Error(
        `Life site ${site.id}: ${site.osm_id} is a ${feature.properties.class}, not a site`,
      );
    if (!feature) {
      const [lng, lat] = site.position!;
      if (lng < west || lng > east || lat < south || lat > north)
        throw new Error(`Life site ${site.id}: ${lat}, ${lng} is outside the region`);
      feature = {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: site.position! },
        properties: { id: `life:${site.id}`, class: 'furniture' },
        tippecanoe: { layer: 'poi', minzoom: 13, maxzoom: 16 },
      };
      features.push(feature);
    }
    const p = feature.properties;
    markSite(
      feature,
      {
        kind: site.kind,
        modes: site.modes ? transitMask(site.modes) : (p.life_modes ?? 0),
        covered: site.covered ?? p.life_covered ?? site.kind === 'shelter',
      },
      turfCentroid(feature).geometry.coordinates,
    );
    if (p.class === 'furniture') p.variant = site.kind;
  }
  return features;
}

/** The classes a site can annotate: its own glyph, a covered entrance, or a building. */
const isSiteClass = (cls: string) =>
  cls === 'furniture' || cls === 'entrance' || cls.startsWith('building');
