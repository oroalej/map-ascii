import { describe, expect, it } from 'vitest';
import {
  ART_CHARACTERS,
  CameraState,
  City,
  CityLife,
  EmergencyConfigSchema,
  EmojiSubjectSchema,
  Season,
  SeasonEmojiEntrySchema,
  contentSchemas,
  Event,
  Landcover,
  Landmark,
  LandmarkFact,
  LandmarkArt,
  LandmarkPlan,
  LocalizedText,
  NameHistory,
  TilesLock,
  Procession,
  Tour,
} from './schemas';

const source = { title: 'Example source', url: 'https://example.org/' };

describe('illustrative emergency configuration', () => {
  const run = { max: 1, interval_s: [150, 300], dwell_s: [20, 40] };
  it('accepts disabled kinds and preserves runtime config without putting emergency crafts in traffic mixes', () => {
    const emergency = { ambulance: run, source: 'illustrative OSM tags' };
    expect(CityLife.parse({ emergency, source: 'synthetic' }).emergency).toEqual(emergency);
    expect(
      EmergencyConfigSchema.safeParse({ ...emergency, ambulance: { ...run, max: 0 } }).success,
    ).toBe(true);
  });
  it.each([
    { source: 'synthetic' },
    { ambulance: { ...run, max: 4 }, source: 'synthetic' },
    { ambulance: { ...run, interval_s: [300, 150] }, source: 'synthetic' },
    { ambulance: { ...run, dwell_s: [0, 2] }, source: 'synthetic' },
    { ambulance: run },
    { ambulance: run, exclude: ['way/1'], source: 'synthetic' },
    { ambulance: { ...run, siren: true }, source: 'synthetic' },
  ])('rejects unsupported or unsourced config %j', (bad) => {
    expect(EmergencyConfigSchema.safeParse(bad).success).toBe(false);
  });
});

describe('seasonal emoji', () => {
  const entry = { mood: 'gift', subjects: ['person'] };
  const season = {
    id: 'winter',
    title: { en: 'Winter' },
    sources: [source],
    emoji: [entry],
    window: { from: { month: 12, day: 1 }, to: { month: 1, day: 6 } },
  };
  it.each([['bird'], ['person', 'bird']])('rejects unsupported bird subjects %j', (...subjects) => {
    const result = SeasonEmojiEntrySchema.safeParse({ ...entry, subjects });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ['subjects'],
          message: 'birds do not support seasonal emoji',
        }),
      );
    expect(Season.safeParse({ ...season, emoji: [{ ...entry, subjects }] }).success).toBe(false);
  });
  it('preserves existing seasonal subjects and runtime bird fear cues', () => {
    expect(
      SeasonEmojiEntrySchema.safeParse({
        ...entry,
        subjects: ['person', 'driver', 'cat', 'dog'],
      }).success,
    ).toBe(true);
    expect(EmojiSubjectSchema.parse('bird')).toBe('bird');
  });
  it('accepts emoji-only seasons, supplies weights and preserves strict fields', () => {
    expect(Season.parse(season).emoji![0]!.weight).toBe(1);
    expect(SeasonEmojiEntrySchema.safeParse({ ...entry, extra: true }).success).toBe(false);
    expect(Season.safeParse({ ...season, note: 'Unsupported' }).success).toBe(false);
  });
  it.each([
    { subjects: [] },
    { subjects: ['person', 'person'] },
    { hours: [0, 0] },
    { hours: [1440, 0] },
    { hours: [0, 1441] },
    { hours: [0.5, 60] },
    { days: [{ month: 4, day: 31 }] },
    {
      days: [
        { month: 12, day: 1 },
        { month: 12, day: 1 },
      ],
    },
    { days: [] },
    { weight: 0 },
    { weight: 6 },
    { mood: 'invented' },
    { subjects: ['driver'], figure: 'adult' },
    { subjects: ['person', 'dog'], figure: 'child' },
  ])('rejects malformed entries %j', (change) => {
    expect(SeasonEmojiEntrySchema.safeParse({ ...entry, ...change }).success).toBe(false);
  });
  it.each(['cheers', 'beer'])('keeps %s entirely within adult evening hours', (mood) => {
    const drinking = { mood, subjects: ['person'], figure: 'adult', hours: [960, 360] };
    expect(SeasonEmojiEntrySchema.safeParse(drinking).success).toBe(true);
    expect(SeasonEmojiEntrySchema.safeParse({ ...drinking, hours: [1080, 1440] }).success).toBe(
      true,
    );
    for (const change of [
      { figure: 'child' },
      { figure: undefined },
      { subjects: ['driver'] },
      { hours: undefined },
      { hours: [900, 1440] },
      { hours: [1020, 1000] },
    ])
      expect(SeasonEmojiEntrySchema.safeParse({ ...drinking, ...change }).success).toBe(false);
  });
  it('validates real authored dates across wrapping, moving and leap calendars', () => {
    const withDay = (month: number, day: number) => ({ ...entry, days: [{ month, day }] });
    expect(Season.safeParse({ ...season, emoji: [withDay(12, 24)] }).success).toBe(true);
    expect(Season.safeParse({ ...season, emoji: [withDay(7, 1)] }).success).toBe(false);
    expect(
      Season.safeParse({
        ...season,
        emoji: [withDay(2, 29)],
        window: { from: { month: 2, day: 1 }, to: { month: 3, day: 1 } },
      }).success,
    ).toBe(true);
    expect(
      Season.safeParse({
        ...season,
        emoji: [withDay(9, 20)],
        window: {
          anchor: { month: 9, weekday: 6, nth: 3, offset_days: 1 },
          days_before: 0,
          days_after: 0,
        },
      }).success,
    ).toBe(false);
  });
  it('bounds composed pools without revalidating inherited days in the includer window', () => {
    const base = { ...season, emoji: [{ ...entry, days: [{ month: 12, day: 24 }] }] };
    const included = {
      ...season,
      id: 'new-year',
      includes: ['winter'],
      window: { from: { month: 12, day: 31 }, to: { month: 1, day: 1 } },
    };
    expect(CityLife.safeParse({ source: 'Fixture', seasons: [included, base] }).success).toBe(true);
    expect(
      CityLife.safeParse({
        source: 'Fixture',
        seasons: [
          { ...included, emoji: Array.from({ length: 11 }, () => entry) },
          { ...base, emoji: Array.from({ length: 10 }, () => entry) },
        ],
      }).success,
    ).toBe(false);
    expect(Season.safeParse({ ...season, emoji: [] }).success).toBe(false);
  });
});

const landmark = {
  id: 'landmark/example-church',
  osm_id: 'osm:way/123456',
  name: { en: 'Example Church' },
  type: 'church',
  start_year: 1900,
  certainty: 'circa',
  sources: [source],
};

const camera = { lat: 13.6218, lng: 123.1948, zoom: 13 };

describe('landmark facts', () => {
  const fact = { text: { en: 'A sourced fact.' }, source: 0 };
  const facts = [fact, fact, fact];
  it('validates the count and every source reference with the fact path', () => {
    expect(Landmark.safeParse({ ...landmark, facts }).success).toBe(true);
    expect(Landmark.safeParse({ ...landmark, facts: [...facts, fact, fact] }).success).toBe(true);
    for (const count of [0, 1, 2, 6]) {
      expect(Landmark.safeParse({ ...landmark, facts: Array(count).fill(fact) }).success).toBe(
        false,
      );
    }
    for (const source of [-1, 0.5, 1]) {
      const result = Landmark.safeParse({ ...landmark, facts: [fact, { ...fact, source }, fact] });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(['facts', 1, 'source']);
    }
  });
  it('limits English text while respecting declared translations', () => {
    expect(LandmarkFact.safeParse({ ...fact, text: { en: 'x'.repeat(240) } }).success).toBe(true);
    expect(LandmarkFact.safeParse({ ...fact, text: { en: 'x'.repeat(241) } }).success).toBe(false);
    const schema = contentSchemas(['fil']).LandmarkFact;
    expect(schema.safeParse({ ...fact, text: { en: 'English', fil: 'Filipino' } }).success).toBe(
      true,
    );
    expect(schema.safeParse({ ...fact, text: { en: 'English', de: 'Deutsch' } }).success).toBe(
      false,
    );
  });
  it('uses certainty only for a known fact date', () => {
    expect(LandmarkFact.safeParse(fact).success).toBe(true);
    for (const certainty of [undefined, 'exact', 'circa']) {
      expect(LandmarkFact.safeParse({ ...fact, year: 1900, certainty }).success).toBe(true);
    }
    for (const certainty of ['exact', 'circa', 'unknown']) {
      expect(LandmarkFact.safeParse({ ...fact, certainty }).success).toBe(false);
    }
    expect(LandmarkFact.safeParse({ ...fact, year: 1900, certainty: 'unknown' }).success).toBe(
      false,
    );
    expect(LandmarkFact.safeParse({ ...fact, extra: true }).success).toBe(false);
  });
});

describe('Landmark', () => {
  it('accepts a valid landmark', () => {
    expect(Landmark.safeParse(landmark).success).toBe(true);
  });

  it('accepts standalone geometry instead of an osm_id', () => {
    const { osm_id: _unused, ...rest } = landmark;
    const result = Landmark.safeParse({
      ...rest,
      geometry: { type: 'Point', coordinates: [123.19, 13.62] },
    });
    expect(result.success).toBe(true);
  });

  it('requires osm_id or geometry', () => {
    const { osm_id: _unused, ...rest } = landmark;
    expect(Landmark.safeParse(rest).success).toBe(false);
  });

  it('requires at least one source', () => {
    expect(Landmark.safeParse({ ...landmark, sources: [] }).success).toBe(false);
  });

  it('rejects end_year <= start_year', () => {
    expect(Landmark.safeParse({ ...landmark, end_year: 1900 }).success).toBe(false);
    expect(Landmark.safeParse({ ...landmark, end_year: 1901 }).success).toBe(true);
  });

  it('requires photo credit and license', () => {
    const photo = { src: 'media/x.jpg', credit: 'Someone' };
    expect(Landmark.safeParse({ ...landmark, photos: [photo] }).success).toBe(false);
    expect(
      Landmark.safeParse({ ...landmark, photos: [{ ...photo, license: 'CC BY 4.0' }] }).success,
    ).toBe(true);
  });

  it('rejects a malformed osm_id', () => {
    expect(Landmark.safeParse({ ...landmark, osm_id: 'way/123' }).success).toBe(false);
  });
});

describe('NameHistory', () => {
  it('accepts ordered ranges and rejects inverted ones', () => {
    const base = { osm_id: 'osm:way/1', sources: [source] };
    expect(
      NameHistory.safeParse({
        ...base,
        names: [{ name: 'Old Street', to: 1946, certainty: 'circa' }],
      }).success,
    ).toBe(true);
    expect(
      NameHistory.safeParse({
        ...base,
        names: [{ name: 'Old Street', from: 1950, to: 1940, certainty: 'exact' }],
      }).success,
    ).toBe(false);
  });
});

describe('Event', () => {
  it('validates coordinates and date format', () => {
    const event = {
      id: 'event/example',
      year: 2006,
      date: '2006-09-30',
      lat: 13.62,
      lng: 123.19,
      title: { en: 'Example' },
      story: { en: 'Something happened.' },
      sources: [source],
    };
    expect(Event.safeParse(event).success).toBe(true);
    expect(Event.safeParse({ ...event, lat: 91 }).success).toBe(false);
    expect(Event.safeParse({ ...event, date: '30/09/2006' }).success).toBe(false);
  });
});

describe('CameraState', () => {
  it('is flat and north-up: rejects pitch and bearing', () => {
    expect(CameraState.safeParse(camera).success).toBe(true);
    expect(CameraState.safeParse({ ...camera, pitch: 60 }).success).toBe(false);
    expect(CameraState.safeParse({ ...camera, bearing: 15 }).success).toBe(false);
  });
});

describe('Procession', () => {
  const procession = {
    id: 'procession/river',
    title: { en: 'River procession' },
    story: { en: 'TODO(verify)' },
    status: 'draft',
    kind: 'fluvial',
    route: { to: 'osm:node/1', upstream_m: 1200 },
    schedule: {
      month: 9,
      weekday: 0,
      nth: 3,
      offset_days: -1,
      start: '15:00',
      duration_min: 180,
      timezone: 'Asia/Manila',
    },
  };
  const ok = (p: unknown) => Procession.safeParse(p).success;
  it('rejects aggregate physical actor overflow and resolves partial formations', () => {
    const street = {
      ...procession,
      kind: 'procession',
      route: { from: 'osm:way/1', to: 'osm:way/2' },
    };
    const formation = { images: 2, bearers: 64, ranks: 16, columns: 10, marshals: 10 };
    expect(ok({ ...street, formation })).toBe(true); // 300 actors.
    expect(ok({ ...street, formation: { ...formation, marshals: 11 } })).toBe(false);
    expect(
      ok({
        ...street,
        formation: { images: 3, bearers: 64, ranks: 20, columns: 10, marshals: 32 },
      }),
    ).toBe(false); // 427.
    expect(ok({ ...street, formation: { images: 3, bearers: 64, marshals: 32 } })).toBe(true); // 299 with defaults.
    expect(ok({ ...street, formation: { images: 3, bearers: 64, marshals: 32, ranks: 13 } })).toBe(
      false,
    );
    expect(
      ok({ ...procession, formation: { columns: 6, ranks: 20, escorts: 40, followers: 139 } }),
    ).toBe(true);
    expect(
      ok({ ...procession, formation: { columns: 6, ranks: 20, escorts: 40, followers: 140 } }),
    ).toBe(false);
  });

  it('accepts a draft with placeholders', () => {
    expect(ok(procession)).toBe(true);
    expect(ok({ ...procession, route: { to: 'osm:node/1', from: 'osm:way/2' } })).toBe(true);
  });

  it('needs exactly one way to find its start', () => {
    expect(ok({ ...procession, route: { to: 'osm:node/1' } })).toBe(false);
    expect(
      ok({ ...procession, route: { to: 'osm:node/1', from: 'osm:way/2', upstream_m: 5 } }),
    ).toBe(false);
  });

  it('checks the schedule', () => {
    const at = (schedule: object) =>
      ok({ ...procession, schedule: { ...procession.schedule, ...schedule } });
    expect(at({ start: '25:00' })).toBe(false);
    expect(at({ weekday: 7 })).toBe(false);
    expect(at({ timezone: 'Manila' })).toBe(false);
  });

  it('discriminates street formations and route-less Masses', () => {
    const street = {
      ...procession,
      kind: 'procession',
      route: { from: 'osm:way/1', to: 'osm:way/2' },
      season: 'fiesta',
      label: { en: 'Procession' },
    };
    expect(ok(street)).toBe(true);
    expect(ok({ ...street, formation: { columns: 3 } })).toBe(true);
    expect(ok({ ...street, formation: { columns: 11 } })).toBe(false);
    expect(ok({ ...street, label: undefined })).toBe(false);
    expect(ok({ ...street, label: { en: '   ' } })).toBe(false);
    const { route: _route, ...base } = street;
    const mass = {
      ...base,
      kind: 'mass',
      site: 'osm:way/2',
      grounds: ['osm:way/3'],
      radius_m: 100,
      schedule: { follows: 'procession/river', duration_min: 90 },
    };
    expect(ok(mass)).toBe(true);
    expect(ok({ ...mass, route: street.route })).toBe(false);
    expect(ok({ ...mass, schedule: { ...mass.schedule, start: '16:00' } })).toBe(false);
    expect(ok({ ...mass, status: 'verified' })).toBe(false);
  });

  it('is verified only without placeholders and with sources', () => {
    const verified = { ...procession, status: 'verified' };
    expect(ok(verified)).toBe(false);
    expect(ok({ ...verified, story: { en: 'The image returns by river.' } })).toBe(false);
    expect(
      ok({ ...verified, story: { en: 'The image returns by river.' }, sources: [source] }),
    ).toBe(true);
    const sourced = {
      ...verified,
      story: { en: 'The image returns by river.' },
      sources: [source],
    };
    for (const label of [{ en: 'TODO(verify)' }, { en: 'Procession', fil: 'TODO(verify)' }]) {
      expect(ok({ ...sourced, label })).toBe(false);
      expect(ok({ ...sourced, status: 'draft', label })).toBe(true);
    }
  });
});

describe('Tour', () => {
  const step = { camera, duration_ms: 4000, narration: { en: 'TODO(verify)' } };
  const tour = { id: 'tour/x', title: { en: 'X' }, status: 'draft', steps: [step] };

  it('accepts a draft tour with placeholder narration', () => {
    expect(Tour.safeParse(tour).success).toBe(true);
  });

  it('requires a status', () => {
    const { status: _unused, ...rest } = tour;
    expect(Tour.safeParse(rest).success).toBe(false);
  });

  it('rejects an empty tour', () => {
    expect(Tour.safeParse({ ...tour, steps: [] }).success).toBe(false);
  });

  it('rejects a non-positive duration and an overlong flight', () => {
    expect(Tour.safeParse({ ...tour, steps: [{ ...step, duration_ms: 0 }] }).success).toBe(false);
    expect(Tour.safeParse({ ...tour, steps: [{ ...step, fly_ms: 9000 }] }).success).toBe(true);
    expect(Tour.safeParse({ ...tour, steps: [{ ...step, fly_ms: 60_000 }] }).success).toBe(false);
  });

  it('takes feature ids for select and highlight', () => {
    const ok = { ...step, select: 'osm:way/1', highlight: ['osm:way/2', 'osm:node/3'] };
    expect(Tour.safeParse({ ...tour, steps: [ok] }).success).toBe(true);
    expect(Tour.safeParse({ ...tour, steps: [{ ...step, select: 'landmark/x' }] }).success).toBe(
      false,
    );
  });

  it('keeps placeholders and unsourced steps out of verified tours', () => {
    const verified = { ...tour, status: 'verified' };
    const issues = Tour.safeParse(verified).error?.issues.map((i) => i.path.join('.'));
    expect(issues).toEqual(['steps.0.narration', 'steps.0.sources']);
    const sourced = { ...step, narration: { en: 'Checked.' }, sources: [source] };
    expect(Tour.safeParse({ ...verified, steps: [sourced] }).success).toBe(true);
  });
});

describe('LocalizedText', () => {
  it('requires en and accepts any valid language code', () => {
    expect(LocalizedText.safeParse({ en: 'Hi', fil: 'Kumusta' }).success).toBe(true);
    expect(LocalizedText.safeParse({ fil: 'Kumusta' }).success).toBe(false);
    expect(LocalizedText.safeParse({ en: 'Hi', English: 'Hi' }).success).toBe(false);
  });

  it('limits content to the declared languages', () => {
    const { Landmark: CityLandmark } = contentSchemas(['fil']);
    expect(CityLandmark.safeParse({ ...landmark, name: { en: 'X', fil: 'Y' } }).success).toBe(true);
    const result = CityLandmark.safeParse({ ...landmark, name: { en: 'X', de: 'Y' } });
    expect(result.error?.issues[0]?.path).toEqual(['name', 'de']);
  });
});

describe('City', () => {
  const city = {
    slug: 'example',
    name: { en: 'Example City' },
    country: 'XX',
    boundary: { name: 'Example City', admin_level: 6, within: 'Example Region' },
    detail_buffer_km: 2,
    region: { name: 'Example Region' },
    subdivision: { admin_level: 10, label: { en: 'ward', xx: 'wardo' } },
    languages: ['xx'],
    smoke_landmark: 'Example Church',
  };

  it('accepts a valid config', () => {
    expect(City.safeParse(city).success).toBe(true);
    expect(City.safeParse({ ...city, region: { bbox: [120, 10, 125, 15] } }).success).toBe(true);
  });

  it('opts a bbox region into the whole boundary while retaining strict keys', () => {
    const region = { bbox: [120, 10, 125, 15], include_boundary: true };
    expect(City.safeParse({ ...city, region }).success).toBe(true);
    expect(City.safeParse({ ...city, region: { ...region, typo: true } }).success).toBe(false);
    expect(
      City.safeParse({ ...city, region: { ...region, include_boundary: false } }).success,
    ).toBe(false);
    expect(
      City.safeParse({ ...city, region: { name: 'Example', include_boundary: true } }).success,
    ).toBe(false);
  });

  it('accepts sourced sidewalk policy and defaults derivation only when configured', () => {
    expect(City.parse(city).streets).toBeUndefined();
    const policy = { sidewalks: { source: 'Project policy' } };
    expect(City.parse({ ...city, streets: policy }).streets?.sidewalks?.derive).toBe(true);
    expect(
      City.parse({ ...city, streets: { sidewalks: { derive: false, source: 'Survey pending' } } })
        .streets?.sidewalks?.derive,
    ).toBe(false);
    expect(City.safeParse({ ...city, streets: { sidewalks: { derive: false } } }).success).toBe(
      false,
    );
    expect(City.safeParse({ ...city, streets: { sidewalks: { source: ' ' } } }).success).toBe(
      false,
    );
    expect(City.safeParse({ ...city, streets: { driving_side: 'left' } }).success).toBe(false);
  });

  it('validates sourced road direction overrides and rejects duplicate targets', () => {
    const entry = { osm_id: 'osm:way/1', oneway: 1, source: 'Owner survey' };
    const parse = (directions: unknown[]) => City.safeParse({ ...city, streets: { directions } });
    for (const oneway of [-1, 0, 1]) expect(parse([{ ...entry, oneway }]).success).toBe(true);
    for (const invalid of [
      { ...entry, oneway: 2 },
      { ...entry, oneway: 'yes' },
      { ...entry, osm_id: 'osm:node/1' },
      { ...entry, source: ' ' },
      { osm_id: entry.osm_id, oneway: 1 },
    ])
      expect(parse([invalid]).success).toBe(false);
    expect(parse([entry, entry]).success).toBe(false);
  });

  it('requires a source and unique OSM ways for road exclusions', () => {
    const entry = { osm_id: 'osm:way/1', source: 'Owner annotated atlas' };
    const parse = (exclusions: unknown[]) => City.safeParse({ ...city, streets: { exclusions } });
    expect(parse([entry]).success).toBe(true);
    for (const invalid of [
      { ...entry, osm_id: 'osm:node/1' },
      { ...entry, source: ' ' },
      { osm_id: entry.osm_id },
      { ...entry, typo: true },
    ])
      expect(parse([invalid]).success).toBe(false);
    expect(parse([entry, entry]).success).toBe(false);
  });

  it('rejects localized fields in undeclared languages', () => {
    const result = City.safeParse({ ...city, languages: [] });
    expect(result.error?.issues[0]?.path).toEqual(['subdivision', 'label', 'xx']);
  });

  it('rejects "en" in languages and unknown keys', () => {
    expect(City.safeParse({ ...city, languages: ['en', 'xx'] }).success).toBe(false);
    expect(City.safeParse({ ...city, center: [1, 2] }).success).toBe(false);
  });

  it('takes a focus feature, not camera coordinates', () => {
    const focus = { osm_id: 'osm:way/1', zoom: 17 };
    expect(City.safeParse({ ...city, focus }).success).toBe(true);
    expect(City.safeParse({ ...city, focus: { ...focus, osm_id: 'way/1' } }).success).toBe(false);
    expect(City.safeParse({ ...city, focus: { ...focus, lat: 1 } }).success).toBe(false);
  });

  it('takes a time zone and a daily rhythm', () => {
    const life = { rhythm: { vehicle: [[7, 1]] }, source: 'x' };
    expect(City.safeParse({ ...city, timezone: 'Asia/Manila', life }).success).toBe(true);
    expect(City.safeParse({ ...city, timezone: 'Manila' }).success).toBe(false);
    expect(City.safeParse({ ...city, life: { rhythm: {} } }).success).toBe(false);
  });

  it('takes when places fill up', () => {
    const ok = (schedules: unknown) =>
      City.safeParse({ ...city, life: { schedules, source: 'x' } }).success;
    expect(ok({ worship: [{ weekdays: [0, 6], times: ['06:00', '18:30'] }] })).toBe(true);
    expect(ok({ school: { weekdays: [1, 2, 3, 4, 5], in: '07:30', out: '16:30' } })).toBe(true);
    expect(ok({ worship: [{ weekdays: [7], times: ['06:00'] }] })).toBe(false);
    expect(ok({ worship: [{ weekdays: [0, 0], times: ['06:00'] }] })).toBe(false);
    expect(ok({ worship: [{ weekdays: [0], times: ['6am'] }] })).toBe(false);
    expect(ok({ school: { weekdays: [1], in: '16:30', out: '07:30' } })).toBe(false);
  });

  it('rejects an inverted bbox', () => {
    expect(City.safeParse({ ...city, region: { bbox: [120, 15, 125, 10] } }).success).toBe(false);
  });

  it('takes a traffic mix of known vehicle types by road class', () => {
    const ok = (traffic: unknown) => City.safeParse({ ...city, traffic }).success;
    expect(ok({ road_major: { car: 3, jeepney: 2, bus: 0 }, road_minor: { tricycle: 1 } })).toBe(
      true,
    );
    expect(ok({ road_major: { hovercraft: 1 } })).toBe(false);
    expect(ok({ road_major: { car: -1 } })).toBe(false);
    expect(ok({ road_major: { car: 0 } })).toBe(false);
    expect(ok({ path: { car: 1 } })).toBe(false);
    expect(ok({ river: { banca: 2, rowboat: 1 }, parked: { car: 1, bicycle: 1 } })).toBe(true);
    expect(ok({ river: { car: 1 } })).toBe(false);
    expect(ok({ river: { banca: 0 } })).toBe(false);
  });
});

describe('LandmarkArt', () => {
  const art = {
    id: 'art/test-church',
    osm_id: 'osm:way/1',
    title: 'Test church',
    variants: [
      { rows: [' † ', '▐█▌'], colors: [' g ', '   '] },
      { rows: ['  †  ', ' ╱○╲ ', '▐▓∩▓▌'], colors: ['  g  ', '     ', '     '] },
    ],
    palette: { s: 'stone', g: 'gold' },
    status: 'draft',
    sources: [{ title: 'A reference photo' }],
  };
  const issues = (value: unknown) =>
    LandmarkArt.safeParse(value).error?.issues.map((i) => i.message) ?? [];

  it('accepts a valid piece', () => {
    expect(issues(art)).toEqual([]);
  });

  it('rejects ragged rows and color rows of another shape', () => {
    const ragged = { ...art, variants: [{ rows: [' † ', '▐█'], colors: ['   ', '  '] }] };
    expect(issues(ragged)).toContainEqual(expect.stringContaining('not 3 wide'));
    const colors = { ...art, variants: [{ rows: [' † '], colors: ['   ', '   '] }] };
    expect(issues(colors)).toContainEqual(expect.stringContaining('one row per row'));
  });

  it('rejects characters outside the art set and unknown color keys', () => {
    expect(ART_CHARACTERS.has('╬')).toBe(true);
    expect(ART_CHARACTERS.has('😀')).toBe(false);
    const emoji = { ...art, variants: [{ rows: ['😀'], colors: [' '] }] };
    expect(issues(emoji)).toContainEqual(expect.stringContaining('not allowed'));
    const key = { ...art, variants: [{ rows: ['█'], colors: ['x'] }] };
    expect(issues(key)).toContainEqual(expect.stringContaining('not in the palette'));
  });

  it('needs sources and variants that grow in width', () => {
    expect(issues({ ...art, sources: [] }).length).toBeGreaterThan(0);
    const shrinking = { ...art, variants: [...art.variants].reverse() };
    expect(issues(shrinking)).toContainEqual(expect.stringContaining('grow in width'));
  });

  it('is part of the per-city content schemas', () => {
    expect(contentSchemas(['fil']).LandmarkArt.safeParse(art).success).toBe(true);
  });
});

describe('LandmarkPlan', () => {
  const plan = {
    id: 'plan/test-church',
    osm_id: 'osm:way/1',
    title: 'Test church',
    front: 'sw',
    parts: [
      {
        kind: 'belfry',
        shape: 'hexagon',
        size_m: 7,
        height_m: 24,
        at: { along: 0.9, across: -0.8 },
      },
      { kind: 'tier', shape: 'circle', size_m: 5, height_m: 1, offset_m: [0, 0] },
    ],
    status: 'draft',
    sources: [{ title: 'Reference' }],
  };

  it('accepts a valid plan', () => {
    expect(LandmarkPlan.safeParse(plan).success).toBe(true);
  });

  it('needs sources, and positions within the footprint', () => {
    expect(LandmarkPlan.safeParse({ ...plan, sources: [] }).success).toBe(false);
    const outside = { ...plan.parts[0], at: { along: 1.5, across: 0 } };
    expect(LandmarkPlan.safeParse({ ...plan, parts: [outside] }).success).toBe(false);
  });

  it('needs exactly one of at or offset_m per part', () => {
    const both = { ...plan.parts[0], offset_m: [0, 0] };
    const neither = { kind: 'dome', shape: 'circle', size_m: 5, height_m: 5 };
    expect(LandmarkPlan.safeParse({ ...plan, parts: [both] }).success).toBe(false);
    expect(LandmarkPlan.safeParse({ ...plan, parts: [neither] }).success).toBe(false);
  });
});

describe('Landcover', () => {
  const ring = [
    [123.1, 13.6],
    [123.101, 13.6],
    [123.101, 13.601],
    [123.1, 13.6],
  ];
  const pack = {
    id: 'landcover/test-grounds',
    title: 'Test grounds',
    trees: [
      { at: [123.1, 13.6], crown_m: 9 },
      { at: [123.1002, 13.6], kind: 'palm' },
    ],
    rows: [{ line: [ring[0], ring[1]], kind: 'palm' }],
    areas: [
      { ring, cover: 'woods', kind: 'broadleaved' },
      { ring, cover: 'parking' },
    ],
    status: 'draft',
    credit: 'Tree positions: Example imagery',
    sources: [{ title: 'Example imagery' }],
  };

  it('accepts a valid pack, with missing collections defaulting to empty', () => {
    expect(Landcover.safeParse(pack).success).toBe(true);
    const onlyTrees = Landcover.parse({ ...pack, rows: undefined, areas: undefined });
    expect(onlyTrees.rows).toEqual([]);
    expect(onlyTrees.areas).toEqual([]);
  });

  it('accepts sourced draft farmland without a tree kind', () => {
    expect(Landcover.parse({ ...pack, areas: [{ ring, cover: 'farmland' }] }).areas[0]!.cover).toBe(
      'farmland',
    );
    expect(
      Landcover.safeParse({ ...pack, areas: [{ ring, cover: 'farmland', kind: 'palm' }] }).success,
    ).toBe(false);
  });

  it('needs something to draw, sources, and a credit', () => {
    expect(Landcover.safeParse({ ...pack, trees: [], rows: [], areas: [] }).success).toBe(false);
    expect(Landcover.safeParse({ ...pack, sources: [] }).success).toBe(false);
    expect(Landcover.safeParse({ ...pack, credit: '' }).success).toBe(false);
  });

  it('accepts shrub polygons without a tree kind', () => {
    expect(
      Landcover.safeParse({ ...pack, trees: [], rows: [], areas: [{ ring, cover: 'shrubs' }] })
        .success,
    ).toBe(true);
    expect(
      Landcover.safeParse({ ...pack, areas: [{ ring, cover: 'shrubs', kind: 'palm' }] }).success,
    ).toBe(false);
  });

  it('rejects unclosed rings, unknown covers, and tree kinds on non-woods', () => {
    const open = { ring: ring.slice(0, 3).concat([[123.2, 13.7]]), cover: 'grass' };
    expect(Landcover.safeParse({ ...pack, areas: [open] }).success).toBe(false);
    expect(Landcover.safeParse({ ...pack, areas: [{ ring, cover: 'lawn' }] }).success).toBe(false);
    const kindedGrass = { ring, cover: 'grass', kind: 'palm' };
    expect(Landcover.safeParse({ ...pack, areas: [kindedGrass] }).success).toBe(false);
  });

  it('rejects bad tree kinds and positions off the globe', () => {
    expect(Landcover.safeParse({ ...pack, trees: [{ at: [0, 0], kind: 'oak' }] }).success).toBe(
      false,
    );
    expect(Landcover.safeParse({ ...pack, trees: [{ at: [13.6, 123.1] }] }).success).toBe(false);
  });
});

describe('TilesLock', () => {
  const sha = 'a'.repeat(64);
  const lock = {
    repo: 'owner/name',
    tag: 'tiles-naga-20260929-1930',
    files: { 'naga.pmtiles': sha },
  };

  it('accepts a release tag and hashed files', () => {
    expect(TilesLock.parse(lock)).toEqual(lock);
  });

  it('rejects paths, bad hashes, and empty file lists', () => {
    expect(TilesLock.safeParse({ ...lock, files: { '../x.pmtiles': sha } }).success).toBe(false);
    expect(TilesLock.safeParse({ ...lock, files: { '..': sha } }).success).toBe(false);
    expect(TilesLock.safeParse({ ...lock, files: { 'naga.pmtiles': 'abc' } }).success).toBe(false);
    expect(TilesLock.safeParse({ ...lock, files: {} }).success).toBe(false);
    expect(TilesLock.safeParse({ ...lock, repo: 'name-only' }).success).toBe(false);
  });
});
