import { expect, test, type Page } from '@playwright/test';
import { cities, mapReady } from './helpers';

/** The life layer's agent count, from the debug overlay (`?debug=1`). */
const agents = async (page: Page) => {
  const text = (await page.locator('pre').filter({ hasText: 'agents' }).textContent()) ?? '';
  return Number(/agents\s+(\d+)/.exec(text)?.[1] ?? NaN);
};

for (const city of cities) {
  test.describe(`${city.name}: life layer`, () => {
    test.skip(!city.hasMeta, 'no generated tiles; run pnpm data:build');

    test('shows simulated agents up close, and turns off and stays off', async ({ page }) => {
      await page.goto(`/${city.slug}?z=17.5&debug=1`);
      await mapReady(page);
      await expect.poll(() => agents(page), { timeout: 20_000 }).toBeGreaterThan(0);
      // In the legend (collapsed on phones).
      await expect(page.getByText('People (simulated)')).toHaveCount(1);

      const life = page.getByRole('button', { name: 'Life' });
      await expect(life).toHaveAttribute('aria-pressed', 'true');
      await life.click();
      await expect(life).toHaveAttribute('aria-pressed', 'false');
      await expect.poll(() => agents(page)).toBe(0);
      await expect(page.getByText('People (simulated)')).toHaveCount(0);

      // A viewer preference: remembered across a reload.
      await page.reload();
      await mapReady(page);
      await expect(page.getByRole('button', { name: 'Life' })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
    });

    test('cycles the time of day and remembers it', async ({ page }) => {
      await page.goto(`/${city.slug}?z=16`);
      await mapReady(page);
      const time = page.getByRole('button', { name: /^Time:/ });
      // e2e runs are pinned to noon (playwright.config.ts).
      await expect(time).toHaveText('Time: 12:00');
      await time.click();
      await expect(time).toHaveText('Time: 18:00');
      await time.click();
      await expect(time).toHaveText('Time: 22:00');
      await page.reload();
      await mapReady(page);
      await expect(page.getByRole('button', { name: /^Time:/ })).toHaveText('Time: 22:00');
    });

    test('moves a time of day saved as daylight to an hour', async ({ page }) => {
      await page.addInitScript(() => {
        window.localStorage.setItem('atlas.life', '{"enabled":true,"time":"day"}');
      });
      await page.goto(`/${city.slug}?z=16`);
      await mapReady(page);
      await expect(page.getByRole('button', { name: /^Time:/ })).toHaveText('Time: 12:00');
    });

    for (const procession of city.processions) {
      test(`plays the ${procession.title.en}`, async ({ page }) => {
        await page.goto(`/${city.slug}?z=16&debug=1`);
        await mapReady(page);
        const play = page.getByRole('button', { name: `▶ ${procession.title.en}` });
        await play.click();
        const caption = page.getByRole('status').filter({ hasText: '(simulated)' });
        await expect(caption).toContainText(procession.title.en);
        // Its boats and crowds are drawn.
        await expect.poll(() => agents(page), { timeout: 20_000 }).toBeGreaterThan(0);
        await page.getByRole('button', { name: 'Stop' }).click();
        await expect(caption).toHaveCount(0);
      });
    }

    test('keeps the map still with reduced motion', async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(`/${city.slug}?z=17.5&debug=1`);
      await mapReady(page);
      await expect(page.getByRole('button', { name: 'Life' })).toBeDisabled();
      // Let tiles arrive, then check no agent was ever drawn.
      await expect(page.locator('pre').filter({ hasText: 'agents' })).toBeVisible({
        timeout: 20_000,
      });
      await page.waitForTimeout(2000);
      expect(await agents(page)).toBe(0);
      await expect(page.getByText('People (simulated)')).toHaveCount(0);
    });
  });
}
