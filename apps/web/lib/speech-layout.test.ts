import { expect, it } from 'vitest';
import { placeSpeech } from './speech-layout';

const viewport = { width: 800, height: 600 },
  size = { width: 200, height: 60 };
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
