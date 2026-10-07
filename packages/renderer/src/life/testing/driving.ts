import { metersPerUnit } from '../../raster/geometry';
import { LifeBuilder, LifeLine } from '../geometry';
import { TileLife, type LifeEnv, type Mover } from '../simulate';
import { left } from './continuity';

export const driveTile = left;
export const drivePm = 1 / metersPerUnit(driveTile);

/** Clear road with controlled traffic and no incidental local scenes. */
export function driveRoad(
  seed = 1,
  bend = 0,
  kind: LifeLine = LifeLine.roadMajor,
  oneway: 0 | 1 = 0,
) {
  const b = new LifeBuilder();
  const points = [
    { x: 0, y: 2000 },
    { x: 3000, y: 2000 },
  ];
  if (bend) points.push({ x: 3000 + 1000 * Math.cos(bend), y: 2000 + 1000 * Math.sin(bend) });
  b.line(points, kind, 14, 77, oneway);
  const life = new TileLife(driveTile, b.finish(), seed);
  life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
  life.flocks.length = life.scenes.sites.length = 0;
  return life;
}

export function driveMover(life: TileLife, x = 1000, speed = 8, rank = 0.3): Mover {
  const m: Mover = {
    kind: 'vehicle',
    vehicle: 'car',
    line: 0,
    from: 0,
    dir: 1,
    d: x,
    x,
    y: 2000,
    hx: 1,
    hy: 0,
    speed: speed * life.perMeter,
    v: speed * life.perMeter,
    paint: 0,
    lane: 0,
    pause: 0,
    rank,
  };
  life.movers.push(m);
  return m;
}

export const driveStep = (life: TileLife, rain = 0, env: Omit<LifeEnv, 'rain'> = {}) =>
  life.step(0.1, undefined, undefined, undefined, { ...env, rain });

export const driveStreams = (life: TileLife) => life as unknown as { rushRng: () => number };
