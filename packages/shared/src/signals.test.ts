import { expect, it } from 'vitest';
import { CityLife } from './schemas';
it('validates sourced signal additions and unambiguous removal targets', () => {
  expect(
    CityLife.safeParse({
      source: 'Default',
      signals: {
        derive: false,
        add: [{ id: 'main', position: [123, 13], source: 'Survey' }],
        remove: [{ id: 'wrong', osm_id: 45, source: 'Survey' }],
      },
    }).success,
  ).toBe(true);
  for (const remove of [
    { id: 'x', source: 'x' },
    { id: 'x', osm_id: 1, position: [0, 0], source: 'x' },
  ])
    expect(CityLife.safeParse({ source: 'x', signals: { remove: [remove] } }).success).toBe(false);
  expect(
    CityLife.safeParse({
      source: 'x',
      signals: { add: [{ id: 'x', position: [181, 0], source: '' }] },
    }).success,
  ).toBe(false);
});
