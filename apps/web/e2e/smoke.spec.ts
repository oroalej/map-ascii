import { expect, test } from '@playwright/test';

test('loads a full-screen dark canvas with attribution', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('/');

  await expect(page).toHaveTitle('ASCII Atlas');
  const canvas = page.getByLabel('Map of Naga City');
  await expect(canvas).toBeVisible();

  const box = await canvas.boundingBox();
  const viewport = page.viewportSize();
  expect(box?.width).toBe(viewport?.width);
  expect(box?.height).toBe(viewport?.height);

  const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(background).toBe('rgb(4, 5, 10)');

  await expect(page.getByRole('link', { name: 'OpenStreetMap contributors' })).toBeVisible();
  await expect(page.getByText(/needs WebGL2/)).toHaveCount(0);
  expect(errors).toEqual([]);
});
