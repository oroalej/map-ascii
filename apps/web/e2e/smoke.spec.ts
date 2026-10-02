import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { AtlasProfile } from '@atlas/renderer';
import { cities, drawnShare, mapShot, mapReady, MIN_DRAWN, type TourFile } from './helpers';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('atlas.quality', JSON.stringify('high')));
});

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
          await mapReady(page);
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
        async ({ page, hasTouch }) => {
          const place = city.smokePlace!;
          const view = new URLSearchParams({
            lat: String(place.lat),
            lng: String(place.lng),
            z: String(place.zoomHint),
          });
          await page.goto(`/${city.slug}?${view}`);
          await mapReady(page);
          const canvas = page.getByLabel(`Map of ${city.name}`);
          // Start without a selection: only the actual mouse click or touch tap opens the panel.
          const box = (await canvas.boundingBox())!;
          const position = { x: box.width / 2, y: box.height / 2 };
          const panel = page.getByRole('complementary', { name: 'Selected place' });
          await expect(panel).toHaveCount(0);
          const legend = page
            .locator('details')
            .filter({ has: page.locator('summary', { hasText: 'Legend' }) });
          await expect(legend).toBeVisible();
          // Readouts may cover the landmark on a phone when attribution pushes the HUD up.
          // They must let map gestures through; only HUD controls should intercept input.
          const scaleBox = (await page.getByLabel(/^Scale:/).boundingBox())!;
          expect(
            await canvas.evaluate(
              (map, point) => document.elementFromPoint(point.x, point.y) === map,
              { x: scaleBox.x + scaleBox.width / 2, y: scaleBox.y + scaleBox.height / 2 },
            ),
            'the scale readout lets pointer events reach the map',
          ).toBe(true);
          // Controls in the same HUD remain clickable.
          await page.getByRole('button', { name: 'Coordinates', exact: true }).click();
          await expect(coordsButton(page)).toBeVisible();
          await coordsButton(page).click();
          // Probe the actual pick buffer, including on touch devices, before selecting. A drawn
          // screenshot can precede this landmark's tile and is expensive at phone DPRs.
          await expect(async () => {
            await canvas.hover({ position });
            await expect(canvas).toHaveCSS('cursor', 'pointer', { timeout: 500 });
          }).toPass({ timeout: 20_000 });
          await page.mouse.move(-10, -10);
          await expect(canvas).not.toHaveCSS('cursor', 'pointer');
          // Send one gesture and wait for its asynchronous GPU result. Retrying the gesture can
          // leave a second pick in flight that reopens the panel after Escape.
          if (hasTouch) await canvas.tap({ position });
          else await canvas.click({ position });
          await expect(panel.getByRole('heading', { level: 2 })).toHaveText(city.smokeLandmark, {
            timeout: 20_000,
          });
          await expect.poll(() => query(page).sel).toBe(place.id);
          await expect(legend).toBeHidden();
          await page.keyboard.press('Escape');
          await expect(panel).toHaveCount(0);
          await expect(legend).toBeVisible();
        },
      );

      test(
        'legend focus controls remain usable without covering the header',
        { tag: '@mobile' },
        async ({ page, hasTouch }) => {
          const place = city.smokePlace!;
          const view = new URLSearchParams({
            lat: String(place.lat),
            lng: String(place.lng),
            z: String(place.zoomHint),
          });
          await page.goto(`/${city.slug}?${view}`);
          await mapReady(page);
          const legend = page
            .locator('details')
            .filter({ has: page.locator('summary', { hasText: 'Legend' }) });
          const summary = legend.locator('summary');
          if (!(await legend.evaluate((element) => (element as HTMLDetailsElement).open)))
            await summary.click();
          const focus = legend.getByRole('button', { name: 'Secondary road', exact: true });
          await expect(focus).toBeVisible();
          if (hasTouch) await focus.tap();
          else {
            await focus.focus();
            await page.keyboard.press('Enter');
            await expect(focus).toHaveCSS('outline-style', 'solid');
          }
          const clear = page.getByRole('button', { name: /^Clear legend focus:/ });
          await expect(clear).toBeVisible();
          if (hasTouch) {
            for (const control of [focus, summary, clear])
              expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
            const tours = (await page.getByRole('button', { name: /^Tours/ }).boundingBox())!;
            const zoom = (await page.getByLabel('Zoom').boundingBox())!;
            expect(zoom.x).toBeGreaterThanOrEqual(tours.x + tours.width + 8);
          }
          await summary.click();
          await expect(clear).toBeVisible();
          await clear.click();
          await expect(summary).toBeFocused();
        },
      );

      test('a shared URL reproduces the view', async ({ page, context }) => {
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
        await page.close();
        // Inherit the fixture's rendering settings; only one atlas uses the software GPU.
        const other = await context.newPage();
        try {
          await other.goto(shared);
          await mapReady(other);
          await expect(other.getByLabel('Zoom')).toHaveText(/^z 15\.5 /);
          await other.getByRole('button', { name: 'Coordinates' }).click();
          await expect(coordsButton(other)).toHaveText(coords);
        } finally {
          await other.close();
        }
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

      test('follows the Life toggle and changed motion preference with GPU timing', async ({
        page,
      }) => {
        // Bound animated software-WebGL work while exercising startup and motion toggles.
        await page.setViewportSize({ width: 640, height: 480 });
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await page.goto(`/${city.slug}?debug=1&z=18`);
        await mapReady(page);
        const life = page.getByRole('button', { name: 'Life', exact: true });
        await expect(life).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('pre')).toContainText(/gpu\s+(?:n\/a|\d+\.\d+) ms/);
        // Keyboard activation keeps this motion check independent of profile toolbar layout.
        const agents = async () =>
          Number((await page.locator('pre').textContent())?.match(/agents\s+(\d+)/)?.[1] ?? NaN);
        await expect.poll(agents, { timeout: 20_000 }).toBeGreaterThan(0);
        await life.press('Enter');
        await expect.poll(agents).toBe(0);
        await life.press('Enter');
        await expect.poll(agents, { timeout: 20_000 }).toBeGreaterThan(0);
        const saved = await page.evaluate(() => localStorage.getItem('atlas.life'));
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await expect(life).toBeDisabled();
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await expect(life).toHaveAttribute('aria-pressed', 'true');
        // The preference pauses Life without changing the viewer's saved settings.
        expect(await page.evaluate(() => localStorage.getItem('atlas.life'))).toBe(saved);
        expect(errors).toEqual([]);
      });

      test('captures and downloads a bounded CPU stage profile', async ({ page }) => {
        await page.goto(`/${city.slug}?debug=1&captureMs=1000&z=18`);
        await mapReady(page);
        await page.getByRole('button', { name: /^Capture \d+ seconds$/ }).click();
        const button = page.getByRole('button', { name: 'Download profile', exact: true });
        await expect(button).toBeEnabled({ timeout: 5_000 });
        const downloading = page.waitForEvent('download');
        await button.click();
        const download = await downloading;
        const report = JSON.parse(await readFile(await download.path(), 'utf8')) as {
          version: number;
          start: { city: string; viewport: { dpr: number }; gpuBackend: string | null };
          profile: AtlasProfile;
        };
        expect(report.version).toBe(1);
        expect(report.start.city).toBe(`/${city.slug}`);
        expect(report.start.viewport.dpr).toBeGreaterThan(0);
        expect(report.start).toHaveProperty('gpuBackend');
        expect(report.profile.gpuRenderer).toBe(report.start.gpuBackend);
        expect(report.profile.dropped).toBe(0);
        expect(report.profile.spanMs).toBeGreaterThan(0);
        expect(report.profile.samples.length).toBeGreaterThan(0);
        expect(report.profile.samples.length).toBeLessThanOrEqual(4096);
        expect(report.profile.stages.callback.medianMs).not.toBeNull();
        await page.getByRole('button', { name: 'Reset profile', exact: true }).click();
        await expect(button).toBeDisabled();
      });

      // One tour stands for the player; its controls are unit-tested (state/tour.test.ts).
      const tour = city.tours[0];
      if (tour) {
        test(`tour "${tour.title.en}" plays end to end on its own`, async ({ page }) => {
          const count = tour.steps.length;
          // Keep software WebGL work bounded while exercising every real camera flight.
          await page.setViewportSize({ width: 600, height: 600 });
          await page.emulateMedia({ reducedMotion: 'reduce' });
          await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
          await page.goto(`/${city.slug}`);
          await mapReady(page);
          // Installing a clock alone still lets wall time advance it. Pause before starting so
          // slow rendering cannot move to the next step between the two assertions below.
          await page.clock.pauseAt(new Date('2026-01-01T01:00:00Z'));
          const card = await startTour(page, tour);
          for (let step = 1; step <= count; step++) {
            await expect(card.getByLabel(`Step ${step} of ${count}`)).toBeVisible();
            await expect(card).toContainText(tour.steps[step - 1]!.narration.en);
            // One frame finishes the reduced-motion flight; the next jump completes its dwell.
            // The player itself advances the step, without clicking Next or changing app state.
            await page.clock.fastForward(1000);
            await page.clock.fastForward(tour.steps[step - 1]!.duration_ms);
          }
          await expect(card).toContainText('End of the tour.');
        });
      }
    });
  });
}
