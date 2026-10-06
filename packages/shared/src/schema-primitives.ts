import { z } from 'zod';
import { OSM_ID_PATTERN, OSM_AREA_ID_PATTERN, OSM_WAY_ID_PATTERN } from './constants';

/** Leaf primitives shared by pack and tile schemas without circular initialization. */
export const OsmId = z.string().regex(OSM_ID_PATTERN, 'expected osm:<type>/<id>');
export const OsmAreaId = z.string().regex(OSM_AREA_ID_PATTERN);
export const OsmWayId = z.string().regex(OSM_WAY_ID_PATTERN);
export const MercatorPosition = z.tuple([
  z.number().min(-180).max(180),
  z.number().min(-85.051129).max(85.051129),
]);
