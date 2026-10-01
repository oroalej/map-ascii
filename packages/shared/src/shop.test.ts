import { expect, it } from 'vitest';
import { Frontage, ShopAnchor } from './schemas';
import { FRONTAGE_KINDS } from './constants';

it('validates frontage values and complete finite shop anchors', () => {
  for (const kind of FRONTAGE_KINDS) expect(Frontage.parse(kind)).toBe(kind);
  expect(Frontage.safeParse('cafe').success).toBe(false);
  const anchor = { shop_lng: 123, shop_lat: 13, shop_radius_m: 5 };
  expect(ShopAnchor.parse(anchor)).toEqual(anchor);
  for (const key of Object.keys(anchor)) {
    const partial: Record<string, number> = { ...anchor };
    delete partial[key];
    expect(ShopAnchor.safeParse(partial).success).toBe(false);
    expect(ShopAnchor.safeParse({ ...anchor, [key]: Infinity }).success).toBe(false);
  }
  expect(ShopAnchor.safeParse({ ...anchor, shop_radius_m: 0 }).success).toBe(false);
});
