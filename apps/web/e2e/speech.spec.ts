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
    localStorage.setItem('atlas.speech.naga', JSON.stringify({ enabled: true, translation: 'en' }));
  });
  // The reported camera is deliberately fixed: relocating to a discovered speaker hid this bug.
  await page.goto('/naga?lat=13.623407&lng=123.184867&z=21');
  await mapReady(page);
  const bubbles = page.locator('[data-speech-bubble]:visible');
  // Capture a real scene's native/translated pair atomically before it naturally expires.
  await expect
    .poll(
      () =>
        bubbles.evaluateAll(
          (elements, { nativeCode, lines }) =>
            elements.some((element) => {
              const nativeText = element.querySelector(`[lang="${nativeCode}"]`)?.textContent;
              const translatedText = element.querySelector('[lang="en"]')?.textContent;
              return lines.some(
                (entry) => entry[nativeCode] === nativeText && entry.en === translatedText,
              );
            }),
          { nativeCode: catalog.native.code, lines: catalog.exchanges.flatMap((e) => e.lines) },
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
  // Toggle/reply/EN-FIL behavior is covered in components/SpeechBubbles.test.tsx;
  // per-city preference loading is covered in state/speech.test.ts.
});
