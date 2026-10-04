import { createHash } from 'node:crypto';
import { SiteDetail } from './schemas';

/** Geometry/selection fingerprint for matching local smoke fixtures to a generated archive. */
export function detailLayoutKey(input: unknown): string {
  const detail = SiteDetail.parse(input);
  // Parsing fixes property order and defaults. Annotation edits do not invalidate a layout.
  const layout = {
    osm_id: detail.osm_id,
    selection_osm_id: detail.selection_osm_id,
    surface: detail.surface,
    grounds: detail.grounds,
    ...(detail.extent && { extent: detail.extent }),
    structures: detail.structures.map((part) => ({
      ...part,
      ground_override: part.ground_override ?? false,
    })),
    ...(detail.roof_overrides.length && { roof_overrides: detail.roof_overrides }),
    ...(detail.building_overrides.length && { building_overrides: detail.building_overrides }),
    flagpoles: detail.flagpoles,
    walks: detail.walks,
    seating: detail.seating,
    lamps: detail.lamps,
    ...(detail.parked_vehicles.length && { parked_vehicles: detail.parked_vehicles }),
  };
  return createHash('sha256').update(JSON.stringify(layout)).digest('hex');
}
