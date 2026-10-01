import { existsSync, readFileSync } from 'node:fs';
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
});

for (const city of cities.filter((entry) => entry.hasMeta)) {
  const path = new URL(
    `../../../packages/content/cities/${city.slug}/dialogue.json`,
    import.meta.url,
  );
  if (!existsSync(path)) continue;
  const catalog = JSON.parse(readFileSync(path, 'utf8')) as DialogueCatalog;
  test(`${city.slug}: speech controls remember display preferences`, async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 480 });
    await page.goto(`/${city.slug}?z=18`);
    await mapReady(page);
    const speech = page.getByRole('button', { name: 'Speech (simulated)', exact: true });
    const translation = page.getByRole('combobox', { name: 'Speech translation' });
    await expect(speech).toHaveAttribute('aria-pressed', 'true');
    await expect(translation).toHaveValue('');
    for (const { code } of catalog.translations) await translation.selectOption(code);
    await speech.click();
    await expect(speech).toHaveAttribute('aria-pressed', 'false');
    const selected = catalog.translations.at(-1)?.code ?? '';
    await expect
      .poll(() =>
        page.evaluate(
          (slug) => JSON.parse(localStorage.getItem(`atlas.speech.${slug}`) ?? '{}') as unknown,
          city.slug,
        ),
      )
      .toEqual({ enabled: false, translation: selected || null });
    await page.reload();
    await mapReady(page);
    await expect(speech).toHaveAttribute('aria-pressed', 'false');
    await expect(translation).toHaveValue(selected);
  });
}
