import { readFileSync } from 'node:fs';
import { DetailLayouts, normalizeCredits, type SiteDetail } from '@atlas/shared';
import { expect, test } from '@playwright/test';
import { detailLayoutKey } from '@atlas/shared/detail-layout';
import { isCityMeta } from '../lib/guards';
import { cities, mapReady } from './helpers';
import { additionalCredits } from '../lib/attribution';
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
  // At most two surfaces per city exercise direct and aliased selection. A unit
  // check caps this fixture; geometry and cold-load selection belong in Vitest.
  const cases = samples[city.slug] ?? [];
  for (const sample of cases) {
    const detail = JSON.parse(
      readFileSync(new URL(`${sample.slug}.json`, directory), 'utf8'),
    ) as SiteDetail;
    test(`${city.name}: ${detail.title} details retain area selection with Life off and on`, async ({
      page,
    }) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript(() => {
        // Software WebGL needs selection coverage, not animated high-quality effects.
        localStorage.setItem('atlas.quality', JSON.stringify('low'));
        localStorage.setItem(
          'atlas.life',
          JSON.stringify({ enabled: false, time: 'noon', wind: 'calm' }),
        );
      });
      const [lng, lat] = sample.at;
      await page.goto(`/${city.slug}?lng=${lng}&lat=${lat}&z=21`);
      await mapReady(page);
      const canvas = page.getByLabel(`Map of ${city.name}`);
      const response = await page.request.get(`/tiles/${city.slug}.meta.json`);
      expect(response.ok()).toBe(true);
      const meta: unknown = await response.json();
      if (!isCityMeta(meta)) throw new Error(`${city.slug}: invalid served city meta`);
      // Credits survive layout edits, so also match the exact current geometry/selection.
      const layoutResponse = await page.request.get(`/tiles/${city.slug}.detail-layouts.json`);
      const layouts = layoutResponse.ok() ? DetailLayouts.parse(await layoutResponse.json()) : {};
      const currentLayout = layouts[detail.id] === detailLayoutKey(detail);
      const expectedCredits = normalizeCredits([detail.credit]);
      const servedCredits = normalizeCredits(meta.attribution);
      const hasCredit = expectedCredits.every((credit) => servedCredits.includes(credit));
      if (process.env.ATLAS_REQUIRE_DETAILS === '1') {
        expect(servedCredits).toEqual(expect.arrayContaining(expectedCredits));
        expect(layoutResponse.ok(), 'Tiles must include detail-layout fingerprints').toBe(true);
        expect(currentLayout, 'Served tiles must match this detail layout').toBe(true);
      }
      test.skip(!hasCredit || !currentLayout, 'Pinned tiles predate this detail layout');
      for (const credit of additionalCredits([detail.credit]))
        await expect(page.locator('footer')).toContainText(credit);
      await expect(page.getByRole('link', { name: 'OpenStreetMap contributors' })).toBeVisible();
      const footer = await page.locator('footer').boundingBox();
      expect(footer!.height).toBeLessThan(200);
      const box = (await canvas.boundingBox())!;
      const position = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      const life = page.getByRole('button', { name: 'Life', exact: true });
      const lifeBox = (await life.boundingBox({ timeout: 5000 }))!;
      const panel = page.getByRole('complementary', { name: 'Selected place' });
      const selectedId = detail.selection_osm_id ?? detail.osm_id;
      await expect(life).toHaveAttribute('aria-pressed', 'false');
      for (const enabled of [false, true]) {
        if (enabled) {
          await page.emulateMedia({ reducedMotion: 'no-preference' });
          await expect(life).toBeEnabled();
          await page.mouse.click(lifeBox.x + lifeBox.width / 2, lifeBox.y + lifeBox.height / 2);
          await expect(life).toHaveAttribute('aria-pressed', 'true');
        }
        let attempt = 0;
        await expect(async () => {
          // Reissue pointer input as tiles arrive; reduced motion does not continuously pick.
          // The viewport is fixed; direct pointer input avoids waiting for animation frames
          // in locator actionability checks on an otherwise stationary canvas.
          await page.mouse.move(position.x + (attempt++ % 2), position.y);
          await expect(canvas).toHaveCSS('cursor', 'pointer', { timeout: 500 });
        }).toPass({ timeout: 5000 });
        await page.mouse.move(-10, -10);
        await expect(canvas).not.toHaveCSS('cursor', 'pointer');
        // One click, awaited separately, leaves no retry click to reopen the panel after Escape.
        await page.mouse.click(position.x, position.y);
        await expect
          .poll(() => new URL(page.url()).searchParams.get('sel'), { timeout: 5000 })
          .toBe(selectedId);
        await expect(panel).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(panel).toBeHidden();
        await expect.poll(() => new URL(page.url()).searchParams.get('sel')).toBeNull();
      }
      await page.emulateMedia({ reducedMotion: 'reduce' });
      expect(errors).toEqual([]);
    });
  }
}
