import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { SiteDetail } from '@atlas/shared';
import { expect, test } from '@playwright/test';
import { cities, drawnShare, mapReady, mapShot, MIN_DRAWN } from './helpers';

test.use({ reducedMotion: 'no-preference' });

for (const city of cities.filter((city) => city.hasMeta)) {
  const directory = new URL(
    `../../../packages/content/cities/${city.slug}/details/`,
    import.meta.url,
  );
  const details = existsSync(directory)
    ? readdirSync(directory)
        .filter((file) => file.endsWith('.json'))
        .map((file) => JSON.parse(readFileSync(new URL(file, directory), 'utf8')) as SiteDetail)
    : [];
  for (const detail of details.filter((detail) => detail.walks.length > 0)) {
    test(`${city.name}: plaza details retain area selection with Life off and on`, async ({
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
      const [lng, lat] = detail.walks[0]!.line[0]!;
      await page.goto(`/${city.slug}?lng=${lng}&lat=${lat}&z=19`);
      await mapReady(page);
      const canvas = page.getByLabel(`Map of ${city.name}`);
      await expect
        .poll(async () => drawnShare(page, await mapShot(canvas)), { timeout: 20_000 })
        .toBeGreaterThan(MIN_DRAWN);
      await expect(page.locator('footer')).toContainText(detail.credit);
      const box = (await canvas.boundingBox())!;
      const position = { x: box.width / 2, y: box.height / 2 };
      const life = page.getByRole('button', { name: 'Life', exact: true });
      await expect(life).toHaveAttribute('aria-pressed', 'false');
      for (const enabled of [false, true]) {
        if (enabled) {
          await life.click();
          await expect(life).toHaveAttribute('aria-pressed', 'true');
        }
        await canvas.hover({ position });
        await expect(canvas).toHaveCSS('cursor', 'pointer');
        await expect(async () => {
          await canvas.click({ position });
          await expect
            .poll(() => new URL(page.url()).searchParams.get('sel'), { timeout: 1500 })
            .toBe(detail.osm_id);
        }).toPass({ timeout: 20_000 });
        await expect(page.getByRole('complementary', { name: 'Selected place' })).toBeVisible();
        await page.keyboard.press('Escape');
      }
      await info.attach('plaza-detail', { body: await mapShot(canvas), contentType: 'image/png' });
      expect(errors).toEqual([]);
    });
  }
}
