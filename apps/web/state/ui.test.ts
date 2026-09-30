import { describe, expect, it } from 'vitest';
import { isPickable } from './ui';

describe('isPickable', () => {
  it('lets only landmarks respond to the pointer', () => {
    expect(
      isPickable({ id: 'osm:way/1', class: 'building', landmarkId: 'landmark/example-church' }),
    ).toBe(true);
    expect(isPickable({ id: 'osm:way/2', class: 'building', name: 'Town Hall' })).toBe(false);
    expect(isPickable({ id: 'osm:way/3', class: 'road_major', name: 'Main Street' })).toBe(false);
    expect(isPickable(null)).toBe(false);
  });
});
