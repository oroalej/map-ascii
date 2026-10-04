import { UMBRELLA_MOTION } from './config';
import type { Walker } from './simulate';

type Motion = { open: boolean; from: number; at: number; seen: number };

/** Canopy state follows immutable group members through tile handoff without changing them. */
export class UmbrellaMotion {
  private states = new WeakMap<Walker, Motion>();

  /** A close-view reentry starts from the weather already shown at distant zooms. */
  reset() {
    this.states = new WeakMap();
  }

  /** Realised openness, including unchanged endpoints while waiting for the person's delay. */
  look(walker: Walker, want: boolean, clock: number): number {
    let state = this.states.get(walker);
    if (!state) {
      state = { open: want, from: Number(want), at: -Infinity, seen: clock };
      this.states.set(walker, state);
      return state.from;
    }
    if (clock - state.seen > UMBRELLA_MOTION.lost) {
      state.open = want;
      state.from = Number(want);
      state.at = -Infinity;
      state.seen = clock;
      return state.from;
    }

    const duration = state.open ? UMBRELLA_MOTION.open : UMBRELLA_MOTION.close;
    const t = Math.min(1, Math.max(0, (clock - state.at) / duration));
    const ease = t * t * (3 - 2 * t);
    const value = state.from + (Number(state.open) - state.from) * ease;
    if (state.open !== want) {
      state.from = value;
      state.open = want;
      state.at =
        value === Number(want)
          ? -Infinity
          : clock + ((walker.umbrella * 7919.123) % 1) * UMBRELLA_MOTION.stagger;
    }
    state.seen = clock;
    return value;
  }
}
