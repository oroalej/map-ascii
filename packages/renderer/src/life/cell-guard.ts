import type { TileId } from '../tiles';
import { tileToLngLat } from '../raster/geometry';
import type { Body } from './occupancy';
import { isWalker } from './config';
import type { VisibleAgent } from './simulate';
import { eventGroundAllows, type EventGround } from './ground-events';

type Hits = { hits(bodies: readonly Body[]): boolean };
const CELL_OFFSETS = [0, 0.5, 1] as const;
const CACHE_CELLS = 4096;
type PermissionCache = {
  tile: TileId;
  perMeter: number;
  width: number;
  height: number;
  columns: Map<number, Map<number, boolean>>;
  cells: number;
};
const NO_BLOCKED: Hits = { hits: () => false };
// Prepared terrain and route grounds are immutable; weak keys retire their caches too.
const permissions = new WeakMap<EventGround, WeakMap<Hits, PermissionCache>>();

/** Whole-cell clearance shared by the inline world and received terrain snapshots. */
export function makeCellGuard(
  ref: { tile: TileId; perMeter: number },
  access: { roads: Hits; forbidden: Hits },
  trees: Hits,
  toCell: (lng: number, lat: number) => [number, number],
  grounds?: ReadonlyMap<string, EventGround>,
  blocked?: Hits,
  hardBlocked?: Hits,
) {
  const [c0, r0] = toCell(...tileToLngLat(ref.tile, { x: 0, y: 0 }));
  const [c1, r1] = toCell(...tileToLngLat(ref.tile, { x: ref.perMeter, y: ref.perMeter }));
  const width = 1 / (c1 - c0),
    height = 1 / (r1 - r0);
  const body: Body = { x: 0, y: 0, hx: 1, hy: 0, length: width, width: height };
  const sample = [body];
  const points: [number, number][] = Array.from({ length: 9 }, () => [0, 0]);
  const ordinaryTerrain = blocked ?? NO_BLOCKED;
  return (agent: VisibleAgent, col: number, row: number) => {
    if (agent.aboard) return true;
    if (agent.eventGround) {
      const base = grounds?.get(agent.eventGround);
      const ground =
        agent.eventRole === 'seated'
          ? base?.seated
          : agent.eventRole === 'altar'
            ? base?.altar
            : base;
      const terrain = agent.eventRole ? (hardBlocked ?? ordinaryTerrain) : ordinaryTerrain;
      if (!ground) return false;
      let frames = permissions.get(ground);
      if (!frames) permissions.set(ground, (frames = new WeakMap<Hits, PermissionCache>()));
      let cache = frames.get(terrain);
      if (
        !cache ||
        cache.tile.z !== ref.tile.z ||
        cache.tile.x !== ref.tile.x ||
        cache.tile.y !== ref.tile.y ||
        cache.perMeter !== ref.perMeter ||
        cache.width !== width ||
        cache.height !== height
      ) {
        cache = {
          tile: { ...ref.tile },
          perMeter: ref.perMeter,
          width,
          height,
          columns: new Map<number, Map<number, boolean>>(),
          cells: 0,
        };
        frames.set(terrain, cache);
      }
      // Exact tile-relative offsets reuse integer-cell pans, but never alias a shifted
      // cell footprint, another zoom, metric frame, route or blocked-terrain snapshot.
      const x = col - c0,
        y = row - r0;
      const saved = cache.columns.get(x)?.get(y);
      if (saved !== undefined) return saved;
      if (cache.cells >= CACHE_CELLS) {
        cache.columns.clear();
        cache.cells = 0;
      }
      let i = 0;
      for (const dx of CELL_OFFSETS)
        for (const dy of CELL_OFFSETS) {
          const x = (col + dx - c0) * width * ref.perMeter;
          const y = (row + dy - r0) * height * ref.perMeter;
          const q = tileToLngLat(ref.tile, { x, y }),
            point = points[i++]!;
          point[0] = q[0];
          point[1] = q[1];
        }
      body.x = (col + 0.5 - c0) * width;
      body.y = (row + 0.5 - r0) * height;
      const allowed =
        !terrain.hits(sample) &&
        eventGroundAllows(ground, points, [points[0]!, points[6]!, points[8]!, points[2]!]);
      let rows = cache.columns.get(x);
      if (!rows) cache.columns.set(x, (rows = new Map<number, boolean>()));
      rows.set(y, allowed);
      cache.cells++;
      return allowed;
    }
    body.x = (col + 0.5 - c0) * width;
    body.y = (row + 0.5 - r0) * height;
    if (isWalker(agent.kind))
      return !(agent.vehicle !== 'cart' ? access.forbidden : access.roads).hits(sample);
    return agent.kind !== 'vehicle' || !agent.parked || !agent.vehicle || !trees.hits(sample);
  };
}
