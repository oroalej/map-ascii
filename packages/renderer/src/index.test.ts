import { describe, expect, it, vi } from 'vitest';
import { createAtlas } from './index';

const options = {
  tilesUrl: '/tiles/naga.pmtiles',
  initialCamera: { lat: 13.6218, lng: 123.1948, zoom: 13, pitch: 0, bearing: 0 },
  year: 2026,
};

describe('createAtlas', () => {
  it('throws a clear error when WebGL2 is unavailable', () => {
    const canvas = document.createElement('canvas');
    vi.spyOn(canvas, 'getContext').mockReturnValue(null);
    expect(() => createAtlas(canvas, options)).toThrow(/WebGL2/);
  });
});
