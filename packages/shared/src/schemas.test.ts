import { describe, expect, it } from 'vitest';
import {
  ART_CHARACTERS,
  CameraState,
  City,
  contentSchemas,
  Event,
  Landmark,
  LandmarkArt,
  LandmarkPlan,
  LocalizedText,
  NameHistory,
  Tour,
} from './schemas';

const source = { title: 'Example source', url: 'https://example.org/' };

const landmark = {
  id: 'landmark/example-church',
  osm_id: 'osm:way/123456',
  name: { en: 'Example Church' },
  type: 'church',
  start_year: 1900,
  certainty: 'circa',
  sources: [source],
};

const camera = { lat: 13.6218, lng: 123.1948, zoom: 13, pitch: 0, bearing: 0 };

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
  it('limits pitch to 0-60', () => {
    expect(CameraState.safeParse(camera).success).toBe(true);
    expect(CameraState.safeParse({ ...camera, pitch: 61 }).success).toBe(false);
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

  it('rejects an inverted bbox', () => {
    expect(City.safeParse({ ...city, region: { bbox: [120, 15, 125, 10] } }).success).toBe(false);
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
