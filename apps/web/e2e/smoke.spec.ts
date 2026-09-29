import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/** Every registered city pack (ARCHITECTURE.md §9: the suite covers each one). */
const citiesDir = new URL('../../../packages/content/cities/', import.meta.url);
const cities = readdirSync(citiesDir)
  .filter((slug) => existsSync(new URL(`${slug}/city.json`, citiesDir)))
  .sort()
  .map((slug) => {
    const city = JSON.parse(readFileSync(new URL(`${slug}/city.json`, citiesDir), 'utf8')) as {
      name: { en: string };
      smoke_landmark: string;
    };
    const hasMeta = existsSync(new URL(`../public/tiles/${slug}.meta.json`, import.meta.url));
    return { slug, name: city.name.en, smokeLandmark: city.smoke_landmark, hasMeta };
  });

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

/**
 * Share of the canvas that must be ink once tiles load. Glyph strokes are thin, more so on
 * high-DPR phones (~2% of pixels at the default camera), so this only proves drawing happened.
 */
const MIN_DRAWN = 0.01;

/** Wait until the atlas is live (the HUD shows its zoom), so keyboard input reaches the map. */
async function mapReady(page: Page) {
  await expect(page.getByLabel('Zoom')).toHaveText(/^z \d/, { timeout: 20_000 });
}

/** The view parameters currently in the address bar. */
const query = (page: Page) => Object.fromEntries(new URL(page.url()).searchParams);

test('/ opens the only city, keeping the view parameters', async ({ page }) => {
  test.skip(cities.length !== 1, 'with several cities, / is a city picker');
  await page.goto('/?z=15');
  await page.waitForURL(`**/${cities[0]!.slug}?z=15*`);
});

for (const city of cities) {
  test.describe(city.name, () => {
    test('loads a full-screen dark canvas with attribution', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (err) => errors.push(err.message));

      await page.goto(`/${city.slug}`);

      await expect(page).toHaveTitle(`${city.name} · ASCII Atlas`);
      const canvas = page.getByLabel(`Map of ${city.name}`);
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
      await expect(page.getByText(/No map data for/)).toHaveCount(city.hasMeta ? 0 : 1);
      await expect(page.getByText(/map data .* is invalid/)).toHaveCount(0);
      expect(errors).toEqual([]);
    });

    test.describe('with map data', () => {
      test.skip(!city.hasMeta, 'no generated tiles; run pnpm data:build');

      test('draws the city as ASCII once its tiles load', async ({ page }) => {
        const errors: string[] = [];
        page.on('pageerror', (err) => errors.push(err.message));

        await page.goto(`/${city.slug}`);
        const canvas = page.getByLabel(`Map of ${city.name}`);
        await expect(canvas).toBeVisible();
        // The default camera shows the city's focus at street level, so glyphs cover a good
        // share of the screen once tiles arrive.
        await expect
          .poll(async () => drawnShare(page, await canvas.screenshot()), { timeout: 20_000 })
          .toBeGreaterThan(MIN_DRAWN);
        expect(errors).toEqual([]);
      });

      test(`search finds "${city.smokeLandmark}", flies there, and opens the panel`, async ({
        page,
      }) => {
        await page.goto(`/${city.slug}?z=15`);
        await mapReady(page);
        await page.locator('body').press('/');
        const box = page.getByRole('combobox', { name: 'Search places' });
        await expect(box).toBeFocused();
        await box.fill(city.smokeLandmark);
        await expect(page.getByRole('option').first()).toContainText(city.smokeLandmark);
        await box.press('Enter');
        const panel = page.getByRole('complementary', { name: 'Selected place' });
        await expect(panel.getByRole('heading', { level: 2 })).toHaveText(city.smokeLandmark);
        await expect.poll(() => query(page).sel).toBeTruthy();
        // The flight ends at the place, close in.
        await expect.poll(() => Number(query(page).z), { timeout: 10_000 }).toBeGreaterThan(16);
      });

      test('a click or tap on a place opens the panel, and Esc closes it', async ({ page }) => {
        await page.goto(`/${city.slug}`);
        const canvas = page.getByLabel(`Map of ${city.name}`);
        await expect
          .poll(async () => drawnShare(page, await canvas.screenshot()), { timeout: 20_000 })
          .toBeGreaterThan(MIN_DRAWN);
        // The default camera centers on the city's focus feature. Its tile may still be on the
        // way when drawing starts, so click again until the panel opens.
        const box = (await canvas.boundingBox())!;
        const panel = page.getByRole('complementary', { name: 'Selected place' });
        await expect(async () => {
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          await expect(panel).toBeVisible({ timeout: 1_500 });
        }).toPass({ timeout: 20_000 });
        await expect.poll(() => query(page).sel).toBeTruthy();
        await page.keyboard.press('Escape');
        await expect(panel).toHaveCount(0);
      });

      test('the HUD tracks the camera and lists what is on screen', async ({ page }) => {
        await page.goto(`/${city.slug}?z=15`);
        const zoom = page.getByLabel('Zoom');
        await expect(zoom).toHaveText(/^z 15\.0 · District$/);
        await page.getByLabel(`Map of ${city.name}`).focus();
        await page.keyboard.press('+');
        await expect(zoom).toHaveText(/^z 16\.0 · Street$/);
        // Open on desktop, collapsed on phones; either way it lists what the map shows.
        const legend = page.getByRole('list', {
          name: 'What the glyphs on screen mean',
          includeHidden: true,
        });
        await expect(legend.getByText('Building', { exact: true })).toBeAttached();
      });

      test('a shared URL reproduces the view', async ({ page, browser }) => {
        await page.goto(`/${city.slug}?z=15.5`);
        await mapReady(page);
        const canvas = page.getByLabel(`Map of ${city.name}`);
        await canvas.focus();
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowUp');
        await page.getByRole('button', { name: 'Coordinates' }).click();
        const coords = (await page.getByRole('button', { pressed: true }).textContent())!;
        // The URL follows the camera after a short debounce: wait until it shows this view.
        const [lat, lng] = coords.split(', ').map(Number) as [number, number];
        await expect
          .poll(() => {
            const q = query(page);
            return (
              q.z === '15.5' &&
              Math.abs(Number(q.lat) - lat) < 1e-5 &&
              Math.abs(Number(q.lng) - lng) < 1e-5
            );
          })
          .toBe(true);
        const shared = page.url();

        const other = await browser.newPage();
        await other.goto(shared);
        await expect(other.getByLabel('Zoom')).toHaveText(/^z 15\.5 /);
        await other.getByRole('button', { name: 'Coordinates' }).click();
        await expect(other.getByRole('button', { pressed: true })).toHaveText(coords);
        await other.close();
      });

      test('mirrors the camera in the URL', async ({ page }) => {
        await page.goto(`/${city.slug}?z=15`);
        await mapReady(page);
        const canvas = page.getByLabel(`Map of ${city.name}`);
        await canvas.focus();
        await page.keyboard.press('+');
        await expect.poll(() => query(page).z).toBe('16');
        expect(query(page)).toHaveProperty('lat');
        expect(query(page)).toHaveProperty('lng');
      });
    });
  });
}
