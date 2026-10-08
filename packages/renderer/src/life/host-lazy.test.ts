import { expect, it, vi } from 'vitest';
import { createInlineHostLazy, type LifeHost } from './host';
import type { FrameInput } from './worker-api';
import type { ProcessionRoute } from '@atlas/shared';

const route: ProcessionRoute = {
  id: 'test',
  title: { en: 'Test' },
  status: 'draft',
  kind: 'fluvial',
  route: [
    [0, 0],
    [0.001, 0],
  ],
  length_m: 111,
  schedule: {
    month: 9,
    weekday: 0,
    nth: 3,
    offset_days: 0,
    start: '15:00',
    duration_min: 60,
    timezone: 'UTC',
  },
};
function fixture() {
  const calls: string[] = [];
  const host = {
    sync: vi.fn(() => {
      calls.push('sync');
    }),
    clearTiles: vi.fn(() => {
      calls.push('clear');
    }),
    setEmergency: vi.fn(() => {
      calls.push('emergency');
    }),
    setProcessions: vi.fn(() => {
      calls.push('routes');
    }),
    setLive: vi.fn(() => {
      calls.push('live');
    }),
    play: vi.fn(() => {
      calls.push('play');
      return true;
    }),
    stop: vi.fn(() => {
      calls.push('stop');
    }),
    invalidateFrame: vi.fn(() => {
      calls.push('frame');
    }),
    invalidateFolklore: vi.fn(() => {
      calls.push('folklore');
    }),
    request: vi.fn(() => true),
    latest: vi.fn<LifeHost['latest']>(),
    dispose: vi.fn(),
  } satisfies LifeHost;
  const createConfiguredInlineHost = vi.fn(() => host);
  let resolve!: (module: { createConfiguredInlineHost: typeof createConfiguredInlineHost }) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<{ createConfiguredInlineHost: typeof createConfiguredInlineHost }>(
    (done, fail) => {
      resolve = done;
      reject = fail;
    },
  );
  const lazy = createInlineHostLazy({}, [route], undefined, () => promise);
  const ready = async () => {
    resolve({ createConfiguredInlineHost });
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };
  return { lazy, host, calls, createConfiguredInlineHost, ready, reject };
}
it('replays non-frame commands in order and accepts only a fresh frame after readiness', async () => {
  const f = fixture();
  // Rejected requests must never read or retain the old input.
  const old = new Proxy({} as FrameInput, {
    get() {
      throw new Error('stale input');
    },
  });
  f.lazy.sync([], [1, 2]);
  f.lazy.clearTiles();
  f.lazy.sync([], [3, 4]);
  f.lazy.setProcessions([route]);
  f.lazy.setEmergency(undefined);
  f.lazy.setLive('test', 0.5);
  expect(f.lazy.play('test')).toBe(true);
  f.lazy.stop();
  f.lazy.invalidateFrame();
  f.lazy.invalidateFolklore();
  expect(f.lazy.request(old)).toBe(false);
  expect(f.lazy.request(old)).toBe(false);
  expect(f.lazy.latest()?.procession).toBeUndefined();
  await f.ready();
  expect(f.calls).toEqual([
    'sync',
    'clear',
    'sync',
    'routes',
    'emergency',
    'live',
    'play',
    'stop',
    'frame',
    'folklore',
  ]);
  expect(f.host.sync).toHaveBeenLastCalledWith([], [3, 4], undefined);
  expect(f.host.request).not.toHaveBeenCalled();
  const fresh = {} as FrameInput;
  expect(f.lazy.request(fresh)).toBe(true);
  expect(f.host.request).toHaveBeenCalledExactlyOnceWith(fresh);
  f.lazy.dispose();
});
it('reports pending playback synchronously and cancels it on replacement', async () => {
  const f = fixture();
  expect(f.lazy.play('absent')).toBe(false);
  expect(f.lazy.play('test')).toBe(true);
  expect(f.lazy.latest()?.procession).toEqual({ id: 'test', progress: 0, live: false });
  f.lazy.setProcessions([]);
  expect(f.lazy.latest()?.procession).toBeUndefined();
  expect(f.lazy.play('test')).toBe(false);
  await f.ready();
  expect(f.calls).toEqual(['play', 'routes']);
  f.lazy.dispose();
});
it('disposal before resolution prevents world construction and leaves the wrapper inert', async () => {
  const f = fixture();
  f.lazy.sync([]);
  f.lazy.play('test');
  f.lazy.dispose();
  await f.ready();
  expect(f.createConfiguredInlineHost).not.toHaveBeenCalled();
  f.lazy.sync([]);
  f.lazy.setProcessions([route]);
  expect(f.lazy.request({} as FrameInput)).toBe(false);
  expect(f.lazy.play('test')).toBe(false);
  expect(f.lazy.latest()).toBeUndefined();
});
it('reports loader rejection once, releases commands and remains inert', async () => {
  const report = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const f = fixture();
    f.lazy.sync([]);
    f.lazy.play('test');
    f.reject(new Error('module unavailable'));
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(report).toHaveBeenCalledTimes(1);
    expect(f.createConfiguredInlineHost).not.toHaveBeenCalled();
    expect(f.lazy.request({} as FrameInput)).toBe(false);
    expect(f.lazy.play('test')).toBe(false);
    expect(f.lazy.latest()).toBeUndefined();
    f.lazy.dispose();
  } finally {
    report.mockRestore();
  }
});
