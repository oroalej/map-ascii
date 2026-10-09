import { expect, it } from 'vitest';
import type { DialogueChoice } from '@atlas/shared';
import { PeddlerCaller } from './peddler-calls';
import { peddlerFixture, peddlerConfig, peddlerWeather } from './testing/peddlers';
const choices: DialogueChoice[] = [
  {
    id: 'plain',
    kind: 'talk',
    profile: 'peddler-call',
    delivery: 'utterance',
    speakers: [0],
    turns: 1,
  },
  {
    id: 'hot',
    kind: 'talk',
    profile: 'peddler-call',
    delivery: 'utterance',
    speakers: [0],
    turns: 1,
    conditions: { weather: 'heat' },
  },
  {
    id: 'hover',
    kind: 'talk',
    profile: 'peddler-call',
    delivery: 'utterance',
    speakers: [0],
    turns: 1,
    conditions: { event: 'hover' },
  },
  {
    id: 'leave',
    kind: 'talk',
    profile: 'peddler-call',
    delivery: 'utterance',
    speakers: [0],
    turns: 1,
    conditions: { event: 'leaving' },
  },
];
function owner() {
  const { population } = peddlerFixture();
  population.step(0, peddlerWeather, 0);
  return population.owners[0]!;
}
it('calls at every voice stop with event, weather and plain priority; leaves once', () => {
  const p = owner(),
    caller = new PeddlerCaller(choices);
  caller.step(p, 0, peddlerWeather, true, false);
  for (let i = 0; i < 4; i++) {
    p.callToken++;
    caller.step(p, 4, peddlerWeather, true, false);
    expect(caller.cue(p)?.exchangeId).toBe('plain');
  }
  p.callToken++;
  caller.step(p, 4, { ...peddlerWeather, minutes: 780, sunAltitude: 60 }, true, false);
  expect(caller.cue(p)?.exchangeId).toBe('hot');
  caller.step(p, 4, peddlerWeather, true, true);
  expect(caller.cue(p)?.exchangeId).toBe('hover');
  p.leaving = true;
  caller.step(p, 1, peddlerWeather, true, true);
  expect(caller.cue(p)?.exchangeId).toBe('leave');
  caller.step(p, 4, peddlerWeather, true, false);
  expect(caller.cue(p)).toBeUndefined();
  p.callToken++;
  caller.step(p, 1, peddlerWeather, true, true);
  expect(caller.cue(p)).toBeUndefined();
});
it('hover is entry-only, has its own eight-second cooldown and advances while physically held', () => {
  const p = owner(),
    caller = new PeddlerCaller(choices);
  caller.step(p, 0, peddlerWeather, true, true);
  const id = caller.cue(p)!.id;
  caller.step(p, 4, peddlerWeather, true, true);
  expect(caller.cue(p)).toBeUndefined();
  caller.step(p, 0, peddlerWeather, true, false);
  caller.step(p, 1, peddlerWeather, true, true);
  expect(caller.cue(p)).toBeUndefined();
  caller.step(p, 0, peddlerWeather, true, false);
  caller.step(p, 3, peddlerWeather, true, true);
  expect(caller.cue(p)!.id).not.toBe(id);
  caller.step(p, 1, peddlerWeather, false, true);
  expect(caller.cue(p)).toBeUndefined();
  const { population } = peddlerFixture([{ ...peddlerConfig, perTile: 1 }]);
  population.step(0, { ...peddlerWeather, zoom: 19 }, 0);
  const held = population.owners[0]!;
  population.context.held = () => true;
  const visible = population.visible(held, peddlerWeather);
  population.step(
    1,
    { ...peddlerWeather, zoom: 19, pointer: { lngLat: [visible.lng, visible.lat], cellMeters: 1 } },
    0,
  );
  expect(population.caller.state(held).serial).toBe(1);
  expect(held.effectClock).toBe(0);
  population.step(4, { ...peddlerWeather, zoom: 19 }, 0);
  expect(population.caller.cue(held)).toBeUndefined();
});
it('bell voice frequency is near one in three without simulation RNG draws', () => {
  const p = owner();
  p.config = { ...p.config, call: 'bell' };
  const caller = new PeddlerCaller(choices);
  const physical = p.rng;
  let voiced = 0;
  for (let i = 0; i < 300; i++) {
    p.callToken++;
    caller.step(p, 4, peddlerWeather, true, false);
    voiced += Number(!!caller.cue(p));
  }
  expect(voiced).toBeGreaterThan(70);
  expect(voiced).toBeLessThan(130);
  expect(p.rng).toBe(physical);
});
