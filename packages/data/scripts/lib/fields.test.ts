import { expect, it } from 'vitest';
import { Landcover, SimpleRing } from '@atlas/shared/schemas';
import { union, difference, intersection, type Geom } from 'polyclip-ts';
import { landcoverFeatures } from './landcover';
import mask from '../__fixtures__/fields-exclusions.json';

const modules = import.meta.glob('../../../content/cities/naga/landcover/east-*-fields.json', {
  eager: true,
  import: 'default',
});
const packs = Object.values(modules).map((pack) => Landcover.parse(pack));
const ringArea = (r: readonly (readonly number[])[]) => {
  const [x, y] = r[0]!;
  return Math.abs(
    r
      .slice(1)
      .reduce(
        (sum, p, i) => sum + (r[i]![0]! - x!) * (p[1]! - y!) - (p[0]! - x!) * (r[i]![1]! - y!),
        0,
      ) / 2,
  );
};
const area = (g: number[][][][]) =>
  g.reduce(
    (sum, polygon) =>
      sum +
      ringArea(polygon[0]!) -
      polygon.slice(1).reduce((holes, ring) => holes + ringArea(ring), 0),
    0,
  );

it('retains licensed draft field packs with simple, disjoint, exclusion-safe rings inside the territory', () => {
  expect(packs).toHaveLength(2);
  const rings = packs.flatMap((pack) => pack.areas.map((a) => a.ring));
  for (const [i, ring] of rings.entries()) {
    const parsed = SimpleRing.safeParse(ring);
    expect(parsed.success, `ring ${i}: ${parsed.error?.message}`).toBe(true);
  }
  const [first, ...rest] = rings.map((ring) => [ring] as Geom);
  const combined = union(first!, ...rest);
  expect(area(combined)).toBeCloseTo(
    rings.reduce((sum, ring) => sum + ringArea(ring), 0),
    10,
  );
  expect(difference(combined, mask.territory.coordinates as Geom)).toEqual([]);
  expect(intersection(combined, mask.excluded.coordinates as Geom)).toEqual([]);
  for (const pack of packs) {
    expect(pack.status).toBe('draft');
    expect(pack.credit).toContain('modified Copernicus Sentinel data 2026');
    const emitted = landcoverFeatures([], [pack]);
    expect(emitted.warnings).toEqual([]);
    expect(emitted.features).toHaveLength(pack.areas.length);
    expect(
      emitted.features.every(
        (f) =>
          f.properties.class === 'farmland' &&
          f.tippecanoe.layer === 'landuse' &&
          f.tippecanoe.minzoom === 12,
      ),
    ).toBe(true);
  }
});
