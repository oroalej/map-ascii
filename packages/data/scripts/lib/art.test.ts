import type { LandmarkArt } from '@atlas/shared';
import { describe, expect, it } from 'vitest';
import { bboxAround, placeArt } from './art';

const piece = (over: Partial<LandmarkArt>): LandmarkArt => ({
  id: 'art/test',
  osm_id: 'osm:way/1',
  title: 'Test',
  variants: [{ rows: ['█'], colors: [' '] }],
  palette: { s: 'stone' },
  status: 'draft',
  sources: [{ title: 'Reference' }],
  ...over,
});

const square = {
  type: 'Feature' as const,
  properties: { id: 'osm:way/1', label_lng: 0.5, label_lat: 0.5 },
  geometry: {
    type: 'Polygon' as const,
    coordinates: [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
        [0, 0],
      ],
    ],
  },
};
const point = {
  type: 'Feature' as const,
  properties: { id: 'osm:node/2' },
  geometry: { type: 'Point' as const, coordinates: [10, 0] },
};

describe('placeArt', () => {
  it('places area art on the footprint and label anchor', () => {
    const { pieces } = placeArt([square], [piece({})]);
    expect(pieces[0]).toMatchObject({ bbox: [0, 0, 1, 1], anchor: [0.5, 0.5] });
  });

  it('sizes point art by footprint_m around the point', () => {
    const { pieces } = placeArt([point], [piece({ osm_id: 'osm:node/2', footprint_m: 10 })]);
    const [w, s, e, n] = pieces[0]!.bbox;
    expect(pieces[0]!.anchor).toEqual([10, 0]);
    // Coordinates are rounded to 1e-7° (about a centimeter).
    expect((e - w) * 111_320).toBeCloseTo(10, 1);
    expect((n - s) * 111_320).toBeCloseTo(10, 1);
  });

  it('fails loudly for a missing feature or a point without footprint_m', () => {
    expect(() => placeArt([square], [piece({ osm_id: 'osm:way/9' })])).toThrow(/not in the OSM/);
    expect(() => placeArt([point], [piece({ osm_id: 'osm:node/2' })])).toThrow(/footprint_m/);
  });

  it('widens bboxes in longitude away from the equator', () => {
    const [w, , e] = bboxAround([0, 60], 1000);
    expect((e - w) * 111_320 * Math.cos(Math.PI / 3)).toBeCloseTo(1000, 3);
  });
});
