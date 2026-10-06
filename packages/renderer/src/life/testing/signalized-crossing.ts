import { LifeBuilder, LifeLine } from '../geometry';
import { finalizeControlledCrossings } from '../crossing-geometry';
import { stripRing } from '../terrain';
import { metersPerUnit, tileToLngLat } from '../../raster/geometry';
import { type LifeWorld, type Mover } from '../simulate';
import { worldTiles } from './scenarios';

export const controlledTile = { z: 16, x: 55192, y: 30266 };
export function signalizedCrossingEntry() {
  const pm = 1 / metersPerUnit(controlledTile),
    b = new LifeBuilder();
  const at = (x: number, y: number) => ({ x: 2000 + x * pm, y: 2000 + y * pm });
  b.line([at(-20, 0), at(20, 0)], LifeLine.roadMajor, 10);
  b.line([at(-6, -8), at(0, -8), at(0, 8)], LifeLine.path, 3, 42);
  const road = [stripRing(at(-20, 0), at(20, 0), 5 * pm)];
  b.area('carriageway', road);
  b.area('crossing', [stripRing(at(-1.5, 0), at(1.5, 0), 6.5 * pm)]);
  b.controlledCrossing({
    id: 'controlled-crossing',
    anchor: at(0, 0),
    bearing: 90,
    width: 10,
    lineId: 42,
    controller: {
      id: 'control',
      at: tileToLngLat(controlledTile, at(-10, 0)),
      seed: 7,
      midBlock: false,
      walk: 'a',
    },
  });
  const life = b.finish();
  finalizeControlledCrossings(life.controlledCrossings!, [road], pm);
  life.navigationOnly = new Uint8Array(life.kinds.length).fill(1);
  return { tile: controlledTile, key: 'signalized-crossing', life };
}
export function seedSignalizedCrossing(world: LifeWorld) {
  (world as unknown as { clock: number }).clock = 25;
  const life = worldTiles(world).get('signalized-crossing')!,
    pm = life.perMeter;
  life.movers.length = life.gatherers.length = life.parked.length = life.stalls.length = 0;
  life.scenes.sites.length = 0;
  const m: Mover = {
    kind: 'person',
    line: 1,
    from: 2,
    dir: 1,
    d: 0,
    x: 2000 - 6 * pm,
    y: 2000 - 8 * pm,
    hx: 1,
    hy: 0,
    speed: 2 * pm,
    pause: 0,
    paint: 0,
    lane: 0,
    rank: 0,
    group: [{ figure: 'adult', shirt: 3, umbrella: 0, canopy: 0, lateral: 0, back: 0, step: 0 }],
  };
  life.movers.push(m);
  return { life, m };
}
