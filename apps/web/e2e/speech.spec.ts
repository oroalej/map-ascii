import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { DialogueCatalog } from '@atlas/shared';
import type { VisibleAgent } from '../../../packages/renderer/src/life/simulate';
import { cities, mapReady } from './helpers';

test('speech bubbles keep Bikol and switch English/Tagalog translations and conversation replies', async ({
  page,
}) => {
  const city = cities.find((entry) => entry.slug === 'naga' && entry.hasMeta)!;
  const catalog = JSON.parse(
    readFileSync(
      new URL('../../../packages/content/cities/naga/dialogue.json', import.meta.url),
      'utf8',
    ),
  ) as DialogueCatalog;
  const meta = JSON.parse(
    readFileSync(new URL('../public/tiles/naga.meta.json', import.meta.url), 'utf8'),
  ) as { defaultCamera: { lng: number; lat: number } };
  await page.setViewportSize({ width: 800, height: 560 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  // Hold real actors after admission and script the cue clock so UI assertions do not race
  // movement. Real tiles, packing, GPU visibility and controls stay live; unit tests prove timing.
  await page.addInitScript(() => {
    const scope = window as unknown as { speechFixture: { exchangeId: string; line: number } };
    scope.speechFixture = { exchangeId: 'greet-afternoon', line: 0 };
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      private wrapped = new Map<EventListenerOrEventListenerObject, EventListener>();
      private frames = 0;
      override postMessage(
        message: unknown,
        transfer: Transferable[] | StructuredSerializeOptions = [],
      ) {
        const payload = message as {
          path?: string[];
          argumentList?: { value?: { step?: { dt: number } } }[];
        };
        if (payload.path?.[0] === 'frame' && ++this.frames > 6) {
          const step = payload.argumentList?.[0]?.value?.step;
          if (step) step.dt = 0;
        }
        if (Array.isArray(transfer)) super.postMessage(message, transfer);
        else super.postMessage(message, transfer);
      }
      override addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions,
      ) {
        if (!listener) return;
        if (type !== 'message') return super.addEventListener(type, listener, options);
        const wrapped: EventListener = (event) => {
          const data = (event as MessageEvent).data as { value?: { agents?: VisibleAgent[] } };
          data.value?.agents?.forEach((agent, i) => {
            if (
              agent.kind === 'person' &&
              !agent.vehicle &&
              !agent.aboard &&
              !agent.prop &&
              agent.people?.length === 1
            )
              agent.speech = { id: `smoke-speaker-${i}`, ...scope.speechFixture };
          });
          if (typeof listener === 'function') listener.call(this, event);
          else listener.handleEvent(event);
        };
        this.wrapped.set(listener, wrapped);
        super.addEventListener(type, wrapped, options);
      }
      override removeEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | EventListenerOptions,
      ) {
        if (!listener) return;
        super.removeEventListener(type, this.wrapped.get(listener) ?? listener, options);
        this.wrapped.delete(listener);
      }
    };
  });
  await page.goto(
    `/${city.slug}?lng=${meta.defaultCamera.lng}&lat=${meta.defaultCamera.lat}&z=19.5`,
  );
  await mapReady(page);
  await page.locator('summary').filter({ hasText: 'Legend' }).click();
  const bubbles = page.locator('[data-speech-bubble]:visible');
  const native = bubbles.locator(`[lang="${catalog.native.code}"]`).first();
  await expect(native).toHaveText('Marhay na hapon!', { timeout: 30_000 });
  const selector = page.getByRole('combobox', { name: 'Speech translation' });
  await selector.selectOption('en');
  await expect(bubbles.locator('[lang="en"]').first()).toHaveText('Good afternoon!');
  await expect(native).toHaveText('Marhay na hapon!');
  await selector.selectOption('fil');
  await expect(bubbles.locator('[lang="fil"]').first()).toHaveText('Magandang hapon!');
  await page.evaluate(() => {
    (window as unknown as { speechFixture: object }).speechFixture = {
      exchangeId: 'talk-how-are-you',
      line: 0,
    };
  });
  await expect(native).toHaveText('Kumusta ka?');
  await page.evaluate(() => {
    (window as unknown as { speechFixture: object }).speechFixture = {
      exchangeId: 'talk-how-are-you',
      line: 1,
    };
  });
  await expect(native).toHaveText('Marhay man, salamat.');
  await expect(bubbles.locator('[lang="fil"]').first()).toHaveText('Mabuti naman, salamat.');
  await page.getByRole('button', { name: 'Speech', exact: true }).click();
  await expect(bubbles).toHaveCount(0);
  await page.getByRole('button', { name: 'Speech', exact: true }).click();
  await expect(native).toHaveText('Marhay man, salamat.');
  await page.reload();
  await mapReady(page);
  await page.locator('summary').filter({ hasText: 'Legend' }).click();
  await expect(selector).toHaveValue('fil');
  await expect(bubbles.locator('[lang="fil"]').first()).toHaveText('Magandang hapon!', {
    timeout: 20_000,
  });
  await page.getByRole('button', { name: 'Life', exact: true }).click();
  await expect(bubbles).toHaveCount(0);
});
