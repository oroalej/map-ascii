import { z } from 'zod';

/** A BCP 47-style language code: "fil", "bcl", "pt-BR". */
export const LanguageCode = z
  .string()
  .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'expected a language code like "fil" or "pt-BR"');

/**
 * Localized text. English is always required. With `languages` (a city's declared languages),
 * the only other keys allowed are those; without it, any valid language code passes.
 */
export function localizedText(languages?: readonly string[]) {
  const allowed = languages && new Set(languages);
  return z
    .object({ en: z.string().min(1) })
    .catchall(z.string().min(1))
    .superRefine((value, ctx) => {
      for (const key of Object.keys(value)) {
        if (key === 'en') continue;
        if (!LanguageCode.safeParse(key).success) {
          ctx.addIssue({ code: 'custom', path: [key], message: `"${key}" is not a language code` });
        } else if (allowed && !allowed.has(key)) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `language "${key}" is not declared in the city's languages`,
          });
        }
      }
    });
}

export const LocalizedText = localizedText();
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

export const CameraState = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  zoom: z.number().min(0).max(22),
  pitch: z.number().min(0).max(60),
  bearing: z.number().min(-180).max(180),
});
export type CameraState = z.infer<typeof CameraState>;

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

/**
 * Schemas for a city pack's content. Pass the city's declared `languages` to reject localized
 * fields in any other language; omit it for language-agnostic validation.
 */
export function contentSchemas(languages?: readonly string[]) {
  const text = localizedText(languages);

  const Landmark = z
    .object({
      id: z.string().regex(/^landmark\/[a-z0-9-]+$/, 'expected landmark/<slug>'),
      osm_id: OsmId.optional(),
      geometry: GeoJsonGeometry.optional(),
      name: text,
      type: LandmarkType,
      start_year: Year.optional(),
      end_year: Year.optional(),
      certainty: Certainty,
      story: text.optional(),
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

  const NameHistory = z.object({
    osm_id: OsmId,
    names: z.array(NameHistoryEntry).min(1),
    sources: Sources,
  });

  const Event = z.object({
    id: z.string().regex(/^event\/[a-z0-9-]+$/, 'expected event/<slug>'),
    year: Year,
    date: z.iso.date().optional(),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    title: text,
    story: text,
    sources: Sources,
  });

  const TourStep = z.object({
    camera: CameraState,
    duration_ms: z.int().positive(),
    narration: text,
    year: Year.optional(),
    select: z.string().min(1).optional(),
    highlight: z.array(z.string().min(1)).optional(),
    audio: z.string().min(1).optional(),
  });

  const Tour = z.object({
    id: z.string().regex(/^tour\/[a-z0-9-]+$/, 'expected tour/<slug>'),
    title: text,
    steps: z.array(TourStep).min(1),
  });

  return { Landmark, NameHistory, Event, TourStep, Tour };
}

export const { Landmark, NameHistory, Event, TourStep, Tour } = contentSchemas();
export type Landmark = z.infer<typeof Landmark>;
export type NameHistory = z.infer<typeof NameHistory>;
export type Event = z.infer<typeof Event>;
export type TourStep = z.infer<typeof TourStep>;
export type Tour = z.infer<typeof Tour>;

/** [west, south, east, north] in degrees. */
export const BBox = z
  .tuple([
    z.number().min(-180).max(180),
    z.number().min(-90).max(90),
    z.number().min(-180).max(180),
    z.number().min(-90).max(90),
  ])
  .refine(([, south, , north]) => south < north, { message: 'south must be less than north' });
export type BBox = z.infer<typeof BBox>;

/**
 * A city pack's config (`cities/<slug>/city.json`). Geography is looked up in OSM by the
 * pipeline; the only coordinates allowed here are a region bbox (when the region has no usable
 * OSM relation) and an optional camera override.
 */
export const City = z
  .strictObject({
    slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'expected a lowercase slug'),
    name: LocalizedText,
    country: z.string().regex(/^[A-Z]{2}$/, 'expected an ISO 3166-1 alpha-2 code'),
    /** Overpass lookup for the city's boundary relation; it must match exactly one. */
    boundary: z.strictObject({
      name: z.string().min(1),
      admin_level: z.int().min(2).max(11),
      /** Name of an enclosing admin area, to disambiguate the lookup. */
      within: z.string().min(1).optional(),
    }),
    detail_buffer_km: z.number().min(0).max(50),
    region: z.union([
      z.strictObject({
        name: z.string().min(1),
        osm_relation: z.string().regex(/^\d+$/, 'expected a numeric relation id').optional(),
      }),
      z.strictObject({ bbox: BBox }),
    ]),
    subdivision: z.strictObject({
      admin_level: z.int().min(2).max(11),
      /** Local term shown in the UI, e.g. "barangay". */
      label: LocalizedText,
    }),
    /** Content languages besides English, which is always required. */
    languages: z
      .array(LanguageCode)
      .refine((langs) => !langs.includes('en'), { message: '"en" is implicit; do not list it' })
      .refine((langs) => new Set(langs).size === langs.length, { message: 'duplicate language' }),
    /** Name the e2e smoke test searches for. */
    smoke_landmark: z.string().min(1),
    initial_camera: CameraState.partial().optional(),
  })
  .superRefine((city, ctx) => {
    // The city's own localized fields follow the same language rule as its content.
    const text = localizedText(city.languages);
    const fields = [
      [['name'], city.name],
      [['subdivision', 'label'], city.subdivision.label],
    ] as const;
    for (const [path, value] of fields) {
      for (const issue of text.safeParse(value).error?.issues ?? []) {
        ctx.addIssue({ code: 'custom', path: [...path, ...issue.path], message: issue.message });
      }
    }
  });
export type City = z.infer<typeof City>;
