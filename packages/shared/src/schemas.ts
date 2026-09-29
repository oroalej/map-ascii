import { z } from 'zod';

/** Localized text. English is required; Filipino and Bikol are optional. */
export const LocalizedText = z.object({
  en: z.string().min(1),
  fil: z.string().min(1).optional(),
  bcl: z.string().min(1).optional(),
});
export type LocalizedText = z.infer<typeof LocalizedText>;

export const Source = z.object({
  title: z.string().min(1),
  url: z.url().optional(),
  note: z.string().optional(),
});
export type Source = z.infer<typeof Source>;

export const Sources = z.array(Source).min(1, 'at least one source is required');

export const Certainty = z.enum(['exact', 'circa', 'unknown']);
export type Certainty = z.infer<typeof Certainty>;

/** Certainty for a known date; "unknown" makes no sense when a year is given. */
export const DateCertainty = z.enum(['exact', 'circa']);
export type DateCertainty = z.infer<typeof DateCertainty>;

export const Year = z.int().min(1000).max(3000);

export const OsmId = z.string().regex(/^osm:(node|way|relation)\/\d+$/, 'expected osm:<type>/<id>');

export const Photo = z.object({
  src: z.string().min(1),
  year: Year.optional(),
  caption: z.string().optional(),
  credit: z.string().min(1),
  license: z.string().min(1),
});
export type Photo = z.infer<typeof Photo>;

/** Loose GeoJSON geometry; full validation happens in the data pipeline. */
export const GeoJsonGeometry = z.looseObject({
  type: z.enum(['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon']),
  coordinates: z.array(z.unknown()),
});
export type GeoJsonGeometry = z.infer<typeof GeoJsonGeometry>;

const endAfterStart = (v: { start_year?: number | undefined; end_year?: number | undefined }) =>
  v.start_year === undefined || v.end_year === undefined || v.end_year > v.start_year;

export const LandmarkType = z.enum([
  'church',
  'school',
  'plaza',
  'market',
  'government',
  'bridge',
  'monument',
  'other',
]);
export type LandmarkType = z.infer<typeof LandmarkType>;

export const Landmark = z
  .object({
    id: z.string().regex(/^landmark\/[a-z0-9-]+$/, 'expected landmark/<slug>'),
    osm_id: OsmId.optional(),
    geometry: GeoJsonGeometry.optional(),
    name: LocalizedText,
    type: LandmarkType,
    start_year: Year.optional(),
    end_year: Year.optional(),
    certainty: Certainty,
    story: LocalizedText.optional(),
    photos: z.array(Photo).optional(),
    sources: Sources,
  })
  .refine(endAfterStart, {
    message: 'end_year must be greater than start_year',
    path: ['end_year'],
  })
  .refine((v) => v.osm_id !== undefined || v.geometry !== undefined, {
    message: 'a landmark needs either osm_id or geometry',
    path: ['osm_id'],
  });
export type Landmark = z.infer<typeof Landmark>;

export const NameHistoryEntry = z
  .object({
    name: z.string().min(1),
    from: Year.optional(),
    to: Year.optional(),
    certainty: DateCertainty,
  })
  .refine((v) => v.from === undefined || v.to === undefined || v.to > v.from, {
    message: 'to must be greater than from',
    path: ['to'],
  });
export type NameHistoryEntry = z.infer<typeof NameHistoryEntry>;

export const NameHistory = z.object({
  osm_id: OsmId,
  names: z.array(NameHistoryEntry).min(1),
  sources: Sources,
});
export type NameHistory = z.infer<typeof NameHistory>;

export const Event = z.object({
  id: z.string().regex(/^event\/[a-z0-9-]+$/, 'expected event/<slug>'),
  year: Year,
  date: z.iso.date().optional(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  title: LocalizedText,
  story: LocalizedText,
  sources: Sources,
});
export type Event = z.infer<typeof Event>;

export const CameraState = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  zoom: z.number().min(0).max(22),
  pitch: z.number().min(0).max(60),
  bearing: z.number().min(-180).max(180),
});
export type CameraState = z.infer<typeof CameraState>;

export const TourStep = z.object({
  camera: CameraState,
  duration_ms: z.int().positive(),
  narration: LocalizedText,
  year: Year.optional(),
  select: z.string().min(1).optional(),
  highlight: z.array(z.string().min(1)).optional(),
  audio: z.string().min(1).optional(),
});
export type TourStep = z.infer<typeof TourStep>;

export const Tour = z.object({
  id: z.string().regex(/^tour\/[a-z0-9-]+$/, 'expected tour/<slug>'),
  title: LocalizedText,
  steps: z.array(TourStep).min(1),
});
export type Tour = z.infer<typeof Tour>;
