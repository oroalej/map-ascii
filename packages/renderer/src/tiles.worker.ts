/**
 * Tile worker: fetches tiles from the PMTiles archive (HTTP range requests), decodes them, and
 * converts them to typed arrays for the cell pass, off the main thread.
 */
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { PMTiles } from 'pmtiles';
import { archiveSource } from './range-cache';
import {
  buildTileGeometry,
  buildResidentialSites,
  createIdRegistry,
  transferables,
} from './raster/geometry';
import type { WorkerRequest, WorkerResponse, ResidentialResponse } from './tiles';
import { prepareMemorialSites } from './life/seasonal-candles';

// The package compiles with the DOM lib, where `self` is a Window; this file runs in a worker.
const scope = self as unknown as {
  postMessage(message: WorkerResponse | ResidentialResponse, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};

let archive: PMTiles | undefined;
let maxZoom: number | undefined;
let fireworks = false;
let fireworksActive = false;
let memorials = false;
let folklore = false;
const registry = createIdRegistry();

async function handle(request: WorkerRequest) {
  if (request.type === 'init') {
    fireworks = request.fireworks === true;
    memorials = request.memorials === true;
    folklore = request.folklore === true;
    fireworksActive = fireworks && request.fireworksActive === true;
    archive = new PMTiles(archiveSource(request.url));
    const h = await archive.getHeader();
    maxZoom = h.maxZoom;
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
  if (request.type === 'fireworks') {
    fireworksActive = fireworks && request.active;
    return;
  }
  const { key, z, x, y } = request;
  if (!archive) throw new Error('tile requested before init');
  const response = await archive.getZxy(z, x, y);
  if (!response) {
    scope.postMessage(
      request.type === 'residential'
        ? { type: 'residential', key, sites: new Float64Array(), newFeatures: [] }
        : { type: 'tile', key, geometry: null, newFeatures: [] },
    );
    return;
  }
  const start = performance.now();
  const tile = new VectorTile(new PbfReader(new Uint8Array(response.data)));
  if (request.type === 'residential') {
    const sites = fireworks
      ? buildResidentialSites(tile.layers, registry, { z, x, y })
      : new Float64Array();
    scope.postMessage({ type: 'residential', key, sites, newFeatures: registry.takeNew() }, [
      sites.buffer as ArrayBuffer,
    ]);
    return;
  }
  const geometry = buildTileGeometry(
    tile.layers,
    registry,
    { z, x, y },
    maxZoom,
    fireworksActive,
    folklore,
  );
  if (memorials && z === maxZoom) prepareMemorialSites({ z, x, y }, geometry.life);
  const decodeMs = performance.now() - start;
  scope.postMessage(
    { type: 'tile', key, geometry, newFeatures: registry.takeNew(), decodeMs },
    transferables(geometry),
  );
}

scope.onmessage = (event) => {
  const request = event.data;
  handle(request).catch((err: unknown) => {
    scope.postMessage({
      type: 'error',
      key: request.type === 'init' || request.type === 'fireworks' ? null : request.key,
      message: err instanceof Error ? err.message : String(err),
    });
  });
};
