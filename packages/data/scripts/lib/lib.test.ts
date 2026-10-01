import { describe, expect, it } from 'vitest';
import {
  buildingHeight,
  classify,
  kindOf,
  layerFor,
  roadWidth,
  treeKind,
  treeSize,
  variantOf,
} from './classify';
import { parseOsmDate } from './dates';
import {
  bboxContains,
  bboxesOverlap,
  bufferBbox,
  inBbox,
  intersectBbox,
  splitOverpassBbox,
  toOverpassBbox,
} from './geo';

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
    expect(line({ waterway: 'stream' })).toBe('water_stream');
    expect(line({ waterway: 'canal' })).toBe('water_stream');
    expect(area({ natural: 'water' })).toBe('water_area');
    expect(area({ leisure: 'swimming_pool', sport: 'swimming' })).toBe('water_area');
    expect(area({ leisure: 'swimming_pool', building: 'yes' })).toBe('building');
    expect(classify({ leisure: 'swimming_pool' }, 'point', 10)).toBeNull();
    expect(area({ place: 'square' })).toBe('park');
    expect(area({ landuse: 'forest' })).toBe('trees');
    expect(area({ landuse: 'farmland', crop: 'rice' })).toBe('farmland');
    expect(area({ landuse: 'residential' })).toBeNull();
  });

  it('maps railway track and stations', () => {
    expect(line({ railway: 'rail' })).toBe('rail');
    expect(line({ railway: 'rail', service: 'siding' })).toBe('rail');
    expect(line({ railway: 'narrow_gauge' })).toBe('rail');
    expect(line({ railway: 'abandoned' })).toBeNull();
    expect(layerFor('rail', 'line')).toBe('roads');
    expect(area({ building: 'train_station', railway: 'station' })).toBe('building_station');
    expect(area({ building: 'yes', public_transport: 'station', train: 'yes' })).toBe(
      'building_station',
    );
    expect(classify({ railway: 'halt', name: 'X' }, 'point', 10)).toBe('building_station');
    expect(buildingHeight({ building: 'train_station' }, 'building_station')).toBe(8);
    expect(kindOf({ railway: 'rail' })).toBe('railway=rail');
    expect(variantOf({ railway: 'rail', service: 'spur' }, 'rail')).toBe('spur');
    expect(variantOf({ railway: 'rail', service: 'siding' }, 'rail')).toBe('siding');
    expect(variantOf({ railway: 'rail', usage: 'main' }, 'rail')).toBeUndefined();
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

describe('classify: monuments and grounds', () => {
  it('classifies statues, memorials, monuments, and artwork as monuments', () => {
    for (const tags of [
      { historic: 'memorial', memorial: 'statue' },
      { historic: 'monument' },
      { memorial: 'bust' },
      { tourism: 'artwork' },
    ]) {
      expect(classify(tags, 'point', 10)).toBe('monument');
      expect(classify(tags, 'area', 10)).toBe('monument');
    }
    expect(classify({ historic: 'castle' }, 'point', 10)).toBeNull();
    expect(layerFor('monument', 'point')).toBe('poi');
  });

  it('classifies church grounds as a height-less religious feature', () => {
    const tags = { landuse: 'religious', name: 'Cathedral Grounds' };
    expect(classify(tags, 'area', 10)).toBe('building_religious');
    expect(buildingHeight(tags, 'building_religious')).toBeUndefined();
  });
});

describe('classify: street-level detail', () => {
  it('classifies trees, furniture, entrances, and barriers', () => {
    expect(classify({ natural: 'tree' }, 'point', 10)).toBe('tree');
    expect(classify({ natural: 'tree_row' }, 'line', 10)).toBe('tree');
    expect(classify({ amenity: 'bench' }, 'point', 10)).toBe('furniture');
    expect(classify({ man_made: 'flagpole' }, 'point', 10)).toBe('furniture');
    expect(classify({ highway: 'street_lamp' }, 'point', 10)).toBe('furniture');
    expect(classify({ amenity: 'fountain' }, 'area', 10)).toBe('furniture');
    expect(classify({ entrance: 'main' }, 'point', 10)).toBe('entrance');
    expect(classify({ barrier: 'fence' }, 'line', 10)).toBe('barrier');
    expect(classify({ barrier: 'gate' }, 'point', 10)).toBe('barrier');
    expect(classify({ barrier: 'bollard' }, 'point', 10)).toBeNull();
  });

  it('classifies grass under parks', () => {
    for (const tags of [
      { landuse: 'grass' },
      { landuse: 'meadow' },
      { landuse: 'village_green' },
      { natural: 'grassland' },
      { leisure: 'recreation_ground' },
      { landuse: 'recreation_ground' },
    ]) {
      expect(classify(tags, 'area', 10)).toBe('grass');
    }
    expect(classify({ leisure: 'park', landuse: 'grass' }, 'area', 10)).toBe('park');
    expect(classify({ leisure: 'park', landuse: 'recreation_ground' }, 'area', 10)).toBe('park');
    expect(layerFor('grass', 'area')).toBe('landuse');
  });

  it('tells palms, needleleaved, and broadleaved trees apart', () => {
    expect(treeKind({ natural: 'tree', genus: 'Cocos' })).toBe('palm');
    expect(treeKind({ natural: 'tree', species: 'Roystonea regia' })).toBe('palm');
    expect(treeKind({ natural: 'tree', 'species:en': 'Coconut Palm' })).toBe('palm');
    expect(treeKind({ natural: 'tree', leaf_type: 'needleleaved' })).toBe('needleleaved');
    expect(treeKind({ natural: 'tree', leaf_type: 'broadleaved' })).toBe('broadleaved');
    expect(treeKind({ natural: 'tree', genus: 'Pterocarpus' })).toBeUndefined();
    expect(treeKind({ natural: 'tree' })).toBeUndefined();
    expect(variantOf({ genus: 'Areca' }, 'tree')).toBe('palm');
    expect(variantOf({ leaf_type: 'needleleaved' }, 'trees')).toBe('needleleaved');
  });

  it("sizes trees from their tags, else their kind's typical size", () => {
    expect(treeSize({ height: '14', diameter_crown: '11.5' })).toEqual({ height: 14, crown: 11.5 });
    expect(treeSize({ genus: 'Cocos' })).toEqual({ height: 12, crown: 6 });
    expect(treeSize({})).toEqual({ height: 10, crown: 8 });
    expect(treeSize({ height: 'tall', diameter_crown: '-3' })).toEqual({ height: 10, crown: 8 });
    expect(treeSize({ height: '400' }).height).toBe(255);
  });

  it('classifies parking and pitches', () => {
    expect(classify({ amenity: 'parking' }, 'area', 10)).toBe('parking');
    expect(classify({ leisure: 'pitch' }, 'area', 10)).toBe('pitch');
    expect(layerFor('parking', 'area')).toBe('landuse');
    expect(layerFor('furniture', 'point')).toBe('poi');
  });

  it('keeps building and monument rules ahead of the new point classes', () => {
    expect(classify({ amenity: 'place_of_worship', entrance: 'yes' }, 'point', 10)).toBe(
      'building_religious',
    );
    expect(classify({ historic: 'memorial', amenity: 'fountain' }, 'point', 10)).toBe('monument');
  });

  it('records the kind of furniture, barrier, or roof', () => {
    expect(variantOf({ amenity: 'bench' }, 'furniture')).toBe('bench');
    expect(variantOf({ man_made: 'flagpole' }, 'furniture')).toBe('flagpole');
    expect(variantOf({ highway: 'street_lamp' }, 'furniture')).toBe('lamp');
    expect(variantOf({ barrier: 'hedge' }, 'barrier')).toBe('hedge');
    expect(variantOf({ building: 'yes', 'roof:shape': 'gabled' }, 'building')).toBe('gabled');
    expect(variantOf({ building: 'yes' }, 'building')).toBeUndefined();
    expect(variantOf({ 'roof:shape': 'flat' }, 'park')).toBeUndefined();
  });
});

describe('roadWidth', () => {
  it('prefers width, then lanes × 3.2 m, then a class default', () => {
    expect(roadWidth({ width: '7.5' }, 'road_mid')).toBe(7.5);
    expect(roadWidth({ lanes: '4' }, 'road_major')).toBe(12.8);
    expect(roadWidth({}, 'road_minor')).toBe(6);
    expect(roadWidth({ width: 'wide' }, 'road_major')).toBe(14);
  });

  it('gives only carriageways a width', () => {
    expect(roadWidth({ width: '2' }, 'path')).toBeUndefined();
    expect(roadWidth({}, 'building')).toBeUndefined();
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

  it('intersects bboxes, and refuses ones that do not overlap', () => {
    expect(intersectBbox([0, 0, 2, 2], [1, -1, 3, 1])).toEqual([1, 0, 2, 1]);
    expect(() => intersectBbox([0, 0, 1, 1], [2, 2, 3, 3])).toThrow(/don't overlap/);
  });

  it('reads the bbox setting back out of a query, and the query without it', () => {
    const query = `[out:json][bbox:${toOverpassBbox([123, 13, 124, 14])}];\nway;`;
    expect(splitOverpassBbox(query)).toEqual({
      bbox: [123, 13, 124, 14],
      rest: '[out:json];\nway;',
    });
    expect(splitOverpassBbox('[out:json];\nrel(1);')).toBeNull();
  });

  it('tests bbox containment and overlap', () => {
    expect(bboxContains([0, 0, 2, 2], [0.5, 0.5, 2, 2])).toBe(true);
    expect(bboxContains([0, 0, 2, 2], [1, 1, 3, 3])).toBe(false);
    expect(bboxesOverlap([0, 0, 1, 1], [1, 1, 2, 2])).toBe(true);
    expect(bboxesOverlap([0, 0, 1, 1], [1.1, 0, 2, 1])).toBe(false);
  });

  it('tests points against a bbox, edges included', () => {
    expect(inBbox(1, 1, [0, 0, 1, 1])).toBe(true);
    expect(inBbox(1.1, 0.5, [0, 0, 1, 1])).toBe(false);
  });
});
