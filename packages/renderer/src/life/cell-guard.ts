import type { TileId } from '../tiles';
import { tileToLngLat } from '../raster/geometry';
import type { Body } from './occupancy';
import { isWalker } from './config';
import type { VisibleAgent } from './simulate';

type Hits = { hits(bodies: readonly Body[]): boolean };

/** Whole-cell clearance shared by the inline world and received terrain snapshots. */
export function makeCellGuard(
  ref: { tile: TileId; perMeter: number },
  access: { roads: Hits; forbidden: Hits },
  trees: Hits,
  toCell: (lng: number, lat: number) => [number, number],
) {
  const [c0, r0] = toCell(...tileToLngLat(ref.tile, { x: 0, y: 0 }));
  const [c1, r1] = toCell(...tileToLngLat(ref.tile, { x: ref.perMeter, y: ref.perMeter }));
  const width = 1 / (c1 - c0),
    height = 1 / (r1 - r0);
  const body: Body = { x: 0, y: 0, hx: 1, hy: 0, length: width, width: height };
  const sample = [body];
  return (agent: VisibleAgent, col: number, row: number) => {
    if (agent.aboard) return true;
    body.x = (col + 0.5 - c0) * width;
    body.y = (row + 0.5 - r0) * height;
    if (isWalker(agent.kind))
      return !(agent.vehicle !== 'cart' ? access.forbidden : access.roads).hits(sample);
    return agent.kind !== 'vehicle' || !agent.parked || !agent.vehicle || !trees.hits(sample);
  };
}
