import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProcessionRoute } from '@atlas/shared';
import { FrameProfiler } from '../profile';
import { createWorkerHost } from './host';
import { makeScenario } from './testing/scenarios';
import type { FrameInput, FrameResult, SyncTile } from './worker-api';

const mock = vi.hoisted(() => ({
  init: vi.fn(),
  sync: vi.fn<(tiles: readonly SyncTile[]) => Promise<void>>(),
  frame: vi.fn(),
  play: vi.fn(),
  stop: vi.fn(),
  setLive: vi.fn(),
  release: vi.fn(),
  terminate: vi.fn(),
}));
vi.mock('comlink', () => ({
  wrap: () => ({ ...mock, [Symbol.for('release')]: mock.release }),
  releaseProxy: Symbol.for('release'),
}));
const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};
const result = (clock: number): FrameResult => ({
  agents: [],
  procession: undefined,
  signalClock: clock,
});
const fixture = () => {
  const s = makeScenario('sparse', 1, true);
  const input: FrameInput = {
    gust: {
      camera: { lng: s.center[0], lat: s.center[1], zoom: 18 },
      size: { width: 390, height: 844 },
      cssCell: { w: 10, h: 18 },
      time: 0,
      wind: { dir: [1, 0], strength: 0 },
    },
    step: {
      dt: 1 / 30,
      zoom: 18,
      bounds: s.bounds,
      wind: undefined,
      weather: undefined,
      cellMeters: 0.9,
    },
    visible: [18, s.levels, s.center],
  };
  return { ...s, input };
};

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

describe('pipelined Life host', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    for (const method of [mock.init, mock.sync, mock.play, mock.stop, mock.setLive])
      method.mockResolvedValue(undefined);
    vi.stubGlobal(
      'Worker',
      class extends EventTarget {
        terminate = mock.terminate;
      },
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('sends geometry once per residency, limits frames in flight and merges asynchronous profiles', async () => {
    const s = fixture();
    const profiler = new FrameProfiler(() => 0);
    const host = createWorkerHost({}, [], profiler);
    expect(host.request(s.input)).toBe(false);
    host.sync(s.tiles);
    host.sync(s.tiles);
    expect(mock.sync.mock.calls[0]![0][0]!.life).toBe(s.tiles[0]!.life);
    expect(mock.sync.mock.calls[1]![0][0]).not.toHaveProperty('life');
    expect(s.tiles[0]!.life.coords.byteLength).toBeGreaterThan(0);
    await flush();
    let resolve!: (value: FrameResult) => void;
    mock.frame.mockImplementationOnce(
      () =>
        new Promise<FrameResult>((r) => {
          resolve = r;
        }),
    );
    expect(host.request(s.input)).toBe(true);
    expect(host.request(s.input)).toBe(false);
    expect(host.latest()).toBeUndefined();
    resolve({
      ...result(1),
      profile: { at: 0, drawn: false, agents: 0, checks: 2, ms: { step: 3 } },
    });
    await flush();
    expect(host.latest()?.signalClock).toBe(1);
    profiler.begin(1);
    profiler.end();
    expect(profiler.snapshot().samples[0]).toMatchObject({ checks: 2, ms: { step: 3 } });
    expect(profiler.snapshot().stages.syncPost.count).toBe(1);
    host.sync([]);
    host.sync(s.tiles);
    expect(mock.sync.mock.calls.at(-1)![0][0]!.life).toBe(s.tiles[0]!.life);
    expect(host.latest()?.signalClock).toBe(1);
    host.dispose();
    expect(mock.release).toHaveBeenCalledOnce();
    expect(mock.terminate).toHaveBeenCalledOnce();
  });

  it('drops results invalidated by clearing tiles or disposal', async () => {
    const s = fixture();
    const host = createWorkerHost({}, []);
    await flush();
    let resolve!: (value: FrameResult) => void;
    mock.frame.mockImplementation(
      () =>
        new Promise<FrameResult>((r) => {
          resolve = r;
        }),
    );
    host.request(s.input);
    host.sync([]);
    resolve(result(1));
    await flush();
    expect(host.latest()).toBeUndefined();
    expect(host.request(s.input)).toBe(true);
    host.dispose();
    resolve(result(2));
    await flush();
    expect(host.latest()).toBeUndefined();
    expect(host.request(s.input)).toBe(false);
  });

  it('answers procession membership synchronously and recovers from startup failure', async () => {
    const s = fixture();
    mock.init.mockRejectedValueOnce(new Error('worker startup failed'));
    const host = createWorkerHost({}, [route]);
    host.sync(s.tiles);
    expect(host.play('unknown')).toBe(false);
    expect(host.play('test')).toBe(true);
    await flush();
    expect(mock.terminate).toHaveBeenCalledOnce();
    expect(host.latest()?.procession?.id).toBe('test');
    expect(host.request(s.input)).toBe(true);
    expect(host.latest()?.agents.length).toBeGreaterThan(0);
    host.stop();
    expect(host.latest()?.procession).toBeUndefined();
    host.dispose();
    expect(mock.terminate).toHaveBeenCalledOnce();
  });

  it('replays a procession after worker failure only while it is still playing', async () => {
    const s = fixture();
    const replies: ((value: FrameResult) => void)[] = [];
    mock.frame.mockImplementation(
      () =>
        new Promise<FrameResult>((r) => {
          replies.push(r);
        }),
    );
    const failOver = async (host: ReturnType<typeof createWorkerHost>) => {
      mock.setLive.mockRejectedValueOnce(new Error('worker lost'));
      host.setLive(undefined);
      await flush();
    };

    // A reply to a frame posted before play() cannot show that the time-lapse ended.
    const early = createWorkerHost({}, [route]);
    early.sync(s.tiles);
    await flush();
    expect(early.request(s.input)).toBe(true);
    expect(early.play('test')).toBe(true);
    replies.shift()!(result(1));
    await flush();
    await failOver(early);
    expect(early.latest()?.procession?.id).toBe('test');
    early.dispose();

    // A later reply without it means the time-lapse ended; the fallback must not restart it.
    const ended = createWorkerHost({}, [route]);
    ended.sync(s.tiles);
    await flush();
    expect(ended.play('test')).toBe(true);
    expect(ended.request(s.input)).toBe(true);
    replies.shift()!(result(1));
    await flush();
    await failOver(ended);
    expect(ended.latest()?.procession).toBeUndefined();
    ended.dispose();
  });
});
