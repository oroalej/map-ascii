import { describe, expect, it } from 'vitest';
import { Cemetery } from './schemas';

const pack = {
  id: 'cemetery/fixture',
  osm_id: 'osm:way/1',
  title: 'Fixture cemetery',
  rows: [
    {
      id: 'north',
      line: [
        [120, 14],
        [120.001, 14],
      ],
      count: 10,
      kind: 'flush',
      width_m: 0.6,
      length_m: 0.4,
      height_m: 0,
    },
  ],
  status: 'draft',
  credit: 'Owner reference',
  sources: [{ title: 'Undated reference' }],
};
describe('Cemetery content', () => {
  it('requires sourced, bounded rows and distinct endpoints', () => {
    expect(Cemetery.safeParse(pack).success).toBe(true);
    for (const row of [
      { ...pack.rows[0], count: 0 },
      { ...pack.rows[0], width_m: 0 },
      {
        ...pack.rows[0],
        line: [
          [120, 14],
          [120, 14],
        ],
      },
      { ...pack.rows[0], count: 201 },
    ])
      expect(Cemetery.safeParse({ ...pack, rows: [row] }).success).toBe(false);
    expect(Cemetery.safeParse({ ...pack, sources: [] }).success).toBe(false);
  });
  it('rejects duplicate row identities and excessive geometry', () => {
    expect(Cemetery.safeParse({ ...pack, rows: [...pack.rows, ...pack.rows] }).success).toBe(false);
    expect(
      Cemetery.safeParse({
        ...pack,
        rows: Array.from({ length: 76 }, (_, i) => ({
          ...pack.rows[0],
          id: `row-${i}`,
          count: 200,
        })),
      }).success,
    ).toBe(false);
  });
  it('distinguishes flush plaques from raised structures', () => {
    expect(Cemetery.safeParse({ ...pack, rows: [{ ...pack.rows[0], height_m: 1 }] }).success).toBe(
      false,
    );
    expect(Cemetery.safeParse({ ...pack, rows: [{ ...pack.rows[0], kind: 'slab' }] }).success).toBe(
      false,
    );
    expect(
      Cemetery.safeParse({ ...pack, rows: [{ ...pack.rows[0], kind: 'vault', height_m: 2 }] })
        .success,
    ).toBe(true);
  });
});
