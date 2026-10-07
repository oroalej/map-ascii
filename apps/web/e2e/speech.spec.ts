import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { DialogueCatalog } from '@atlas/shared';
import { cities, mapReady } from './helpers';
test.describe('natural emoji', () => {
  // Keep the full high-quality population, with less software-GPU pixel work.
  test.use({ deviceScaleFactor: 0.75 });
  test('naga: natural emoji appears at the central z19 view', async ({ page }) => {
    test.skip(!cities.some((city) => city.slug === 'naga' && city.hasMeta));
    // Bound software-WebGL work while retaining the desktop controls and reported camera.
    await page.setViewportSize({ width: 641, height: 480 });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.addInitScript(() => {
      // Remember a real visible cue from the first render. A short cue can disappear
      // while the test waits for the HUD or sends another software-WebGL poll.
      const seenEmoji = new MutationObserver(() => {
        if (
          [...document.querySelectorAll('[data-emoji-bubble]')].some(
            (bubble) =>
              getComputedStyle(bubble).visibility === 'visible' &&
              bubble.getBoundingClientRect().width > 0 &&
              bubble.getBoundingClientRect().height > 0,
          )
        ) {
          document.documentElement.dataset.e2eEmojiSeen = 'true';
          seenEmoji.disconnect();
        }
      });
      seenEmoji.observe(document, { childList: true, subtree: true, attributes: true });
      localStorage.setItem(
        'atlas.life',
        JSON.stringify({ enabled: true, time: 'noon', wind: 'calm' }),
      );
      localStorage.setItem('atlas.quality', JSON.stringify('high'));
      localStorage.setItem('atlas.emoji.naga', JSON.stringify({ enabled: true }));
      localStorage.setItem(
        'atlas.speech.naga',
        JSON.stringify({ enabled: false, translation: null }),
      );
    });
    await page.goto('/naga?lat=13.623407&lng=123.184867&z=19');
    await mapReady(page);
    // Make room to observe sparse natural cues; obstacle suppression is covered in unit tests.
    await page.getByText('Legend', { exact: true }).press('Enter');
    await expect(page.getByRole('list', { name: 'What the glyphs on screen mean' })).toBeHidden();
    await expect(page.locator('html')).toHaveAttribute('data-e2e-emoji-seen', 'true', {
      timeout: 30_000,
    });
  });
});

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
