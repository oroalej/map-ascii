import { expect, it } from 'vitest';
import type { Landmark } from '@atlas/shared';

const landmarks = import.meta.glob('../cities/naga/landmarks/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, Landmark>;

it('curates facts for twenty-three Naga landmarks, including heritage sites and the museum statue', () => {
  const clickable = Object.values(landmarks).filter((landmark) => landmark.facts);
  expect(clickable.map((landmark) => landmark.id).sort()).toEqual(
    [
      'abella-business-buildings',
      'administracion-de-correo',
      'almeda-ancestral-house',
      'ateneo-de-naga-main-building',
      'ateneo-de-naga-university',
      'badiola-house',
      'bichara-theatre',
      'immaculate-conception-parish',
      'jesse-robredo-monument',
      'naga-metropolitan-cathedral',
      'old-abella-mansion-arch',
      'old-provincial-jail',
      'padre-jorge-barlin-plaza',
      'penafrancia-basilica',
      'penafrancia-shrine',
      'people-power-monument',
      'plaza-quince-martires',
      'plaza-rizal',
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
