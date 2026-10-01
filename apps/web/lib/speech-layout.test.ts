import { expect, it } from 'vitest';
import { placeSpeech } from './speech-layout';

const viewport = { width: 800, height: 600 },
  size = { width: 200, height: 60 };
it('raises a longer native line slightly when the HUD gap is too narrow', () => {
  const box = placeSpeech([494, 562], { width: 194, height: 36 }, { width: 1280, height: 720 }, [
    { left: 12, top: 549, width: 425, height: 159 },
    { left: 632, top: 535, width: 640, height: 180 },
  ]);
  expect(box).toMatchObject({ left: 397, top: 504, tail: 97, below: false });
});
it('uses a narrow gap between HUD and attribution without detaching the tail', () => {
  const box = placeSpeech([500, 600], { width: 180, height: 60 }, { width: 1280, height: 720 }, [
    { left: 0, top: 530, width: 444, height: 190 },
    { left: 636, top: 530, width: 644, height: 190 },
  ]);
  expect(box).toMatchObject({ left: 450, top: 526, tail: 50, below: false });
});
it('places a speaker tail above the actor and tries below when a panel blocks above', () => {
  const box = placeSpeech([400, 300], size, viewport, [])!;
  expect(box).toMatchObject({ left: 300, top: 226, tail: 100, below: false });
  const below = placeSpeech([400, 300], size, viewport, [
    { left: 0, top: 0, width: 800, height: 300 },
  ]);
  expect(below?.below).toBe(true);
});
it('clamps at viewport edges, avoids other bubbles and suppresses when no space remains', () => {
  expect(placeSpeech([15, 300], size, viewport, [])?.left).toBe(8);
  const first = placeSpeech([400, 300], size, viewport, [])!;
  const second = placeSpeech([400, 300], size, viewport, [first]);
  expect(second?.below).toBe(true);
  expect(placeSpeech([400, 300], size, viewport, [{ left: 0, top: 0, ...viewport }])).toBeNull();
  expect(placeSpeech([-1, 300], size, viewport, [])).toBeNull();
});
