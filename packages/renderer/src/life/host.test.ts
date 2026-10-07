import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eventOccurrence, eventTime, type ProcessionRoute } from '@atlas/shared';
import { FrameProfiler } from '../profile';
import { createInlineHost, createWorkerHost } from './host';
import { makeScenario } from './testing/scenarios';
import type { FrameInput, FrameResult, SyncTile } from './worker-api';
import { LifeWorld, type LifeTile, type VisibleAgent } from './simulate';
import { snapshotOf } from './terrain-snapshot';
import { emergencyConfig, emergencyFixture } from './testing/emergency';
const scenarioNeighbor = (entry: LifeTile): LifeTile[] => [
  { ...entry, key: 'neighbor', tile: { ...entry.tile, x: entry.tile.x + 1 } },
];

const mock = vi.hoisted(() => ({
  init: vi.fn(),
  sync: vi.fn<(tiles: readonly SyncTile[]) => Promise<void>>(),
  clearTiles: vi.fn(),
  frame: vi.fn<(input: FrameInput) => Promise<FrameResult>>(),
  play: vi.fn(),
  stop: vi.fn(),
  setLive: vi.fn(),
  setProcessions: vi.fn(() => Promise.resolve()),
  setEmergency: vi.fn(() => Promise.resolve()),
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
  puffs: new Float64Array(0),
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
  it('rejects stale emergency drawables while retaining terrain after a late network command', async () => {
    const s = fixture(),
      { data } = emergencyFixture(),
      host = createWorkerHost(
        { cityLife: { source: 'Test', emergency: emergencyConfig }, emergency: data },
        [],
      );
    host.sync(s.tiles);
    await flush();
    expect(mock.init).toHaveBeenCalledWith(
      expect.objectContaining({ emergency: data, emergencyConfig }),
    );
    let resolve!: (reply: FrameResult) => void;
    mock.frame.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    host.request(s.input);
    host.setEmergency(undefined);
    resolve({
      ...result(1),
      agents: [{ kind: 'vehicle', vehicle: 'ambulance', lng: 0, lat: 0, flap: 0 }],
      terrain: snapshotOf(s.world.cellTerrain()!).snapshot,
    });
    await flush();
    expect(host.latest()?.agents).toEqual([]);
    expect(host.latest()?.cellGuard((x, y) => [x, y])).toBeTypeOf('function');
    expect(mock.setEmergency).toHaveBeenCalledWith(undefined);
    expect(mock.sync).toHaveBeenCalledTimes(1);
    host.dispose();
  });
  it('keeps provenance on an accepted frame and drops marked stale replies', async () => {
    const s = fixture(),
      host = createWorkerHost({}, []);
    host.sync(s.tiles);
    await flush();
    const marked = { kind: 'person' as const, lng: 123, lat: 13, flap: 0, mappedPersonMover: true };
    const accepted = { ...result(1), agents: [marked] };
    mock.frame.mockResolvedValueOnce(accepted);
    host.request(s.input);
    await flush();
    expect(host.latest()?.agents).toEqual([marked]);
    const saved = structuredClone(host.latest()?.agents);
    let resolve!: (reply: FrameResult) => void;
    mock.frame.mockImplementationOnce(
      () =>
        new Promise<FrameResult>((done) => {
          resolve = done;
        }),
    );
    host.request(s.input);
    host.invalidateFrame();
    resolve({ ...result(2), agents: [{ ...marked, lng: 124 }] });
    await flush();
    expect(host.latest()?.agents).toEqual([]);
    expect(accepted.agents).toEqual(saved);
    mock.frame.mockResolvedValueOnce({
      ...result(3),
      agents: [{ kind: 'person', lng: 123, lat: 13, flap: 0 }],
    });
    host.request(s.input);
    await flush();
    expect(host.latest()?.agents[0]?.mappedPersonMover).toBeUndefined();
    host.clearTiles();
    expect(host.latest()?.agents).toEqual([]);
    host.dispose();
  });

  it.each(['worker', 'inline'] as const)(
    'retains compatible ordinary agents across %s event commands and stale replies',
    async (mode) => {
      const s = fixture();
      const street: ProcessionRoute = {
        ...route,
        kind: 'procession',
        formation: undefined,
        segments: [{ id: 'osm:way/1', width_m: 8, sidewalk_m: 0 }],
        blocked: [],
      };
      const world = new LifeWorld();
      world.setProcessions([street]);
      const host = mode === 'inline' ? createInlineHost(world) : createWorkerHost({}, [street]);
      const person: VisibleAgent = { kind: 'person', lng: 0.0005, lat: 0.0001, flap: 0 };
      const car: VisibleAgent = {
        kind: 'vehicle',
        vehicle: 'car',
        lng: 0.0005,
        lat: 0,
        ahead: [0.00051, 0],
        flap: 0,
      };
      const event: VisibleAgent = { ...person, event: true };
      const agents = [person, car, event];
      if (mode === 'inline') vi.spyOn(world, 'visible').mockReturnValue(agents);
      else mock.frame.mockResolvedValueOnce({ ...result(1), agents });
      host.sync(s.tiles);
      await flush();
      host.request(s.input);
      await flush();
      let resolve!: (reply: FrameResult) => void;
      if (mode === 'worker') {
        mock.frame.mockImplementationOnce(
          () =>
            new Promise((done) => {
              resolve = done;
            }),
        );
        host.request(s.input);
      }
      host.play(street.id);
      expect(host.latest()?.agents).toEqual([person]);
      if (mode === 'worker') {
        resolve({ ...result(2), agents });
        await flush();
        expect(host.latest()?.agents).toEqual([person]);
      }
      host.stop();
      expect(host.latest()?.agents).toEqual([person]);
      host.setProcessions([]);
      expect(host.latest()?.agents).toEqual([person]);
      expect(host.latest()?.procession).toBeUndefined();
      host.dispose();
    },
  );
  it('installs late event routes in the inline fallback and replaces active playback', () => {
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          throw Error('Unavailable');
        }
      },
    );
    const s = fixture(),
      host = createWorkerHost({}, []);
    host.sync(s.tiles);
    host.setProcessions([route]);
    expect(host.play(route.id)).toBe(true);
    expect(host.latest()?.procession?.id).toBe(route.id);
    host.setProcessions([]);
    expect(host.latest()?.procession).toBeUndefined();
    expect(host.play(route.id)).toBe(false);
    host.dispose();
  });
  it('installs late routes without resyncing tiles and discards an older event reply', async () => {
    const s = fixture(),
      host = createWorkerHost({}, []);
    host.sync(s.tiles);
    await flush();
    let resolve!: (reply: FrameResult) => void;
    mock.frame.mockImplementationOnce(
      () =>
        new Promise<FrameResult>((done) => {
          resolve = done;
        }),
    );
    expect(host.request(s.input)).toBe(true);
    host.setProcessions([route]);
    resolve({ ...result(1), procession: { id: 'old', progress: 0.5, live: false } });
    await flush();
    expect(host.latest()?.procession).toBeUndefined();
    expect(mock.setProcessions).toHaveBeenCalledWith([route]);
    expect(mock.sync).toHaveBeenCalledTimes(1);
    expect(host.play(route.id)).toBe(true);
    host.setProcessions([]);
    expect(host.play(route.id)).toBe(false);
    host.dispose();
  });
  it('initializes the ordinary shop schedule once without sending city config in frame requests', async () => {
    const s = fixture(),
      shops = { open: '22:00', close: '06:00' };
    const host = createWorkerHost({ cityLife: { source: 'Test', schedules: { shops } } }, []);
    host.sync(s.tiles);
    await flush();
    expect(mock.init).toHaveBeenCalledWith(
      expect.objectContaining({ seasons: [], shopSchedule: shops }),
    );
    mock.frame.mockResolvedValueOnce(result(1));
    host.request(s.input);
    await flush();
    expect(mock.frame.mock.calls[0]![0].step.weather).toBeUndefined();
    host.dispose();
  });
  it('retains terrain from a stale season reply, including when the worker does not resend it', async () => {
    const s = fixture(),
      host = createWorkerHost({}, []);
    host.sync(s.tiles);
    await flush();
    let resolve!: (value: FrameResult) => void;
    mock.frame.mockImplementationOnce(
      () =>
        new Promise<FrameResult>((done) => {
          resolve = done;
        }),
    );
    host.request(s.input);
    host.invalidateFrame();
    host.invalidateFrame();
    resolve({ ...result(99), terrain: snapshotOf(s.world.cellTerrain()!).snapshot });
    await flush();
    const project = (lng: number, lat: number): [number, number] => [lng * 10000, lat * 10000];
    expect(host.latest()?.cellGuard(project)).toBeTypeOf('function');
    expect(host.latest()).toMatchObject({ agents: [], signalClock: 0, procession: undefined });
    mock.frame.mockResolvedValueOnce(result(2));
    host.request(s.input);
    await flush();
    expect(host.latest()?.cellGuard(project)).toBeTypeOf('function');
    expect(host.latest()?.signalClock).toBe(2);
    mock.frame.mockImplementationOnce(
      () =>
        new Promise<FrameResult>((done) => {
          resolve = done;
        }),
    );
    host.request(s.input);
    host.invalidateFrame();
    resolve({ ...result(100), terrain: null });
    await flush();
    expect(host.latest()?.cellGuard(project)).toBeUndefined();
    expect(host.latest()?.signalClock).toBe(2);
    host.dispose();
  });
  it('discards in-flight replies after a season changes without clearing tile residency', async () => {
    const s = fixture(),
      host = createWorkerHost({}, [], undefined);
    host.sync(s.tiles);
    await flush();
    let resolve!: (value: FrameResult) => void;
    mock.frame.mockImplementationOnce(
      () =>
        new Promise<FrameResult>((done) => {
          resolve = done;
        }),
    );
    expect(host.request(s.input)).toBe(true);
    host.invalidateFrame();
    resolve(result(1));
    await flush();
    expect(host.latest()).toBeUndefined();
    mock.frame.mockResolvedValueOnce(result(2));
    expect(host.request(s.input)).toBe(true);
    await flush();
    expect(host.latest()?.signalClock).toBe(2);
    expect(mock.sync).toHaveBeenCalledTimes(1);
    host.dispose();
  });
  it('accepts an atomic in-flight frame while new geometry queues, but drops it after an empty view', async () => {
    const s = fixture(),
      host = createWorkerHost({}, []);
    const view = { bounds: s.bounds, spawnMarginM: 12 };
    host.sync(s.tiles, s.center, view);
    await flush();
    let resolve!: (reply: FrameResult) => void;
    mock.frame.mockImplementation(
      () =>
        new Promise<FrameResult>((r) => {
          resolve = r;
        }),
    );
    host.request(s.input);
    host.sync(scenarioNeighbor(s.tiles[0]!), s.center, view);
    resolve(result(7));
    await flush();
    expect(host.latest()?.signalClock).toBe(7);
    host.request(s.input);
    host.sync([], s.center, view);
    resolve(result(8));
    await flush();
    expect(host.latest()?.signalClock).toBe(7);
    expect(host.latest()?.agents).toEqual([]);
    host.dispose();
  });
  it('measures accepted frame age on the posting clock and ignores stale diagnostics', async () => {
    let now = 100;
    const p = new FrameProfiler(() => now),
      s = fixture(),
      host = createWorkerHost({}, [], p);
    host.sync(s.tiles);
    await flush();
    const reply = result(1);
    reply.profile = {
      at: 999999,
      drawn: false,
      agents: 0,
      checks: 0,
      ms: {},
      continuity: { counts: { transfers: 2 }, trace: [] },
    };
    mock.frame.mockResolvedValueOnce(reply);
    host.request(s.input);
    await flush();
    now = 150;
    host.latest();
    p.begin(1);
    p.end();
    expect(p.snapshot().stages.acceptedFrameAge.p95Ms).toBe(50);
    expect(p.snapshot().continuity.counts.transfers).toBe(2);
    let finish!: (value: FrameResult) => void;
    mock.frame.mockImplementationOnce(
      () =>
        new Promise<FrameResult>((done) => {
          finish = done;
        }),
    );
    host.request(s.input);
    host.clearTiles();
    finish(reply);
    await flush();
    p.begin(2);
    p.end();
    expect(p.snapshot().continuity.counts.transfers).toBeUndefined();
    host.dispose();
  });
  beforeEach(() => {
    vi.resetAllMocks();
    for (const method of [
      mock.init,
      mock.sync,
      mock.clearTiles,
      mock.play,
      mock.stop,
      mock.setLive,
    ])
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
    host.sync(s.tiles);
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
    resolve({ ...result(1), puffs: new Float64Array([1, 2, 3, 4, 5, 6, 7, 8]) });
    await flush();
    expect(host.latest()).toBeUndefined();
    expect(host.request(s.input)).toBe(true);
    host.dispose();
    resolve(result(2));
    await flush();
    expect(host.latest()).toBeUndefined();
    expect(host.request(s.input)).toBe(false);
  });
  it('clears puff packets with actors and never restores a stale generation', async () => {
    const s = fixture(),
      host = createWorkerHost({}, []);
    host.sync(s.tiles);
    await flush();
    const packet = new Float64Array([1, 2, 3, 4, 5, 6, 7, 8]);
    mock.frame.mockResolvedValueOnce({ ...result(1), puffs: packet });
    host.request(s.input);
    await flush();
    expect(host.latest()?.puffs).toBe(packet);
    let finish!: (value: FrameResult) => void;
    mock.frame.mockImplementationOnce(
      () =>
        new Promise<FrameResult>((r) => {
          finish = r;
        }),
    );
    host.request(s.input);
    host.clearTiles();
    expect(host.latest()?.puffs.length).toBe(0);
    finish({ ...result(2), puffs: packet });
    await flush();
    expect(host.latest()?.puffs.length).toBe(0);
    host.dispose();
  });

  it('invalidates changed residency and hard clears, but accepts frames across identical syncs', async () => {
    const s = fixture();
    const host = createWorkerHost({}, []);
    const focus = [123, 13] as const;
    host.sync(s.tiles, focus);
    expect(mock.sync).toHaveBeenLastCalledWith(expect.any(Array), focus, undefined);
    await flush();
    let resolve!: (value: FrameResult) => void;
    mock.frame.mockImplementation(
      () =>
        new Promise<FrameResult>((r) => {
          resolve = r;
        }),
    );
    host.request(s.input);
    host.sync(s.tiles, focus);
    resolve(result(1));
    await flush();
    expect(host.latest()?.signalClock).toBe(1);
    host.request(s.input);
    const retained = host.latest();
    const nextTile = s.tiles[0]!;
    host.sync([
      { ...nextTile, key: 'neighbor', tile: { ...nextTile.tile, x: nextTile.tile.x + 1 } },
    ]);
    expect(host.latest()).toBe(retained);
    resolve(result(2));
    await flush();
    expect(host.latest()).toBe(retained);
    host.request(s.input);
    host.sync([]);
    host.sync(s.tiles);
    resolve(result(2));
    await flush();
    expect(host.latest()?.signalClock).toBe(1);
    host.request(s.input);
    host.clearTiles();
    expect(mock.clearTiles).toHaveBeenCalledOnce();
    resolve(result(3));
    await flush();
    expect(host.latest()?.signalClock).toBe(1);
    host.sync(s.tiles);
    expect(mock.sync.mock.calls.at(-1)![0][0]!.life).toBe(s.tiles[0]!.life);
    host.dispose();
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
  it('invalidates event timing immediately on Stop and rejects late playback frames', async () => {
    const s = fixture(),
      host = createWorkerHost({}, [route]);
    host.sync(s.tiles);
    await flush();
    const timing = eventOccurrence(route.schedule, new Date('2026-06-01'));
    host.play(route.id, timing);
    expect(host.latest()?.procession?.time).toEqual(eventTime(timing, 0));
    let resolve!: (value: FrameResult) => void;
    mock.frame.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    host.request(s.input);
    host.stop();
    expect(host.latest()?.procession).toBeUndefined();
    resolve({
      ...result(1),
      procession: { id: route.id, progress: 0.5, live: false, time: eventTime(timing, 0.5) },
    });
    await flush();
    expect(host.latest()?.procession).toBeUndefined();
    host.play(route.id, timing);
    mock.frame.mockResolvedValueOnce({
      ...result(2),
      procession: { id: route.id, progress: 0.25, live: false, time: eventTime(timing, 0.25) },
    });
    host.request(s.input);
    await flush();
    expect(host.latest()?.procession?.time?.minute).toBe(15 * 60 + 15);
    host.dispose();
  });
});
