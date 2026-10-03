import { expect, it } from 'vitest';
import { EffectClocks } from './effect-clocks';

it('preserves independent channels, updates winning tokens, and clears only departed cells', () => {
  const clocks = new EffectClocks(4);
  clocks.begin(0);
  clocks.set(0, 0, -2);
  clocks.finish(0);
  clocks.begin(1);
  clocks.pool(1, 5);
  clocks.finish(1);
  expect([...clocks.values]).toEqual([-2, -1, -1, 5, -1, -1, -1, -1]);
  const revision = clocks.revision;
  clocks.begin(0);
  clocks.set(0, 0, -2);
  clocks.finish(0);
  expect(clocks.revision).toBe(revision);
  expect(clocks.values[3]).toBe(5); // Idle lighting still owns G.
  clocks.begin(1);
  clocks.pool(1, 8);
  clocks.pool(1, -1); // The final ordinary winner replaces both inspected pools.
  clocks.finish(1);
  expect(clocks.values[3]).toBe(-1);
  clocks.begin(0);
  clocks.set(0, 2, 4.25);
  clocks.finish(0);
  expect([...clocks.values]).toEqual([-1, -1, -1, -1, 4.25, -1, -1, -1]);
  clocks.begin(0);
  clocks.finish(0);
  expect(clocks.active).toBe(false);
});

it('compares final float tokens instead of intermediate winners or double precision inputs', () => {
  const clocks = new EffectClocks(2);
  const token = 1 / 3;
  clocks.begin(1);
  clocks.pool(0, token);
  clocks.finish(1);
  const revision = clocks.revision;
  clocks.begin(1);
  clocks.pool(0, 8);
  clocks.pool(0, token);
  clocks.finish(1);
  expect(clocks.revision).toBe(revision);
});
