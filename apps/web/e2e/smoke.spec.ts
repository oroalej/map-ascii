import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

// The first registered city, read from its pack (Phase 2 adds a route per city).
const citiesDir = new URL('../../../packages/content/cities/', import.meta.url);
const slug = readdirSync(citiesDir).sort()[0]!;
const city = JSON.parse(readFileSync(new URL(`${slug}/city.json`, citiesDir), 'utf8')) as {
  name: { en: string };
};
const hasMeta = existsSync(new URL(`../public/tiles/${slug}.meta.json`, import.meta.url));

/**
 * Share of pixels in a PNG screenshot that differ from the page background. The PNG is decoded
 * in the page, which avoids an image dependency here.
 */
async function drawnShare(page: Page, png: Buffer): Promise<number> {
  return page.evaluate(
    async (src) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      const ctx = Object.assign(document.createElement('canvas'), {
        width: image.width,
        height: image.height,
      }).getContext('2d')!;
      ctx.drawImage(image, 0, 0);
      const { data } = ctx.getImageData(0, 0, image.width, image.height);
      let drawn = 0;
      for (let i = 0; i < data.length; i += 4) {
        const [r, g, b] = [data[i]!, data[i + 1]!, data[i + 2]!];
        if (Math.abs(r - 4) + Math.abs(g - 5) + Math.abs(b - 10) > 24) drawn++;
      }
      return drawn / (data.length / 4);
    },
    `data:image/png;base64,${png.toString('base64')}`,
  );
}

test('loads a full-screen dark canvas with attribution', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('/');

  await expect(page).toHaveTitle('ASCII Atlas');
  const canvas = page.getByLabel(`Map of ${city.name.en}`);
  await expect(canvas).toBeVisible();

  const box = await canvas.boundingBox();
  const viewport = page.viewportSize();
  expect(box?.width).toBe(viewport?.width);
  expect(box?.height).toBe(viewport?.height);

  const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(background).toBe('rgb(4, 5, 10)');

  await expect(page.getByRole('link', { name: 'OpenStreetMap contributors' })).toBeVisible();
  await expect(page.getByText(/needs WebGL2/)).toHaveCount(0);
  // Without generated tiles (e.g. in CI) the app explains how to build them instead of failing.
  await expect(page.getByText(/No map data for/)).toHaveCount(hasMeta ? 0 : 1);
  await expect(page.getByText(/map data .* is invalid/)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('draws the city as ASCII once its tiles load', async ({ page }) => {
  test.skip(!hasMeta, 'no generated tiles; run pnpm data:build');
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('/');
  const canvas = page.getByLabel(`Map of ${city.name.en}`);
  await expect(canvas).toBeVisible();
  // The default camera shows the city's focus at street level, so glyphs cover a good share
  // of the screen once tiles arrive.
  await expect
    .poll(async () => drawnShare(page, await canvas.screenshot()), { timeout: 20_000 })
    .toBeGreaterThan(0.02);
  expect(errors).toEqual([]);
});
