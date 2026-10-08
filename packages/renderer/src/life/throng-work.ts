/**
 * Crowd field worker logic: classifies one field chunk at a time and checks it against the
 * accepted terrain. It keeps the events and the latest terrains, not the chunks.
 */
import type { ProcessionRoute } from '@atlas/shared';
import { makeCellGuard } from './cell-guard';
import { groundForRoute, type EventGround } from './ground-events';
import { FrozenPolygonIndex } from './occupancy';
import { buildFieldChunk } from './throng';
import {
  THRONG_WORKER_TERRAINS,
  type ThrongWorkerRequest,
  type ThrongWorkerResponse,
} from './throng-protocol';

type Terrain = {
  ref: Extract<ThrongWorkerRequest, { type: 'terrain' }>['ref'];
  blocked: FrozenPolygonIndex;
  hard: FrozenPolygonIndex;
};
const NONE = { hits: () => false };

/** One worker's message handler; `post` returns responses with their buffers to transfer. */
export function throngWorker(
  post: (message: ThrongWorkerResponse, transfer: Transferable[]) => void,
) {
  const events = new Map<number, { event: ProcessionRoute; grounds: Map<string, EventGround> }>();
  const terrains = new Map<number, Terrain>();
  return (data: ThrongWorkerRequest) => {
    if (data.type === 'event') {
      events.set(data.id, {
        event: data.event,
        grounds: new Map([[data.event.id, groundForRoute(data.event)]]),
      });
      return;
    }
    if (data.type === 'terrain') {
      const blocked = new FrozenPolygonIndex(data.blocked);
      terrains.set(data.id, {
        ref: data.ref,
        blocked,
        hard: data.hard ? new FrozenPolygonIndex(data.hard) : blocked,
      });
      for (const id of terrains.keys()) {
        if (terrains.size <= THRONG_WORKER_TERRAINS) break;
        terrains.delete(id);
      }
      return;
    }
    try {
      const entry = events.get(data.event);
      if (!entry) throw new Error(`crowd event ${data.event} not loaded`);
      const terrain = data.terrain ? terrains.get(data.terrain) : undefined;
      if (data.terrain && !terrain) throw new Error(`crowd terrain ${data.terrain} not loaded`);
      const chunk = buildFieldChunk(
        entry.event,
        data.index,
        terrain &&
          ((toCell) =>
            makeCellGuard(
              terrain.ref,
              { roads: NONE, forbidden: NONE },
              NONE,
              toCell,
              entry.grounds,
              terrain.blocked,
              terrain.hard,
              true,
            )),
      );
      const transfer = chunk
        ? [chunk.kind, chunk.blocks, chunk.heading, chunk.along, chunk.clear].flatMap((a) =>
            a ? [a.buffer as ArrayBuffer] : [],
          )
        : [];
      post({ request: data.request, chunk }, transfer);
    } catch (error) {
      post({ request: data.request, error: String(error) }, []);
    }
  };
}
