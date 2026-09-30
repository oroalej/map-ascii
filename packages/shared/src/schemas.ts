import * as z from 'zod';
import { WIND_STRENGTHS, type ClimateConfig } from './climate';
import { RHYTHM_KINDS, type CityLifeConfig } from './rhythm';
import { LIFE_SITE_KINDS, TRANSIT_MODES, type LifeSiteConfig } from './life-sites';
import {
  artChars,
  ATLAS_CLASSES,
  CAMERA_RANGES,
  BOAT_TYPES,
  VEHICLE_TYPES,
  YEAR_RANGE,
  type TrafficMix,
} from './constants';

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

export const Year = z.int().min(YEAR_RANGE[0]).max(YEAR_RANGE[1]);

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

const inRange = ([min, max]: readonly [number, number]) => z.number().min(min).max(max);

/** The map is always flat and north-up (SPEC.md §3), so a camera is just where and how close. */
export const CameraState = z.strictObject({
  lat: inRange(CAMERA_RANGES.lat),
  lng: inRange(CAMERA_RANGES.lng),
  zoom: inRange(CAMERA_RANGES.zoom),
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
  'station',
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

/** A position as `[lng, lat]`, GeoJSON order. */
export const LngLat = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
export type LngLat = z.infer<typeof LngLat>;

/** Tree kinds with their own glyphs (SPEC.md §4); unset draws the generic tree. */
export const TreeKind = z.enum(['broadleaved', 'palm', 'needleleaved']);
export type TreeKind = z.infer<typeof TreeKind>;

const treeShape = {
  kind: TreeKind.optional(),
  /** Crown diameter in meters (default: typical for the kind). */
  crown_m: z.number().positive().max(60).optional(),
  height_m: z.number().positive().max(255).optional(),
};

/** One curated tree (`Landcover`). */
export const CuratedTree = z.strictObject({ at: LngLat, ...treeShape });

/** A curated line of trees, drawn a crown every crown's width (`Landcover`). */
export const CuratedTreeRow = z.strictObject({ line: z.array(LngLat).min(2), ...treeShape });

/** What a curated area is: its atlas class is `grass`, `parking`, or `trees` (woods). */
export const LandCover = z.enum(['grass', 'parking', 'woods']);
export type LandCover = z.infer<typeof LandCover>;

/**
 * A curated area (`Landcover`): a closed ring (first position repeated last) and what covers
 * it. Only woods have a tree `kind`.
 */
export const CuratedArea = z
  .strictObject({
    ring: z.array(LngLat).min(4),
    cover: LandCover,
    kind: TreeKind.optional(),
    /** A raised planting bed, inaccessible to ground agents. */
    raised: z.boolean().optional(),
  })
  .refine(({ ring }) => ring[0]![0] === ring.at(-1)![0] && ring[0]![1] === ring.at(-1)![1], {
    message: 'the ring must end where it starts',
    path: ['ring'],
  })
  .refine(({ cover, kind }) => kind === undefined || cover === 'woods', {
    message: 'only woods have a tree kind',
    path: ['kind'],
  });

const DetailKey = z.string().regex(/^[a-z0-9-]+$/);
const DetailLine = z
  .array(LngLat)
  .min(2)
  .refine(
    (line) => line.slice(1).every((p, i) => p[0] !== line[i]![0] || p[1] !== line[i]![1]),
    'consecutive positions must differ',
  );

/** Sourced outdoor detail, anchored to an existing OSM area; coordinates are GeoJSON order. */
export const SiteDetail = z
  .strictObject({
    id: z.string().regex(/^detail\/[a-z0-9-]+$/),
    osm_id: OsmId,
    title: z.string().min(1),
    surface: z.literal('paving'),
    walks: z
      .array(
        z.strictObject({
          id: DetailKey,
          line: DetailLine,
          width_m: z.number().positive().max(20),
        }),
      )
      .default([]),
    seating: z
      .array(
        z.strictObject({
          id: DetailKey,
          line: DetailLine,
          width_m: z.number().positive().max(3),
          height_m: z.number().positive().max(2),
          /** Which side of the directed seating line faces accessible paving. */
          facing: z.enum(['left', 'right']),
        }),
      )
      .default([]),
    lamps: z
      .array(
        z.strictObject({
          id: DetailKey,
          at: LngLat,
          bearing: z.number().min(0).lt(360),
          reach_m: z.number().positive().max(3),
          heads: z.int().min(1).max(4),
        }),
      )
      .default([]),
    status: z.enum(['draft', 'verified']),
    credit: z.string().min(1),
    sources: Sources,
  })
  .superRefine((v, ctx) => {
    for (const key of ['walks', 'seating', 'lamps'] as const) {
      if (new Set(v[key].map((item) => item.id)).size !== v[key].length)
        ctx.addIssue({ code: 'custom', path: [key], message: 'duplicate detail id' });
    }
  });
export type SiteDetail = z.infer<typeof SiteDetail>;

/** When a procession runs (the `Procession` schema's `schedule`). */
/** An IANA time zone, e.g. "Asia/Manila". */
export const TimeZone = z
  .string()
  .regex(/^[A-Za-z_]+(\/[A-Za-z_+-]+)+$/, 'expected an IANA time zone');

export const ProcessionSchedule = z.strictObject({
  month: z.int().min(1).max(12),
  /** 0 = Sunday … 6 = Saturday. */
  weekday: z.int().min(0).max(6),
  /** Which one of that weekday in the month, 1–5. */
  nth: z.int().min(1).max(5),
  /** Days after that weekday; -1 is the day before. */
  offset_days: z.int().min(-31).max(31),
  /** Local start time, HH:MM. */
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM'),
  duration_min: z
    .int()
    .positive()
    .max(24 * 60),
  /** IANA time zone the start time is in, e.g. "Asia/Manila". */
  timezone: TimeZone,
});
export type ProcessionSchedule = z.infer<typeof ProcessionSchedule>;

/** A procession's boats: paddle-boat columns and ranks ahead of the pagoda, and escorts. */
export const ProcessionFormation = z.strictObject({
  columns: z.int().min(1).max(6).optional(),
  ranks: z.int().min(1).max(20).optional(),
  escorts: z.int().min(0).max(40).optional(),
});
export type ProcessionFormation = z.infer<typeof ProcessionFormation>;

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

  /**
   * Trees and land cover (grass, parking, woods) that OSM doesn't have yet, traced from imagery
   * (DATA.md §2 step 04). The pipeline adds them as features of their atlas class and drops a
   * tree once OSM maps one at the same spot. `credit` is shown with the map attribution;
   * `status` stays `draft` until someone has checked the tracing on the ground or against
   * newer imagery.
   */
  const Landcover = z
    .object({
      id: z.string().regex(/^landcover\/[a-z0-9-]+$/, 'expected landcover/<slug>'),
      title: z.string().min(1),
      trees: z.array(CuratedTree).default([]),
      rows: z.array(CuratedTreeRow).default([]),
      areas: z.array(CuratedArea).default([]),
      status: z.enum(['draft', 'verified']),
      credit: z.string().min(1),
      sources: Sources,
    })
    .refine((v) => v.trees.length + v.rows.length + v.areas.length > 0, {
      message: 'needs at least one tree, row, or area',
      path: ['trees'],
    });

  /**
   * A river procession the life layer stages (SPEC.md §4 "Processions"): a pagoda barge and
   * columns of paddle boats along a river, crowds on its banks. The pipeline follows the river in
   * OSM from `route.from` (or `upstream_m` upstream of `to`) down to `route.to` (DATA.md §2 step
   * 07). It runs when a visitor plays it, and live on the day `schedule` names: `offset_days`
   * after the `nth` `weekday` (0 = Sunday) of `month`, at `start` in `timezone`. Like a tour, it
   * stays `draft` (and may hold `TODO(verify)`) until its route and schedule are sourced.
   */
  const Procession = z
    .object({
      id: z.string().regex(/^procession\/[a-z0-9-]+$/, 'expected procession/<slug>'),
      title: text,
      story: text,
      status: z.enum(['draft', 'verified']),
      kind: z.literal('fluvial'),
      route: z
        .strictObject({
          to: OsmId,
          from: OsmId.optional(),
          upstream_m: z.number().positive().max(20_000).optional(),
        })
        .refine((r) => (r.from === undefined) !== (r.upstream_m === undefined), {
          message: 'give exactly one of from and upstream_m',
        }),
      schedule: ProcessionSchedule,
      formation: ProcessionFormation.optional(),
      sources: Sources.optional(),
    })
    .superRefine((p, ctx) => {
      if (p.status !== 'verified') return;
      if (
        [...Object.values(p.title), ...Object.values(p.story)].some((t) => t.includes(TODO_VERIFY))
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['story'],
          message: `a verified procession cannot contain ${TODO_VERIFY}`,
        });
      }
      if (!p.sources) {
        ctx.addIssue({
          code: 'custom',
          path: ['sources'],
          message: 'a verified procession needs sources',
        });
      }
    });

  return {
    Landmark,
    NameHistory,
    Event,
    TourStep,
    Tour,
    LandmarkArt,
    LandmarkPlan,
    Landcover,
    SiteDetail,
    Procession,
  };
}

export const {
  Landmark,
  NameHistory,
  Event,
  TourStep,
  Tour,
  LandmarkArt,
  LandmarkPlan,
  Landcover,
  Procession,
} = contentSchemas();
export type Procession = z.infer<typeof Procession>;
export type Landcover = z.infer<typeof Landcover>;
export type LandmarkPlan = z.infer<typeof LandmarkPlan>;
export type LandmarkArt = z.infer<typeof LandmarkArt>;
export type Landmark = z.infer<typeof Landmark>;
export type NameHistory = z.infer<typeof NameHistory>;
export type Event = z.infer<typeof Event>;
export type TourStep = z.infer<typeof TourStep>;
export type Tour = z.infer<typeof Tour>;

/**
 * A city's generated `<slug>.processions.json` (DATA.md §2 step 07): each procession with its
 * route resolved along the river, from its start down to where it lands.
 */
export const CityProcessions = z.object({
  processions: z.array(
    z.object({
      id: z.string().min(1),
      title: LocalizedText,
      status: z.enum(['draft', 'verified']),
      kind: z.literal('fluvial'),
      /** [lng, lat] points from the start to the landing. */
      route: z.array(z.tuple([z.number(), z.number()])).min(2),
      length_m: z.number().positive(),
      /**
       * Per route point, how far the water reaches to its left and right (m, across the
       * direction of travel); absent where the river is mapped only as a line.
       */
      banks: z.array(z.tuple([z.number(), z.number()])).optional(),
      schedule: ProcessionSchedule,
      formation: ProcessionFormation.optional(),
      sources: Sources.optional(),
    }),
  ),
});
export type CityProcessions = z.infer<typeof CityProcessions>;
export type ProcessionRoute = CityProcessions['processions'][number];

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
 * A city's traffic mix for the life layer (SPEC.md §4): per road class, relative weights of the
 * vehicle types seen there. It sets the look of simulated traffic; it is not traffic data.
 */
const weights = <T extends string>(types: readonly [T, ...T[]]) =>
  z
    .partialRecord(z.enum(types), z.number().min(0))
    .refine((w) => Object.values(w).some((v) => ((v as number | undefined) ?? 0) > 0), {
      message: 'at least one type needs a weight above 0',
    })
    .optional();
const VehicleWeights = weights(VEHICLE_TYPES);
const Compass = z.number().min(0).lt(360);

const PrevailingWindSchema = z.strictObject({
  /** Where the wind blows from, in compass degrees (0 north, 90 east). */
  from: Compass,
  strength: z.enum(WIND_STRENGTHS),
});

/** A city's winds by season (climate.ts); the renderer's wind follows the current month. */
export const Climate = z
  .strictObject({
    wind: z.array(
      PrevailingWindSchema.extend({
        name: z.string().min(1).optional(),
        months: z.array(z.int().min(1).max(12)).min(1),
      }),
    ),
    default: PrevailingWindSchema,
    source: z.string().min(1),
  })
  .superRefine((climate, ctx) => {
    const seen = new Set<number>();
    climate.wind.forEach((season, i) => {
      for (const month of season.months) {
        if (seen.has(month)) {
          ctx.addIssue({
            code: 'custom',
            path: ['wind', i, 'months'],
            message: `month ${month} is in two seasons`,
          });
        }
        seen.add(month);
      }
    });
  }) satisfies z.ZodType<ClimateConfig>;

/** A daily rhythm curve (rhythm.ts): [hour 0–24, share 0–1] points, hours ascending. */
const RhythmCurve = z
  .array(z.tuple([z.number().min(0).lt(24), z.number().min(0).max(1)]))
  .min(1)
  .refine((points) => points.every(([hour], i) => i === 0 || hour > points[i - 1]![0]), {
    message: 'hours must be ascending',
  });

const ClockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM');
const Weekdays = z
  .array(z.int().min(0).max(6))
  .min(1)
  .refine((days) => new Set(days).size === days.length, { message: 'duplicate weekday' });

/** An interaction site: a mapped OSM feature annotated by the city pack, or a sourced point. */
export const LifeSite = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'expected a kebab-case id'),
    kind: z.enum(LIFE_SITE_KINDS),
    osm_id: z
      .string()
      .regex(/^osm:(node|way|relation)\/\d+$/)
      .optional(),
    position: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]).optional(),
    modes: z.array(z.enum(TRANSIT_MODES)).min(1).optional(),
    covered: z.boolean().optional(),
    source: z.string().min(1),
  })
  .superRefine((site, ctx) => {
    if (!!site.osm_id === !!site.position)
      ctx.addIssue({ code: 'custom', message: 'provide either osm_id or position' });
    if (site.kind !== 'shelter' && !site.modes?.length)
      ctx.addIssue({
        code: 'custom',
        path: ['modes'],
        message: 'transit sites require vehicle modes',
      });
    if (site.kind === 'shelter' && site.covered === false)
      ctx.addIssue({ code: 'custom', path: ['covered'], message: 'a shelter is covered' });
  }) satisfies z.ZodType<LifeSiteConfig>;

/**
 * A city's life beyond traffic mix and winds: its daily rhythm, and when places fill up
 * (rhythm.ts).
 */
export const CityLife = z.strictObject({
  signals: z
    .strictObject({
      derive: z.boolean().optional(),
      add: z
        .array(
          z.strictObject({
            id: z.string().min(1),
            position: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]),
            source: z.string().min(1),
          }),
        )
        .refine(
          (items) => new Set(items.map((i) => i.id)).size === items.length,
          'duplicate signal id',
        )
        .optional(),
      remove: z
        .array(
          z
            .strictObject({
              id: z.string().min(1),
              osm_id: z.int().positive().optional(),
              position: z
                .tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])
                .optional(),
              source: z.string().min(1),
            })
            .refine(
              (item) => !!item.osm_id !== !!item.position,
              'provide either osm_id or position',
            ),
        )
        .optional(),
    })
    .optional(),
  sites: z
    .array(LifeSite)
    .refine((sites) => new Set(sites.map((s) => s.id)).size === sites.length, {
      message: 'duplicate life site id',
    })
    .refine(
      (sites) => {
        const ids = sites.flatMap((s) => (s.osm_id ? [s.osm_id] : []));
        return new Set(ids).size === ids.length;
      },
      { message: 'duplicate life site osm_id' },
    )
    .optional(),
  rhythm: z.partialRecord(z.enum(RHYTHM_KINDS), RhythmCurve).optional(),
  schedules: z
    .strictObject({
      /** Services at places of worship: weekdays (0 = Sunday) and local start times. */
      worship: z
        .array(z.strictObject({ weekdays: Weekdays, times: z.array(ClockTime).min(1) }))
        .optional(),
      /** School days and hours. */
      school: z
        .strictObject({ weekdays: Weekdays, in: ClockTime, out: ClockTime })
        .refine((s) => s.in < s.out, { message: 'classes must end after they start' })
        .optional(),
      /** Shops' typical opening and closing times (each keeps its own around them). */
      shops: z.strictObject({ open: ClockTime, close: ClockTime }).optional(),
    })
    .optional(),
  source: z.string().min(1),
}) satisfies z.ZodType<CityLifeConfig>;
export type CityLife = z.infer<typeof CityLife>;

export const Traffic = z.strictObject({
  road_major: VehicleWeights,
  road_mid: VehicleWeights,
  road_minor: VehicleWeights,
  /** Boats on rivers. */
  river: weights(BOAT_TYPES),
  /** Boats on canals. */
  canal: weights(BOAT_TYPES),
  /** Vehicles in parking lots and along curbs. */
  parked: VehicleWeights,
}) satisfies z.ZodType<TrafficMix>;
export type Traffic = z.infer<typeof Traffic>;

/**
 * A city pack's config (`cities/<slug>/city.json`). Geography is looked up in OSM by the
 * pipeline. Coordinates are allowed for a region bbox without a usable OSM relation, and for
 * independently sourced life sites missing from OSM.
 */
/** Optional city policy for derived street details; explicit policy is sourced. */
export const CityStreets = z.strictObject({
  sidewalks: z
    .strictObject({
      derive: z.boolean().default(true),
      source: z.string().trim().min(1),
    })
    .optional(),
});

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
    /** The simulated traffic's vehicle mix (default: cars, motorcycles, buses, and trucks). */
    traffic: Traffic.optional(),
    /** The winds by season (default: a breeze from the east all year). */
    climate: Climate.optional(),
    /**
     * The city's time zone: the clock its daily rhythm, fixed times of day, and seasons follow
     * (default: the sun's time at the city's longitude).
     */
    timezone: TimeZone.optional(),
    /** The daily rhythm of the life layer (default: rhythm.ts `DEFAULT_RHYTHM`). */
    life: CityLife.optional(),
    streets: CityStreets.optional(),
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

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'expected a hex sha256');

/**
 * A city pack's `tiles.lock.json` (DATA.md §9): which GitHub release holds the city's generated
 * files, and each file's sha256, so builds fetch exactly the tiles that were published.
 */
export const TilesLock = z.object({
  /** `owner/name` of the GitHub repository with the release. */
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'expected owner/name'),
  /** The release tag, e.g. `tiles-naga-20260929-1930`. */
  tag: z.string().regex(/^tiles-[a-z0-9-]+$/, 'expected tiles-<slug>-<stamp>'),
  /** Release asset name (a file in `apps/web/public/tiles/`) → its sha256. */
  files: z
    .record(z.string().regex(/^\w[\w.-]*$/, 'expected a plain file name'), Sha256)
    .refine((files) => Object.keys(files).length > 0, 'at least one file'),
});
export type TilesLock = z.infer<typeof TilesLock>;

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
export const AtlasClass = z.enum(ATLAS_CLASSES);
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
