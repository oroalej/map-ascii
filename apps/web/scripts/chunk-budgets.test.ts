import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { canvasChunks, canvasEntries } from './chunk-budgets';

it('counts every canvas entry and shared eager dependency, excluding worker and nested lazy graphs', () => {
  const out = mkdtempSync(join(tmpdir(), 'atlas-chunks-'));
  const chunks = join(out, '_next/static/chunks');
  mkdirSync(chunks, { recursive: true });
  const files = {
    'initial.js':
      'Promise.all(["static/chunks/canvas.js","static/chunks/a.js","static/chunks/b.js"].map(load));Promise.all(["static/chunks/details.js"].map(load))',
    'canvas.js':
      'worker("static/chunks/turbopack-worker-1.js",["static/chunks/worker-config.js","static/chunks/b.js","static/chunks/shared.js"]);e.v(load=>Promise.all(["static/chunks/fallback.js","static/chunks/b.js"].map(chunk=>e.l(chunk))).then(()=>load(1)))',
    'a.js': '"static/chunks/shared.js","static/chunks/initial.js"',
    'b.js': '"static/chunks/shared.js"',
    'shared.js': '"static/chunks/canvas.js"',
    'turbopack-worker-1.js': '"static/chunks/worker-only.js"',
    'fallback.js': '"static/chunks/fallback-helper.js"',
    'fallback-helper.js': '',
  };
  for (const [name, source] of Object.entries(files)) writeFileSync(join(chunks, name), source);
  const initial = new Set(['/_next/static/chunks/initial.js']);
  const entries = canvasEntries(out, initial, '/_next/static/chunks/canvas.js');
  expect(entries).toEqual([
    '/_next/static/chunks/canvas.js',
    '/_next/static/chunks/a.js',
    '/_next/static/chunks/b.js',
  ]);
  expect([...canvasChunks(out, entries, initial)].sort()).toEqual([
    '/_next/static/chunks/a.js',
    '/_next/static/chunks/b.js',
    '/_next/static/chunks/canvas.js',
    '/_next/static/chunks/shared.js',
  ]);
  // Making a formerly lazy dependency part of the canvas loader must count its
  // entire graph, even though a worker and another lazy factory also name it.
  writeFileSync(
    join(chunks, 'initial.js'),
    'Promise.all(["static/chunks/canvas.js","static/chunks/a.js","static/chunks/b.js","static/chunks/fallback.js"].map(load))',
  );
  const eager = canvasEntries(out, initial, '/_next/static/chunks/canvas.js');
  expect([...canvasChunks(out, eager, initial)].sort()).toEqual([
    '/_next/static/chunks/a.js',
    '/_next/static/chunks/b.js',
    '/_next/static/chunks/canvas.js',
    '/_next/static/chunks/fallback-helper.js',
    '/_next/static/chunks/fallback.js',
    '/_next/static/chunks/shared.js',
  ]);
});
