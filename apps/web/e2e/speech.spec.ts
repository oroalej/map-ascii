import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { DialogueCatalog } from '@atlas/shared';
import { cities, mapReady } from './helpers';

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
