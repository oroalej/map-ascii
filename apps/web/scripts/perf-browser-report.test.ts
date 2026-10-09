// @vitest-environment node
import { expect, it } from 'vitest';
import { resolve } from 'node:path';
import { browserOptions, drawnIntervals, summarize } from './perf-browser-report';

const output = resolve('fixture-scene.json');

it('keeps the legacy captures and requires an absolute output for a scene', () => {
  expect(browserOptions([])).toEqual({ startup: false, pan: false });
  expect(browserOptions(['--pan'])).toEqual({ startup: false, pan: true });
  expect(browserOptions(['--startup', '--output=x'])).toEqual({ startup: true, pan: false });
  expect(browserOptions(['--scene', 'zoom', '--output', output])).toEqual({
    startup: false,
    pan: false,
    scene: 'zoom',
    output,
  });
  expect(browserOptions([`--scene=idle`, `--output=${output}`]).scene).toBe('idle');
  for (const args of [
    ['--scene', 'idle'],
    ['--scene', 'idle', '--output', 'relative.json'],
    ['--scene', 'sunrise', '--output', output],
    ['--output', output],
    ['--pan', '--scene', 'pan', '--output', output],
    ['--scene', 'idle', '--scene', 'pan', '--output', output],
    ['--unknown'],
  ])
    expect(() => browserOptions(args)).toThrow();
});

it('measures intervals between drawn samples only, and keeps missing stages apart from zero', () => {
  const samples = [
    { at: 0, drawn: true, ms: { callback: 2, replyClone: 0 } },
    { at: 16, drawn: false, ms: { callback: 0.1 } },
    { at: 33, drawn: true, ms: { callback: 4 } },
    { at: 66, drawn: true, ms: { callback: 3 } },
    { at: 70, drawn: false, ms: {} },
  ];
  expect(drawnIntervals(samples)).toEqual([33, 33]);
  const summary = summarize({ dropped: 2, spanMs: 70, samples }, undefined, [
    { startTime: 1, duration: 60 },
    { startTime: 9, duration: 80 },
  ]);
  expect(summary).toMatchObject({
    samples: 5,
    droppedSamples: 2,
    drawnFrames: 3,
    frameIntervalP50Ms: 33,
    frameIntervalP95Ms: 33,
    drawnCallbackP95Ms: 4,
    smoothed: null,
    longTasks: { count: 2, totalMs: 140 },
  });
  expect(summary.drawnFps).toBeCloseTo(2000 / 66);
  expect(summary.stages.replyClone).toEqual({ missing: false, count: 1, p95Ms: 0 });
  expect(summary.stages.activation).toEqual({ missing: true, count: 0, p95Ms: null });
});

it('reports no interval or rate without two drawn frames', () => {
  const summary = summarize(
    { dropped: 0, spanMs: 0, samples: [{ at: 5, drawn: true, ms: {} }] },
    { lifeMs: 1, cellPassMs: 2, frameMs: 3, fps: 30 },
    [],
  );
  expect(summary.frameIntervalP95Ms).toBeNull();
  expect(summary.drawnFps).toBeNull();
  expect(summary.smoothed).toEqual({ lifeMs: 1, cellPassMs: 2, frameMs: 3 });
});
