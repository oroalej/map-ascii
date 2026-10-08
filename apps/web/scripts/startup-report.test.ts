// @vitest-environment node
import { expect, it } from 'vitest';
import { resolve } from 'node:path';
import { startupOptions, startupOrder, startupSummary } from './startup-report';
const output = resolve('fixture-startup.json');
it('validates flags, absolute paths and balanced sample counts', () => {
  expect(startupOptions(['--startup', `--output=${output}`]).runs).toBe(8);
  for (const args of [
    ['--runs=0'],
    ['--runs=3'],
    ['--runs=no'],
    ['--output=relative.json'],
    ['--unknown'],
    ['--control', `--baseline=${resolve('out')}`],
  ])
    expect(() => startupOptions([`--output=${output}`, ...args])).toThrow();
});
it('balances arm order across pairs and aggregates milliseconds with explicit control spread', () => {
  const options = startupOptions([
    '--startup',
    '--control',
    '--interleaved',
    '--runs=4',
    `--output=${output}`,
  ]);
  const order = startupOrder(options);
  expect(order.map((s) => s.arm)).toEqual([
    'controlA',
    'controlB',
    'controlB',
    'controlA',
    'controlA',
    'controlB',
    'controlB',
    'controlA',
  ]);
  const samples = order.map((sample) => ({
    ...sample,
    readyMs: [1000, 2000, 3000, 4000][sample.run]! + (sample.arm === 'controlB' ? 100 : 0),
  }));
  expect(startupSummary(samples, options)).toMatchObject({
    arms: { controlA: { medianMs: 2500, p75Ms: 3000 }, controlB: { medianMs: 2600, p75Ms: 3100 } },
    controlSpreadMs: 100,
    budgetMs: 2500,
  });
  expect(() => startupSummary(samples.slice(1), options)).toThrow('Missing');
  expect(() =>
    startupSummary(
      samples.map((s, i) => (i === 0 ? { ...s, error: 'worker error' } : s)),
      options,
    ),
  ).toThrow('failed');
  expect(() =>
    startupSummary(
      samples.map((s, i) => (i === 0 ? { ...s, readyMs: NaN } : s)),
      options,
    ),
  ).toThrow('failed');
});
