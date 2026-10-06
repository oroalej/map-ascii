import { expect, it } from 'vitest';
import type { Landmark } from '@atlas/shared';

const landmarks = import.meta.glob('../cities/naga/landmarks/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, Landmark>;

it('curates facts for the twelve owner-selected Naga landmarks and the museum statue', () => {
  const clickable = Object.values(landmarks).filter((landmark) => landmark.facts);
  expect(clickable.map((landmark) => landmark.id).sort()).toEqual(
    [
      'ateneo-de-naga-university',
      'immaculate-conception-parish',
      'jesse-robredo-monument',
      'naga-metropolitan-cathedral',
      'padre-jorge-barlin-plaza',
      'penafrancia-basilica',
      'penafrancia-shrine',
      'people-power-monument',
      'plaza-quince-martires',
      'plaza-rizal',
      'san-francisco-parish',
      'universidad-de-santa-isabel',
    ].map((slug) => `landmark/${slug}`),
  );
  expect(
    clickable.find((landmark) => landmark.id === 'landmark/jesse-robredo-monument')?.osm_id,
  ).toBe('osm:node/13958319312');
});
