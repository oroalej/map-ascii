/**
 * The tour player's logic (SPEC.md §6), with no React, timers, or renderer inside: a reducer
 * from a run and an action to the next run and the effects to carry out. Times come in with
 * the actions, so it is deterministic and unit-tested.
 *
 * A step flies to its camera, then holds (dwells) for its duration, then the next step starts.
 * Pausing freezes the dwell. When the visitor grabs the camera, the tour pauses; resuming flies
 * back to the current step and holds it from the start.
 */

export type TourRun = {
  step: number;
  /** Each step's dwell in ms; its length is the step count. */
  durations: readonly number[];
  phase: 'flying' | 'dwelling' | 'ended';
  paused: boolean;
  /** The visitor took the camera (or the run was restored from a URL): resuming re-shows the step. */
  grabbed: boolean;
  /** Dwell time already spent, before `since`. */
  elapsed: number;
  /** When the running dwell (re)started; null while it isn't running. */
  since: number | null;
};

export type TourAction =
  | { type: 'flyEnd'; now: number }
  | { type: 'dwellDone'; now: number }
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'restart' }
  | { type: 'pause'; now: number }
  | { type: 'resume'; now: number }
  | { type: 'grab'; now: number };

export type TourEffect =
  /** Apply the step (selection, highlights, year) and fly to its camera. */
  | { type: 'show'; step: number }
  /** Start the dwell timer; `dwellDone` follows after `ms`. */
  | { type: 'hold'; ms: number }
  | { type: 'cancelHold' };

type Result = [TourRun, TourEffect[]];

/**
 * Start a tour at `step`. A restored run (from a shared URL) starts paused and shows nothing:
 * the URL's own view stays until the visitor resumes, which flies to the step.
 */
export function startTour(
  durations: readonly number[],
  step = 0,
  { restored = false }: { restored?: boolean } = {},
): Result {
  const at = Math.min(Math.max(0, Math.trunc(step)), durations.length - 1);
  const run: TourRun = {
    step: at,
    durations,
    phase: 'flying',
    paused: restored,
    grabbed: restored,
    elapsed: 0,
    since: null,
  };
  return [run, restored ? [] : [{ type: 'show', step: at }]];
}

/** Go to a step, keeping the pause state (unless `play`). */
const goTo = (run: TourRun, step: number, play = false): Result => [
  {
    ...run,
    step,
    phase: 'flying',
    paused: play ? false : run.paused,
    grabbed: false,
    elapsed: 0,
    since: null,
  },
  [{ type: 'cancelHold' }, { type: 'show', step }],
];

const last = (run: TourRun) => run.durations.length - 1;
const duration = (run: TourRun) => run.durations[run.step] ?? 0;

export function reduceTour(run: TourRun, action: TourAction): Result {
  switch (action.type) {
    case 'flyEnd': {
      // Only the tour's own flight counts; after a grab, flights are the visitor's.
      if (run.phase !== 'flying' || run.grabbed) return [run, []];
      const since = run.paused ? null : action.now;
      const next: TourRun = { ...run, phase: 'dwelling', elapsed: 0, since };
      return [next, run.paused ? [] : [{ type: 'hold', ms: duration(run) }]];
    }
    case 'dwellDone': {
      // A stale timer (paused or moved on since) does nothing.
      if (run.phase !== 'dwelling' || run.paused || run.since === null) return [run, []];
      if (run.step >= last(run)) {
        return [{ ...run, phase: 'ended', elapsed: duration(run), since: null }, []];
      }
      return goTo(run, run.step + 1);
    }
    case 'next':
      if (run.phase === 'ended') return [run, []];
      if (run.step >= last(run)) {
        return [
          { ...run, phase: 'ended', grabbed: false, elapsed: duration(run), since: null },
          [{ type: 'cancelHold' }],
        ];
      }
      return goTo(run, run.step + 1);
    case 'prev':
      if (run.phase === 'ended') return goTo(run, run.step);
      return goTo(run, Math.max(0, run.step - 1));
    case 'restart':
      return goTo(run, 0, true);
    case 'pause': {
      if (run.paused || run.phase === 'ended') return [run, []];
      const running = run.since !== null;
      const elapsed = running ? run.elapsed + (action.now - run.since!) : run.elapsed;
      return [
        { ...run, paused: true, elapsed, since: null },
        running ? [{ type: 'cancelHold' }] : [],
      ];
    }
    case 'resume': {
      if (!run.paused || run.phase === 'ended') return [run, []];
      if (run.grabbed) {
        return [
          { ...run, paused: false, grabbed: false, phase: 'flying', elapsed: 0, since: null },
          [{ type: 'show', step: run.step }],
        ];
      }
      if (run.phase === 'dwelling') {
        const ms = Math.max(0, duration(run) - run.elapsed);
        return [{ ...run, paused: false, since: action.now }, [{ type: 'hold', ms }]];
      }
      // Still flying: the flight's end starts the dwell.
      return [{ ...run, paused: false }, []];
    }
    case 'grab': {
      if (run.phase === 'ended' || run.grabbed) return [run, []];
      const running = run.since !== null;
      return [
        { ...run, paused: true, grabbed: true, since: null },
        running ? [{ type: 'cancelHold' }] : [],
      ];
    }
  }
}

/** How far through the current step's dwell the run is, 0–1. */
export function dwellProgress(run: TourRun, now: number): number {
  if (run.phase === 'ended') return 1;
  if (run.phase !== 'dwelling') return 0;
  const total = duration(run);
  if (total <= 0) return 1;
  const spent = run.elapsed + (run.since === null ? 0 : now - run.since);
  return Math.min(1, Math.max(0, spent / total));
}
