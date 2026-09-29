import { describe, expect, it } from 'vitest';
import { CameraState, Event, Landmark, NameHistory, Tour } from './schemas';

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

  it('accepts a tour with steps', () => {
    expect(Tour.safeParse({ id: 'tour/x', title: { en: 'X' }, steps: [step] }).success).toBe(true);
  });

  it('rejects an empty tour', () => {
    expect(Tour.safeParse({ id: 'tour/x', title: { en: 'X' }, steps: [] }).success).toBe(false);
  });

  it('rejects a non-positive duration', () => {
    expect(
      Tour.safeParse({ id: 'tour/x', title: { en: 'X' }, steps: [{ ...step, duration_ms: 0 }] })
        .success,
    ).toBe(false);
  });
});
