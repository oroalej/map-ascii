import { fileURLToPath } from 'node:url';
import { e2ePort } from './e2e-port';
import { runNodeCli } from './run-node-cli';

// Serve the export on this checkout's e2e port, so Playwright reuses this server.
const port = e2ePort();
console.log(`Serving apps/web/out on http://localhost:${port}`);
process.exitCode = await runNodeCli(
  'serve/build/main.js',
  ['out', '-l', String(port)],
  fileURLToPath(new URL('../', import.meta.url)),
);
