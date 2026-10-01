import { TURN_SIGNAL, hasTurnSignals, type VehicleRouting } from './turn-signals';
import type { CraftType } from './vehicles';

/** Acceleration/velocity in SI units; hold in simulation seconds. */
export const BRAKE = { on: 0.8, hold: 0.3, stopped: 0.3 } as const;
export const BRAKE_LAMP = 1;
export const BRAKE_COLOR = { day: [1, 0.2, 0.12], night: [1, 0.32, 0.2], glow: 1.4 } as const;
export type VehicleLamps = Readonly<{ kind: 'brake' } | { kind: 'hazard'; on: boolean }>;

export function brakeHold(
  previous: number,
  before: number,
  after: number,
  dt: number,
  held: boolean,
) {
  if (held) return 0;
  return (before - after) / dt >= BRAKE.on - 1e-9 || after < BRAKE.stopped
    ? BRAKE.hold
    : Math.max(0, previous - dt);
}

export function visibleLamps(
  vehicle: CraftType | undefined,
  brake: number | undefined,
  held: boolean,
  routing: VehicleRouting | undefined,
  clock: number,
): VehicleLamps | undefined {
  if (!hasTurnSignals(vehicle)) return;
  if (!held) return brake && brake > 1e-9 ? { kind: 'brake' } : undefined;
  const offset = (((routing?.seed ?? 0) >>> 0) / 0x1_0000_0000) * TURN_SIGNAL.period;
  const phase = (((clock + offset) % TURN_SIGNAL.period) + TURN_SIGNAL.period) % TURN_SIGNAL.period;
  return { kind: 'hazard', on: phase < TURN_SIGNAL.period * TURN_SIGNAL.duty };
}
