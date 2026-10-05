import { DetailLayouts, SiteDetail } from '@atlas/shared';
import { describe, expect, it } from 'vitest';
import { detailLayoutKey } from '@atlas/shared/detail-layout';

const detail = {
  id: 'detail/fixture',
  osm_id: 'osm:way/1',
  title: 'Fixture',
  surface: 'keep',
  structures: [
    {
      id: 'court',
      ring: [
        [0, 0],
        [0.001, 0],
        [0.001, 0.001],
        [0, 0.001],
        [0, 0],
      ],
      height_m: 0.15,
      material: 'paving',
      overhead: false,
    },
  ],
  status: 'draft',
  credit: 'Fixture survey',
  sources: [{ title: 'Fixture survey' }],
};

describe('detail layout fingerprints', () => {
  it('validates a separate record of detail ids and SHA-256 fingerprints', () => {
    expect(DetailLayouts.parse({ [detail.id]: detailLayoutKey(detail) })).toEqual({
      [detail.id]: detailLayoutKey(detail),
    });
    expect(DetailLayouts.parse({})).toEqual({});
    for (const broken of [null, [], { fixture: 'a'.repeat(64) }, { [detail.id]: 'not-a-hash' }])
      expect(DetailLayouts.safeParse(broken).success).toBe(false);
  });
  it('matches raw and parsed content, property order, default values and annotation edits', () => {
    const parsed = SiteDetail.parse(detail);
    const reordered = Object.fromEntries(Object.entries(detail).reverse());
    const annotated = {
      ...detail,
      title: 'Updated title',
      status: 'verified',
      credit: 'Additional credit',
      sources: [{ title: 'New source' }],
      structures: detail.structures.map((part) => ({ ...part, ground_override: false })),
    };
    expect(detailLayoutKey(detail)).toMatch(/^[0-9a-f]{64}$/);
    expect(detailLayoutKey(parsed)).toBe(detailLayoutKey(detail));
    expect(detailLayoutKey(reordered)).toBe(detailLayoutKey(detail));
    expect(detailLayoutKey(annotated)).toBe(detailLayoutKey(detail));
    expect(detailLayoutKey({ ...detail, roof_overrides: [] })).toBe(detailLayoutKey(detail));
    expect(detailLayoutKey({ ...detail, building_overrides: [] })).toBe(detailLayoutKey(detail));
  });

  it('changes when surface priority, geometry or canonical selection changes', () => {
    const key = detailLayoutKey(detail);
    for (const changed of [
      { ...detail, surface: 'paving' },
      { ...detail, selection_osm_id: 'osm:way/2' },
      {
        ...detail,
        structures: detail.structures.map((part) => ({ ...part, ground_override: true })),
      },
      { ...detail, structures: detail.structures.map((part) => ({ ...part, height_m: 0.3 })) },
      { ...detail, structures: [] },
      { ...detail, structures: detail.structures.map((part) => ({ ...part, material: 'water' })) },
      { ...detail, roof_overrides: [{ osm_id: 'osm:way/2', shape: 'flat' }] },
      { ...detail, building_overrides: [{ osm_id: 'osm:way/2', height_m: 9 }] },
    ])
      expect(detailLayoutKey(changed)).not.toBe(key);
  });
});
