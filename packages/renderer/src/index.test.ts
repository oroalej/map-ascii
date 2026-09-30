import { describe, expect, it, vi } from 'vitest';
import { createAtlas } from './index';

const options = {
  tilesUrl: '/tiles/example.pmtiles',
  bounds: [-1, -1, 1, 1] as [number, number, number, number],
  initialCamera: { lat: 0, lng: 0, zoom: 13 },
  year: 2026,
};

describe('createAtlas', () => {
  it('throws a clear error when WebGL2 is unavailable', () => {
    const canvas = document.createElement('canvas');
    vi.spyOn(canvas, 'getContext').mockReturnValue(null);
    expect(() => createAtlas(canvas, options)).toThrow(/WebGL2/);
  });
});
