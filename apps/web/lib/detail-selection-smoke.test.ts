// @vitest-environment node
import type { SiteDetail } from '@atlas/shared';
import { describe, expect, it } from 'vitest';
import samples from '../e2e/fixtures/detail-selection.json';

const details = import.meta.glob('../../../packages/content/cities/*/details/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, SiteDetail>;

describe('detail selection smoke budget', () => {
  for (const [city, cases] of Object.entries(samples)) {
    it(`${city} uses at most two valid surfaces covering direct and aliased selection`, () => {
      expect(cases.length).toBeGreaterThan(0);
      expect(cases.length).toBeLessThanOrEqual(2);
      const selectionKinds = new Set<boolean>();
      for (const sample of cases) {
        const detail =
          details[`../../../packages/content/cities/${city}/details/${sample.slug}.json`];
        expect(detail, sample.slug).toBeDefined();
        expect(sample.at).toHaveLength(2);
        expect(sample.at.every(Number.isFinite)).toBe(true);
        selectionKinds.add(detail!.selection_osm_id !== undefined);
      }
      expect(selectionKinds).toEqual(new Set([false, true]));
    });
  }
});
