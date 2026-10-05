import type { TileId } from '../tiles';
import { tileToLngLat } from '../raster/geometry';
import type { Body } from './occupancy';
import { isWalker } from './config';
import type { VisibleAgent } from './simulate';
import { eventGroundAllows, type EventGround } from './ground-events';

type Hits = { hits(bodies: readonly Body[]): boolean };

/** Whole-cell clearance shared by the inline world and received terrain snapshots. */
export function makeCellGuard(
  ref: { tile: TileId; perMeter: number },
  access: { roads: Hits; forbidden: Hits },
  trees: Hits,
  toCell: (lng: number, lat: number) => [number, number],
  grounds?: ReadonlyMap<string, EventGround>,
) {
  const [c0, r0] = toCell(...tileToLngLat(ref.tile, { x: 0, y: 0 }));
  const [c1, r1] = toCell(...tileToLngLat(ref.tile, { x: ref.perMeter, y: ref.perMeter }));
  const width = 1 / (c1 - c0),
    height = 1 / (r1 - r0);
  const body: Body = { x: 0, y: 0, hx: 1, hy: 0, length: width, width: height };
  const sample = [body];
  const points: [number, number][] = Array.from({ length: 9 }, () => [0, 0]);
  return (agent: VisibleAgent, col: number, row: number) => {
    if (agent.aboard) return true;
    if (agent.eventGround) {
      const ground = grounds?.get(agent.eventGround);
      if (!ground) return false;
      let i = 0;
      for (const dx of [0, 0.5, 1])
        for (const dy of [0, 0.5, 1]) {
          const x = (col + dx - c0) * width * ref.perMeter;
          const y = (row + dy - r0) * height * ref.perMeter;
          const q = tileToLngLat(ref.tile, { x, y }),
            point = points[i++]!;
          point[0] = q[0];
          point[1] = q[1];
        }
      return eventGroundAllows(ground, points);
    }
    body.x = (col + 0.5 - c0) * width;
    body.y = (row + 0.5 - r0) * height;
    if (isWalker(agent.kind))
      return !(agent.vehicle !== 'cart' ? access.forbidden : access.roads).hits(sample);
    return agent.kind !== 'vehicle' || !agent.parked || !agent.vehicle || !trees.hits(sample);
  };
}
