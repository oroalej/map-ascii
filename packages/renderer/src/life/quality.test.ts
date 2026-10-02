import { expect, it } from 'vitest';
import { makeScenario, completeScenarioState } from './testing/scenarios';
// eslint-disable-next-line no-restricted-syntax -- slow before the time-limit ban; tracked by the CI file budget
it('keeps complete simulation state identical across every draw tier', () => {
  const full = makeScenario('transit', 1);
  const low = makeScenario('transit', 1);
  let fewer = false;
  for (let frame = 0; frame < 300; frame++) {
    const env = full.environment(frame);
    for (const s of [full, low]) s.world.step(1 / 30, undefined, 18, s.bounds, undefined, env, 0.9);
    const visible = full.world.visible(
      18,
      full.levels,
      full.center,
      { rain: env.rain, sunAltitude: 40 },
      full.bounds,
    );
    const tier = frame % 3;
    const scaled = low.world.visible(
      18,
      low.levels,
      low.center,
      { rain: env.rain, sunAltitude: 40 },
      low.bounds,
      [0.6, 0.4, 0.3][tier],
      [700, 500, 500][tier],
    );
    fewer ||= scaled.length < visible.length;
    expect(completeScenarioState(low.world)).toEqual(completeScenarioState(full.world));
  }
  expect(fewer).toBe(true);
}, 30_000);
