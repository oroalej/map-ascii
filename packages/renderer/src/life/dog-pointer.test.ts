import { expect, it } from 'vitest';
import { addPet, petPointer } from './testing/pet-pointer';
import { continuityTile, right, continuityMover } from './testing/continuity';
import { LifeLine } from './geometry';
import { metersPerUnit, tileToLngLat } from '../raster/geometry';
import { left } from './testing/continuity';

it('selects the nearest two dogs across a seam, with stable rank ties', () => {
  const f = petPointer('dog'),
    second = continuityTile(right, LifeLine.path);
  f.world.sync([f.entry, second]);
  const other = f.world.resident(second.key)!;
  other.movers.length = other.gatherers.length = other.stalls.length = other.parked.length = 0;
  other.flocks.length = 0;
  f.pet.x = 4092;
  f.pet.d = 4192;
  const dog = continuityMover(other, 3, 'dog');
  dog.speed = 0.6 * other.perMeter;
  other.movers.push(dog);
  const far = addPet(f.life, f.pet, -8, 0.8);
  f.step(tileToLngLat(f.life.tile, { x: 4095, y: f.pet.y }));
  expect([f.pet, dog].every((m) => !!m.pointerDog)).toBe(true);
  expect(far.pointerDog).toBeUndefined();
});

it('overrides ambient idles, turns toward the cursor, safely sits and releases', () => {
  const f = petPointer('dog');
  f.pet.pause = 100;
  f.pet.lying = true;
  f.stream.dogRng = () => 0;
  const pointer = f.at(-5);
  f.step(pointer);
  expect(f.pet.hx).toBe(-1);
  expect(f.pet.pause).toBe(0);
  for (let i = 0; i < 30; i++) f.step(pointer);
  expect(f.pet.pointerDog).toBe('sit');
  expect(f.life.emoji.cue(f.pet)?.mood).toBe('happy');
  const x = f.pet.x;
  for (let i = 0; i < 20; i++) f.step(pointer);
  expect(f.pet.x).toBe(x);
  expect(f.life.roadTerrain.access.allows(f.life.groundBodies(f.pet))).toBe(true);
  f.step(f.at(-8));
  expect(f.pet.pointerDog).toBe('follow');
  f.step();
  expect(f.pet.pointerDog).toBeUndefined();
});

it('cannot leave its walking line for a disconnected target and preserves pointer-free state', () => {
  const a = petPointer('dog'),
    b = petPointer('dog');
  for (let i = 0; i < 20; i++) {
    a.step();
    b.step();
  }
  expect(a.pet).toEqual(b.pet);
  for (let i = 0; i < 80; i++) {
    a.step(a.at(0, 6));
    expect(a.pet.y).toBe(2000);
    expect(a.life.roadTerrain.access.allows(a.life.groundBodies(a.pet))).toBe(true);
    expect(a.pet.line).toBe(0);
  }
});

it.each(['off-path', 'dead-end'] as const)(
  'waits without heading reversals at a fixed unreachable %s target and releases normally',
  (target) => {
    const end = target === 'dead-end' ? 2000 + 4 / metersPerUnit(left) : 4196;
    const f = petPointer('dog', true, end),
      pointer = f.at(target === 'dead-end' ? 8 : 3, target === 'dead-end' ? 0 : 6);
    for (let i = 0; i < 50; i++) f.step(pointer);
    const x = f.pet.x,
      heading = [f.pet.hx, f.pet.hy];
    for (let i = 0; i < 30; i++) {
      f.step(pointer);
      expect(f.pet.x).toBe(x);
      expect([f.pet.hx, f.pet.hy]).toEqual(heading);
      expect(f.life.roadTerrain.access.allows(f.life.groundBodies(f.pet))).toBe(true);
    }
    expect(f.life.emoji.cue(f.pet)?.mood).not.toBe('happy');
    expect(f.pet.pointerDog).toBe('follow');
    f.stream.dogRng = () => 0.9;
    f.step();
    expect(f.pet.pointerDog).toBeUndefined();
    expect(f.pet.momentFacing).toBeUndefined();
    expect(f.pet.x).not.toBe(x);
  },
);
