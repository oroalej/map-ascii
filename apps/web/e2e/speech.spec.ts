import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { DialogueCatalog } from '@atlas/shared';
import { cities, mapReady } from './helpers';

test('naga: natural moment speech appears at the reported monument view', async ({ page }) => {
  test.skip(!cities.some((city) => city.slug === 'naga' && city.hasMeta));
  const catalog = JSON.parse(
    readFileSync(
      new URL('../../../packages/content/cities/naga/dialogue.json', import.meta.url),
      'utf8',
    ),
  ) as DialogueCatalog;
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.addInitScript(() => {
    localStorage.setItem(
      'atlas.life',
      JSON.stringify({ enabled: true, time: 'noon', wind: 'calm' }),
    );
    localStorage.setItem('atlas.quality', JSON.stringify('high'));
  });
  // The reported camera is deliberately fixed: relocating to a discovered speaker hid this bug.
  await page.goto('/naga?lat=13.623407&lng=123.184867&z=21');
  await mapReady(page);
  const bubbles = page.locator('[data-speech-bubble]:visible');
  const native = bubbles.first().locator(`[lang="${catalog.native.code}"]`);
  await expect(native).toBeVisible({ timeout: 30_000 });
  const text = await native.textContent();
  const line = catalog.exchanges
    .flatMap((exchange) => exchange.lines)
    .find((entry) => entry[catalog.native.code] === text);
  expect(line).toBeDefined();
  const translation = page.getByRole('combobox', { name: 'Speech translation' });
  for (const code of ['en', 'fil']) {
    await translation.selectOption(code);
    await expect(bubbles.first().locator('[lang]')).toHaveText([text!, line![code]!]);
  }
  await page.getByRole('button', { name: 'Speech (simulated)', exact: true }).click();
  await expect(page.locator('[data-speech-bubble]')).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(localStorage.getItem('atlas.speech.naga') ?? '{}') as unknown),
    )
    .toEqual({ enabled: false, translation: 'fil' });
  await page.reload();
  await mapReady(page);
  await expect(
    page.getByRole('button', { name: 'Speech (simulated)', exact: true }),
  ).toHaveAttribute('aria-pressed', 'false');
  await expect(translation).toHaveValue('fil');
  await expect(page.locator('[data-speech-bubble]')).toHaveCount(0);
});
