import { expect, test, type Page } from '@playwright/test';
import { cities, drawnShare, mapShot, mapReady, MIN_DRAWN, type TourFile } from './helpers';

/** The view parameters currently in the address bar. */
const query = (page: Page) => Object.fromEntries(new URL(page.url()).searchParams);

/** The Coordinates button once pressed: it shows "lat, lng". */
const coordsButton = (page: Page) =>
  page.getByRole('button', { pressed: true, name: /^-?\d+\.\d+, -?\d+\.\d+$/ });

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
    test(
      'loads a full-screen dark canvas with attribution and draws the city',
      { tag: '@mobile' },
      async ({ page }) => {
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

        const background = await page.evaluate(
          () => getComputedStyle(document.body).backgroundColor,
        );
        expect(background).toBe('rgb(4, 5, 10)');

        await expect(page.getByRole('link', { name: 'OpenStreetMap contributors' })).toBeVisible();
        await expect(page.getByText(/needs WebGL2/)).toHaveCount(0);
        // Without generated tiles (e.g. in CI) the app explains how to build them instead of failing.
        await expect(page.getByText(/No map data for/)).toHaveCount(city.hasMeta ? 0 : 1);
        await expect(page.getByText(/map data .* is invalid/)).toHaveCount(0);
        if (city.hasMeta) {
          // The default camera shows the city's focus at street level, so glyphs cover a good
          // share of the screen once tiles arrive.
          await expect
            .poll(async () => drawnShare(page, await mapShot(canvas)), { timeout: 20_000 })
            .toBeGreaterThan(MIN_DRAWN);
        }
        expect(errors).toEqual([]);
      },
    );

    test.describe('with map data', () => {
      test.skip(!city.hasMeta, 'no generated tiles; run pnpm data:build');

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

      test(
        'a click or tap on a place opens the panel, and Esc closes it',
        { tag: '@mobile' },
        async ({ page }) => {
          await page.goto(`/${city.slug}`);
          const canvas = page.getByLabel(`Map of ${city.name}`);
          await expect
            .poll(async () => drawnShare(page, await mapShot(canvas)), { timeout: 20_000 })
            .toBeGreaterThan(MIN_DRAWN);
          // The default camera centers on the city's focus landmark. Only the landmark's own cells
          // respond to the pointer, and grass, trees, or paths drawn over it cover most of a
          // plaza: hover outward from the center until the landmark's tooltip shows, then click
          // there. Its tile may still be on the way when drawing starts, so search again until
          // the panel opens.
          const box = (await canvas.boundingBox())!;
          const [cx, cy] = [box.x + box.width / 2, box.y + box.height / 2];
          const steps = Array.from({ length: 9 }, (_, i) => (i - 4) * 4);
          const offsets = steps
            .flatMap((dx) => steps.map((dy) => [dx, dy] as const))
            .sort(([ax, ay], [bx, by]) => Math.hypot(ax, ay) - Math.hypot(bx, by));
          const tooltip = page.getByRole('tooltip');
          const panel = page.getByRole('complementary', { name: 'Selected place' });
          await expect(async () => {
            for (const [dx, dy] of offsets) {
              await page.mouse.move(cx + dx, cy + dy);
              // Hover answers a frame or more late (WebGL runs in software here): let it settle
              // for this point, and make sure it stays up.
              await page.waitForTimeout(250);
              if (!(await tooltip.isVisible())) continue;
              await page.waitForTimeout(250);
              if (!(await tooltip.isVisible())) continue;
              await page.mouse.click(cx + dx, cy + dy);
              break;
            }
            await expect(panel).toBeVisible({ timeout: 1_500 });
          }).toPass({ timeout: 30_000 });
          await expect.poll(() => query(page).sel).toBeTruthy();
          await page.keyboard.press('Escape');
          await expect(panel).toHaveCount(0);
        },
      );

      test('a shared URL reproduces the view', async ({ page, browser }) => {
        await page.goto(`/${city.slug}?z=15.5`);
        await mapReady(page);
        const canvas = page.getByLabel(`Map of ${city.name}`);
        await canvas.focus();
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowUp');
        await page.getByRole('button', { name: 'Coordinates' }).click();
        const coords = (await coordsButton(page).textContent())!;
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
        await expect(coordsButton(other)).toHaveText(coords);
        await other.close();
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
          .poll(async () => drawnShare(page, await mapShot(canvas)), drawn)
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
          .poll(async () => drawnShare(page, await mapShot(canvas)), drawn)
          .toBeGreaterThan(MIN_DRAWN);
        expect(errors).toEqual([]);
      });

      // One tour stands for the player; its controls are unit-tested (state/tour.test.ts).
      const tour = city.tours[0];
      if (tour) {
        test(`tour "${tour.title.en}" plays end to end on its own`, async ({ page }) => {
          const count = tour.steps.length;
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
      }
    });
  });
}
