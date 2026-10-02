import { expect, it } from 'vitest';
import { LifePause, LivePauseOffset } from './pause';

it('holds the drawn frame despite late worker replies and excludes inspection time', () => {
  const pause = new LifePause<{ agents: number[]; signalClock: number }>(0);
  const drawn = { agents: [1, 2], signalClock: 0.1 };
  const reply = { agents: [3, 4], signalClock: 0.2 };
  pause.tick(100);
  expect(pause.delta).toBeCloseTo(0.1);
  pause.accept();
  pause.pause(drawn, 100);
  pause.tick(10_100);
  expect(pause.view(reply)).toBe(drawn);
  expect(pause.time).toBeCloseTo(0.1);
  expect(pause.pausedSeconds(10_100)).toBe(10);
  pause.resume(10_100);
  expect(pause.view(reply)).toBe(reply);
  pause.tick(10_120);
  expect(pause.delta).toBeCloseTo(0.02);
});

it('accumulates rejected running steps but rebases on resume and inactive transitions', () => {
  const pause = new LifePause<object>(0);
  pause.tick(30);
  pause.tick(60);
  expect(pause.delta).toBeCloseTo(0.06);
  pause.accept();
  pause.tick(80);
  pause.pause({}, 80);
  pause.resume(1080);
  expect(pause.delta).toBe(0);
  pause.tick(1100);
  expect(pause.delta).toBeCloseTo(0.02);
  pause.tick(1100, false);
  pause.tick(5000, true);
  pause.tick(5020);
  expect(pause.delta).toBeCloseTo(0.02);
  expect(pause.pausedSeconds(5020)).toBe(1);
});

it('ignores duplicate pause/resume and never holds an absent frame', () => {
  const pause = new LifePause<object>(0);
  pause.pause(undefined, 0);
  expect(pause.inspecting).toBe(false);
  const frame = {};
  pause.pause(frame, 0);
  pause.pause({}, 500);
  expect(pause.view({})).toBe(frame);
  pause.resume(1000);
  pause.resume(2000);
  pause.tick(2020);
  expect(pause.delta).toBeCloseTo(1.02);
  expect(pause.pausedSeconds(2020)).toBe(1);
});

it('keeps live procession visuals smooth and resets delay for occurrences and explicit changes', () => {
  const offset = new LivePauseOffset();
  expect(offset.progress('route/2026', 0.3, 100, 2)).toBeCloseTo(0.3);
  expect(offset.progress('route/2026', 0.4, 100, 12)).toBeCloseTo(0.3);
  expect(offset.progress('route/2026', 0.41, 100, 12)).toBeCloseTo(0.31);
  expect(offset.progress('route/2027', 0.5, 100, 12)).toBeCloseTo(0.5);
  offset.reset();
  expect(offset.progress('route/2027', 0.6, 100, 20)).toBeCloseTo(0.6);
  expect(offset.progress('route/2027', 0.01, 100, 40)).toBe(0);
});
