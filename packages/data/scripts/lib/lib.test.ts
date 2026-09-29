import { describe, expect, it } from 'vitest';
import { buildingHeight, classify, layerFor } from './classify';
import { parseOsmDate } from './dates';
import { bufferBbox, toOverpassBbox } from './geo';

describe('classify', () => {
  const area = (tags: Record<string, string>) => classify(tags, 'area', 10);
  const line = (tags: Record<string, string>) => classify(tags, 'line', 10);

  it('maps highways by hierarchy, including links', () => {
    expect(line({ highway: 'trunk' })).toBe('road_major');
    expect(line({ highway: 'primary_link' })).toBe('road_major');
    expect(line({ highway: 'tertiary' })).toBe('road_mid');
    expect(line({ highway: 'service' })).toBe('road_minor');
    expect(line({ highway: 'steps' })).toBe('path');
    expect(line({ highway: 'proposed' })).toBeNull();
  });

  it('picks the specific building class over generic building', () => {
    expect(area({ building: 'yes' })).toBe('building');
    expect(area({ building: 'cathedral' })).toBe('building_religious');
    expect(area({ building: 'yes', amenity: 'place_of_worship' })).toBe('building_religious');
    expect(area({ building: 'yes', amenity: 'university' })).toBe('building_school');
    expect(area({ building: 'retail', shop: 'mall' })).toBe('building_market');
    expect(area({ building: 'no', leisure: 'park' })).toBe('park');
  });

  it('maps water, green, and farm areas', () => {
    expect(line({ waterway: 'river' })).toBe('water_river');
    expect(area({ natural: 'water' })).toBe('water_area');
    expect(area({ place: 'square' })).toBe('park');
    expect(area({ landuse: 'forest' })).toBe('trees');
    expect(area({ landuse: 'farmland', crop: 'rice' })).toBe('farmland');
    expect(area({ landuse: 'residential' })).toBeNull();
  });

  it('keeps only the configured subdivision level of admin boundaries', () => {
    expect(area({ boundary: 'administrative', admin_level: '10' })).toBe('admin_subdivision');
    expect(area({ boundary: 'administrative', admin_level: '11' })).toBeNull();
    expect(classify({ boundary: 'administrative', admin_level: '8' }, 'area', 8)).toBe(
      'admin_subdivision',
    );
  });

  it('labels named places and sends other points to poi', () => {
    expect(classify({ place: 'quarter', name: 'X' }, 'point', 10)).toBe('place_label');
    expect(classify({ place: 'quarter' }, 'point', 10)).toBeNull();
    expect(layerFor('place_label', 'point')).toBe('labels');
    expect(layerFor('building_school', 'point')).toBe('poi');
    expect(layerFor('building_school', 'area')).toBe('buildings');
    expect(layerFor('park', 'area')).toBe('landuse');
  });
});

describe('buildingHeight', () => {
  it('prefers height, then levels, then the class default', () => {
    expect(buildingHeight({ building: 'yes', height: '14.5 m' }, 'building')).toBe(14.5);
    expect(buildingHeight({ building: 'yes', 'building:levels': '3' }, 'building')).toBe(9);
    expect(buildingHeight({ building: 'church' }, 'building_religious')).toBe(15);
    expect(buildingHeight({ height: '10' }, 'park')).toBeUndefined();
  });

  it('gives grounds without building=* no height', () => {
    expect(buildingHeight({ amenity: 'school' }, 'building_school')).toBeUndefined();
    expect(
      buildingHeight({ amenity: 'school', building: 'no' }, 'building_school'),
    ).toBeUndefined();
  });
});

describe('parseOsmDate', () => {
  it('treats plain years and ISO dates as exact', () => {
    expect(parseOsmDate('1954')).toEqual({ year: 1954, certainty: 'exact' });
    expect(parseOsmDate('1954-05-01')).toEqual({ year: 1954, certainty: 'exact' });
  });

  it('treats approximate forms as circa', () => {
    for (const value of ['~1950', '1950s', 'c. 1950', 'ca 1950', 'circa 1950']) {
      expect(parseOsmDate(value)).toEqual({ year: 1950, certainty: 'circa' });
    }
  });

  it('does not guess at ranges, bounds, or free text', () => {
    for (const value of ['1950..1960', 'before 1950', 'C19', 'old', '', undefined]) {
      expect(parseOsmDate(value)).toBeUndefined();
    }
  });
});

describe('geo', () => {
  it('buffers a bbox by kilometers', () => {
    const [w, s, e, n] = bufferBbox([0, 0, 0, 0], 1.1132);
    expect(n).toBeCloseTo(0.01, 6);
    expect(s).toBeCloseTo(-0.01, 6);
    expect(e).toBeCloseTo(0.01, 6);
    expect(w).toBeCloseTo(-0.01, 6);
  });

  it('formats bboxes in Overpass order (south, west, north, east)', () => {
    expect(toOverpassBbox([123, 13, 124, 14])).toBe('13.000000,123.000000,14.000000,124.000000');
  });
});
