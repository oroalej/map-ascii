import type { TileId } from '../../tiles';
import { LifeBuilder, LifeLine } from '../geometry';
import type { LifeTile, Mover, TileLife } from '../simulate';

export const parent = { z: 15, x: 27596, y: 15133 };
export const left = { z: 16, x: 55192, y: 30266 };
export const right = { ...left, x: left.x + 1 };
export function continuityTile(
  tile: TileId,
  kind: LifeLine = LifeLine.roadMajor,
  id = 77,
  offset = 0,
  oneway: -1 | 0 | 1 = 0,
): LifeTile {
  const b = new LifeBuilder();
  const y = 1000 * 2 ** (tile.z - parent.z) + offset;
  b.line(
    [
      { x: -100, y },
      { x: 4196, y },
    ],
    kind,
    6,
    id,
    oneway,
  );
  return { key: `${tile.z}/${tile.x}/${tile.y}`, tile, life: b.finish() };
}
export function continuityMover(life: TileLife, x: number, kind: Mover['kind'] = 'vehicle'): Mover {
  const y = life.geo.coords[1]!;
  return {
    kind,
    line: 0,
    from: 0,
    dir: 1,
    d: x + 100,
    speed: 10 * life.perMeter,
    v: 3 * life.perMeter,
    vehicle: kind === 'vehicle' ? 'car' : kind === 'boat' ? 'rowboat' : undefined,
    paint: 3,
    lane: 0,
    pause: 0,
    rank: 0,
    x,
    y,
    hx: 1,
    hy: 0,
    routing: kind === 'vehicle' ? { seed: 123, turns: 7 } : undefined,
    train:
      kind === 'train'
        ? {
            cars: ['locomotive', 'coach'],
            trail: [x - 20, y, x - 40, y],
            reverse: false,
            edge: false,
            stopX: x - 60,
            stopY: y,
          }
        : undefined,
  };
}
