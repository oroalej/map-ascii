import { z } from 'zod';

const point = z.tuple([z.number().min(-180).max(180), z.number().min(-85.051129).max(85.051129)]);
const way = z.string().regex(/^osm:way\/\d+$/);
const feature = z.string().regex(/^osm:(node|way|relation)\/\d+$/);
export const BuntingCorridorSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
    ways: z
      .array(way)
      .min(1)
      .max(100)
      .refine((v) => new Set(v).size === v.length, 'duplicate ways'),
    from: feature.optional(),
    to: feature.optional(),
    spacing_m: z.number().min(3).max(80),
    style: z.literal('red-yellow-rectangles'),
  })
  .refine((v) => !v.from || v.from !== v.to, 'endpoints must differ');
export const SeasonalBuntingRecordSchema = z
  .strictObject({
    version: z.literal(1),
    kind: z.literal('bunting'),
    id: z.string().min(1),
    season: z.string().min(1),
    corridor: z.string().min(1),
    road: way,
    from: point,
    to: point,
    segment: z.tuple([point, point]),
    seed: z.int().min(0).max(0xffffffff),
  })
  .refine((v) => v.from[0] !== v.to[0] || v.from[1] !== v.to[1], 'empty span')
  .refine(
    (v) => v.segment[0][0] !== v.segment[1][0] || v.segment[0][1] !== v.segment[1][1],
    'empty source segment',
  );

const installation = {
  version: z.literal(1),
  id: z.string().min(1),
  season: z.string().min(1),
  installation: z.string().min(1),
  anchor: feature,
  seed: z.int().min(0).max(0xffffffff),
};
export const SeasonalRecordSchema = z.union([
  SeasonalBuntingRecordSchema,
  z.strictObject({
    ...installation,
    kind: z.enum(['christmas-tree', 'decorated-canopy']),
    at: point,
    radius_m: z.number().min(0.5).max(20),
  }),
  z
    .strictObject({ ...installation, kind: z.literal('light-string'), from: point, to: point })
    .refine((v) => v.from[0] !== v.to[0] || v.from[1] !== v.to[1], 'empty light string'),
]);
