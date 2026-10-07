import { describe, expect, it } from 'vitest';
import { isPickable } from './ui';

describe('isPickable', () => {
  it('lets only landmarks respond to the pointer', () => {
    const clickable = new Set(['landmark/example-church']);
    expect(
      isPickable(
        { id: 'osm:way/1', class: 'building', landmarkId: 'landmark/example-church' },
        clickable,
      ),
    ).toBe(true);
    expect(
      isPickable({ id: 'osm:way/2', class: 'building', landmarkId: 'unlisted' }, clickable),
    ).toBe(false);
    expect(
      isPickable({ id: 'osm:way/3', class: 'road_major', name: 'Main Street' }, clickable),
    ).toBe(false);
    expect(isPickable(null, clickable)).toBe(false);
  });
});
