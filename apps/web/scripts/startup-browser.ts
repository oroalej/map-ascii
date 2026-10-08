import { chromium, type CDPSession } from '@playwright/test';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { cpus, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { serveExport } from './serve-export';
import { startupOptions, startupOrder, startupSummary, type StartupSample } from './startup-report';

const network = {
  offline: false,
  latency: 170,
  downloadThroughput: 1_125_000,
  uploadThroughput: 375_000,
  connectionType: 'cellular4g' as const,
};
async function exportHash(directory: string): Promise<string> {
  const hash = createHash('sha256');
  async function visit(path: string) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) await visit(file);
      else {
        hash.update(file.slice(directory.length));
        hash.update(await readFile(file));
      }
    }
  }
  await visit(directory);
  return hash.digest('hex');
}

/** Attach before dedicated workers run, so their range requests get the same throttle as HTML. */
async function throttleWorkers(session: CDPSession, errors: string[]) {
  let command = 0,
    workers = 0;
  const waiting = new Map<number, { resolve(): void; reject(error: Error): void }>();
  session.on('Target.receivedMessageFromTarget', ({ message }: { message: string }) => {
    const response = JSON.parse(message) as {
      id?: number;
      error?: { message: string };
      method?: string;
      params?: { exceptionDetails?: { text: string; exception?: { description?: string } } };
    };
    if (response.method === 'Runtime.exceptionThrown')
      errors.push(
        response.params?.exceptionDetails?.exception?.description ??
          response.params?.exceptionDetails?.text ??
          'Worker exception',
      );
    if (response.id === undefined) return;
    const pending = waiting.get(response.id);
    waiting.delete(response.id);
    if (response.error) pending?.reject(new Error(response.error.message));
    else pending?.resolve();
  });
  const send = (sessionId: string, method: string, params: object = {}) =>
    new Promise<void>((resolveCommand, rejectCommand) => {
      const id = ++command;
      const timer = setTimeout(() => {
        waiting.delete(id);
        rejectCommand(new Error(`Worker CDP timeout: ${method}`));
      }, 10_000);
      waiting.set(id, {
        resolve: () => {
          clearTimeout(timer);
          resolveCommand();
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectCommand(error);
        },
      });
      void session
        .send('Target.sendMessageToTarget', {
          sessionId,
          message: JSON.stringify({ id, method, params }),
        })
        .catch((error: unknown) => {
          waiting.get(id)?.reject(error instanceof Error ? error : new Error(String(error)));
          waiting.delete(id);
        });
    });
  session.on(
    'Target.attachedToTarget',
    ({ sessionId, targetInfo }: { sessionId: string; targetInfo: { type: string } }) => {
      void (async () => {
        try {
          if (targetInfo.type === 'worker') {
            workers++;
            await send(sessionId, 'Runtime.enable');
            await send(sessionId, 'Network.enable');
            await send(sessionId, 'Network.emulateNetworkConditionsByRule', {
              matchedNetworkConditions: [{ ...network, urlPattern: '' }],
            });
          }
        } catch (error) {
          errors.push(`Worker throttle: ${String(error)}`);
        } finally {
          try {
            await send(sessionId, 'Runtime.runIfWaitingForDebugger');
          } catch (error) {
            errors.push(String(error));
          }
        }
      })();
    },
  );
  await session.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: false,
  });
  return () => workers;
}

export async function runStartup(
  root: string,
  port: number,
  city: string,
  args: readonly string[],
) {
  const options = startupOptions(args);
  const candidate = resolve(root, 'apps/web/out');
  const directories = new Map<string, string>(
    options.control
      ? [
          ['controlA', candidate],
          ['controlB', candidate],
        ]
      : options.baseline
        ? [
            ['baseline', options.baseline],
            ['candidate', candidate],
          ]
        : [['candidate', candidate]],
  );
  const servers = new Map<string, Awaited<ReturnType<typeof serveExport>>>();
  const samples: StartupSample[] = [];
  const hashes: Record<string, string> = {};
  const browser = await chromium.launch({ headless: false });
  try {
    for (const directory of new Set(directories.values())) {
      servers.set(directory, await serveExport(root, port + servers.size, city, directory));
      hashes[directory] = await exportHash(directory);
    }
    for (const sample of startupOrder(options)) {
      const server = servers.get(directories.get(sample.arm)!)!;
      const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        deviceScaleFactor: 1,
        reducedMotion: 'no-preference',
      });
      const errors: string[] = [];
      try {
        const page = await context.newPage();
        page.on('pageerror', (error) => errors.push(error.message));
        const cdp = await context.newCDPSession(page);
        await cdp.send('Network.enable');
        await cdp.send('Network.clearBrowserCache');
        await cdp.send('Storage.clearDataForOrigin', {
          origin: server.origin,
          storageTypes: 'all',
        });
        await cdp.send('Network.emulateNetworkConditionsByRule', {
          matchedNetworkConditions: [{ ...network, urlPattern: '' }],
        });
        const workerCount = await throttleWorkers(cdp, errors);
        // Literal browser code avoids tsx injecting its module-local __name helper.
        await page.addInitScript({
          content: `
          const instant = Date.parse('2026-06-15T04:00:00Z');
          window.Date = new Proxy(Date, {
            construct: (target, args) =>
              Reflect.construct(target, args.length ? args : [instant]),
            get: (target, key) =>
              key === 'now' ? () => instant : Reflect.get(target, key),
          });
          localStorage.setItem(
            'atlas.life',
            JSON.stringify({ enabled: true, time: 'noon', wind: 'calm' }),
          );
          localStorage.setItem('atlas.quality', JSON.stringify('high'));
        `,
        });
        const response = await page.goto(`${server.origin}/${city}`, {
          waitUntil: 'domcontentloaded',
          timeout: 60_000,
        });
        if (!response?.ok()) throw new Error(`Startup navigation failed: ${response?.status()}`);
        await page.waitForFunction(
          () => performance.getEntriesByName('atlas:ready').length > 0,
          undefined,
          { timeout: 60_000 },
        );
        const readyMs = await page.evaluate(() => {
          const mark = performance.getEntriesByName('atlas:ready')[0]!;
          const navigation = performance.getEntriesByType('navigation')[0]!;
          return mark.startTime - navigation.startTime;
        });
        if (errors.length) throw new Error(errors.join('\n'));
        if (workerCount() < 1)
          throw new Error('Tile worker traffic was not attached and throttled');
        samples.push({ ...sample, readyMs, workerTargets: workerCount() });
        console.log(`${sample.arm}/${sample.run + 1}: ${readyMs.toFixed(1)} ms`);
      } catch (error) {
        samples.push({ ...sample, error: String(error) });
        throw error;
      } finally {
        await context.close();
      }
    }
  } finally {
    for (const server of servers.values()) server.close();
    await browser.close();
    let summary: ReturnType<typeof startupSummary> | undefined;
    try {
      summary = startupSummary(samples, options);
    } catch {
      /* Preserve failed samples. */
    }
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(
      options.output,
      JSON.stringify(
        {
          protocol: 'atlas-startup-v1',
          endpoint: 'completed qualifying canvas draw submission',
          options,
          network,
          viewport: { width: 1920, height: 1080, dpr: 1 },
          clock: '2026-06-15T04:00:00Z',
          browser: browser.version(),
          cpu: cpus()[0]?.model,
          os: release(),
          exportHashes: hashes,
          samples,
          summary,
        },
        null,
        2,
      ),
    );
  }
}
