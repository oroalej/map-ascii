import { describe, expect, it } from 'vitest';
import { SearchEntry } from './search';
import { foldTerm } from './search-options';
import { bandVisibility, CLASS_ZOOM, featureZoomBand, tileZoomRange, zoomLevel } from './zoom';

describe('bandVisibility', () => {
  it('fades in over the half zoom before min', () => {
    const band = { min: 13 };
    expect(bandVisibility(band, 12.4)).toBe(0);
    expect(bandVisibility(band, 12.75)).toBeCloseTo(0.5);
    expect(bandVisibility(band, 13)).toBe(1);
    expect(bandVisibility(band, 19)).toBe(1);
  });

  it('fades out over the half zoom after max', () => {
    const band = { min: 0, max: 9.5 };
    expect(bandVisibility(band, 9.5)).toBe(1);
    expect(bandVisibility(band, 9.75)).toBeCloseTo(0.5);
    expect(bandVisibility(band, 10)).toBe(0);
  });
});

describe('featureZoomBand', () => {
  it("uses the class's band for most classes", () => {
    expect(featureZoomBand('water_river')).toEqual(CLASS_ZOOM.water_river);
    expect(featureZoomBand('water_stream')).toEqual({ min: 12.5 });
  });

  it('shows place labels by what they name', () => {
    expect(featureZoomBand('place_label', { place: 'province' })).toEqual({ min: 0, max: 9.5 });
    expect(featureZoomBand('place_label', { place: 'city' })).toEqual({ min: 0, max: 13 });
    expect(featureZoomBand('place_label', { place: 'village', subdivision_label: true })).toEqual({
      min: 10.5,
      max: 16,
    });
    expect(featureZoomBand('place_label', { place: 'neighbourhood' })).toEqual({ min: 13.5 });
  });
});

describe('tileZoomRange', () => {
  const tiles = { min: 6, max: 16 };

  it('puts a class in the tiles from which it starts fading in', () => {
    expect(tileZoomRange({ min: 13 }, tiles)).toEqual({ minzoom: 12, maxzoom: 16 });
    expect(tileZoomRange({ min: 12.5 }, tiles)).toEqual({ minzoom: 12, maxzoom: 16 });
    expect(tileZoomRange({ min: 0 }, tiles)).toEqual({ minzoom: 6, maxzoom: 16 });
  });

  it('keeps a class in tiles until it has faded out', () => {
    expect(tileZoomRange(CLASS_ZOOM.terrain, tiles)).toEqual({ minzoom: 6, maxzoom: 10 });
  });
});

describe('zoomLevel', () => {
  it('names the SPEC §2 levels', () => {
    expect(zoomLevel(7)).toBe('Region');
    expect(zoomLevel(9.5)).toBe('City');
    expect(zoomLevel(14)).toBe('District');
    expect(zoomLevel(16)).toBe('Street');
    expect(zoomLevel(18.2)).toBe('Place');
  });
});

describe('search', () => {
  it('folds diacritics and case', () => {
    expect(foldTerm('Peñafrancia')).toBe('penafrancia');
    expect(foldTerm('Santo Niño')).toBe(foldTerm('SANTO NINO'));
  });

  it('validates entries', () => {
    const entry = {
      id: 'osm:way/1',
      name: 'Example',
      altNames: [],
      type: 'landmark',
      lat: 1,
      lng: 2,
      zoomHint: 17,
    };
    expect(SearchEntry.safeParse(entry).success).toBe(true);
    expect(SearchEntry.safeParse({ ...entry, type: 'airport' }).success).toBe(false);
  });
});
