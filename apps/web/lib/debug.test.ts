import { afterEach, beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => vi.resetModules());
afterEach(() => window.history.replaceState(null, '', '/'));

it('captures the debug duration before URL mirroring removes debug parameters', async () => {
  window.history.replaceState(null, '', '/example?debug=1&captureMs=1000');
  const { isDebugRequested, debugCaptureMs } = await import('./debug');
  expect(isDebugRequested()).toBe(true);
  window.history.replaceState(null, '', '/example?lat=1&lng=2&z=18');
  expect(debugCaptureMs()).toBe(1000);
  expect(isDebugRequested()).toBe(true);
});

it('ignores capture duration overrides without debug mode', async () => {
  window.history.replaceState(null, '', '/example?captureMs=1000');
  const { isDebugRequested, debugCaptureMs } = await import('./debug');
  expect(isDebugRequested()).toBe(false);
  expect(debugCaptureMs()).toBe(30_000);
});

it.each(['', '0', '-1', 'invalid', 'Infinity'])(
  'uses the default capture duration for %j',
  async (duration) => {
    window.history.replaceState(null, '', `/example?debug=1&captureMs=${duration}`);
    const { debugCaptureMs } = await import('./debug');
    expect(debugCaptureMs()).toBe(30_000);
  },
);
