import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { DialogueCatalog } from '@atlas/shared';
import type { VisibleAgent } from '../../../packages/renderer/src/life/simulate';
import { cities, mapReady } from './helpers';

test('speech bubbles keep Bikol and switch English/Tagalog translations and conversation replies', async ({
  page,
}, testInfo) => {
  const city = cities.find((entry) => entry.slug === 'naga' && entry.hasMeta)!;
  const catalog = JSON.parse(
    readFileSync(
      new URL('../../../packages/content/cities/naga/dialogue.json', import.meta.url),
      'utf8',
    ),
  ) as DialogueCatalog;
  const search = JSON.parse(
    readFileSync(new URL('../public/tiles/naga.search-index.json', import.meta.url), 'utf8'),
  ) as { entries: { name: string; lng: number; lat: number }[] };
  const center = search.entries.find((entry) => entry.name === 'Plaza Rizal')!;
  await page.setViewportSize({ width: 640, height: 640 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  // Hold real actors after admission and script the cue clock so UI assertions do not race
  // movement. Real tiles, packing, GPU visibility and controls stay live; unit tests prove timing.
  await page.addInitScript(() => {
    localStorage.setItem(
      'atlas.life',
      JSON.stringify({ enabled: true, time: 'noon', wind: 'calm' }),
    );
    localStorage.setItem('atlas.quality', JSON.stringify('high'));
    const scope = window as unknown as {
      speechFixture: { exchangeId: string; line: number };
      holdSpeakers: boolean;
      speechDiagnostics: {
        frames: number;
        eligible: number;
        maxEligible: number;
        fences: number;
        completed: number;
        maxLatency: number;
      };
    };
    scope.speechFixture = { exchangeId: 'greet-afternoon', line: 0 };
    scope.holdSpeakers = false;
    const diagnostics = (scope.speechDiagnostics = {
      frames: 0,
      eligible: 0,
      maxEligible: 0,
      fences: 0,
      completed: 0,
      maxLatency: 0,
    });
    // Test-only latency counters explain software-GPU failures without changing renderer APIs.
    const starts = new WeakMap<WebGLSync, number>();
    const glPrototype = WebGL2RenderingContext.prototype;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- invoke with the original GL receiver below
    const fenceSync = glPrototype.fenceSync;
    glPrototype.fenceSync = function (condition, flags) {
      const sync = fenceSync.call(this, condition, flags);
      if (sync) {
        starts.set(sync, performance.now());
        diagnostics.fences++;
      }
      return sync;
    };
    // eslint-disable-next-line @typescript-eslint/unbound-method -- invoke with the original GL receiver below
    const getSyncParameter = glPrototype.getSyncParameter;
    glPrototype.getSyncParameter = function (sync, pname) {
      const result: unknown = getSyncParameter.call(this, sync, pname);
      const started = starts.get(sync);
      if (pname === this.SYNC_STATUS && result === this.SIGNALED && started !== undefined) {
        diagnostics.completed++;
        diagnostics.maxLatency = Math.max(diagnostics.maxLatency, performance.now() - started);
        starts.delete(sync);
      }
      return result;
    };
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      private wrapped = new Map<EventListenerOrEventListenerObject, EventListener>();
      override postMessage(
        message: unknown,
        transfer: Transferable[] | StructuredSerializeOptions = [],
      ) {
        const payload = message as {
          path?: string[];
          argumentList?: { value?: { step?: { dt: number } } }[];
        };
        if (payload.path?.[0] === 'frame' && scope.holdSpeakers) {
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
          if (data.value?.agents) {
            diagnostics.frames++;
            diagnostics.eligible = 0;
          }
          data.value?.agents?.forEach((agent, i) => {
            if (
              agent.kind === 'person' &&
              !agent.vehicle &&
              !agent.aboard &&
              !agent.prop &&
              agent.people?.length === 1
            ) {
              agent.speech = { id: `smoke-speaker-${i}`, ...scope.speechFixture };
              diagnostics.eligible++;
            }
          });
          diagnostics.maxEligible = Math.max(diagnostics.maxEligible, diagnostics.eligible);
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
  await page.goto(`/${city.slug}?lng=${center.lng}&lat=${center.lat}&z=19.5`);
  await mapReady(page);
  await page.locator('summary').filter({ hasText: 'Legend' }).click();
  const bubbles = page.locator('[data-speech-bubble]');
  const native = bubbles.locator(`[lang="${catalog.native.code}"]`).first();
  try {
    await expect(native).toHaveText('Marhay na hapon!', { timeout: 30_000 });
  } catch (error) {
    const diagnostics = await page.evaluate(
      () => (window as unknown as { speechDiagnostics: object }).speechDiagnostics,
    );
    await testInfo.attach('speech-diagnostics', {
      body: JSON.stringify(diagnostics),
      contentType: 'application/json',
    });
    console.log('Speech admission diagnostics:', diagnostics);
    throw error;
  }
  await expect(bubbles.locator(`[lang="${catalog.native.code}"]:visible`).first()).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { holdSpeakers: boolean }).holdSpeakers = true;
  });
  const selector = page.getByRole('combobox', { name: 'Speech translation' });
  await selector.selectOption('en');
  await expect(bubbles.first().locator('[lang]')).toHaveText([
    'Marhay na hapon!',
    'Good afternoon!',
  ]);
  await selector.selectOption('fil');
  await expect(bubbles.first().locator('[lang]')).toHaveText([
    'Marhay na hapon!',
    'Magandang hapon!',
  ]);
  await page.evaluate(() => {
    (window as unknown as { speechFixture: object }).speechFixture = {
      exchangeId: 'talk-how-are-you',
      line: 1,
    };
  });
  await expect(bubbles.first().locator('[lang]')).toHaveText([
    'Marhay man, salamat.',
    'Mabuti naman, salamat.',
  ]);
  await page.getByRole('button', { name: 'Speech', exact: true }).click();
  await expect(bubbles).toHaveCount(0);
});
