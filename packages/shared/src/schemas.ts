import type {
  UtilityPole as UtilityPoleType,
  UtilitySpan as UtilitySpanType,
  UtilityRecord as UtilityRecordType,
} from './utilities';
import * as z from 'zod';
import { OsmId, OsmAreaId, OsmWayId, MercatorPosition } from './schema-primitives';
export { OsmId } from './schema-primitives';
import { isDetailSelection, type DetailSelection } from './detail-selection';
import { SignalPosition } from './signal-layout';
import { WIND_STRENGTHS, type ClimateConfig } from './climate';
import {
  RHYTHM_KINDS,
  SEASON_ANCHOR_KINDS,
  runtimeCityLife,
  type CityLifeConfig,
  type RuntimeCityLife,
} from './rhythm';
import {
  FIREWORK_VARIANTS,
  validMonthDay,
  occurrence,
  seasonContains,
  composeSeasonInstallations,
  type FireworksConfig,
  type SeasonConfig,
  type SeasonGrounds,
  type SeasonWindow,
} from './seasons';
import {
  EMOJI_SUBJECTS,
  EMOJI_MOODS,
  DRINKING_MOODS,
  EMOJI_EVENING,
  type SeasonEmojiEntry,
} from './emoji';
import { BuntingCorridorSchema, CarnivalComponentSchema } from './seasonal-schema';
export { BuntingCorridorSchema, SeasonalRecordSchema } from './seasonal-schema';
import { LIFE_SITE_KINDS, TRANSIT_MODES, type LifeSiteConfig } from './life-sites';
import {
  artChars,
  ATLAS_CLASSES,
  FRONTAGE_KINDS,
  CAMERA_RANGES,
  BOAT_TYPES,
  VEHICLE_TYPES,
  YEAR_RANGE,
  RoofShape,
  PROCESSION_LIMITS,
  TODO_VERIFY,
  PROCESSION_DEFAULTS,
  PROCESSION_VEHICLES,
  CLOCK_TIME_PATTERN,
  TIME_ZONE_PATTERN,
  type TrafficMix,
} from './constants';

export const Frontage = z.enum(FRONTAGE_KINDS);
const RoofShapeSchema = z.enum(
  Object.keys(RoofShape) as [keyof typeof RoofShape, ...(keyof typeof RoofShape)[]],
);
/** Scalars retained through vector-tile clipping; all three must be supplied together. */
export const ShopAnchor = z.object({
  shop_lng: z.number().finite().min(-180).max(180),
  shop_lat: z.number().finite().min(-85.051129).max(85.051129),
  shop_radius_m: z.number().finite().positive(),
});
export type ShopAnchor = z.infer<typeof ShopAnchor>;

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
export { TODO_VERIFY } from './constants';

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

/** Refine a mapped tree's appearance while preserving its surveyed identity and position. */
export const CuratedTreeOverride = z
  .strictObject({ osm_id: OsmId, ...treeShape })
  .refine(
    (v) => v.crown_m !== undefined || v.height_m !== undefined || v.kind !== undefined,
    'needs an appearance override',
  );

/** A curated line of trees, drawn a crown every crown's width (`Landcover`). */
export const CuratedTreeRow = z.strictObject({ line: z.array(LngLat).min(2), ...treeShape });

/** A curated ground cover; woods use the atlas `trees` class. */
export const LandCover = z.enum(['grass', 'parking', 'woods', 'shrubs', 'planting']);
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

/** A simple, closed, nonzero-area geographic ring. */
export const SimpleRing = z
  .array(LngLat)
  .min(4)
  .superRefine((ring, ctx) => {
    if (ring.length < 4) return;
    const first = ring[0]!,
      last = ring.at(-1)!;
    const fail = () =>
      ctx.addIssue({ code: 'custom', message: 'expected a simple, closed, nonzero-area ring' });
    if (first[0] !== last[0] || first[1] !== last[1]) {
      fail();
      return;
    }
    const cross = (a: LngLat, b: LngLat, c: LngLat) =>
      (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const on = (a: LngLat, b: LngLat, p: LngLat) =>
      cross(a, b, p) === 0 &&
      p[0] >= Math.min(a[0], b[0]) &&
      p[0] <= Math.max(a[0], b[0]) &&
      p[1] >= Math.min(a[1], b[1]) &&
      p[1] <= Math.max(a[1], b[1]);
    let area = 0;
    const count = ring.length - 1;
    for (let i = 0; i < count; i++) {
      const a = ring[i]!,
        b = ring[i + 1]!;
      if (a[0] === b[0] && a[1] === b[1]) {
        fail();
        return;
      }
      area += cross(first, a, b);
      for (let j = i + 2; j < count; j++) {
        if (i === 0 && j === count - 1) continue;
        const c = ring[j]!,
          d = ring[j + 1]!;
        if (
          (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) ||
          on(a, b, c) ||
          on(a, b, d) ||
          on(c, d, a) ||
          on(c, d, b)
        ) {
          fail();
          return;
        }
      }
    }
    if (area === 0) fail();
  });

/** A plan-view beam, support, platform, or roof; overhead parts leave the ground walkable. */
export const SiteStructure = z
  .strictObject({
    id: DetailKey,
    ring: SimpleRing,
    /** Open interiors, e.g. a running track surrounding a lawn. */
    holes: z.array(SimpleRing).max(16).optional(),
    height_m: z.number().positive().max(255),
    material: z.enum(['wood', 'stone', 'roof', 'paving', 'pitch', 'water']),
    overhead: z.boolean(),
    /** Explicit roof wing on a standing mapped building; generic ridges follow this outline. */
    roof_shape: RoofShapeSchema.optional(),
    roof_osm_id: OsmId.optional(),
    /** Explicit paving replacing a coarse ground fill; omitted preserves legacy priority. */
    ground_override: z.boolean().optional(),
  })
  .refine((part) => !['paving', 'pitch', 'water'].includes(part.material) || !part.overhead, {
    path: ['overhead'],
    message: 'ground surfaces cannot be overhead',
  })
  .refine((part) => part.ground_override === undefined || part.material === 'paving', {
    path: ['ground_override'],
    message: 'only paving can override ground fill',
  })
  .refine(
    (part) =>
      (part.roof_shape === undefined && part.roof_osm_id === undefined) ||
      (part.roof_shape !== undefined &&
        part.roof_osm_id !== undefined &&
        part.material === 'roof' &&
        part.overhead),
    'roof wings need a shape, mapped building and overhead roof material',
  );
export type SiteStructure = z.infer<typeof SiteStructure>;

/** Canonical metadata for selection of linked detail surfaces. */
export const DetailSelectionSchema = z.custom<DetailSelection>(
  isDetailSelection,
  'invalid detail selection metadata',
);

/** Sourced outdoor detail, anchored to OSM; coordinates are GeoJSON order. */
export const SiteDetail = z
  .strictObject({
    id: z.string().regex(/^detail\/[a-z0-9-]+$/),
    osm_id: OsmId,
    title: z.string().min(1),
    surface: z.enum(['paving', 'keep']),
    /** Optional site outline containing a complete area, point or line parent. */
    grounds: SimpleRing.optional(),
    /** Detail confined to part of an existing area parent; preserves the complete parent. */
    extent: SimpleRing.optional(),
    /** Curated landmark selected by this site, when different from its geometry anchor. */
    selection_osm_id: OsmId.optional(),
    structures: z.array(SiteStructure).default([]),
    /** Fixed, illustrative parking inventory, visible independently of simulated Life. */
    parked_vehicles: z
      .array(
        z.strictObject({
          id: DetailKey,
          at: LngLat,
          bearing: z.number().min(0).lt(360),
          kind: z.enum(['car', 'bus']),
        }),
      )
      .max(200)
      .default([]),
    /** Sourced height corrections retain the mapped building identity and footprint. */
    building_overrides: z
      .array(z.strictObject({ osm_id: OsmId, height_m: z.number().positive().max(255) }))
      .default([]),
    /** Replace an inaccurate generic roof inference, without changing the OSM footprint. */
    roof_overrides: z
      .array(
        z.strictObject({
          osm_id: OsmId,
          shape: RoofShapeSchema,
        }),
      )
      .default([]),
    /** Curated positions for existing mapped flagpoles, retaining their OSM identity. */
    flagpoles: z
      .array(z.strictObject({ osm_id: OsmId, at: LngLat, flag: z.literal('PH').optional() }))
      .default([]),
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
        z
          .strictObject({
            id: DetailKey,
            line: DetailLine,
            width_m: z.number().positive().max(3),
            height_m: z.number().positive().max(2),
            /** Which side of the directed seating line faces accessible paving. */
            facing: z.enum(['left', 'right']),
            /** Inclusive vertex indices for wider seating sections; [] is a rim without seats. */
            bench_spans: z
              .array(
                z.strictObject({
                  id: DetailKey,
                  start: z.int().nonnegative(),
                  end: z.int().positive(),
                  width_m: z.number().positive().max(3),
                }),
              )
              .optional(),
          })
          .superRefine((seat, ctx) => {
            const spans = seat.bench_spans ?? [];
            if (new Set(spans.map((span) => span.id)).size !== spans.length)
              ctx.addIssue({
                code: 'custom',
                path: ['bench_spans'],
                message: 'duplicate bench span id',
              });
            for (const [i, span] of spans.entries()) {
              if (span.start >= span.end || span.end >= seat.line.length)
                ctx.addIssue({
                  code: 'custom',
                  path: ['bench_spans', i],
                  message: 'invalid bench span vertex range',
                });
              if (span.width_m < seat.width_m)
                ctx.addIssue({
                  code: 'custom',
                  path: ['bench_spans', i, 'width_m'],
                  message: 'bench must be at least as wide as the rim',
                });
              if (
                spans.slice(0, i).some((other) => span.start < other.end && span.end > other.start)
              )
                ctx.addIssue({
                  code: 'custom',
                  path: ['bench_spans', i],
                  message: 'overlapping bench spans',
                });
            }
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
          style: z.enum(['streetlight', 'lantern']).default('streetlight'),
        }),
      )
      .default([]),
    status: z.enum(['draft', 'verified']),
    credit: z.string().min(1),
    sources: Sources,
  })
  .superRefine((v, ctx) => {
    if (v.grounds && v.extent)
      ctx.addIssue({
        code: 'custom',
        path: ['extent'],
        message: 'choose grounds or a contained extent',
      });
    if (
      new Set(v.building_overrides.map((building) => building.osm_id)).size !==
      v.building_overrides.length
    )
      ctx.addIssue({
        code: 'custom',
        path: ['building_overrides'],
        message: 'duplicate building target',
      });
    if (new Set(v.roof_overrides.map((roof) => roof.osm_id)).size !== v.roof_overrides.length)
      ctx.addIssue({ code: 'custom', path: ['roof_overrides'], message: 'duplicate roof target' });
    if (new Set(v.flagpoles.map((pole) => pole.osm_id)).size !== v.flagpoles.length)
      ctx.addIssue({ code: 'custom', path: ['flagpoles'], message: 'duplicate flagpole target' });
    for (const key of ['walks', 'seating', 'lamps', 'structures', 'parked_vehicles'] as const) {
      if (new Set(v[key].map((item) => item.id)).size !== v[key].length)
        ctx.addIssue({ code: 'custom', path: [key], message: 'duplicate detail id' });
    }
  });
export type SiteDetail = z.infer<typeof SiteDetail>;

/** Sourced burial layouts; row endpoints are marker centres, not a cemetery boundary. */
export const Cemetery = z
  .strictObject({
    id: z.string().regex(/^cemetery\/[a-z0-9-]+$/),
    osm_id: OsmId,
    title: z.string().min(1).max(512),
    rows: z
      .array(
        z
          .strictObject({
            id: DetailKey,
            line: z
              .tuple([LngLat, LngLat])
              .refine(([a, b]) => a[0] !== b[0] || a[1] !== b[1], 'row endpoints must differ'),
            count: z.int().min(1).max(200),
            kind: z.enum(['flush', 'slab', 'vault']),
            width_m: z.number().positive().max(6),
            length_m: z.number().positive().max(10),
            height_m: z.number().nonnegative().max(5),
          })
          .refine((row) => (row.kind === 'flush' ? row.height_m === 0 : row.height_m > 0), {
            path: ['height_m'],
            message: 'flush markers must be ground-level; slabs and vaults must be raised',
          }),
      )
      .min(1)
      .max(500),
    status: z.enum(['draft', 'verified']),
    credit: z.string().min(1),
    sources: Sources,
  })
  .superRefine((pack, ctx) => {
    if (new Set(pack.rows.map((row) => row.id)).size !== pack.rows.length)
      ctx.addIssue({ code: 'custom', path: ['rows'], message: 'duplicate burial row id' });
    if (pack.rows.reduce((count, row) => count + row.count, 0) > 15_000)
      ctx.addIssue({ code: 'custom', path: ['rows'], message: 'too many burial markers' });
  });
export type Cemetery = z.infer<typeof Cemetery>;

/** When a procession runs (the `Procession` schema's `schedule`). */
/** An IANA time zone, e.g. "Asia/Manila". */
export const TimeZone = z.string().regex(TIME_ZONE_PATTERN, 'expected an IANA time zone');

export const ProcessionSchedule = z.strictObject({
  month: z.int().min(1).max(12),
  /** 0 = Sunday … 6 = Saturday. */
  weekday: z.int().min(0).max(6),
  /** Which one of that weekday in the month, 1–5. */
  nth: z.int().min(1).max(5),
  /** Days after that weekday; -1 is the day before. */
  offset_days: z
    .int()
    .min(PROCESSION_LIMITS.schedule.offset_days[0])
    .max(PROCESSION_LIMITS.schedule.offset_days[1]),
  /** Local start time, HH:MM. */
  start: z.string().regex(CLOCK_TIME_PATTERN, 'expected HH:MM'),
  duration_min: z
    .int()
    .min(PROCESSION_LIMITS.schedule.duration_min[0])
    .max(PROCESSION_LIMITS.schedule.duration_min[1]),
  /** IANA time zone the start time is in, e.g. "Asia/Manila". */
  timezone: TimeZone,
});
export type ProcessionSchedule = z.infer<typeof ProcessionSchedule>;

/** A procession's boats: paddle-boat columns and ranks ahead of the pagoda, and escorts. */
const formationCount = (range: readonly [number, number]) => z.int().min(range[0]).max(range[1]);
export const ProcessionFormation = z.strictObject({
  columns: formationCount(PROCESSION_LIMITS.fluvial.columns).optional(),
  ranks: formationCount(PROCESSION_LIMITS.fluvial.ranks).optional(),
  escorts: formationCount(PROCESSION_LIMITS.fluvial.escorts).optional(),
});
export type ProcessionFormation = z.infer<typeof ProcessionFormation>;
const ProcessionId = z.string().regex(/^procession\/[a-z0-9-]+$/, 'expected procession/<slug>');
export const FollowingSchedule = z.strictObject({
  follows: ProcessionId,
  duration_min: z
    .int()
    .min(PROCESSION_LIMITS.schedule.duration_min[0])
    .max(PROCESSION_LIMITS.schedule.duration_min[1]),
});
export const StreetFormation = z.strictObject({
  bearers: formationCount(PROCESSION_LIMITS.procession.bearers).default(
    PROCESSION_DEFAULTS.procession.bearers,
  ),
  ranks: formationCount(PROCESSION_LIMITS.procession.ranks).default(
    PROCESSION_DEFAULTS.procession.ranks,
  ),
  marshals: formationCount(PROCESSION_LIMITS.procession.marshals).default(
    PROCESSION_DEFAULTS.procession.marshals,
  ),
});
export const ParadeFormation = z.strictObject({
  contingents: formationCount(PROCESSION_LIMITS.parade.contingents).default(
    PROCESSION_DEFAULTS.parade.contingents,
  ),
  ranks: formationCount(PROCESSION_LIMITS.parade.ranks).default(PROCESSION_DEFAULTS.parade.ranks),
  band: formationCount(PROCESSION_LIMITS.parade.band).default(PROCESSION_DEFAULTS.parade.band),
  color_guard: formationCount(PROCESSION_LIMITS.parade.color_guard).default(
    PROCESSION_DEFAULTS.parade.color_guard,
  ),
  vehicles: z.array(z.enum(PROCESSION_VEHICLES)).max(PROCESSION_LIMITS.vehicles).default([]),
});
const EventPoint = LngLat;
const EventRing = z
  .array(EventPoint)
  .min(4)
  .refine(
    (r) => !!r[0] && r[0][0] === r.at(-1)![0] && r[0][1] === r.at(-1)![1],
    'expected closed ring',
  );
export const ProcessionSite = z.strictObject({
  id: OsmId,
  location: EventPoint,
  anchor: EventPoint,
  radius_m: z.number().positive().max(PROCESSION_LIMITS.radius),
  grounds: z.array(EventRing).min(1),
  blocked: z.array(EventRing),
  approaches: z.array(z.array(EventPoint).min(2)).min(1),
  roads: z.array(
    z.strictObject({ line: z.array(EventPoint).min(2), width_m: z.number().positive() }),
  ),
});

/**
 * Schemas for a city pack's content. Pass the city's declared `languages` to reject localized
 * fields in any other language; omit it for language-agnostic validation.
 */
export function contentSchemas(languages?: readonly string[]) {
  const text = localizedText(languages);

  const LandmarkFact = z
    .strictObject({
      text: text.refine((value) => value.en.length <= 240, {
        message: 'English fact text must be at most 240 characters',
        path: ['en'],
      }),
      year: Year.optional(),
      certainty: DateCertainty.optional(),
      source: z.number().int().nonnegative(),
    })
    .refine((fact) => fact.certainty === undefined || fact.year !== undefined, {
      message: 'certainty requires year',
      path: ['certainty'],
    });

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
      facts: z.array(LandmarkFact).min(3).max(5).optional(),
      sources: Sources,
    })
    .refine(endAfterStart, {
      message: 'end_year must be greater than start_year',
      path: ['end_year'],
    })
    .refine((v) => v.osm_id !== undefined || v.geometry !== undefined, {
      message: 'a landmark needs either osm_id or geometry',
      path: ['osm_id'],
    })
    .superRefine((landmark, ctx) => {
      landmark.facts?.forEach((fact, index) => {
        if (fact.source >= landmark.sources.length) {
          ctx.addIssue({
            code: 'custom',
            message: `fact ${index} source must reference a landmark source`,
            path: ['facts', index, 'source'],
          });
        }
      });
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
      /** Attribution for reference imagery, shown with the map credits. */
      credit: z.string().trim().min(1).optional(),
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
   * Trees and land cover (grass, parking, woods, shrubs) that OSM doesn't have yet, traced from imagery
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
      tree_overrides: z.array(CuratedTreeOverride).default([]),
      rows: z.array(CuratedTreeRow).default([]),
      areas: z.array(CuratedArea).default([]),
      status: z.enum(['draft', 'verified']),
      credit: z.string().min(1),
      sources: Sources,
    })
    .refine((v) => v.trees.length + v.rows.length + v.areas.length + v.tree_overrides.length > 0, {
      message: 'needs at least one tree, row, area, or mapped tree override',
      path: ['trees'],
    });

  /**
   * Authored fluvial processions, street processions, parades and outdoor Masses (SPEC.md §4).
   * Step 07 resolves routes or safe exterior gathering grounds from complete OSM geography.
   * Events play on demand and run live on their annual schedule, or after a predecessor ends.
   * They stay `draft` (and may hold `TODO(verify)`) until arrangements and timing are sourced.
   */
  const eventBase = {
    id: ProcessionId,
    title: text,
    story: text,
    status: z.enum(['draft', 'verified']),
    season: z.string().min(1).optional(),
    label: text.optional(),
    schedule: z.union([ProcessionSchedule, FollowingSchedule]),
    sources: Sources.optional(),
  };
  const streetRoute = z.strictObject({
    from: OsmId,
    to: OsmId,
    via: z.array(OsmWayId).min(1).optional(),
  });
  const Procession = z
    .discriminatedUnion('kind', [
      z.strictObject({
        ...eventBase,
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
        formation: ProcessionFormation.optional(),
      }),
      z.strictObject({
        ...eventBase,
        kind: z.literal('procession'),
        route: streetRoute,
        formation: StreetFormation.optional(),
      }),
      z.strictObject({
        ...eventBase,
        kind: z.literal('parade'),
        route: streetRoute,
        formation: ParadeFormation.optional(),
      }),
      z.strictObject({
        ...eventBase,
        kind: z.literal('mass'),
        site: OsmId,
        grounds: z.array(OsmAreaId).min(1),
        /** Authored exterior forecourt; the pipeline snaps only to safe connected cells. */
        gathering_anchor: LngLat.optional(),
        radius_m: z.number().positive().max(PROCESSION_LIMITS.radius),
      }),
    ])
    .superRefine((p, ctx) => {
      if (p.season && !p.label?.en?.trim())
        ctx.addIssue({
          code: 'custom',
          path: ['label'],
          message: 'a seasonal procession needs an English label',
        });
      if (p.status !== 'verified') return;
      if (
        [
          ...Object.values(p.title),
          ...Object.values(p.story),
          ...Object.values(p.label ?? {}),
        ].some((t) => t.includes(TODO_VERIFY))
      )
        ctx.addIssue({
          code: 'custom',
          path: ['story'],
          message: `a verified procession cannot contain ${TODO_VERIFY}`,
        });
      if (!p.sources)
        ctx.addIssue({
          code: 'custom',
          path: ['sources'],
          message: 'a verified procession needs sources',
        });
    });

  return {
    LandmarkFact,
    Landmark,
    NameHistory,
    Event,
    TourStep,
    Tour,
    LandmarkArt,
    LandmarkPlan,
    Landcover,
    SiteDetail,
    Cemetery,
    Procession,
  };
}

export const {
  LandmarkFact,
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
export type LandmarkFact = z.infer<typeof LandmarkFact>;
export type Landmark = z.infer<typeof Landmark>;
export type NameHistory = z.infer<typeof NameHistory>;
export type Event = z.infer<typeof Event>;
export type TourStep = z.infer<typeof TourStep>;
export type Tour = z.infer<typeof Tour>;

/**
 * A city's generated `<slug>.processions.json` (DATA.md §2 step 07): fluvial and street
 * processions, parades and outdoor Masses with resolved geography and annual schedules.
 */
const generatedEventBase = {
  id: z.string().min(1),
  title: LocalizedText,
  status: z.enum(['draft', 'verified']),
  season: z.string().min(1).optional(),
  label: LocalizedText.optional(),
  schedule: ProcessionSchedule,
  sources: Sources.optional(),
  follows: z.string().min(1).optional(),
};
const movingEventBase = { route: z.array(EventPoint).min(2), length_m: z.number().positive() };
const streetEventBase = {
  ...movingEventBase,
  segments: z
    .array(
      z.strictObject({
        id: OsmId,
        width_m: z.number().positive(),
        // Legacy symmetric allowance; new archives carry route-relative sides.
        sidewalk_m: z.number().min(0),
        sidewalks_m: z
          .strictObject({ left: z.number().min(0), right: z.number().min(0) })
          .optional(),
      }),
    )
    .min(1),
  blocked: z.array(EventRing),
  water: z.array(EventRing).optional(),
  bridges: z.array(EventRing).optional(),
};
export const CityProcessions = z.object({
  processions: z.array(
    z
      .discriminatedUnion('kind', [
        z.strictObject({
          ...generatedEventBase,
          ...movingEventBase,
          kind: z.literal('fluvial'),
          banks: z.array(z.tuple([z.number().min(0), z.number().min(0)])).optional(),
          formation: ProcessionFormation.optional(),
        }),
        z.strictObject({
          ...generatedEventBase,
          ...streetEventBase,
          kind: z.literal('procession'),
          formation: StreetFormation.optional(),
        }),
        z.strictObject({
          ...generatedEventBase,
          ...streetEventBase,
          kind: z.literal('parade'),
          formation: ParadeFormation.optional(),
        }),
        z.strictObject({ ...generatedEventBase, kind: z.literal('mass'), site: ProcessionSite }),
      ])
      .superRefine((p, ctx) => {
        if (p.season && !p.label?.en?.trim())
          ctx.addIssue({
            code: 'custom',
            path: ['label'],
            message: 'a seasonal procession needs an English label',
          });
        if (p.kind === 'fluvial' && p.banks && p.banks.length !== p.route.length)
          ctx.addIssue({
            code: 'custom',
            path: ['banks'],
            message: 'one bank pair per route point',
          });
        if (
          (p.kind === 'procession' || p.kind === 'parade') &&
          p.segments.length !== p.route.length - 1
        )
          ctx.addIssue({
            code: 'custom',
            path: ['segments'],
            message: 'one source segment per route edge',
          });
        if (p.status === 'verified') {
          if (!p.sources)
            ctx.addIssue({
              code: 'custom',
              path: ['sources'],
              message: 'a verified procession needs sources',
            });
          if (
            [...Object.values(p.title), ...Object.values(p.label ?? {})].some((t) =>
              t.includes(TODO_VERIFY),
            )
          )
            ctx.addIssue({
              code: 'custom',
              path: ['title'],
              message: 'verified title or label contains TODO(verify)',
            });
        }
      }),
  ),
});
export type CityProcessions = z.infer<typeof CityProcessions>;
export type ProcessionRoute = CityProcessions['processions'][number];
export type FluvialRoute = Extract<ProcessionRoute, { kind: 'fluvial' }>;
export type StreetRoute = Extract<ProcessionRoute, { kind: 'procession' | 'parade' }>;
export type MassRoute = Extract<ProcessionRoute, { kind: 'mass' }>;

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

const ClockTime = z.string().regex(CLOCK_TIME_PATTERN, 'expected HH:MM');
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
const MonthDaySchema = z
  .strictObject({ month: z.int().min(1).max(12), day: z.int().min(1).max(31) })
  .refine(validMonthDay, 'expected a real month/day');
export const EmojiSubjectSchema = z.enum(EMOJI_SUBJECTS);
export const EmojiMoodSchema = z.enum(EMOJI_MOODS);
export const SeasonEmojiEntrySchema = z
  .strictObject({
    mood: EmojiMoodSchema,
    subjects: z
      .array(EmojiSubjectSchema)
      .min(1)
      .refine((subjects) => new Set(subjects).size === subjects.length, 'duplicate emoji subject'),
    hours: z
      .tuple([z.int().min(0).max(1439), z.int().min(0).max(1440)])
      .refine(([from, to]) => from !== to, 'empty emoji hour window')
      .optional(),
    days: z
      .array(MonthDaySchema)
      .min(1)
      .max(4)
      .refine(
        (days) => new Set(days.map((d) => `${d.month}/${d.day}`)).size === days.length,
        'duplicate emoji date',
      )
      .optional(),
    figure: z.enum(['adult', 'child']).optional(),
    weight: z.number().positive().max(5).default(1),
  })
  .superRefine((entry, ctx) => {
    const person = entry.subjects.length === 1 && entry.subjects[0] === 'person';
    if (entry.figure && !person)
      ctx.addIssue({ code: 'custom', path: ['figure'], message: 'figure requires only person' });
    if (DRINKING_MOODS.some((mood) => mood === entry.mood)) {
      const hours = entry.hours;
      if (
        !person ||
        entry.figure !== 'adult' ||
        !hours ||
        hours[0] < EMOJI_EVENING.start ||
        (hours[1] < hours[0] && hours[1] > EMOJI_EVENING.end)
      )
        ctx.addIssue({
          code: 'custom',
          message: 'drinking requires adult people and evening hours',
        });
    }
  }) satisfies z.ZodType<SeasonEmojiEntry>;
export const SeasonWindowSchema = z.union([
  z.strictObject({ from: MonthDaySchema, to: MonthDaySchema }),
  z.strictObject({
    anchor: z.strictObject({
      month: z.int().min(1).max(12),
      weekday: z.int().min(0).max(6),
      nth: z.int().min(1).max(5),
      offset_days: z.int().min(-31).max(31),
    }),
    days_before: z.int().min(0).max(60),
    days_after: z.int().min(0).max(60),
  }),
]) satisfies z.ZodType<SeasonWindow>;
const SeasonPlaces = z
  .array(z.enum(SEASON_ANCHOR_KINDS))
  .min(1)
  .refine((places) => new Set(places).size === places.length, 'duplicate place kind');
const SeasonGeometryId = z.string().regex(/^[a-z][a-z0-9-]*$/);
const SeasonInstallationBase = {
  id: SeasonGeometryId,
  anchor: OsmId,
  label: z.string().trim().min(1),
  sources: Sources,
  grounds: SeasonGeometryId.optional(),
};
export const SeasonGroundsSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  anchor: OsmAreaId,
  // Reuse the simple, closed, nonzero-area ring contract from plan-view structures.
  ring: SiteStructure.shape.ring.max(64),
  sources: Sources,
}) satisfies z.ZodType<SeasonGrounds>;
export const FireworksSchema = z.strictObject({
  label: z.string().trim().min(1),
  variants: z
    .array(z.enum(FIREWORK_VARIANTS))
    .min(1)
    .max(FIREWORK_VARIANTS.length)
    .refine((v) => new Set(v).size === v.length, 'duplicate firework variants'),
}) satisfies z.ZodType<FireworksConfig>;
const SeasonId = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'expected a lowercase slug')
  .refine((id) => id !== 'auto', 'auto is reserved');
const MAX_SEASON_INSTALLATIONS = 32;
export const Season = z
  .strictObject({
    id: SeasonId,
    title: LocalizedText,
    window: SeasonWindowSchema,
    includes: z.array(SeasonId).min(1).optional(),
    emoji: z.array(SeasonEmojiEntrySchema).min(1).max(20).optional(),
    fireworks: FireworksSchema.optional(),
    grounds: z
      .array(SeasonGroundsSchema)
      .min(1)
      .max(16)
      .refine(
        (grounds) => new Set(grounds.map((g) => g.id)).size === grounds.length,
        'duplicate grounds ids',
      )
      .optional(),
    installations: z
      .array(
        z.discriminatedUnion('kind', [
          z
            .strictObject({
              ...SeasonInstallationBase,
              anchor: OsmAreaId,
              grounds: SeasonGeometryId,
              kind: z.literal('access-path'),
              style: z.enum(['walkway', 'driveway', 'parking']),
              width_m: z.number().min(1).max(12),
              points: z
                .array(MercatorPosition)
                .min(2)
                .max(32)
                .refine(
                  (points) =>
                    points
                      .slice(1)
                      .every((p, i) => p[0] !== points[i]![0] || p[1] !== points[i]![1]),
                  'empty access segment',
                ),
            })
            .refine(
              (v) => v.style !== 'parking' || v.width_m >= 5.5,
              'parking requires bays and access',
            ),
          z.strictObject({
            ...SeasonInstallationBase,
            anchor: OsmAreaId,
            grounds: SeasonGeometryId,
            kind: z.literal('carnival'),
            components: z
              .array(CarnivalComponentSchema)
              .min(1)
              .max(48)
              .refine(
                (v) => new Set(v.map((c) => c.id)).size === v.length,
                'duplicate carnival components',
              )
              .refine((v) => v.filter((c) => c.style === 'midway').length <= 1, 'only one midway'),
          }),
          z.strictObject({
            ...SeasonInstallationBase,
            kind: z.literal('christmas-tree'),
            radius_m: z.number().min(1).max(12),
          }),
          z.strictObject({
            ...SeasonInstallationBase,
            kind: z.literal('light-string'),
            layout: z.enum(['paths', 'perimeter', 'building-perimeter', 'canopy']),
            spacing_m: z.number().min(0.75).max(12),
            mount: z.literal('canopy').optional(),
            bulb_spacing_m: z.number().min(0.3).max(3).optional(),
            palette: z.enum(['warm', 'christmas']).optional(),
            exclude_tree_crowns: z.boolean().optional(),
          }),
          z.strictObject({
            ...SeasonInstallationBase,
            kind: z.literal('decorated-canopy'),
            trees: z.enum(['inside', 'overlapping']).optional(),
          }),
        ]),
      )
      .min(1)
      .max(MAX_SEASON_INSTALLATIONS)
      .refine((v) => new Set(v.map((i) => i.id)).size === v.length, 'duplicate installation ids')
      .optional(),
    lanterns: z
      .strictObject({
        label: z.string().trim().min(1),
        shape: z.literal('star'),
        near: SeasonPlaces.optional(),
        radius_m: z.number().min(50).max(3000).optional(),
      })
      .refine(
        (v) => (v.near === undefined) === (v.radius_m === undefined),
        'give near and radius_m together',
      )
      .optional(),
    bunting: z
      .strictObject({
        label: z.string().trim().min(1),
        near: SeasonPlaces,
        radius_m: z.number().min(50).max(1000),
        spacing_m: z.number().min(15).max(80),
        corridors: z
          .array(BuntingCorridorSchema)
          .min(1)
          .max(32)
          .refine((v) => new Set(v.map((c) => c.id)).size === v.length, 'duplicate corridor ids')
          .optional(),
      })
      .optional(),
    stalls: z
      .strictObject({
        label: z.string().trim().min(1),
        near: SeasonPlaces,
        radius_m: z.number().min(50).max(600),
        per_tile: z.int().min(1).max(24),
      })
      .optional(),
    candles: z
      .strictObject({ label: z.string().trim().min(1), share: z.number().gt(0).max(1) })
      .optional(),
    visitors: z
      .strictObject({
        label: z.string().trim().min(1),
        share: z.number().gt(0).max(1),
        per_grave_family: z
          .tuple([z.int().min(1).max(8), z.int().min(1).max(8)])
          .refine(([min, max]) => min <= max, 'expected [min, max]'),
        max_per_tile: z.int().min(1).max(150),
        hours: RhythmCurve,
      })
      .optional(),
    congregations: z
      .strictObject({
        label: z.string().trim().min(1),
        landmarks: z
          .array(z.string().regex(/^landmark\/[a-z0-9-]+$/, 'expected landmark/<slug>'))
          .min(1)
          .max(16)
          .refine((v) => new Set(v).size === v.length, 'duplicate landmarks'),
        extra: z.int().min(1).max(100),
        hours: RhythmCurve,
      })
      .optional(),
    sources: Sources,
  })
  .superRefine((season, ctx) => {
    for (const [index, entry] of (season.emoji ?? []).entries())
      for (const date of entry.days ?? [])
        for (let year = 2000; year < 2400; year++) {
          const day = occurrence(year, date);
          if (day === undefined) continue;
          if (!seasonContains(season.window, year, day)) {
            ctx.addIssue({
              code: 'custom',
              path: ['emoji', index, 'days'],
              message: 'emoji dates must fit every occurrence of their authored season window',
            });
            break;
          }
        }
    for (const [index, installation] of (season.installations ?? []).entries()) {
      if (installation.kind === 'light-string') {
        if (installation.layout !== 'canopy' && installation.spacing_m < 3)
          ctx.addIssue({
            code: 'custom',
            path: ['installations', index, 'spacing_m'],
            message: 'only canopy rows may be closer than 3 m',
          });
        if (installation.layout === 'canopy' && installation.mount !== 'canopy')
          ctx.addIssue({
            code: 'custom',
            path: ['installations', index, 'mount'],
            message: 'canopy rows must be mounted above the ground',
          });
      }
      if (
        installation.kind === 'light-string' &&
        installation.layout === 'building-perimeter' &&
        (installation.grounds || installation.mount)
      )
        ctx.addIssue({
          code: 'custom',
          path: ['installations', index, 'grounds'],
          message: 'building lights use the mapped building without grounds or canopy mounting',
        });
      if (!installation.grounds) continue;
      const grounds = season.grounds?.find((g) => g.id === installation.grounds);
      if (!grounds || grounds.anchor !== installation.anchor)
        ctx.addIssue({
          code: 'custom',
          path: ['installations', index, 'grounds'],
          message: 'grounds must exist and share the installation anchor',
        });
    }
    if (
      !season.lanterns &&
      !season.bunting &&
      !season.stalls &&
      !season.installations?.length &&
      !season.fireworks &&
      !season.emoji?.length &&
      !season.candles &&
      !season.visitors &&
      !season.congregations
    )
      ctx.addIssue({ code: 'custom', message: 'a season needs at least one decoration' });
  }) satisfies z.ZodType<SeasonConfig>;
export type Season = z.infer<typeof Season>;

export const CityLife = z.strictObject({
  seasons: z
    .array(Season)
    .refine(
      (seasons) => new Set(seasons.map((s) => s.id)).size === seasons.length,
      'duplicate season id',
    )
    .superRefine((seasons, ctx) => {
      const byId = new Map(seasons.map((season) => [season.id, season]));
      for (const [index, season] of seasons.entries()) {
        if (!season.includes) continue;
        const seen = new Set<string>();
        const includedInstallations: (typeof season.installations)[] = [];
        for (const [includeIndex, id] of season.includes.entries()) {
          const included = byId.get(id);
          const message = !included
            ? 'included season must exist'
            : id === season.id
              ? 'a season cannot include itself'
              : seen.has(id)
                ? 'duplicate included season'
                : included.includes
                  ? 'included seasons cannot include another season'
                  : undefined;
          if (message)
            ctx.addIssue({
              code: 'custom',
              path: [index, 'includes', includeIndex],
              message,
            });
          else if (included) includedInstallations.push(included.installations);
          seen.add(id);
        }
        const installations = composeSeasonInstallations(
          season.installations,
          includedInstallations,
        );
        const emojiCount =
          (season.emoji?.length ?? 0) +
          [...seen].reduce((count, id) => count + (byId.get(id)?.emoji?.length ?? 0), 0);
        if (emojiCount > 20)
          ctx.addIssue({
            code: 'custom',
            path: [index, 'includes'],
            message: 'a composed season accepts at most 20 emoji entries',
          });
        if (new Set(installations.map((i) => i.id)).size !== installations.length)
          ctx.addIssue({
            code: 'custom',
            path: [index, 'includes'],
            message: 'composed installations must have unique ids',
          });
        if (installations.length > MAX_SEASON_INSTALLATIONS)
          ctx.addIssue({
            code: 'custom',
            path: [index, 'includes'],
            message: `a composed season accepts at most ${MAX_SEASON_INSTALLATIONS} installations`,
          });
      }
    })
    .optional(),
  signals: z
    .strictObject({
      derive: z.boolean().optional(),
      add: z
        .array(
          z.strictObject({
            id: z.string().min(1),
            position: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]),
            linked_junctions: z
              .array(SignalPosition)
              .min(1)
              .refine(
                (points) => new Set(points.map((p) => p.join(','))).size === points.length,
                'duplicate linked junction',
              )
              .optional(),
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
export const RuntimeCityLifeSchema = CityLife.transform(
  runtimeCityLife,
) satisfies z.ZodType<RuntimeCityLife>;

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
  utilities: z.strictObject({ derive: z.boolean(), source: z.string().trim().min(1) }).optional(),
  /** Sourced display corrections, applied before roads generate traffic or utilities. */
  exclusions: z
    .array(
      z.strictObject({
        osm_id: z.string().regex(/^osm:way\/\d+$/, 'expected osm:way/<id>'),
        source: z.string().trim().min(1),
      }),
    )
    .refine(
      (items) => new Set(items.map((item) => item.osm_id)).size === items.length,
      'duplicate road exclusion target',
    )
    .optional(),
  directions: z
    .array(
      z.strictObject({
        osm_id: z.string().regex(/^osm:way\/\d+$/, 'expected osm:way/<id>'),
        /** Relative to the original OSM coordinate order; zero explicitly restores two-way. */
        oneway: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
        source: z.string().trim().min(1),
      }),
    )
    .refine(
      (items) => new Set(items.map((item) => item.osm_id)).size === items.length,
      'duplicate road direction target',
    )
    .optional(),
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
    for (const [index, season] of (city.life?.seasons ?? []).entries()) {
      for (const issue of text.safeParse(season.title).error?.issues ?? [])
        ctx.addIssue({
          code: 'custom',
          path: ['life', 'seasons', index, 'title', ...issue.path],
          message: issue.message,
        });
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
  /** Map source credits, including one standalone OpenStreetMap credit. */
  attribution: z.array(z.string().min(1)),
});
export type CityMeta = z.infer<typeof CityMeta>;

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'expected a hex sha256');

/** `<city>.detail-layouts.json`: geometry/selection fingerprints used by smoke tests. */
export const DetailLayouts = z.record(z.string().regex(/^detail\/[a-z0-9-]+$/), Sha256);
export type DetailLayouts = z.infer<typeof DetailLayouts>;

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
  'utilities',
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

/** Utility identities and coordinates survive MVT clipping as a validated JSON property. */
const UtilityPosition = MercatorPosition;
const UtilityDirection = z
  .tuple([z.number(), z.number()])
  .refine((v) => Math.abs(Math.hypot(...v) - 1) < 0.001, 'expected unit direction');
export const UtilityPoleSchema = z.strictObject({
  id: z.string().min(1),
  road: z.string().min(1),
  component: z.string().min(1),
  at: UtilityPosition,
  heading: UtilityDirection,
  normal: UtilityDirection,
  transformer: z.boolean(),
  sharedLamp: z.string().min(1).optional(),
  partner: z.string().min(1).optional(),
}) satisfies z.ZodType<UtilityPoleType>;
export const UtilitySpanSchema = z
  .strictObject({
    id: z.string().min(1),
    kind: z.enum(['corridor', 'crossing', 'junction']),
    from: UtilityPoleSchema,
    to: UtilityPoleSchema,
    seed: z.int().min(0).max(0xffffffff),
  })
  .refine((v) => v.from.id !== v.to.id, 'self span') satisfies z.ZodType<UtilitySpanType>;
export const UtilityRecordSchema = z.discriminatedUnion('kind', [
  z.strictObject({ version: z.literal(1), kind: z.literal('pole'), pole: UtilityPoleSchema }),
  z.strictObject({ version: z.literal(1), kind: z.literal('span'), span: UtilitySpanSchema }),
]) satisfies z.ZodType<UtilityRecordType>;
