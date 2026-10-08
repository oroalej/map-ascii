import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { canvasChunks } from './chunk-budgets';

it('counts shared dependencies once and excludes initial and worker-only chunks', () => {
  const out = mkdtempSync(join(tmpdir(), 'atlas-chunks-'));
  const chunks = join(out, '_next/static/chunks');
  mkdirSync(chunks, { recursive: true });
  const files = {
    'canvas.js':
      '"static/chunks/a.js","static/chunks/b.js",worker("static/chunks/turbopack-worker-1.js",["static/chunks/worker-config.js","static/chunks/shared.js"])',
    'a.js': '"static/chunks/shared.js","static/chunks/initial.js"',
    'b.js': '"static/chunks/shared.js"',
    'shared.js': '"static/chunks/canvas.js"',
    'turbopack-worker-1.js': '"static/chunks/worker-only.js"',
  };
  for (const [name, source] of Object.entries(files)) writeFileSync(join(chunks, name), source);
  expect(
    [
      ...canvasChunks(
        out,
        ['/_next/static/chunks/canvas.js'],
        new Set(['/_next/static/chunks/initial.js']),
      ),
    ].sort(),
  ).toEqual([
    '/_next/static/chunks/a.js',
    '/_next/static/chunks/b.js',
    '/_next/static/chunks/canvas.js',
    '/_next/static/chunks/shared.js',
  ]);
});
