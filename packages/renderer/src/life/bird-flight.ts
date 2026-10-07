/** A temporarily independent bird, in tile units, retaining its cruising velocity. */
export type BirdFlight = {
  x: number;
  y: number;
  hx: number;
  hy: number;
  speed: number;
  phase: number;
};

export type BirdFlightSettings = {
  flee: number;
  turn: number;
  accelerate: number;
  regroup: number;
};

export type BirdFlightStep = {
  dt: number;
  targetX: number;
  targetY: number;
  speed: number;
  pointer?: { x: number; y: number; reach: number };
};

/** Room to turn from a head-on approach without an instantaneous heading change. */
export function birdFlightMargin(speed: number, dt: number, settings: BirdFlightSettings) {
  const fastest = speed * settings.flee * 1.15;
  return (2 * fastest) / settings.turn + fastest * dt;
}

/** Advance one bird with bounded acceleration and turning; true when it rejoins its slot. */
export function stepBirdFlight(
  bird: BirdFlight,
  step: BirdFlightStep,
  settings: BirdFlightSettings,
): boolean {
  const tx = step.targetX - bird.x;
  const ty = step.targetY - bird.y;
  const targetDistance = Math.hypot(tx, ty);
  let hx = targetDistance > 0 ? tx / targetDistance : bird.hx;
  let hy = targetDistance > 0 ? ty / targetDistance : bird.hy;
  let fleeing = false;
  let blocked = false;
  const variation = 0.85 + bird.phase * 0.3;
  if (step.pointer) {
    const dx = bird.x - step.pointer.x;
    const dy = bird.y - step.pointer.y;
    const distance = Math.hypot(dx, dy);
    const safe = step.pointer.reach + birdFlightMargin(step.speed, step.dt, settings);
    fleeing = distance < safe;
    if (!fleeing && targetDistance > 0) {
      const along = Math.max(
        0,
        Math.min(1, -(dx * tx + dy * ty) / (targetDistance * targetDistance)),
      );
      blocked = (dx + tx * along) ** 2 + (dy + ty * along) ** 2 < safe * safe;
    }
    if (fleeing || blocked) {
      const rx = distance > 1e-8 ? dx / distance : bird.hx;
      const ry = distance > 1e-8 ? dy / distance : bird.hy;
      if (fleeing) {
        const fan = (bird.phase - 0.5) * 0.9;
        const cos = Math.cos(fan),
          sin = Math.sin(fan);
        hx = rx * cos - ry * sin;
        hy = rx * sin + ry * cos;
      } else {
        // Stable individual sides split a flock around the mouse instead of flipping together.
        const side = bird.phase < 0.5 ? 1 : -1;
        hx = -ry * side + rx * 0.2;
        hy = rx * side + ry * 0.2;
        const length = Math.hypot(hx, hy);
        hx /= length;
        hy /= length;
      }
    }
  }
  const desiredSpeed = step.speed * (fleeing ? settings.flee : settings.regroup) * variation;
  const acceleration = step.speed * settings.accelerate * (0.75 + bird.phase * 0.5) * step.dt;
  const speed =
    bird.speed + Math.max(-acceleration, Math.min(acceleration, desiredSpeed - bird.speed));
  const distance = ((bird.speed + speed) / 2) * step.dt;
  if (!fleeing && !blocked && targetDistance <= distance) {
    bird.x = step.targetX;
    bird.y = step.targetY;
    return true;
  }
  let turn = Math.atan2(bird.hx * hy - bird.hy * hx, bird.hx * hx + bird.hy * hy);
  if (Math.abs(Math.abs(turn) - Math.PI) < 1e-8) turn = bird.phase < 0.5 ? Math.PI : -Math.PI;
  const limit = settings.turn * (0.85 + bird.phase * 0.3) * step.dt;
  const heading = Math.atan2(bird.hy, bird.hx) + Math.max(-limit, Math.min(limit, turn));
  bird.hx = Math.cos(heading);
  bird.hy = Math.sin(heading);
  bird.speed = speed;
  bird.x += bird.hx * distance;
  bird.y += bird.hy * distance;
  return false;
}
