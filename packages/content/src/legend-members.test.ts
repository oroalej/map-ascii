import { expect, it } from 'vitest';
import type { Landmark, LandmarkPlan, SiteDetail } from '@atlas/shared';

const landmarks = Object.values(
  import.meta.glob('../cities/naga/landmarks/*.json', { eager: true, import: 'default' }),
) as Landmark[];
const plans = Object.values(
  import.meta.glob('../cities/naga/plans/*.json', { eager: true, import: 'default' }),
) as LandmarkPlan[];
const details = Object.values(
  import.meta.glob('../cities/naga/details/*.json', { eager: true, import: 'default' }),
) as SiteDetail[];

// The renderer lights Landmark-focus members through its highlight list (picking.ts MAX_HIGHLIGHT).
const MAX_HIGHLIGHT = 64;

it('keeps every Landmark legend member within the renderer highlight list', () => {
  // The pipeline marks these `notable` (04-merge-content.ts); their parts inherit the flag.
  const notable = new Set(
    landmarks
      .filter((l) => l.facts || l.type === 'heritage' || l.heritage)
      .map((l) => l.osm_id ?? l.id),
  );
  const parts = plans.filter((plan) => notable.has(plan.osm_id)).flatMap((plan) => plan.parts);
  const wings = details
    .flatMap((detail) => detail.structures ?? [])
    .filter((part) => part.roof_osm_id && notable.has(part.roof_osm_id));
  expect(notable.size + parts.length + wings.length).toBeLessThanOrEqual(MAX_HIGHLIGHT);
});
