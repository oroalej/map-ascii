import type { Tour, TourStep } from '@atlas/shared';
import { create } from 'zustand';
import { reduceTour, startTour, type TourAction, type TourEffect, type TourRun } from '@/lib/tour';
import { loadTours } from '@/lib/content';
import { useAtlasStore } from './store';

/**
 * The tour player (SPEC.md §6). Its logic is the pure reducer in `lib/tour.ts`; this module
 * keeps the current run, mirrors it in the atlas store (and so the URL), and hands the
 * reducer's effects to the runner that `useTourPlayer` installs while the atlas is live.
 */

export type ActiveTour = { tour: Tour; run: TourRun };

export type TourStoreState = {
  city: string | null;
  hasTours: boolean;
  dataStatus: 'unloaded' | 'loading' | 'ready' | 'error';
  pending: { id: string; step: number } | null;
  /** The city's tours. */
  tours: readonly Tour[];
  active: ActiveTour | null;
  menuOpen: boolean;
};

export const useTourStore = create<TourStoreState>()(() => ({
  city: null,
  hasTours: false,
  dataStatus: 'unloaded',
  pending: null,
  tours: [],
  active: null,
  menuOpen: false,
}));

/** What the player does to the world: the map, timers, and selection. */
export type TourRunner = {
  /** Apply a step (selection, highlights, year) and fly to its camera. */
  show(step: TourStep): void;
  hold(ms: number): void;
  cancelHold(): void;
  /** Stop any flight and clear the tour's highlights. */
  stop(): void;
};

let runner: TourRunner | null = null;

export const setTourRunner = (next: TourRunner | null) => {
  runner = next;
};

/** A tour's id without its `tour/` prefix, as the URL has it (`?tour=heritage-centro-walk`). */
export const tourSlug = (id: string) => id.replace(/^tour\//, '');

const findTour = (slug: string) =>
  useTourStore.getState().tours.find((t) => tourSlug(t.id) === slug);

const now = () => performance.now();

function commit(tour: Tour, run: TourRun, effects: readonly TourEffect[]) {
  useTourStore.setState({ active: { tour, run } });
  useAtlasStore.getState().setTour({
    id: tourSlug(tour.id),
    step: run.step,
    paused: run.paused || run.phase === 'ended',
  });
  for (const effect of effects) {
    if (effect.type === 'show') {
      const step = tour.steps[effect.step];
      if (step) runner?.show(step);
    } else if (effect.type === 'hold') {
      runner?.hold(effect.ms);
    } else {
      runner?.cancelHold();
    }
  }
}

function dispatch(action: TourAction) {
  const active = useTourStore.getState().active;
  if (!active) return;
  const [run, effects] = reduceTour(active.run, action);
  if (run === active.run && effects.length === 0) return;
  commit(active.tour, run, effects);
}

const durations = (tour: Tour) => tour.steps.map((s) => s.duration_ms);

let generation = 0;
let loading: Promise<void> | null = null;
function settlePending() {
  const { pending, dataStatus } = useTourStore.getState();
  if (!pending || dataStatus !== 'ready') return;
  useTourStore.setState({ pending: null });
  if (!tourControls.restore(pending.id, pending.step)) tourControls.exit();
}
function ensureTours(): Promise<void> {
  const { city, dataStatus } = useTourStore.getState();
  if (!city || dataStatus === 'ready') return Promise.resolve();
  if (loading) return loading;
  const token = generation;
  useTourStore.setState({ dataStatus: 'loading' });
  const promise = loadTours(city)
    .then((tours) => {
      if (token !== generation || useTourStore.getState().city !== city) return;
      useTourStore.setState({ tours, dataStatus: 'ready' });
      settlePending();
    })
    .catch(() => {
      if (token === generation && useTourStore.getState().city === city)
        useTourStore.setState({ dataStatus: 'error' });
    })
    .finally(() => {
      if (loading === promise) loading = null;
    });
  loading = promise;
  return promise;
}

export const tourControls = {
  configure: (city: string | null, hasTours: boolean) => {
    generation++;
    loading = null;
    tourControls.exit();
    useTourStore.setState({
      city,
      hasTours,
      tours: [],
      dataStatus: 'unloaded',
      pending: null,
      menuOpen: false,
    });
  },
  load: ensureTours,
  /** Keep URL intent until a successfully loaded list can decide whether the tour exists. */
  restoreFromUrl: (id: string | null, step = 0) => {
    tourControls.exit();
    if (!id) return;
    useTourStore.setState({ pending: { id, step } });
    if (useTourStore.getState().dataStatus === 'ready') settlePending();
    else void ensureTours();
  },
  /** Start a tour by its slug (needs the atlas, which the runner stands for). */
  start: (slug: string, step = 0): boolean => {
    const tour = findTour(slug);
    if (!tour || !runner) return false;
    runner.cancelHold();
    useTourStore.setState({ menuOpen: false, pending: null });
    const [run, effects] = startTour(durations(tour), step);
    commit(tour, run, effects);
    return true;
  },
  /** Reopen a tour from a URL: paused at `step`, leaving the view as the URL has it. */
  restore: (slug: string, step: number): boolean => {
    const tour = findTour(slug);
    if (!tour) return false;
    runner?.cancelHold();
    const [run, effects] = startTour(durations(tour), step, { restored: true });
    commit(tour, run, effects);
    return true;
  },
  exit: () => {
    useTourStore.setState({ pending: null });
    if (!useTourStore.getState().active) {
      useAtlasStore.getState().setTour(null);
      return;
    }
    runner?.cancelHold();
    runner?.stop();
    useTourStore.setState({ active: null });
    useAtlasStore.getState().setTour(null);
  },
  next: () => dispatch({ type: 'next' }),
  prev: () => dispatch({ type: 'prev' }),
  restart: () => dispatch({ type: 'restart' }),
  pause: () => dispatch({ type: 'pause', now: now() }),
  resume: () => dispatch({ type: 'resume', now: now() }),
  /** Space and the play button: pause, resume, or replay a finished tour. */
  toggle: () => {
    const run = useTourStore.getState().active?.run;
    if (!run) return;
    if (run.phase === 'ended') tourControls.restart();
    else if (run.paused) tourControls.resume();
    else tourControls.pause();
  },
  /** The visitor took the camera. */
  grab: () => dispatch({ type: 'grab', now: now() }),
  flyEnd: () => dispatch({ type: 'flyEnd', now: now() }),
  dwellDone: () => dispatch({ type: 'dwellDone', now: now() }),
  setMenuOpen: (menuOpen: boolean) => {
    useTourStore.setState({ menuOpen });
    if (menuOpen) void ensureTours();
  },
};
