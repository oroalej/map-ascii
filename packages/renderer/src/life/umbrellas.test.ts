import { describe, expect, it } from 'vitest';
import { UMBRELLA_MOTION } from './config';
import type { Walker } from './simulate';
import { UmbrellaMotion } from './umbrellas';

const walker = (umbrella = 0.23): Walker => ({
  figure: 'adult',
  shirt: 2,
  canopy: 3,
  lateral: 0,
  back: 0,
  step: 0,
  umbrella,
});
const delay = (w: Walker) => ((w.umbrella * 7919.123) % 1) * UMBRELLA_MOTION.stagger;

/** Sample continuously so ordinary animation cannot be replaced by the unseen-person snap. */
const fixture = (open: boolean, w = walker()) => {
  const motion = new UmbrellaMotion();
  let clock = 0;
  motion.look(w, open, clock);
  return {
    w,
    motion,
    at(target: number, want: boolean) {
      while (target - clock > 0.1) {
        clock += 0.1;
        motion.look(w, want, clock);
      }
      clock = target;
      return motion.look(w, want, clock);
    },
  };
};

describe('UmbrellaMotion', () => {
  it('snaps to either target on first sight without modifying the walker', () => {
    for (const open of [false, true]) {
      const w = Object.freeze(walker());
      expect(new UmbrellaMotion().look(w, open, 20)).toBe(Number(open));
    }
  });

  it('holds the bare figure during its delay, then eases open and settles exactly', () => {
    const f = fixture(false);
    const wait = delay(f.w);
    expect(f.at(0, true)).toBe(0);
    expect(f.at(wait / 2, true)).toBe(0);
    expect(f.at(wait, true)).toBe(0);
    expect(f.at(wait + UMBRELLA_MOTION.open / 4, true)).toBeCloseTo(0.15625);
    expect(f.at(wait + UMBRELLA_MOTION.open / 2, true)).toBeCloseTo(0.5);
    expect(f.at(wait + UMBRELLA_MOTION.open, true)).toBe(1);
    expect(f.at(wait + UMBRELLA_MOTION.open + 0.1, true)).toBe(1);
  });

  it('holds the full umbrella during its delay, then eases closed and settles exactly', () => {
    const f = fixture(true);
    const wait = delay(f.w);
    expect(f.at(0, false)).toBe(1);
    expect(f.at(wait / 2, false)).toBe(1);
    expect(f.at(wait, false)).toBe(1);
    expect(f.at(wait + UMBRELLA_MOTION.close / 4, false)).toBeCloseTo(0.84375);
    expect(f.at(wait + UMBRELLA_MOTION.close / 2, false)).toBeCloseTo(0.5);
    expect(f.at(wait + UMBRELLA_MOTION.close, false)).toBe(0);
  });

  it('staggers walkers by stable, distinct delays within the configured bound', () => {
    const starts = (motion: UmbrellaMotion) =>
      [0.1, 0.2, 0.3, 0.4].map((umbrella) => {
        const w = walker(umbrella);
        motion.look(w, false, 0);
        motion.look(w, true, 0);
        for (let i = 1; i <= 151; i++) {
          const clock = i / 100;
          if (motion.look(w, true, clock) > 0) return clock;
        }
        throw new Error('Umbrella never began opening');
      });
    const observed = starts(new UmbrellaMotion());
    expect(observed).toEqual(starts(new UmbrellaMotion()));
    expect(new Set(observed).size).toBe(observed.length);
    for (const start of observed) {
      expect(start).toBeGreaterThan(0);
      expect(start).toBeLessThanOrEqual(UMBRELLA_MOTION.stagger);
    }
  });

  it('snaps after an evaluation gap longer than lost', () => {
    const f = fixture(false);
    f.at(0, true);
    expect(f.motion.look(f.w, true, UMBRELLA_MOTION.lost + 0.01)).toBe(1);
    expect(f.motion.look(f.w, false, 2 * UMBRELLA_MOTION.lost + 0.02)).toBe(0);
  });

  it('snaps both endpoints after reset without comparing owner and world clocks', () => {
    for (const want of [false, true]) {
      const f = fixture(!want, Object.freeze(walker()));
      f.at(0, want);
      const clock = delay(f.w) + UMBRELLA_MOTION.open / 2;
      const attained = f.at(clock, want);
      expect(attained).toBeGreaterThan(0);
      expect(attained).toBeLessThan(1);
      f.motion.reset();
      expect(f.motion.look(f.w, want, clock)).toBe(Number(want));
      expect(f.motion.look(f.w, !want, clock)).toBe(Number(want));
      expect(f.motion.look(f.w, !want, clock + 0.1)).toBe(Number(want));
    }
  });

  it('reverses continuously from the attained openness after the new delay', () => {
    for (const opening of [true, false]) {
      const f = fixture(!opening);
      const wait = delay(f.w);
      f.at(0, opening);
      const flipAt = wait + (opening ? UMBRELLA_MOTION.open : UMBRELLA_MOTION.close) / 4;
      const attained = f.at(flipAt, opening);
      expect(f.at(flipAt, !opening)).toBe(attained);
      expect(f.at(flipAt + wait, !opening)).toBe(attained);
      const duration = opening ? UMBRELLA_MOTION.close : UMBRELLA_MOTION.open;
      expect(f.at(flipAt + wait + duration / 2, !opening)).toBeCloseTo(
        (attained + Number(!opening)) / 2,
      );
      expect(f.at(flipAt + wait + duration, !opening)).toBe(Number(!opening));
    }
  });

  it('settles a target reversed during an endpoint delay', () => {
    const f = fixture(false);
    expect(f.at(0, true)).toBe(0);
    const at = delay(f.w) / 2;
    expect(f.at(at, false)).toBe(0);
    expect(f.at(at + 0.1, false)).toBe(0);
  });

  it('retains openness when targets change at a frozen clock', () => {
    const f = fixture(false);
    f.at(0, true);
    const at = delay(f.w) + UMBRELLA_MOTION.open / 2;
    const open = f.at(at, true);
    for (const want of [false, false, true, false]) expect(f.at(at, want)).toBe(open);
  });
});
