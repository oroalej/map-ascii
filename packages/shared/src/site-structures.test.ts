import { describe, expect, it } from 'vitest';
import { SiteDetail, SiteStructure } from './schemas';

const part = {
  id: 'beam',
  ring: [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
    [0, 0],
  ],
  height_m: 3,
  material: 'wood',
  overhead: true,
};
const detail = {
  id: 'detail/test',
  osm_id: 'osm:way/1',
  title: 'Test',
  surface: 'paving',
  status: 'draft',
  credit: 'Survey',
  sources: [{ title: 'Survey' }],
};

describe('site structure content', () => {
  it('accepts walkable raised paving and rejects overhead paving', () => {
    expect(
      SiteStructure.safeParse({ ...part, material: 'paving', height_m: 0.15, overhead: false })
        .success,
    ).toBe(true);
    expect(SiteStructure.safeParse({ ...part, material: 'paving' }).success).toBe(false);
  });
  it('keeps older outdoor records valid and rejects ambiguous structure identities', () => {
    expect(SiteDetail.parse(detail).structures).toEqual([]);
    expect(SiteDetail.safeParse({ ...detail, structures: [part] }).success).toBe(true);
    expect(SiteDetail.safeParse({ ...detail, structures: [part, part] }).success).toBe(false);
  });

  it('rejects open, collapsed and self-intersecting footprints before triangulation', () => {
    for (const ring of [
      [],
      [[0, 0]],
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
      [
        [0, 0],
        [1, 0],
        [2, 0],
        [0, 0],
      ],
      [
        [0, 0],
        [1, 1],
        [0, 1],
        [1, 0],
        [0, 0],
      ],
      [
        [0, 0],
        [1, 0],
        [1, 0],
        [0, 1],
        [0, 0],
      ],
    ])
      expect(SiteStructure.safeParse({ ...part, ring }).success).toBe(false);
    for (const change of [{ height_m: 0 }, { material: 'plastic' }, { overhead: undefined }])
      expect(SiteStructure.safeParse({ ...part, ...change }).success).toBe(false);
  });
});
