import { createHash } from 'node:crypto';
import { SiteDetail } from '@atlas/shared';

/** Geometry/selection fingerprint for matching local smoke fixtures to a generated archive. */
export function detailLayoutKey(input: unknown): string {
  const detail = SiteDetail.parse(input);
  // Parsing fixes property order and defaults. Annotation edits do not invalidate a layout.
  const layout = {
    osm_id: detail.osm_id,
    selection_osm_id: detail.selection_osm_id,
    surface: detail.surface,
    grounds: detail.grounds,
    structures: detail.structures.map((part) => ({
      ...part,
      ground_override: part.ground_override ?? false,
    })),
    flagpoles: detail.flagpoles,
    walks: detail.walks,
    seating: detail.seating,
    lamps: detail.lamps,
  };
  return createHash('sha256').update(JSON.stringify(layout)).digest('hex');
}
