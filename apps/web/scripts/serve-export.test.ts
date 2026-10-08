// @vitest-environment node
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { serveExport } from './serve-export';

async function localServer() {
  const server = createServer((_request, response) => response.end('foreign'));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  return {
    server,
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
it('serves a selected export and refuses an occupied port without stopping its owner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atlas-export-'));
  const foreign = await localServer();
  try {
    await writeFile(join(directory, 'fixture.html'), '<html>selected export</html>');
    await expect(serveExport(directory, foreign.port, 'fixture', directory)).rejects.toThrow(
      'already in use',
    );
    expect(await (await fetch(`http://localhost:${foreign.port}/fixture`)).text()).toBe('foreign');
    const free = await localServer();
    await free.close();
    const owned = await serveExport(directory, free.port, 'fixture', directory);
    expect(await (await fetch(`${owned.origin}/fixture`)).text()).toBe(
      '<html>selected export</html>',
    );
    owned.close();
    await expect(serveExport(directory, free.port, 'missing', directory)).rejects.toThrow();
  } finally {
    await foreign.close();
    await rm(directory, { recursive: true, force: true });
  }
});
