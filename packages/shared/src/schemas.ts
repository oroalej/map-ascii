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

/** Marks draft text that still has to be checked against sources (SPEC.md §6). */
export const TODO_VERIFY = 'TODO(verify)';

/** The longest flight a tour step may ask for, in ms. */
export const MAX_TOUR_FLY_MS = 15_000;

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

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => String.fromCodePoint(from + i));

/**
 * Characters landmark art may use: printable ASCII, the box-drawing and block-element ranges,
 * and a few symbols. The renderer's glyph atlas includes all of them.
 */
export const ART_CHARACTERS: ReadonlySet<string> = new Set([
  ...range(0x20, 0x7e),
  ...range(0x2500, 0x257f),
  ...range(0x2580, 0x259f),
  ...'◆◇▲△▼▽○●◦•·†‡¶°∩≡≈♣♠♦☼',
]);

/** Colors an art piece can use; each theme defines them. */
export const ArtRole = z.enum([
  'stone',
  'wall',
  'roof',
  'wood',
  'gold',
  'glass',
  'foliage',
  'accent',
]);
export type ArtRole = z.infer<typeof ArtRole>;

/** Split a string into characters (code points), so box-drawing and emoji-free art counts right. */
export const artChars = (row: string): string[] => [...row];

/**
 * One size of an art piece. `rows` is the drawing; `colors` has the same shape, each character
 * a key into the piece's palette, or a space for the first palette role.
 */
export const ArtVariant = z
  .object({
    rows: z.array(z.string()).min(1),
    colors: z.array(z.string()).min(1),
  })
  .superRefine((v, ctx) => {
    const width = artChars(v.rows[0]!).length;
    if (width === 0) ctx.addIssue({ code: 'custom', path: ['rows', 0], message: 'empty row' });
    v.rows.forEach((row, i) => {
      if (artChars(row).length !== width) {
        ctx.addIssue({ code: 'custom', path: ['rows', i], message: `row is not ${width} wide` });
      }
      const bad = artChars(row).filter((c) => !ART_CHARACTERS.has(c));
      if (bad.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['rows', i],
          message: `characters not allowed in art: ${[...new Set(bad)].join(' ')}`,
        });
      }
    });
    if (v.colors.length !== v.rows.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['colors'],
        message: 'colors must have one row per row',
      });
    }
    v.colors.forEach((row, i) => {
      if (artChars(row).length !== width) {
        ctx.addIssue({ code: 'custom', path: ['colors', i], message: `row is not ${width} wide` });
      }
    });
  });
export type ArtVariant = z.infer<typeof ArtVariant>;

/** One plan-view part of a landmark (see `LandmarkPlan`). */
export const PlanPart = z.object({
  kind: z.enum(['dome', 'cupola', 'belfry', 'tower', 'tier', 'pedestal']),
  shape: z.enum(['circle', 'hexagon', 'square']),
  /** Width across, in meters. */
  size_m: z.number().positive().max(200),
  height_m: z.number().positive().max(255),
  /**
   * Area features: `along` runs from the back (-1) to the front (+1) of the footprint's long
   * axis; `across` from the left (-1) to the right (+1) edge of the footprint at that point, as
   * seen by someone looking at the front.
   */
  at: z.object({ along: z.number().min(-1).max(1), across: z.number().min(-1).max(1) }).optional(),
  /** Point features: meters east and north of the point. */
  offset_m: z.tuple([z.number(), z.number()]).optional(),
});
export type PlanPart = z.infer<typeof PlanPart>;

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
    /** How long the step holds once the camera arrives. */
    duration_ms: z.int().positive(),
    /** The flight's duration; without it, the renderer's 0.8–3 s rule (SPEC.md §3). */
    fly_ms: z.int().positive().max(MAX_TOUR_FLY_MS).optional(),
    narration: text,
    year: Year.optional(),
    select: OsmId.optional(),
    highlight: z.array(OsmId).max(64).optional(),
    audio: z.string().min(1).optional(),
    /** Where the narration's claims come from; required once the tour is verified. */
    sources: Sources.optional(),
  });

  /**
   * A guided tour (SPEC.md §6). Narration stays `draft` (and may hold `TODO(verify)`
   * placeholders) until it is checked against sources; a `verified` tour has no placeholders
   * and cites sources on every step.
   */
  const Tour = z
    .object({
      id: z.string().regex(/^tour\/[a-z0-9-]+$/, 'expected tour/<slug>'),
      title: text,
      description: text.optional(),
      status: z.enum(['draft', 'verified']),
      steps: z.array(TourStep).min(1),
    })
    .superRefine((tour, ctx) => {
      if (tour.status !== 'verified') return;
      tour.steps.forEach((step, i) => {
        if (Object.values(step.narration).some((t) => t.includes(TODO_VERIFY))) {
          ctx.addIssue({
            code: 'custom',
            path: ['steps', i, 'narration'],
            message: `a verified tour cannot contain ${TODO_VERIFY}`,
          });
        }
        if (!step.sources) {
          ctx.addIssue({
            code: 'custom',
            path: ['steps', i, 'sources'],
            message: 'every step of a verified tour needs sources',
          });
        }
      });
    });

  /**
   * An ASCII drawing of a landmark or monument, shown on the map at close zoom in place of its
   * outline. Drawings are stylized from the reference images in `sources`; `status` stays
   * `draft` until someone who knows the place has checked it.
   */
  const LandmarkArt = z
    .object({
      id: z.string().regex(/^art\/[a-z0-9-]+$/, 'expected art/<slug>'),
      osm_id: OsmId,
      title: z.string().min(1),
      /** From smallest to largest; the renderer picks the largest that fits the footprint. */
      variants: z.array(ArtVariant).min(1),
      /**
       * Approximate width in meters, for point features (statues, monuments) whose OSM
       * geometry has no size. Areas use their mapped footprint instead.
       */
      footprint_m: z.number().positive().max(500).optional(),
      /** When drawings would overlap, the higher priority is drawn (default 0). */
      priority: z.int().min(0).max(100).optional(),
      /** Color keys used in `colors`, each mapped to a theme role. The first is the default. */
      palette: z.record(z.string().length(1), ArtRole),
      status: z.enum(['draft', 'verified']),
      sources: Sources,
    })
    .superRefine((art, ctx) => {
      const keys = new Set(Object.keys(art.palette));
      if (keys.size === 0) ctx.addIssue({ code: 'custom', path: ['palette'], message: 'empty' });
      let previous = 0;
      art.variants.forEach((variant, v) => {
        const width = artChars(variant.rows[0] ?? '').length;
        if (width <= previous) {
          ctx.addIssue({
            code: 'custom',
            path: ['variants', v],
            message: 'variants must grow in width, smallest first',
          });
        }
        previous = width;
        variant.colors.forEach((row, i) => {
          const unknown = artChars(row).filter((c) => c !== ' ' && !keys.has(c));
          if (unknown.length > 0) {
            ctx.addIssue({
              code: 'custom',
              path: ['variants', v, 'colors', i],
              message: `color keys not in the palette: ${[...new Set(unknown)].join(' ')}`,
            });
          }
        });
      });
    });

  /**
   * Plan-view parts of a landmark, drawn on the map from above: belfries, domes, a monument's
   * tiered base. The pipeline turns each part into a `building_part` footprint. Parts of an
   * area feature are placed with `at`, relative to its long axis pointing to `front`; parts of
   * a point feature with `offset_m`.
   */
  const LandmarkPlan = z
    .object({
      id: z.string().regex(/^plan\/[a-z0-9-]+$/, 'expected plan/<slug>'),
      osm_id: OsmId,
      title: z.string().min(1),
      /** Which way the front faces, for area features. */
      front: z.enum(['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']).optional(),
      parts: z.array(PlanPart).min(1),
      status: z.enum(['draft', 'verified']),
      sources: Sources,
    })
    .refine(
      (plan) => plan.parts.every((p) => (p.at === undefined) !== (p.offset_m === undefined)),
      {
        message: 'each part needs exactly one of at or offset_m',
        path: ['parts'],
      },
    );

  return { Landmark, NameHistory, Event, TourStep, Tour, LandmarkArt, LandmarkPlan };
}

export const { Landmark, NameHistory, Event, TourStep, Tour, LandmarkArt, LandmarkPlan } =
  contentSchemas();
export type LandmarkPlan = z.infer<typeof LandmarkPlan>;
export type LandmarkArt = z.infer<typeof LandmarkArt>;
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
 * pipeline; the only coordinates allowed here are a region bbox, when the region has no usable
 * OSM relation.
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
    /**
     * Where the city opens: an OSM feature (e.g. the main plaza) whose center the pipeline
     * resolves into the meta's default camera. Without it, the boundary centroid is used.
     */
    focus: z.strictObject({ osm_id: OsmId, zoom: CameraState.shape.zoom }).optional(),
    /**
     * Admin level of the provinces or states named at Region level (default 4, which fits most
     * countries).
     */
    province_admin_level: z.int().min(2).max(11).optional(),
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

/** A city's generated `<slug>.meta.json`: what the web app needs before loading tiles. */
export const CityMeta = z.object({
  slug: z.string().min(1),
  name: LocalizedText,
  subdivisionLabel: LocalizedText,
  languages: z.array(LanguageCode),
  /** The city boundary's bbox. */
  bounds: BBox,
  /** The camera is clamped to this. */
  regionBounds: BBox,
  defaultCamera: CameraState,
  /** Earliest year with dated data, and the build year. */
  yearRange: z.tuple([Year, Year]),
  /** Extra credits this city's layers need, beyond OpenStreetMap. */
  attribution: z.array(z.string().min(1)),
});
export type CityMeta = z.infer<typeof CityMeta>;

/**
 * A city's generated `<slug>.art.json`: its landmark art, placed. `bbox` is the feature's
 * footprint (or, for a point, its `footprint_m` around it) and `anchor` its label anchor.
 */
export const CityArt = z.object({
  pieces: z.array(
    z.object({
      id: z.string().min(1),
      osm_id: OsmId,
      title: z.string().min(1),
      status: z.enum(['draft', 'verified']),
      priority: z.int().min(0).max(100),
      bbox: BBox,
      anchor: z.tuple([z.number(), z.number()]),
      palette: z.record(z.string().length(1), ArtRole),
      variants: z.array(ArtVariant).min(1),
    }),
  ),
});
export type CityArt = z.infer<typeof CityArt>;

/** Feature classes the pipeline assigns and the renderer themes (DATA.md §3, SPEC.md §4). */
export const AtlasClass = z.enum([
  'water_river',
  'water_area',
  'water_sea',
  'coastline',
  'terrain',
  'road_major',
  'road_mid',
  'road_minor',
  'path',
  'building',
  'building_religious',
  'building_school',
  'building_market',
  'park',
  'trees',
  'farmland',
  'monument',
  'building_part',
  'tree',
  'barrier',
  'entrance',
  'furniture',
  'parking',
  'pitch',
  'admin_city',
  'admin_subdivision',
  'place_label',
  // Appended so the classes above keep their renderer ids (glyphs/select.ts class masks).
  'water_stream',
]);
export type AtlasClass = z.infer<typeof AtlasClass>;

/** Vector tile layers, one per class group. */
export const TileLayer = z.enum([
  'water',
  'roads',
  'buildings',
  'landuse',
  'terrain',
  'poi',
  'admin',
  'labels',
  'events',
]);
export type TileLayer = z.infer<typeof TileLayer>;
