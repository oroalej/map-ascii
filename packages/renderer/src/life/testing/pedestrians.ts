import { metersPerUnit } from '../../raster/geometry';
import { LifeBuilder, LifeLine } from '../geometry';
import { LifeWorld, type Mover } from '../simulate';
import { worldTiles } from './scenarios';

export const pedestrianTile = { z: 16, x: 55192, y: 30266 };
export function pedestrianEntry() {
  const pm = 1 / metersPerUnit(pedestrianTile),
    b = new LifeBuilder();
  b.line(
    [
      { x: 0, y: 2000 },
      { x: 4096, y: 2000 },
    ],
    LifeLine.roadMajor,
    14,
  );
  b.line(
    [
      { x: 2000, y: 2000 - 40 * pm },
      { x: 2000, y: 2000 + 40 * pm },
    ],
    LifeLine.path,
    3,
  );
  b.area('crossing', [
    [
      { x: 2000 - 1.5 * pm, y: 2000 - 7 * pm },
      { x: 2000 + 1.5 * pm, y: 2000 - 7 * pm },
      { x: 2000 + 1.5 * pm, y: 2000 + 7 * pm },
      { x: 2000 - 1.5 * pm, y: 2000 + 7 * pm },
    ],
  ]);
  return { key: 'pedestrian-crossing', tile: pedestrianTile, life: b.finish() };
}
export function seedPedestrians(world: LifeWorld, y = -5) {
  const life = worldTiles(world).get('pedestrian-crossing')!;
  life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
  life.scenes.sites.length = 0;
  const pm = life.perMeter;
  const car: Mover = {
    kind: 'vehicle',
    vehicle: 'car',
    line: 0,
    from: 0,
    dir: 1,
    d: 2000 - 15 * pm,
    x: 2000 - 15 * pm,
    y: 2000,
    hx: 1,
    hy: 0,
    speed: 8 * pm,
    v: 8 * pm,
    paint: 0,
    lane: 0,
    pause: 0,
    rank: 0,
  };
  const human: Mover = {
    kind: 'person',
    line: 1,
    from: 2,
    dir: 1,
    d: (40 + y) * pm,
    x: 2000,
    y: 2000 + y * pm,
    hx: 0,
    hy: 1,
    speed: 0,
    paint: 0,
    lane: 0,
    pause: 100,
    rank: 0,
    group: [{ figure: 'adult', shirt: 3, umbrella: 0, canopy: 0, lateral: 0, back: 0, step: 0 }],
  };
  life.movers.push(car, human);
  return { life, car, human };
}
export function pedestrianWorld(y = -5) {
  const entry = pedestrianEntry(),
    world = new LifeWorld();
  world.sync([entry]);
  return { world, entry, ...seedPedestrians(world, y) };
}
