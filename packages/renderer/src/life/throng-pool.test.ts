import { expect, it } from 'vitest';
import { localMetricProjection, metersPerUnit, type StreetRoute } from '@atlas/shared';
import { throng } from './throng';
import { createThrongPool, throngPoolSize, type ThrongWorkerPort } from './throng-pool';
import { throngWorker } from './throng-work';
import { makeCellGuard } from './cell-guard';
import { groundForRoute } from './ground-events';
import { PolygonIndex } from './occupancy';
import type { ThrongWorkerRequest, ThrongWorkerResponse } from './throng-protocol';
import type { GridPlacement } from '../grid';

const frame = localMetricProjection([0, 0]),
  q = (x: number, y: number) => frame.from([x, y]);
const box = (w: number, s: number, e: number, n: number) => [
  q(w, s),
  q(e, s),
  q(e, n),
  q(w, n),
  q(w, s),
];
const street = (id: string): StreetRoute => ({
  id,
  title: { en: 'Test' },
  status: 'draft',
  schedule: {
    month: 9,
    weekday: 6,
    nth: 3,
    offset_days: 0,
    start: '12:00',
    duration_min: 10,
    timezone: 'Asia/Manila',
  },
  kind: 'procession',
  route: [q(-150, 0), q(150, 0)],
  length_m: 300,
  segments: [
    { id: 'osm:way/1', width_m: 8, clear_m: 8, sidewalk_m: 0, verge_m: { left: 5, right: 5 } },
  ],
  blocked: [],
  crowd_grounds: [box(-60, 10, 60, 40)],
});
function grid(w: number, h: number, cols = 100, rows = 40): GridPlacement {
  return {
    grid: { originCol: -cols / 2, originRow: -rows / 2, shiftX: 0, shiftY: 0 },
    toCell: (lng, lat) => {
      const [x, y] = frame.to([lng, lat]);
      return [x / w + cols / 2, -y / h + rows / 2];
    },
    fromCell: (c, r) => q((c - cols / 2) * w, -(r - rows / 2) * h),
    tileMatrix: () => [],
  };
}
// Terrain bodies are metres from the north-west corner of this tile, at (0, 0); y runs south.
const tile = { z: 16, x: 32768, y: 32768 };
const ref = { tile, perMeter: 1 / metersPerUnit(tile) };
const blocked = new PolygonIndex();
blocked.add([
  [
    { x: 10, y: -30 },
    { x: 40, y: -30 },
    { x: 40, y: -15 },
    { x: 10, y: -15 },
    { x: 10, y: -30 },
  ],
]);
const NONE = { hits: () => false };
const guardFor = (event: StreetRoute) => (toCell: (lng: number, lat: number) => [number, number]) =>
  makeCellGuard(
    ref,
    { roads: NONE, forbidden: NONE },
    NONE,
    toCell,
    new Map([[event.id, groundForRoute(event)]]),
    blocked,
    blocked,
    true,
  );
/** In-process workers: structured clones both ways, delivered when the test flushes. */
function ports(fail?: (request: ThrongWorkerRequest) => boolean) {
  const queue: (() => void)[] = [];
  const spawned: ThrongWorkerPort[] = [];
  const spawn = () => {
    const port: ThrongWorkerPort = {
      onmessage: null,
      onerror: null,
      terminate() {},
      postMessage(message) {
        const data = structuredClone(message);
        queue.push(() => {
          if (fail?.(data)) {
            port.onerror?.(new Event('error') as ErrorEvent);
            return;
          }
          handle(data);
        });
      },
    };
    const handle = throngWorker((message: ThrongWorkerResponse) =>
      queue.push(() =>
        port.onmessage?.({
          data: structuredClone(message),
        } as MessageEvent<ThrongWorkerResponse>),
      ),
    );
    spawned.push(port);
    return port;
  };
  const flush = () => {
    while (queue.length) queue.shift()!();
  };
  return { spawn, flush, spawned };
}
const cellsOf = (payload: ReturnType<typeof throng>) =>
  payload.cells.map((c) => [c.col, c.row, c.agent.paint, c.look]).sort();

it('prepares the same crowd in workers as on the main thread, without frame work', () => {
  const inline = street('pool/inline'),
    pooled = street('pool/workers');
  const placement = grid(1.4, 2.5);
  const expected = throng(inline, 0.4, placement, 100, 40, 18.5, 1, guardFor(inline), Infinity);
  expect(expected.cells.length).toBeGreaterThan(0);
  const { spawn, flush } = ports();
  let ready = 0;
  const pool = createThrongPool(() => ready++, 2, spawn);
  const call = () =>
    throng(pooled, 0.4, placement, 100, 40, 18.5, 1, guardFor(pooled), Infinity, pool);
  // Nothing is classified on the main thread: the first frames wait for the workers.
  const first = call();
  expect(first.pending).toBe(true);
  expect(first.cells).toHaveLength(0);
  let frames = 0,
    payload = first;
  while (payload.pending) {
    expect(++frames).toBeLessThan(200);
    flush();
    payload = call();
  }
  expect(ready).toBeGreaterThan(0);
  expect(cellsOf(payload)).toEqual(cellsOf(expected));
  // The blocked area stays empty in both, though it is crowd ground without the terrain.
  const inBox = (c: (typeof payload.cells)[number]) => {
    const [x, y] = frame.to([c.agent.lng, c.agent.lat]);
    return x > 12 && x < 38 && y > 17 && y < 28;
  };
  const open = street('pool/open');
  expect(
    throng(open, 0.4, placement, 100, 40, 18.5, 1, undefined, Infinity).cells.some(inBox),
  ).toBe(true);
  expect(payload.cells.some(inBox)).toBe(false);
  pool.destroy();
});
it('asks again for a chunk a worker could not prepare, and falls back inline when one fails', () => {
  const event = street('pool/retry');
  const placement = grid(1.4, 2.5);
  let refused = 0;
  const { spawn, flush } = ports();
  const pool = createThrongPool(
    () => {},
    1,
    () => {
      const port = spawn();
      const post = port.postMessage.bind(port);
      // The first chunk request names a terrain the worker never received.
      port.postMessage = (message) => {
        if (message.type === 'chunk' && message.terrain && !refused++)
          post({ ...message, terrain: 999 });
        else post(message);
      };
      return port;
    },
  );
  const call = (p = pool) =>
    throng(event, 0.4, placement, 100, 40, 18.5, 1, guardFor(event), Infinity, p);
  let payload = call();
  for (let frames = 0; payload.pending; frames++) {
    expect(frames).toBeLessThan(200);
    flush();
    payload = call();
  }
  expect(refused).toBeGreaterThan(1);
  expect(payload.cells.length).toBeGreaterThan(0);

  const broken = ports(() => true);
  const failing = createThrongPool(() => {}, 2, broken.spawn);
  const other = street('pool/failing');
  const fallback = () =>
    throng(other, 0.4, placement, 100, 40, 18.5, 1, guardFor(other), Infinity, failing);
  expect(fallback().pending).toBe(true);
  broken.flush();
  expect(failing.alive).toBe(false);
  // A dead pool hands the field back to the main thread's budgeted preparation.
  expect(fallback().cells.length).toBeGreaterThan(0);
});
it('sizes the pool beside the main thread and the Life and tile workers', () => {
  expect(throngPoolSize(2)).toBe(1);
  expect(throngPoolSize(5)).toBe(2);
  expect(throngPoolSize(16)).toBe(3);
});
