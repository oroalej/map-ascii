import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { City, DialogueCatalog } from '@atlas/shared';
import type { FrameInput, FrameResult } from '../../../packages/renderer/src/life/worker-api';
import { naturalSpeech } from '../../../packages/renderer/scripts/natural-speech';
import { cities, mapReady } from './helpers';

test('natural speech bubbles keep Bikol and switch English/Tagalog translations', async ({
  page,
}, testInfo) => {
  const city = cities.find((entry) => entry.slug === 'naga' && entry.hasMeta)!;
  const catalog = JSON.parse(
    readFileSync(
      new URL('../../../packages/content/cities/naga/dialogue.json', import.meta.url),
      'utf8',
    ),
  ) as DialogueCatalog;
  const config = JSON.parse(
    readFileSync(
      new URL('../../../packages/content/cities/naga/city.json', import.meta.url),
      'utf8',
    ),
  ) as City;
  const search = JSON.parse(
    readFileSync(new URL('../public/tiles/naga.search-index.json', import.meta.url), 'utf8'),
  ) as { entries: { name: string; lng: number; lat: number }[] };
  const center = search.entries.find((entry) => entry.name === 'Plaza Rizal')!;
  const camera = { lng: center.lng, lat: center.lat, zoom: 19.5 };
  const size = { width: 1024, height: 768 };
  // Normal seeded real-tile simulation, including terrain rejection and final packing ownership.
  const evidence = await naturalSpeech(config, catalog, camera, { ...size, height: 1024 });
  expect(evidence.seconds).toBeLessThanOrEqual(60);
  await testInfo.attach('natural-packed-speech', {
    body: JSON.stringify(evidence),
    contentType: 'application/json',
  });
  await page.setViewportSize(size);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.addInitScript(() => {
    localStorage.setItem(
      'atlas.life',
      JSON.stringify({ enabled: true, time: 'noon', wind: 'calm' }),
    );
    localStorage.setItem('atlas.quality', JSON.stringify('high'));
    const scope = window as unknown as {
      holdSpeakers: boolean;
      speechDiagnostics: { frames: number; cues: number };
    };
    scope.holdSpeakers = false;
    scope.speechDiagnostics = { frames: 0, cues: 0 };
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      private clockId = 0;
      private holdUntil = 0;
      private input?: FrameInput;
      private held = new Set<string>();
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        super.addEventListener('message', (event: MessageEvent<{ value?: FrameResult }>) => {
          const agents = event.data.value?.agents;
          if (!agents) return;
          scope.speechDiagnostics.frames++;
          scope.speechDiagnostics.cues += agents.filter((a) => a.speech).length;
          if (!this.input || performance.now() < this.holdUntil) return;
          const { camera, size } = this.input.gust;
          const project = (lng: number, lat: number) => {
            const sin = Math.sin((lat * Math.PI) / 180),
              scale = 512 * 2 ** camera.zoom;
            return [
              ((lng + 180) / 360) * scale,
              (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale,
            ];
          };
          const [cx, cy] = project(camera.lng, camera.lat);
          // Pause only an actual worker-produced speaker in the view, to let slow software-GPU
          // readbacks complete. Never alter actors, cues, chance outcomes or admission.
          if (
            agents.some((agent) => {
              if (!agent.speech || this.held.has(agent.speech.id)) return false;
              const [x, y] = project(agent.lng, agent.lat);
              const inside =
                Math.abs(x! - cx!) < size.width / 2 - 24 &&
                Math.abs(y! - cy!) < size.height / 2 - 24;
              if (inside) this.held.add(agent.speech.id);
              return inside;
            })
          )
            this.holdUntil = performance.now() + 8_000;
        });
      }
      override postMessage(
        message: unknown,
        transfer: Transferable[] | StructuredSerializeOptions = [],
      ) {
        const payload = message as {
          id: string;
          path?: string[];
          argumentList?: { value?: FrameInput }[];
        };
        const input = payload.path?.[0] === 'frame' ? payload.argumentList?.[0]?.value : undefined;
        if (input) {
          this.input = input;
          input.step.dt = scope.holdSpeakers || performance.now() < this.holdUntil ? 0 : 0.1;
          // Advance the normal fixed-step clock by up to half a second per drawn frame.
          // Comlink ignores these unique reply IDs; every worker response stays unmodified.
          if (input.step.dt > 0)
            for (let i = 0; i < 4; i++) {
              super.postMessage({ ...payload, id: `speech-clock-${++this.clockId}` });
            }
        }
        if (Array.isArray(transfer)) super.postMessage(message, transfer);
        else super.postMessage(message, transfer);
      }
    };
  });
  await page.goto(`/${city.slug}?lng=${center.lng}&lat=${center.lat}&z=19`);
  await mapReady(page);
  await page.locator('summary').filter({ hasText: 'Legend' }).click();
  const bubbles = page.locator('[data-speech-bubble]:visible');
  const native = bubbles.locator(`[lang="${catalog.native.code}"]`).first();
  try {
    await expect(native).toBeVisible({ timeout: 30_000 });
  } catch (error) {
    const diagnostics = await page.evaluate(
      () => (window as unknown as { speechDiagnostics: object }).speechDiagnostics,
    );
    await testInfo.attach('natural-worker-speech', {
      body: JSON.stringify(diagnostics),
      contentType: 'application/json',
    });
    throw error;
  }
  await page.evaluate(() => {
    (window as unknown as { holdSpeakers: boolean }).holdSpeakers = true;
  });
  const text = await native.textContent();
  const line = catalog.exchanges
    .flatMap((exchange) => exchange.lines)
    .find((line) => line[catalog.native.code] === text)!;
  expect(line).toBeDefined();
  const selector = page.getByRole('combobox', { name: 'Speech translation' });
  await selector.selectOption('en');
  await expect(bubbles.first().locator('[lang]')).toHaveText([text ?? '', line.en ?? '']);
  await selector.selectOption('fil');
  await expect(bubbles.first().locator('[lang]')).toHaveText([text ?? '', line.fil ?? '']);
  await page.getByRole('button', { name: 'Speech', exact: true }).click();
  await expect(page.locator('[data-speech-bubble]')).toHaveCount(0);
});
