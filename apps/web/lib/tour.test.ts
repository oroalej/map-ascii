import { describe, expect, it } from 'vitest';
import { dwellProgress, reduceTour, startTour, type TourAction, type TourRun } from './tour';

const durations = [4000, 5000, 6000];

/** Apply actions in order, collecting every effect. */
function play(run: TourRun, ...actions: TourAction[]) {
  const effects = [];
  for (const action of actions) {
    const [next, out] = reduceTour(run, action);
    run = next;
    effects.push(...out);
  }
  return { run, effects };
}

describe('startTour', () => {
  it('shows the first step', () => {
    const [run, effects] = startTour(durations);
    expect(run).toMatchObject({ step: 0, phase: 'flying', paused: false, grabbed: false });
    expect(effects).toEqual([{ type: 'show', step: 0 }]);
  });

  it('clamps the step into the tour', () => {
    expect(startTour(durations, 9)[0].step).toBe(2);
    expect(startTour(durations, -1)[0].step).toBe(0);
  });

  it('restores paused, showing nothing until resumed', () => {
    const [run, effects] = startTour(durations, 1, { restored: true });
    expect(run).toMatchObject({ step: 1, paused: true, grabbed: true });
    expect(effects).toEqual([]);
    const resumed = play(run, { type: 'resume', now: 0 });
    expect(resumed.run).toMatchObject({ paused: false, phase: 'flying' });
    expect(resumed.effects).toEqual([{ type: 'show', step: 1 }]);
  });
});

describe('reduceTour', () => {
  it('flies, holds for the step duration, and advances on its own', () => {
    const [run] = startTour(durations);
    const landed = play(run, { type: 'flyEnd', now: 100 });
    expect(landed.run).toMatchObject({ phase: 'dwelling', since: 100 });
    expect(landed.effects).toEqual([{ type: 'hold', ms: 4000 }]);
    const next = play(landed.run, { type: 'dwellDone', now: 4100 });
    expect(next.run).toMatchObject({ step: 1, phase: 'flying' });
    expect(next.effects).toContainEqual({ type: 'show', step: 1 });
  });

  it('ends after the last step', () => {
    const [run] = startTour(durations, 2);
    const { run: ended } = play(run, { type: 'flyEnd', now: 0 }, { type: 'dwellDone', now: 6000 });
    expect(ended.phase).toBe('ended');
    expect(dwellProgress(ended, 0)).toBe(1);
    // Nothing moves an ended tour on, but it can restart or step back.
    expect(play(ended, { type: 'next' }).effects).toEqual([]);
    expect(play(ended, { type: 'restart' }).run).toMatchObject({ step: 0, paused: false });
    expect(play(ended, { type: 'prev' }).effects).toContainEqual({ type: 'show', step: 2 });
  });

  it('pauses during the dwell and holds only the rest after resuming', () => {
    const [run] = startTour(durations);
    const { run: paused, effects } = play(
      run,
      { type: 'flyEnd', now: 0 },
      { type: 'pause', now: 1500 },
    );
    expect(paused).toMatchObject({ paused: true, elapsed: 1500, since: null });
    expect(effects).toContainEqual({ type: 'cancelHold' });
    expect(dwellProgress(paused, 99_999)).toBeCloseTo(1500 / 4000);
    const resumed = play(paused, { type: 'resume', now: 10_000 });
    expect(resumed.effects).toEqual([{ type: 'hold', ms: 2500 }]);
    expect(dwellProgress(resumed.run, 11_000)).toBeCloseTo(2500 / 4000);
  });

  it('pauses during a flight: landing does not start the dwell until resumed', () => {
    const [run] = startTour(durations);
    const landed = play(run, { type: 'pause', now: 10 }, { type: 'flyEnd', now: 500 });
    expect(landed.run).toMatchObject({ phase: 'dwelling', paused: true, since: null });
    expect(landed.effects).toEqual([]);
    expect(play(landed.run, { type: 'resume', now: 900 }).effects).toEqual([
      { type: 'hold', ms: 4000 },
    ]);
  });

  it('ignores a stale dwell timer', () => {
    const [run] = startTour(durations);
    const { run: paused } = play(run, { type: 'flyEnd', now: 0 }, { type: 'pause', now: 10 });
    expect(play(paused, { type: 'dwellDone', now: 4000 }).run).toBe(paused);
  });

  it('pauses on a grab, then resuming flies back to the step and holds it afresh', () => {
    const [run] = startTour(durations);
    const grabbed = play(run, { type: 'flyEnd', now: 0 }, { type: 'grab', now: 2000 });
    expect(grabbed.run).toMatchObject({ paused: true, grabbed: true });
    expect(grabbed.effects).toContainEqual({ type: 'cancelHold' });
    // The visitor's own flights don't count as the tour's.
    expect(play(grabbed.run, { type: 'flyEnd', now: 2500 }).run).toBe(grabbed.run);
    const resumed = play(grabbed.run, { type: 'resume', now: 3000 }, { type: 'flyEnd', now: 4000 });
    expect(resumed.effects).toEqual([
      { type: 'show', step: 0 },
      { type: 'hold', ms: 4000 },
    ]);
  });

  it('steps forward and back within the tour, keeping the pause state', () => {
    const [run] = startTour(durations);
    const { run: paused } = play(run, { type: 'pause', now: 0 });
    const next = play(paused, { type: 'next' });
    expect(next.run).toMatchObject({ step: 1, paused: true, phase: 'flying' });
    expect(next.effects).toEqual([{ type: 'cancelHold' }, { type: 'show', step: 1 }]);
    expect(play(next.run, { type: 'prev' }, { type: 'prev' }).run.step).toBe(0);
  });

  it('ends when stepping past the last step', () => {
    const [run] = startTour(durations, 2);
    expect(play(run, { type: 'next' }).run.phase).toBe('ended');
  });
});
