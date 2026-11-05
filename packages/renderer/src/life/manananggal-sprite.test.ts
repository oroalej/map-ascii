import { expect, it } from 'vitest';
import {
  bakeSpriteSheet,
  Ink,
  SPRITE_COLUMNS,
  SPRITE_ROWS,
  SPRITE_SIZE,
  SpriteFrame,
  spriteFrameInks,
  wingLift,
} from './manananggal-sprite';

const count = (frame: Uint8Array, ink: number) => frame.filter((i) => i === ink).length;
const box = (frame: Uint8Array) => {
  let left = SPRITE_SIZE,
    right = -1,
    top = SPRITE_SIZE,
    bottom = -1;
  frame.forEach((ink, i) => {
    if (!ink) return;
    const x = i % SPRITE_SIZE,
      y = Math.floor(i / SPRITE_SIZE);
    left = Math.min(left, x);
    right = Math.max(right, x);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
  });
  return { left, right, top, bottom };
};
const frames = Array.from({ length: SpriteFrame.count }, (_, i) => spriteFrameInks(i));

it('keeps every frame clear of the frame edge, so nothing is cut off', () => {
  for (const frame of frames) {
    const { left, right, top, bottom } = box(frame);
    expect(left).toBeGreaterThan(0);
    expect(top).toBeGreaterThan(0);
    expect(right).toBeLessThan(SPRITE_SIZE - 1);
    expect(bottom).toBeLessThan(SPRITE_SIZE - 1);
  }
});

it('moves the wings through the beat, spreading wide and rising and falling', () => {
  const beat = frames.slice(SpriteFrame.flap, SpriteFrame.flap + SpriteFrame.flaps);
  expect(new Set(beat.map((f) => f.join())).size).toBe(SpriteFrame.flaps);
  for (const frame of beat) expect(box(frame).right - box(frame).left).toBeGreaterThan(32);
  const raised = beat.map((f, i) => ({ top: box(f).top, lift: wingLift(i / SpriteFrame.flaps) }));
  const highest = raised.reduce((a, b) => (b.lift > a.lift ? b : a));
  const lowest = raised.reduce((a, b) => (b.lift < a.lift ? b : a));
  expect(highest.top).toBeLessThan(lowest.top);
});

it('draws the same figure on both sides of the wings', () => {
  const frame = frames[SpriteFrame.flap + 2]!;
  let wings = 0,
    matched = 0;
  for (let y = 0; y < SPRITE_SIZE; y++)
    for (let x = 0; x < 16; x++) {
      const a = frame[y * SPRITE_SIZE + x]!,
        b = frame[y * SPRITE_SIZE + SPRITE_SIZE - 1 - x]!;
      if (a || b) wings++;
      if (a === b && a) matched++;
    }
  expect(matched / wings).toBeGreaterThan(0.95);
});

it('shows what makes it a manananggal: a face, fangs, membrane, and entrails', () => {
  const flying = frames[SpriteFrame.flap]!;
  expect(count(flying, Ink.eye)).toBeGreaterThanOrEqual(4);
  expect(count(flying, Ink.fang)).toBeGreaterThanOrEqual(2);
  expect(count(flying, Ink.wing)).toBeGreaterThan(100);
  expect(count(flying, Ink.gut)).toBe(0);
  expect(count(frames[SpriteFrame.trail]!, Ink.gut)).toBeGreaterThan(20);
  expect(box(frames[SpriteFrame.trail]!).bottom).toBeGreaterThan(SPRITE_SIZE * 0.85);
});

it('folds to a narrower cloak on a roof, tongue let down, with a blink', () => {
  const spread = box(frames[SpriteFrame.flap]!);
  const perched = frames[SpriteFrame.perch]!;
  expect(box(perched).right - box(perched).left).toBeLessThan((spread.right - spread.left) * 0.75);
  expect(count(perched, Ink.tongue)).toBeGreaterThan(20);
  expect(count(frames[SpriteFrame.flap]!, Ink.tongue)).toBe(0);
  expect(count(perched, Ink.eye)).toBeGreaterThan(0);
  expect(count(frames[SpriteFrame.perch + SpriteFrame.perches - 1]!, Ink.eye)).toBe(0);
  const folding = Array.from({ length: SpriteFrame.folds }, (_, i) => {
    const b = box(frames[SpriteFrame.fold + i]!);
    return b.right - b.left;
  });
  for (let i = 1; i < folding.length; i++) expect(folding[i]!).toBeLessThan(folding[i - 1]!);
});

it('leaves legs behind in one still frame, with a raw waist and no wings', () => {
  const legs = frames[SpriteFrame.lower]!;
  expect(count(legs, Ink.gut)).toBeGreaterThan(0);
  expect(count(legs, Ink.skin)).toBeGreaterThan(30);
  expect(count(legs, Ink.wing)).toBe(0);
  expect(count(legs, Ink.eye)).toBe(0);
  expect(SpriteFrame.lower).toBe(SpriteFrame.count - 1);
});

it('bakes the frames into a sheet with clear backgrounds and opaque paint', () => {
  const { width, height, data } = bakeSpriteSheet();
  expect(width).toBe(SPRITE_COLUMNS * SPRITE_SIZE);
  expect(height).toBe(SPRITE_ROWS * SPRITE_SIZE);
  expect(data).toHaveLength(width * height * 4);
  expect(data[3]).toBe(0);
  // The lower half's frame, on the last row: its middle is painted.
  const ox = (SpriteFrame.lower % SPRITE_COLUMNS) * SPRITE_SIZE + 26,
    oy = Math.floor(SpriteFrame.lower / SPRITE_COLUMNS) * SPRITE_SIZE + 24;
  expect(data[(oy * width + ox) * 4 + 3]).toBe(255);
});
