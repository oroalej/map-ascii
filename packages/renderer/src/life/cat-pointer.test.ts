import { expect, it } from 'vitest';
import { petPointer } from './testing/pet-pointer';
import { POINTER } from './config';

it.each([false, true])(
  'bolts from rest/groom=%s, reverses safely and delivers first fear',
  (grooming) => {
    const f = petPointer('cat');
    f.pet.pause = 20;
    f.pet.grooming = grooming;
    const pointer = f.at(1);
    f.step(pointer);
    expect(f.pet.pause).toBe(0);
    expect(f.pet.grooming).toBe(false);
    expect(f.pet.hx).toBe(-1);
    const start = f.pet.x;
    f.stream.catRng = () => 0; // Ambient idle must not interrupt the flee episode.
    f.step(pointer);
    expect(f.pet.x).toBeLessThan(start);
    for (let i = 0; i < 4; i++) f.step(pointer);
    expect(f.life.emoji.cue(f.pet)?.mood).toBe('scared');
    expect(f.life.roadTerrain.access.allows(f.life.groundBodies(f.pet))).toBe(true);
    for (let i = 0; i < POINTER.fleeSeconds * 10; i++) f.step(pointer);
    expect(f.pet.pause).toBeGreaterThan(0);
    f.step(undefined);
    expect(f.pet.pause).toBeGreaterThan(0);
  },
);

it('rearms only after leaving reach and clears the physical episode on pointer leave', () => {
  const f = petPointer('cat');
  f.pet.pause = 20;
  f.step(f.at(1));
  f.step();
  f.stream.catRng = () => 0;
  f.step();
  expect(f.pet.pause).toBeGreaterThan(0);
  const before = f.pet.x;
  f.step(f.at(1));
  expect(f.pet.pause).toBe(0);
  expect(f.pet.x).not.toBe(before);
});

it('preserves pointer-free state and keeps observer admission independent of physics', () => {
  const a = petPointer('cat'),
    b = petPointer('cat', false);
  a.pet.pause = b.pet.pause = 20;
  for (let i = 0; i < 40; i++) {
    const pointer = i < 20 ? a.at(1) : undefined;
    a.step(pointer);
    b.step(pointer);
    expect(b.pet).toEqual(a.pet);
  }
});
