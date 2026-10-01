import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

/** Own a static server and verify it serves this checkout; never stop a foreign process. */
export async function serveExport(root: string, port: number, city: string) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid E2E_PORT');
  if (!/^[a-z0-9-]+$/.test(city)) throw new Error('Invalid city slug');
  const origin = `http://localhost:${port}`,
    url = `${origin}/${city}`;
  const expected = await readFile(resolve(root, 'apps/web/out', `${city}.html`), 'utf8');
  let occupied = false;
  try {
    await fetch(url, { signal: AbortSignal.timeout(1000) });
    occupied = true;
  } catch {
    /* No server. */
  }
  if (occupied) throw new Error(`Port ${port} is already in use; choose another E2E_PORT`);
  const require = createRequire(import.meta.url),
    pkg = require.resolve('serve/package.json');
  const { bin } = require('serve/package.json') as { bin: string | Record<string, string> };
  const server = spawn(
    process.execPath,
    [resolve(dirname(pkg), typeof bin === 'string' ? bin : bin.serve!), 'out', '-l', String(port)],
    {
      cwd: resolve(root, 'apps/web'),
      windowsHide: true,
      stdio: 'ignore',
    },
  );
  let startError: Error | undefined;
  server.on('error', (error) => {
    startError = error;
  });
  const close = () => {
    server.kill();
  };
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (startError) throw startError;
      if (server.exitCode !== null)
        throw new Error(`Static export server exited (${server.exitCode})`);
      let response: Response | undefined;
      try {
        response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      } catch {
        /* Starting. */
      }
      if (response) {
        if (!response.ok || (await response.text()) !== expected)
          throw new Error(`Port ${port} is not serving this checkout`);
        return { origin, close };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Could not serve this checkout static export');
  } catch (error) {
    close();
    throw error;
  }
}
