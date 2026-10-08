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
  return {
    at,
    heading,
    pose,
    flap: Math.sin(elapsed * Math.PI * 4),
    cycle,
    returned: remainingMinutes <= 0,
  };
}
