import { FOLKLORE } from './folklore-config';
import {
  distance,
  mixPoint,
  type Candidate,
  type Point,
  type RoofAnchor,
} from './folklore-geometry';
import { between, hashString, random } from './random';

export function manananggalTiming(candidate: Candidate, night: number) {
  const rng = random(hashString(`${candidate.id}/${night}`) ^ FOLKLORE.seed);
  const flight = between(rng, FOLKLORE.flight),
    landing = between(rng, FOLKLORE.landing);
  return { flight, landing, span: flight + landing + FOLKLORE.departure };
}
const smooth = (t: number) => {
  const v = Math.max(0, Math.min(1, t));
  return v * v * (3 - 2 * v);
};
const share = (time: number, period: number) => (((time / period) % 1) + 1) % 1;

/** How the wings beat: a burst of flaps, then a glide held on the sheet's first frame. */
const BEAT = { period: 6.4, flapping: 3.6, flaps: 6 } as const;
/** Seconds to draw the wings in before touching down, and to open them on leaving. */
const FOLD = { in: 1.2, out: 0.8 } as const;
/** Seconds round the entrails' sway in flight and the tongue's on a roof, and between blinks. */
const SWAY = { flight: 1.1, perched: 3 } as const;
const BLINK = { every: 3.7, lasts: 0.18 } as const;

/** Where the wings are in their beat, 0..1. */
export function wingBeat(elapsed: number) {
  const within = share(elapsed, BEAT.period) * BEAT.period;
  return within < BEAT.flapping ? share((within / BEAT.flapping) * BEAT.flaps, 1) : 0;
}

/** The sole sampled pose is shared by drawing, output-only dog facing and flock disturbance. */
export function manananggalPose(
  candidate: Candidate,
  landing: RoofAnchor,
  night: number,
  elapsed: number,
  remainingMinutes: number,
) {
  const timing = manananggalTiming(candidate, night),
    cycle = Math.floor(elapsed / timing.span),
    age = elapsed - cycle * timing.span;
  const seed = (hashString(`${candidate.id}/${night}`) / 0x100000000) * Math.PI * 2;
  const orbit = (time: number): Point => {
    const [low, high] = FOLKLORE.orbitRadius;
    const radius = (low + high) / 2 + ((high - low) / 2 - 3) * Math.sin(time * 0.021 + seed),
      angle = time * 0.075 + seed;
    return {
      x: candidate.centre.at.x + Math.cos(angle) * radius + Math.sin(time * 2 + seed) * 2,
      y: candidate.centre.at.y + Math.sin(angle) * radius + Math.cos(time * 1.6 + seed) * 2,
    };
  };
  const position = (time: number): Point => {
    const cycle = Math.floor(time / timing.span),
      age = time - cycle * timing.span;
    if (cycle === 0 && age < FOLKLORE.departure)
      return mixPoint(candidate.lower, orbit(FOLKLORE.departure), smooth(age / FOLKLORE.departure));
    if (age >= timing.flight - FOLKLORE.approach && age < timing.flight)
      return mixPoint(
        orbit(cycle * timing.span + timing.flight - FOLKLORE.approach),
        landing.at,
        smooth((age - timing.flight + FOLKLORE.approach) / FOLKLORE.approach),
      );
    if (age >= timing.flight && age < timing.flight + timing.landing) return landing.at;
    if (age >= timing.flight + timing.landing)
      return mixPoint(
        landing.at,
        orbit((cycle + 1) * timing.span),
        smooth((age - timing.flight - timing.landing) / FOLKLORE.departure),
      );
    return orbit(time);
  };
  let at = position(elapsed),
    pose: 'flying' | 'perched' =
      age >= timing.flight && age < timing.flight + timing.landing ? 'perched' : 'flying';
  if (remainingMinutes <= FOLKLORE.returnMinutes) {
    at = mixPoint(at, candidate.lower, smooth(1 - remainingMinutes / FOLKLORE.returnMinutes));
    pose = 'flying';
  }
  const future =
    remainingMinutes <= FOLKLORE.returnMinutes ? candidate.lower : position(elapsed + 0.1);
  const heading = distance(at, future) > 1e-9 ? Math.atan2(future.y - at.y, future.x - at.x) : 0;
  const perched = pose === 'perched';
  const departed = age - timing.flight - timing.landing;
  const fold =
    remainingMinutes <= FOLKLORE.returnMinutes
      ? 0
      : perched
        ? 1
        : departed >= 0
          ? 1 - smooth(departed / FOLD.out)
          : smooth((age - timing.flight + FOLD.in) / FOLD.in);
  return {
    at,
    heading,
    pose,
    // On a roof the wings are still, so this says whether its eyes are shut instead.
    flap: perched
      ? share(elapsed, BLINK.every) * BLINK.every < BLINK.lasts
        ? 1
        : 0
      : wingBeat(elapsed),
    wave: share(elapsed, perched ? SWAY.perched : SWAY.flight),
    fold,
    cycle,
    returned: remainingMinutes <= 0,
  };
}
