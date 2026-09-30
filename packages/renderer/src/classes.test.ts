import { describe, expect, it } from 'vitest';
import {
  classDepths,
  classesIn,
  classId,
  classVisibility,
  crownSurfaces,
  groundDepth,
} from './classes';

describe('classesIn', () => {
  it('lists the class ids in a class-buffer read, once each, in id order', () => {
    const texel = (id: number) => [id, 0, 0, 255];
    const texels = new Uint8Array(
      [classId('road_major'), 0, classId('marker_school'), classId('road_major'), 250].flatMap(
        texel,
      ),
    );
    expect(classesIn(texels)).toEqual(['marker_school', 'road_major']);
  });
});

describe('classVisibility', () => {
  const at = (zoom: number, cls: string) => classVisibility(zoom)[classId(cls)]!;

  it('fades a class in over the half zoom before its band starts', () => {
    expect(at(12.4, 'building')).toBe(0);
    expect(at(12.75, 'building')).toBeCloseTo(0.5);
    expect(at(13, 'building')).toBe(1);
  });

  it('reveals stone edges and shrubs at their detail zooms', () => {
    expect(at(17.4, 'seating')).toBe(0);
    expect(at(18, 'seating')).toBe(1);
    expect(at(18.4, 'shrubs')).toBe(0);
    expect(at(18.75, 'shrubs')).toBeCloseTo(0.5);
    expect(at(19, 'shrubs')).toBe(1);
  });

  it('fades a class out after its band ends', () => {
    expect(at(9, 'terrain')).toBe(1);
    expect(at(9.75, 'terrain')).toBeCloseTo(0.5);
    expect(at(10, 'terrain')).toBe(0);
    expect(at(16.25, 'admin_subdivision')).toBeCloseTo(0.5);
  });

  it('always shows markers, which follow their features', () => {
    expect(at(7, 'marker_landmark')).toBe(1);
  });
});

describe('classDepths', () => {
  const depth = (cls: string) => classDepths()[classId(cls)]!;

  it('puts the region layers under everything else they meet', () => {
    expect(depth('coastline')).toBeLessThan(depth('water_sea'));
    expect(depth('water_sea')).toBeLessThan(depth('terrain'));
    expect(depth('park')).toBeLessThan(depth('terrain'));
    expect(depth('road_major')).toBeLessThan(depth('admin_city'));
    expect(depth('admin_city')).toBeLessThan(depth('building'));
  });

  it('draws grass under the parks, woods, and fields on it, and crowns over them', () => {
    expect(depth('grass')).toBeGreaterThan(depth('park'));
    expect(depth('grass')).toBeLessThan(depth('terrain'));
    expect(depth('tree_crown')).toBeLessThan(depth('park'));
    expect(depth('tree_crown')).toBeGreaterThan(depth('building'));
    expect(depth('tree')).toBeLessThan(depth('tree_crown'));
  });

  it('draws grounds under the grass, parks, and water on them, over terrain', () => {
    const ground = groundDepth();
    for (const cls of ['grass', 'park', 'water_area', 'road_minor'])
      expect(ground).toBeGreaterThan(depth(cls));
    expect(ground).toBeLessThan(depth('terrain'));
  });

  it('never draws place labels as cells', () => {
    expect(depth('place_label')).toBe(2);
  });
});

it('allows crown overlap on roads and compares every roof class, including ids above 31', () => {
  const surfaces = crownSurfaces();
  for (const cls of ['road_major', 'road_mid', 'road_minor'])
    expect(surfaces[classId(cls)]).toBe(1);
  for (const cls of [
    'building',
    'building_religious',
    'building_school',
    'building_market',
    'building_station',
    'building_part',
  ])
    expect(surfaces[classId(cls)]).toBe(2);
  for (const cls of ['water_river', 'marker_landmark', 'tree', 'trees', 'grass'])
    expect(surfaces[classId(cls)]).toBe(0);
});
