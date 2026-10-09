import { describe, expect, it } from 'vitest';
import { CityLife, Peddler } from './schemas';
import { PEDDLER_PROPS, vendorAccessRestricted } from './peddlers';

it('keeps private ownership and access restrictions even when pedestrian entry is allowed', () => {
  for (const access of ['private', 'no', 'customers', 'permit', 'destination', 'residents'])
    expect(vendorAccessRestricted({ access, foot: 'yes' })).toBe(true);
  expect(vendorAccessRestricted({ ownership: 'private', access: 'yes' })).toBe(true);
  expect(vendorAccessRestricted({ access: 'public', foot: 'private' })).toBe(true);
  for (const access of [undefined, '', 'yes', 'public', 'permissive', 'designated'])
    expect(vendorAccessRestricted({ access })).toBe(false);
  expect(vendorAccessRestricted({ foot: 'use_sidepath' })).toBe(false);
});

const example = {
  id: 'sample-goods',
  label: 'Sample vendor',
  prop: 'basket',
  hours: { from: 18, to: 2 },
  lines: ['path'],
  perTile: 1,
  source: [{ title: 'Illustrative practice' }],
};
describe('peddler city configuration', () => {
  it('accepts all generic props and adjacent windows including midnight', () => {
    expect(Peddler.safeParse({ ...example, lines: ['street'] }).success).toBe(true);
    for (const prop of PEDDLER_PROPS)
      expect(Peddler.safeParse({ ...example, prop }).success).toBe(true);
    for (const hours of [
      { from: 0, to: 24 },
      { from: 23, to: 0 },
      [
        { from: 23, to: 2 },
        { from: 2, to: 5 },
      ],
    ])
      expect(Peddler.safeParse({ ...example, hours }).success).toBe(true);
  });
  it.each([
    { hours: [] },
    { hours: { from: 24, to: 2 } },
    { hours: { from: 3, to: 3 } },
    {
      hours: [
        { from: 18, to: 2 },
        { from: 1, to: 5 },
      ],
    },
    {
      hours: [
        { from: 0, to: 24 },
        { from: 5, to: 6 },
      ],
    },
    { lines: [] },
    { lines: ['path', 'path'] },
    { lines: ['roadMinor'] },
    { prop: 'truck' },
    { id: 'Bad Id' },
    { label: ' ' },
    { source: [] },
    { share: 1.1 },
    { weather: { rain: -1 } },
    { weather: { heat: 2 } },
    { near: { kind: 'terminal', reach: 0 } },
    { near: { kind: 'terminal', reach: 201 } },
    { perTile: 3 },
    { unexpected: true },
  ])('rejects invalid bounded entries %j', (change) => {
    expect(Peddler.safeParse({ ...example, ...change }).success).toBe(false);
  });
  it('bounds inventory and requires unique ids', () => {
    const entries = Array.from({ length: 8 }, (_, i) => ({ ...example, id: `goods-${i}` }));
    expect(CityLife.safeParse({ source: 'Practice', peddlers: entries }).success).toBe(true);
    expect(
      CityLife.safeParse({
        source: 'Practice',
        peddlers: [...entries, { ...example, id: 'extra' }],
      }).success,
    ).toBe(false);
    expect(CityLife.safeParse({ source: 'Practice', peddlers: [example, example] }).success).toBe(
      false,
    );
  });
});
