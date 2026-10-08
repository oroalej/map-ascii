/** Messages between the main thread and crowd field workers (`throng-pool.ts`). */
import type { ProcessionRoute } from '@atlas/shared';
import type { TileId } from '../tiles';
import type { FlatPolygonIndex } from './occupancy';
import type { ThrongFieldChunk } from './throng';

/** Terrains a worker keeps; a request for a dropped one fails and is asked again. */
export const THRONG_WORKER_TERRAINS = 2;

export type ThrongWorkerRequest =
  | { type: 'event'; id: number; event: ProcessionRoute }
  | {
      type: 'terrain';
      id: number;
      ref: { tile: TileId; perMeter: number };
      blocked: FlatPolygonIndex;
      /** Absent when the hard terrain is the ordinary one. */
      hard?: FlatPolygonIndex;
    }
  /** `terrain` 0: classify without a terrain check. */
  | { type: 'chunk'; request: number; event: number; index: number; terrain: number };

export type ThrongWorkerResponse =
  { request: number; chunk: ThrongFieldChunk | null } | { request: number; error: string };
