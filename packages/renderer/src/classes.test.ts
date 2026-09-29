import { describe, expect, it } from 'vitest';
import { classDepths, classId, classVisibility } from './classes';

describe('classVisibility', () => {
  const at = (zoom: number, cls: string) => classVisibility(zoom)[classId(cls)]!;

  it('fades a class in over the half zoom before its band starts', () => {
    expect(at(12.4, 'building')).toBe(0);
    expect(at(12.75, 'building')).toBeCloseTo(0.5);
    expect(at(13, 'building')).toBe(1);
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

  it('never draws place labels as cells', () => {
    expect(depth('place_label')).toBe(2);
  });
});
