import { expect, test } from '@playwright/test';
import { cities, drawnShare, mapReady, MIN_DRAWN } from './helpers';

for (const city of cities) {
  test.describe(`${city.name}: access and recovery`, () => {
    test.skip(!city.hasMeta, 'no generated tiles; run pnpm data:build');

    test('the places in view are a keyboard list that selects like a click', async ({ page }) => {
      await page.goto(`/${city.slug}?z=16.5`);
      await mapReady(page);
      // First in the tab order, out of sight until focused.
      await page.keyboard.press('Tab');
      const toggle = page.getByRole('button', { name: /^Places in view \(\d+\)$/ });
      await expect(toggle).toBeFocused();
      await expect(toggle).not.toHaveText('Places in view (0)', { timeout: 20_000 });
      await page.keyboard.press('Enter');
      const list = page.getByRole('navigation', { name: 'Places in view' }).getByRole('list');
      const first = list.getByRole('button').first();
      await expect(first).toBeVisible();
      await first.focus();
      await page.keyboard.press('Enter');
      await expect.poll(() => new URL(page.url()).searchParams.get('sel')).not.toBeNull();
      await expect(page.getByRole('complementary')).toBeVisible();
    });

    test('redraws after the browser takes the WebGL context away', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (err) => errors.push(err.message));
      await page.goto(`/${city.slug}`);
      await mapReady(page);
      const canvas = page.getByLabel(`Map of ${city.name}`);
      // Generous waits: WebGL runs in software here, and the suite runs in parallel.
      const drawn = { timeout: 40_000 };
      await expect
        .poll(async () => drawnShare(page, await canvas.screenshot()), drawn)
        .toBeGreaterThan(MIN_DRAWN);

      await page.evaluate(() => {
        const gl = document.querySelector('canvas')!.getContext('webgl2')!;
        const ext = gl.getExtension('WEBGL_lose_context')!;
        (window as unknown as { loseContext: WEBGL_lose_context }).loseContext = ext;
        ext.loseContext();
      });
      await expect(page.getByText(/Restoring the map/)).toBeVisible();

      await page.evaluate(() =>
        (window as unknown as { loseContext: WEBGL_lose_context }).loseContext.restoreContext(),
      );
      await expect(page.getByText(/Restoring the map/)).toHaveCount(0, drawn);
      await expect
        .poll(async () => drawnShare(page, await canvas.screenshot()), drawn)
        .toBeGreaterThan(MIN_DRAWN);
      expect(errors).toEqual([]);
    });

    test('?debug=1 shows the renderer stats, and share URLs leave it out', async ({ page }) => {
      await page.goto(`/${city.slug}?debug=1`);
      await mapReady(page);
      await expect(page.getByText(/^fps\s+\d+/m)).toBeVisible();
      await page.getByLabel(`Map of ${city.name}`).focus();
      await page.keyboard.press('+');
      await expect.poll(() => new URL(page.url()).searchParams.has('z')).toBe(true);
      expect(new URL(page.url()).searchParams.has('debug')).toBe(false);
      await expect(page.getByText(/^fps\s+\d+/m)).toBeVisible();
    });
  });
}
