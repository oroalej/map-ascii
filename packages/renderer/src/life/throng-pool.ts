/**
 * Crowd field workers: several workers classify and terrain-check field chunks at once, off
 * the main thread. Each worker receives an event once and a terrain once, before its first
 * chunk that needs them; results are installed with `acceptFieldChunk` as they arrive.
 */
import type { ProcessionRoute } from '@atlas/shared';
import type { FlatPolygonIndex } from './occupancy';
import {
  abandonFieldChunk,
  acceptFieldChunk,
  type ThrongFieldPool,
  type ThrongGuardFactory,
} from './throng';
import {
  THRONG_WORKER_TERRAINS,
  type ThrongWorkerRequest,
  type ThrongWorkerResponse,
} from './throng-protocol';

/** Chunks queued per worker; the rest wait for a later frame, nearest the view first. */
export const THRONG_CHUNKS_PER_WORKER = 4;
/** Workers beside the main thread and the Life and tile workers, at most three. */
export function throngPoolSize(cores = globalThis.navigator?.hardwareConcurrency ?? 4) {
  return Math.max(1, Math.min(3, cores - 3));
}

type Guard = NonNullable<ReturnType<ThrongGuardFactory>>;
type Flattenable = { toFlat?: () => FlatPolygonIndex };
export type ThrongWorkerPort = {
  postMessage(message: ThrongWorkerRequest): void;
  onmessage: ((event: MessageEvent<ThrongWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  terminate(): void;
};
type Slot = { port: ThrongWorkerPort; busy: number; events: Set<number>; terrains: number[] };
type Request = {
  event: ProcessionRoute;
  index: number;
  terrain?: object;
  hard?: object;
  order: number;
};
const flattenable = (key: unknown) =>
  typeof (key as Flattenable | undefined)?.toFlat === 'function';

export function createThrongPool(
  onReady: () => void,
  size = throngPoolSize(),
  spawn: () => ThrongWorkerPort = () =>
    new Worker(new URL('./throng.worker.ts', import.meta.url), { type: 'module' }),
): ThrongFieldPool & { destroy(): void } {
  const eventIds = new WeakMap<ProcessionRoute, number>();
  // Terrains are numbered in acceptance order: a newer terrain's chunk wins.
  const terrainIds = new WeakMap<object, { hard: object; id: number }>();
  const requests = new Map<number, Request>();
  let nextEvent = 0,
    nextTerrain = 0,
    nextRequest = 0,
    alive = true;
  const slots: Slot[] = [];
  const fail = () => {
    if (!alive) return;
    alive = false;
    for (const slot of slots) slot.port.terminate();
    for (const request of requests.values()) abandonFieldChunk(request.event, request.index);
    requests.clear();
    onReady();
  };
  try {
    for (let i = 0; i < size; i++) {
      const slot: Slot = { port: spawn(), busy: 0, events: new Set(), terrains: [] };
      slot.port.onmessage = ({ data }) => {
        const request = requests.get(data.request);
        if (!request) return;
        requests.delete(data.request);
        slot.busy--;
        if ('error' in data) abandonFieldChunk(request.event, request.index);
        else
          acceptFieldChunk(
            request.event,
            request.index,
            data.chunk,
            request.terrain,
            request.hard,
            request.order,
          );
        onReady();
      };
      slot.port.onerror = fail;
      slots.push(slot);
    }
  } catch {
    fail();
  }
  const terrainOf = (guard: Guard) => {
    const terrain = guard.terrainKey!,
      hard = guard.hardTerrainKey!;
    let known = terrainIds.get(terrain);
    if (!known || known.hard !== hard)
      terrainIds.set(terrain, (known = { hard, id: ++nextTerrain }));
    return { terrain, hard, id: known.id };
  };
  return {
    get alive() {
      return alive;
    },
    accepts(guard) {
      // The main thread keys chunks by both terrains; a worker rebuilds the guard from them.
      return (
        !guard ||
        (!!guard.terrainRef && flattenable(guard.terrainKey) && flattenable(guard.hardTerrainKey))
      );
    },
    submit(event, index, guard) {
      if (!alive) return false;
      let slot: Slot | undefined;
      for (const candidate of slots)
        if (candidate.busy < THRONG_CHUNKS_PER_WORKER && (!slot || candidate.busy < slot.busy))
          slot = candidate;
      if (!slot) return false;
      let eventId = eventIds.get(event);
      if (eventId === undefined) eventIds.set(event, (eventId = ++nextEvent));
      if (!slot.events.has(eventId)) {
        slot.port.postMessage({ type: 'event', id: eventId, event });
        slot.events.add(eventId);
      }
      const terrain = guard && terrainOf(guard);
      if (terrain && !slot.terrains.includes(terrain.id)) {
        const blocked = (terrain.terrain as Flattenable).toFlat!();
        slot.port.postMessage({
          type: 'terrain',
          id: terrain.id,
          ref: guard.terrainRef!,
          blocked,
          ...(terrain.hard !== terrain.terrain && {
            hard: (terrain.hard as Flattenable).toFlat!(),
          }),
        });
        slot.terrains.push(terrain.id);
        if (slot.terrains.length > THRONG_WORKER_TERRAINS) slot.terrains.shift();
      }
      const request = ++nextRequest;
      requests.set(request, {
        event,
        index,
        terrain: terrain?.terrain,
        hard: terrain?.hard,
        order: terrain?.id ?? 0,
      });
      slot.busy++;
      slot.port.postMessage({
        type: 'chunk',
        request,
        event: eventId,
        index,
        terrain: terrain?.id ?? 0,
      });
      return true;
    },
    destroy() {
      alive = false;
      for (const slot of slots) slot.port.terminate();
      requests.clear();
    },
  };
}
