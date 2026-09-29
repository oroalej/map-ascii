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
    const toursDir = new URL(`${slug}/tours/`, citiesDir);
    const tours = existsSync(toursDir)
      ? readdirSync(toursDir)
          .filter((file) => file.endsWith('.json'))
          .sort()
          .map((file) => JSON.parse(readFileSync(new URL(file, toursDir), 'utf8')) as TourFile)
      : [];
    return { slug, name: city.name.en, smokeLandmark: city.smoke_landmark, hasMeta, tours };
  });

/** The parts of a city pack's tour file the tests read. */
type TourFile = { id: string; title: { en: string }; steps: { narration: { en: string } }[] };

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

/** A tour's id as the URL has it. */
const tourSlug = (tour: TourFile) => tour.id.replace(/^tour\//, '');

/** Open the tours menu and start a tour. */
async function startTour(page: Page, tour: TourFile) {
  await page.getByRole('button', { name: /^Tours/ }).click();
  await page
    .getByRole('list', { name: 'Tours' })
    .getByRole('button', { name: tour.title.en })
    .click();
  return page.getByRole('region', { name: 'Tour' });
}

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

      test('tilting to 60° draws the skyline', async ({ page }) => {
        const errors: string[] = [];
        page.on('pageerror', (err) => errors.push(err.message));
        await page.goto(`/${city.slug}?z=17&pitch=60&bearing=15`);
        await mapReady(page);
        await expect(page.getByRole('button', { name: /tilt 60°/ })).toBeVisible();
        const canvas = page.getByLabel(`Map of ${city.name}`);
        await expect
          .poll(async () => drawnShare(page, await canvas.screenshot()), { timeout: 20_000 })
          .toBeGreaterThan(MIN_DRAWN);
        expect(errors).toEqual([]);
      });

      for (const tour of city.tours) {
        test.describe(`tour "${tour.title.en}"`, () => {
          const count = tour.steps.length;

          test('plays end to end on its own', async ({ page }) => {
            // Short flights, and a fake clock to skip through each step's dwell.
            await page.emulateMedia({ reducedMotion: 'reduce' });
            await page.clock.install();
            await page.goto(`/${city.slug}`);
            await mapReady(page);
            const card = await startTour(page, tour);
            for (let step = 1; step <= count; step++) {
              await expect(async () => {
                await page.clock.fastForward(1000);
                await expect(card.getByLabel(`Step ${step} of ${count}`)).toBeVisible({
                  timeout: 200,
                });
              }).toPass({ timeout: 30_000 });
              await expect(card).toContainText(tour.steps[step - 1]!.narration.en);
            }
            await expect(async () => {
              await page.clock.fastForward(1000);
              await expect(card).toContainText('End of the tour.', { timeout: 200 });
            }).toPass({ timeout: 30_000 });
          });

          test('steps through with the controls, mirrored in the URL', async ({ page }) => {
            // The URL follows the camera once it settles; short flights keep that quick.
            await page.emulateMedia({ reducedMotion: 'reduce' });
            await page.goto(`/${city.slug}`);
            await mapReady(page);
            const card = await startTour(page, tour);
            await expect.poll(() => query(page).tour).toBe(tourSlug(tour));
            await card.getByRole('button', { name: 'Pause' }).click();
            for (let step = 1; step < count; step++) {
              await card.getByRole('button', { name: 'Next step' }).click();
              await expect(card.getByLabel(`Step ${step + 1} of ${count}`)).toBeVisible();
              await expect(card).toContainText(tour.steps[step]!.narration.en);
              await expect.poll(() => query(page).step).toBe(String(step));
            }
            await card.getByRole('button', { name: 'Next step' }).click();
            await expect(card).toContainText('End of the tour.');
            await card.getByRole('button', { name: 'Exit tour' }).click();
            await expect(card).toHaveCount(0);
            await expect.poll(() => query(page).tour).toBeUndefined();
          });

          test('pauses when the visitor moves the map, and resumes', async ({ page }) => {
            await page.goto(`/${city.slug}`);
            await mapReady(page);
            const card = await startTour(page, tour);
            const canvas = page.getByLabel(`Map of ${city.name}`);
            const box = (await canvas.boundingBox())!;
            const [x, y] = [box.x + box.width / 2, box.y + box.height / 3];
            await page.mouse.move(x, y);
            await page.mouse.down();
            await page.mouse.move(x + 80, y + 40, { steps: 4 });
            await page.mouse.up();
            const resume = page.getByRole('button', { name: 'Resume tour' });
            await expect(resume).toBeVisible();
            await expect(card.getByRole('button', { name: 'Play' })).toBeVisible();
            await resume.click();
            await expect(resume).toHaveCount(0);
            await expect(card.getByRole('button', { name: 'Pause' })).toBeVisible();
          });

          test('a shared URL reopens the tour, paused at its step', async ({ page }) => {
            const step = Math.min(1, count - 1);
            await page.goto(`/${city.slug}?tour=${tourSlug(tour)}&step=${step}`);
            await mapReady(page);
            const card = page.getByRole('region', { name: 'Tour' });
            await expect(card.getByLabel(`Step ${step + 1} of ${count}`)).toBeVisible();
            await expect(page.getByRole('button', { name: 'Resume tour' })).toBeVisible();
            await page.keyboard.press('Escape');
            await expect(card).toHaveCount(0);
          });
        });
      }
    });
  });
}
