import { z } from 'zod';

/** Leaf primitives shared by pack and tile schemas without circular initialization. */
export const OsmId = z.string().regex(/^osm:(node|way|relation)\/\d+$/, 'expected osm:<type>/<id>');
export const OsmAreaId = z.string().regex(/^osm:(way|relation)\/\d+$/);
export const OsmWayId = z.string().regex(/^osm:way\/\d+$/);
export const MercatorPosition = z.tuple([
  z.number().min(-180).max(180),
  z.number().min(-85.051129).max(85.051129),
]);
