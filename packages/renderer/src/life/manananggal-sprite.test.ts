import { expect, it } from 'vitest';
import { SPRITE_COLUMNS, SPRITE_ROWS, SPRITE_SIZE, SpriteFrame } from './manananggal-frames';
import { bakeSpriteSheet, Ink, spriteFrameInks, wingBeatShape } from './manananggal-sprite';

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
/** The mean height of an ink in a frame, where the middle row is 0 and the head end negative. */
const meanY = (frame: Uint8Array, ink: number) => {
  let total = 0,
    n = 0;
  frame.forEach((value, i) => {
    if (value !== ink) return;
    total += Math.floor(i / SPRITE_SIZE) + 0.5 - SPRITE_SIZE / 2;
    n++;
  });
  return total / n;
};
const frames = Array.from({ length: SpriteFrame.count }, (_, i) => spriteFrameInks(i));

it('keeps every frame inside the circle it turns in, so no heading cuts it off', () => {
  for (const frame of frames)
    frame.forEach((ink, i) => {
      if (!ink) return;
      const x = (i % SPRITE_SIZE) + 0.5 - SPRITE_SIZE / 2,
        y = Math.floor(i / SPRITE_SIZE) + 0.5 - SPRITE_SIZE / 2;
      expect(Math.hypot(x, y)).toBeLessThanOrEqual(SPRITE_SIZE / 2);
    });
});

it('draws it from above, head first and with no face, its entrails trailing behind', () => {
  for (let i = 0; i < SpriteFrame.flaps; i++) {
    const frame = frames[SpriteFrame.flap + i]!;
    // The crown of the head is ahead of the middle, its parting running back from there.
    expect(meanY(frame, Ink.hairLight)).toBeLessThan(0);
    expect(count(frame, Ink.skinShade)).toBeGreaterThan(0);
    expect(count(frame, Ink.gut)).toBe(0);
  }
  for (let i = 0; i < SpriteFrame.trails; i++) {
    const trail = frames[SpriteFrame.trail + i]!;
    expect(count(trail, Ink.gut)).toBeGreaterThan(20);
    expect(meanY(trail, Ink.gut)).toBeGreaterThan(8);
  }
  expect(Object.keys(Ink)).not.toContain('eye');
});

it('shows a beat from above as the wings narrowing and reaching ahead and back', () => {
  const beat = frames.slice(SpriteFrame.flap, SpriteFrame.flap + SpriteFrame.flaps);
  expect(new Set(beat.map((f) => f.join())).size).toBeGreaterThanOrEqual(SpriteFrame.flaps - 2);
  const widths = beat.map((f) => box(f).right - box(f).left);
  expect(Math.max(...widths)).toBeGreaterThan(36);
  expect(Math.max(...widths) - Math.min(...widths)).toBeGreaterThanOrEqual(6);
  const shapes = beat.map((_, i) => wingBeatShape(i / SpriteFrame.flaps));
  expect(Math.max(...shapes.map((s) => s.sweep))).toBeGreaterThan(0.1);
  expect(Math.min(...shapes.map((s) => s.sweep))).toBeLessThan(-0.1);
});

it('draws the same figure on both sides of its wings', () => {
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

it('folds to a narrow cloak on a roof, with its tongue let out ahead of its head', () => {
  const spread = box(frames[SpriteFrame.flap]!);
  const perched = frames[SpriteFrame.perch]!;
  expect(box(perched).right - box(perched).left).toBeLessThan((spread.right - spread.left) * 0.6);
  expect(count(perched, Ink.tongue)).toBeGreaterThan(15);
  expect(meanY(perched, Ink.tongue)).toBeLessThan(-12);
  expect(count(frames[SpriteFrame.flap]!, Ink.tongue)).toBe(0);
  const sway = Array.from({ length: SpriteFrame.perches }, (_, i) =>
    frames[SpriteFrame.perch + i]!.join(),
  );
  expect(new Set(sway).size).toBeGreaterThan(1);
  const folding = Array.from({ length: SpriteFrame.folds }, (_, i) => {
    const b = box(frames[SpriteFrame.fold + i]!);
    return b.right - b.left;
  });
  for (let i = 1; i < folding.length; i++) expect(folding[i]!).toBeLessThan(folding[i - 1]!);
});

it('leaves legs behind in one still frame, the raw waist uppermost and feet past the skirt', () => {
  const legs = frames[SpriteFrame.lower]!;
  const at = (x: number, y: number) =>
    legs[(y + SPRITE_SIZE / 2) * SPRITE_SIZE + x + SPRITE_SIZE / 2]!;
  expect([Ink.gut, Ink.gutDark]).toContain(at(0, 0));
  expect(count(legs, Ink.dress)).toBeGreaterThan(50);
  expect(meanY(legs, Ink.skin)).toBeGreaterThan(6);
  expect(count(legs, Ink.wing)).toBe(0);
  expect(SpriteFrame.lower).toBe(SpriteFrame.count - 1);
});

it('bakes the frames into a sheet with clear backgrounds and opaque paint', () => {
  const { width, height, data } = bakeSpriteSheet();
  expect(width).toBe(SPRITE_COLUMNS * SPRITE_SIZE);
  expect(height).toBe(SPRITE_ROWS * SPRITE_SIZE);
  expect(data).toHaveLength(width * height * 4);
  expect(data[3]).toBe(0);
  // The middle of the legs' frame, on the last row, is painted.
  const ox = (SpriteFrame.lower % SPRITE_COLUMNS) * SPRITE_SIZE + SPRITE_SIZE / 2,
    oy = Math.floor(SpriteFrame.lower / SPRITE_COLUMNS) * SPRITE_SIZE + SPRITE_SIZE / 2;
  expect(data[(oy * width + ox) * 4 + 3]).toBe(255);
});
