/// <reference types="vite/client" />
import { expect, it } from 'vitest';
import {
  makePeddlerPerfWorld,
  peddlerPerfCounts,
  peddlerPerfWeather,
  peddlerPerfCenter,
} from './peddler-fixture';
import { completeScenarioState } from '../src/life/testing/scenarios';
import.meta.glob('../../content/cities/*/city.json');
it('really admits both required hot-afternoon trades and preserves the same ordinary population', () => {
  const configured = makePeddlerPerfWorld(),
    ordinary = makePeddlerPerfWorld(undefined, false);
  const counts = peddlerPerfCounts(configured);
  expect(counts.sorbetes).toBeGreaterThan(0);
  expect(counts['bote-dyaryo']).toBeGreaterThan(0);
  expect(peddlerPerfCounts(ordinary)).toEqual({});
  for (let i = 0; i < 30; i++) {
    for (const world of [configured, ordinary]) {
      world.step(1 / 30, undefined, 19, undefined, undefined, peddlerPerfWeather);
      world.visible(19, 1, peddlerPerfCenter, peddlerPerfWeather);
    }
    expect(JSON.stringify(completeScenarioState(configured))).toBe(
      JSON.stringify(completeScenarioState(ordinary)),
    );
  }
});
