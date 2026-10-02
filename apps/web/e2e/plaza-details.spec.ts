import { readFileSync } from 'node:fs';
import type { SiteDetail } from '@atlas/shared';
import { expect, test } from '@playwright/test';
import { detailLayoutKey } from '../../../packages/data/scripts/lib/detail-layout';
import { isCityMeta } from '../lib/guards';
import { cities, drawnShare, mapReady, mapShot, MIN_DRAWN } from './helpers';
const samples = JSON.parse(
  readFileSync(new URL('./fixtures/detail-selection.json', import.meta.url), 'utf8'),
) as Record<string, { slug: string; at: number[] }[]>;

// A narrow viewport keeps the legend collapsed and leaves room above attribution. Enable
// animation only for the Life-on check, after the map has loaded.
test.use({ viewport: { width: 600, height: 800 }, reducedMotion: 'reduce' });

for (const city of cities.filter((city) => city.hasMeta)) {
  const directory = new URL(
    `../../../packages/content/cities/${city.slug}/details/`,
    import.meta.url,
  );
  // Reviewed surfaces cover plazas, campus planting, an apron, an aliased landmark,
  // a school pool, fixed terminal parking, a cemetery memorial and point-anchored
  // college grounds. Fixtures keep smoke coverage bounded as packs are added;
  // geometry rules live in Vitest.
  const cases = samples[city.slug] ?? [];
  for (const sample of cases) {
    const detail = JSON.parse(
      readFileSync(new URL(`${sample.slug}.json`, directory), 'utf8'),
    ) as SiteDetail;
    test(`${city.name}: ${detail.title} details retain area selection with Life off and on`, async ({
      page,
    }, info) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript(() => {
        localStorage.setItem('atlas.quality', JSON.stringify('high'));
        localStorage.setItem(
          'atlas.life',
          JSON.stringify({ enabled: false, time: 'noon', wind: 'calm' }),
        );
      });
      const [lng, lat] = sample.at;
      await page.goto(`/${city.slug}?lng=${lng}&lat=${lat}&z=21`);
      await mapReady(page);
      const canvas = page.getByLabel(`Map of ${city.name}`);
      await expect
        .poll(async () => drawnShare(page, await mapShot(canvas)), { timeout: 20_000 })
        .toBeGreaterThan(MIN_DRAWN);
      const response = await page.request.get(`/tiles/${city.slug}.meta.json`);
      expect(response.ok()).toBe(true);
      const meta: unknown = await response.json();
      if (!isCityMeta(meta)) throw new Error(`${city.slug}: invalid served city meta`);
      // Credits survive layout edits, so also match the exact current geometry/selection.
      const currentLayout = meta.detail_layouts?.[detail.id] === detailLayoutKey(detail);
      if (process.env.ATLAS_REQUIRE_DETAILS === '1') {
        expect(meta.attribution).toContain(detail.credit);
        expect(currentLayout, 'Locally rebuilt tiles must match this detail layout').toBe(true);
      }
      test.skip(
        !meta.attribution.includes(detail.credit) || !currentLayout,
        'Pinned tiles predate this detail layout',
      );
      await expect(page.locator('footer')).toContainText(detail.credit);
      await expect(page.getByRole('link', { name: 'OpenStreetMap contributors' })).toBeVisible();
      const footer = await page.locator('footer').boundingBox();
      expect(footer!.height).toBeLessThan(200);
      const box = (await canvas.boundingBox())!;
      const position = { x: box.width / 2, y: box.height / 2 };
      const life = page.getByRole('button', { name: 'Life', exact: true });
      await expect(life).toHaveAttribute('aria-pressed', 'false');
      for (const enabled of [false, true]) {
        if (enabled) {
          await page.emulateMedia({ reducedMotion: 'no-preference' });
          await life.click();
          await expect(life).toHaveAttribute('aria-pressed', 'true');
        }
        await canvas.hover({ position });
        await expect(canvas).toHaveCSS('cursor', 'pointer');
        await expect(async () => {
          await canvas.click({ position });
          await expect
            .poll(() => new URL(page.url()).searchParams.get('sel'), { timeout: 1500 })
            .toBe(detail.selection_osm_id ?? detail.osm_id);
        }).toPass({ timeout: 20_000 });
        await expect(page.getByRole('complementary', { name: 'Selected place' })).toBeVisible();
        await page.keyboard.press('Escape');
      }
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await info.attach('plaza-detail', { body: await mapShot(canvas), contentType: 'image/png' });
      expect(errors).toEqual([]);
    });
  }
}
