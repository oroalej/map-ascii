/**
 * Tile worker: fetches tiles from the PMTiles archive (HTTP range requests), decodes them, and
 * converts them to typed arrays for the cell pass, off the main thread.
 */
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { PMTiles } from 'pmtiles';
import { buildTileGeometry, createIdRegistry, transferables } from './raster/geometry';
import type { WorkerRequest, WorkerResponse } from './tiles';

// The package compiles with the DOM lib, where `self` is a Window; this file runs in a worker.
const scope = self as unknown as {
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};

let archive: PMTiles | undefined;
const registry = createIdRegistry();

async function handle(request: WorkerRequest) {
  if (request.type === 'init') {
    archive = new PMTiles(request.url);
    const h = await archive.getHeader();
    scope.postMessage({
      type: 'header',
      header: {
        minZoom: h.minZoom,
        maxZoom: h.maxZoom,
        bounds: [h.minLon, h.minLat, h.maxLon, h.maxLat],
      },
    });
    return;
  }
  const { key, z, x, y } = request;
  if (!archive) throw new Error('tile requested before init');
  const response = await archive.getZxy(z, x, y);
  if (!response) {
    scope.postMessage({ type: 'tile', key, geometry: null, newIds: [] });
    return;
  }
  const tile = new VectorTile(new PbfReader(new Uint8Array(response.data)));
  const geometry = buildTileGeometry(tile.layers, registry);
  scope.postMessage(
    { type: 'tile', key, geometry, newIds: registry.takeNew() },
    transferables(geometry),
  );
}

scope.onmessage = (event) => {
  const request = event.data;
  handle(request).catch((err: unknown) => {
    scope.postMessage({
      type: 'error',
      key: request.type === 'tile' ? request.key : null,
      message: err instanceof Error ? err.message : String(err),
    });
  });
};
