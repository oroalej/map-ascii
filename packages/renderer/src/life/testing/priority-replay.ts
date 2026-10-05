import { expect } from 'vitest';
import { LifeWorld } from '../simulate';
import { LifeBuilder } from '../geometry';
import { metersPerUnit } from '../../raster/geometry';
import { priorityFixture } from './intersection-priority';
import { completeScenarioState } from './scenarios';
import { preparePriorityTransitions, observePriorityTransitions } from './priority-transitions';

export function* priorityReplaySteps(hz: number) {
  const fixtures = [0, 1].map(() => priorityFixture(LifeWorld, LifeBuilder, metersPerUnit));
  for (const f of fixtures) preparePriorityTransitions(f, 28);
  const transitions = observePriorityTransitions(fixtures[0]!);
  for (let frame = 0; frame < 52 * hz; frame++) {
    transitions.beforeStep();
    for (const f of fixtures) {
      if (frame === 46 * hz)
        for (const m of f.life.movers) if (m.kind === 'vehicle') m.speed = 8 * f.life.perMeter;
      f.beforeStep();
      f.world.step(1 / hz, undefined, 18, undefined, undefined, { rain: 0, minutes: 720 }, 0.9);
    }
    transitions.afterStep();
    if (frame % hz === 0)
      expect(completeScenarioState(fixtures[1]!.world)).toEqual(
        completeScenarioState(fixtures[0]!.world),
      );
    if ((frame + 1) % (13 * hz) === 0 && frame + 1 < 52 * hz) yield;
  }
  expect(transitions.state).toEqual({
    overWait: true,
    expired: true,
    closed: true,
    revoked: true,
    reopened: true,
  });
  transitions.restore();
  expect(completeScenarioState(fixtures[1]!.world)).toEqual(
    completeScenarioState(fixtures[0]!.world),
  );
}

export function priorityReplay(hz: number) {
  for (const _ of priorityReplaySteps(hz)) {
    /* resume the same pair of worlds */
  }
}
