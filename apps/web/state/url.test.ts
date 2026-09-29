import { describe, expect, it } from 'vitest';
import { parseViewParams, serializeViewParams, type SerializableView } from './url';

const view: SerializableView = {
  camera: { lat: 13.6240116, lng: 123.1851389, zoom: 17.2345, pitch: 0, bearing: 0 },
  year: 2026,
  defaultYear: 2026,
};

describe('serializeViewParams', () => {
  it('always writes the position and zoom, rounded', () => {
    expect(serializeViewParams(view)).toBe('lat=13.624012&lng=123.185139&z=17.23');
  });

  it('writes pitch, bearing, year, selection, tour, and mode only when set', () => {
    const q = new URLSearchParams(
      serializeViewParams({
        ...view,
        camera: { ...view.camera, pitch: 42.04, bearing: -30.26 },
        year: 1990,
        sel: 'osm:way/23666715',
        tour: { id: 'heritage-centro-walk', step: 2 },
        mode: 'orbit',
      }),
    );
    expect(Object.fromEntries(q)).toMatchObject({
      pitch: '42',
      bearing: '-30.3',
      year: '1990',
      sel: 'osm:way/23666715',
      tour: 'heritage-centro-walk',
      step: '2',
      mode: 'orbit',
    });
  });

  it('keeps feature ids readable', () => {
    expect(serializeViewParams({ ...view, sel: 'osm:way/1' })).toContain('sel=osm:way/1');
  });
});

describe('parseViewParams', () => {
  it('round-trips a serialized view', () => {
    const full: SerializableView = {
      ...view,
      camera: { lat: 13.5, lng: 123.25, zoom: 15.5, pitch: 30, bearing: 45 },
      year: 1990,
      sel: 'osm:node/9',
      tour: { id: 't', step: 1 },
    };
    expect(parseViewParams(`?${serializeViewParams(full)}`)).toEqual({
      camera: full.camera,
      year: 1990,
      sel: 'osm:node/9',
      tour: 't',
      step: 1,
    });
  });

  it('drops garbage and out-of-range values instead of throwing', () => {
    expect(parseViewParams('lat=abc&lng=1&z=99&pitch=-5&bearing=&year=12&mode=fly')).toEqual({
      camera: {},
    });
    expect(parseViewParams('')).toEqual({ camera: {} });
    expect(parseViewParams('step=3')).toEqual({ camera: {} }); // a step needs a tour
  });

  it('needs both coordinates for a position', () => {
    expect(parseViewParams('lat=13.6&z=16')).toEqual({ camera: { zoom: 16 } });
  });
});
