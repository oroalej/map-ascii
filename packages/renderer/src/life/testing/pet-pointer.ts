import { tileToLngLat } from '../../raster/geometry';
import { LifeLine } from '../geometry';
import { LifeWorld, type Mover } from '../simulate';
import { continuityTile, continuityMover, left } from './continuity';

export function petPointer(kind: 'cat' | 'dog', observer = true) {
  const entry = continuityTile(left, LifeLine.path),
    world = new LifeWorld(undefined, undefined, undefined, true, observer);
  world.sync([entry]);
  const life = world.resident(entry.key)!;
  life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
  life.flocks.length = life.scenes.sites.length = 0;
  const pet = continuityMover(life, 2000, kind);
  pet.speed = 0.6 * life.perMeter;
  pet.v = undefined;
  life.movers.push(pet);
  const at = (dx = 0, dy = 0) =>
    tileToLngLat(left, {
      x: pet.x + dx * life.perMeter,
      y: pet.y + dy * life.perMeter,
    });
  const step = (pointer?: readonly [number, number], rest?: number, dt = 0.1) => {
    world.setEmojiView([19, 1, at()]);
    world.step(
      dt,
      undefined,
      19,
      undefined,
      undefined,
      { rain: 0, minutes: 720 },
      1,
      1.8,
      1,
      pointer,
      rest,
    );
  };
  const stream = life as unknown as { catRng: () => number; dogRng: () => number };
  return { world, life, pet, at, step, stream };
}

export function addPet(
  life: ReturnType<typeof petPointer>['life'],
  source: Mover,
  dx: number,
  rank: number,
) {
  const pet = {
    ...source,
    x: source.x + dx * life.perMeter,
    d: source.d + dx * life.perMeter,
    rank,
  };
  life.movers.push(pet);
  return pet;
}
