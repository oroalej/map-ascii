import { describe, expect, it } from 'vitest';
import { entryBbox } from './06-search-index';

describe('entryBbox', () => {
  it('keeps a bbox with area, rounded', () => {
    expect(entryBbox([123.1, 13.6, 123.2000004, 13.7])).toEqual({
      bbox: [123.1, 13.6, 123.2, 13.7],
    });
  });

  it('drops a bbox without area: a point, or a way along a parallel or meridian', () => {
    expect(entryBbox([123.1, 13.6, 123.1, 13.6])).toEqual({});
    expect(entryBbox([123.1, 13.6, 123.2, 13.6])).toEqual({});
    expect(entryBbox([123.1, 13.6, 123.1000001, 13.7])).toEqual({});
  });
});
