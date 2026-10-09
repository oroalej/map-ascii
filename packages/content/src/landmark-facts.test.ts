import { expect, it } from 'vitest';
import type { Landmark } from '@atlas/shared';

const landmarks = import.meta.glob('../cities/naga/landmarks/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, Landmark>;

it('curates facts for twenty-six Naga landmarks besides food places, including heritage sites and the museum statue', () => {
  // Food places carry their own sourced facts (food-content.test.ts).
  const clickable = Object.values(landmarks).filter(
    (landmark) => landmark.facts && landmark.type !== 'food',
  );
  expect(clickable.map((landmark) => landmark.id).sort()).toEqual(
    [
      'abella-business-buildings',
      'administracion-de-correo',
      'almeda-ancestral-house',
      'ateneo-de-naga-main-building',
      'ateneo-de-naga-university',
      'badiola-house',
      'bichara-theatre',
      'holy-rosary-minor-seminary-building',
      'immaculate-conception-parish',
      'jesse-robredo-monument',
      'naga-city-peoples-mall',
      'naga-metropolitan-cathedral',
      'old-abella-mansion-arch',
      'old-provincial-jail',
      'padre-jorge-barlin-plaza',
      'penafrancia-basilica',
      'penafrancia-shrine',
      'people-power-monument',
      'plaza-quince-martires',
      'plaza-rizal',
      'quince-martires-monument',
      'roco-ancestral-house',
      'san-francisco-parish',
      'universidad-de-santa-isabel',
      'usi-main-building',
      'villafrancia-house',
    ].map((slug) => `landmark/${slug}`),
  );
  expect(
    clickable.find((landmark) => landmark.id === 'landmark/jesse-robredo-monument')?.osm_id,
  ).toBe('osm:node/13958319312');
});
