import type { VehicleType } from '@atlas/shared';
import type { CraftType } from './vehicles';

export const SIGNAL_VEHICLES = [
  'car',
  'motorcycle',
  'tricycle',
  'jeepney',
  'bus',
  'truck',
] as const satisfies readonly VehicleType[];
type MotorVehicle = (typeof SIGNAL_VEHICLES)[number];
const motorVehicles = new Set<CraftType>(SIGNAL_VEHICLES);
export const hasTurnSignals = (vehicle: CraftType | undefined): vehicle is MotorVehicle =>
  vehicle !== undefined && motorVehicles.has(vehicle);

/** B uses agent permissions only; focus (32) and indicators (128) are independent flags. */
export const TURN_SIGNAL_BIT = 128;
export const LIFE_AGENT_MASK = 1 | 2 | 4 | 8 | 64;
export const TURN_SIGNAL_COLOR = [1, 0.55, 0.08] as const;
export const TURN_SIGNAL = {
  leadMeters: 20,
  leadSeconds: 2,
  period: 1,
  duty: 0.5,
  gap: 1,
} as const;
export type TurnSide = 'left' | 'right';
export type TurnSignal = Readonly<{ side: TurnSide; on: boolean }>;

export type VehicleTurnPlan = Readonly<{
  line: number;
  dir: 1 | -1;
  vertex: number;
  exit: number;
  side?: TurnSide;
  /** Junction radius in meters. */
  radius: number;
}>;

/** Replaced as a whole: a shallow movement snapshot must restore every routing decision. */
export type VehicleRouting = Readonly<{
  seed: number;
  turns: number;
  plan?: VehicleTurnPlan;
  /** Planning may precede the visible 20 m / two-second indication window. */
  indicating?: boolean;
  signal?: Readonly<{ side: TurnSide; remaining: number }>;
}>;

/** World x is east and y south, so a positive signed angle turns right. */
export function turnSide(
  incoming: readonly number[],
  outgoing: readonly number[],
): TurnSide | undefined {
  const [ix = 0, iy = 0] = incoming;
  const [ox = 0, oy = 0] = outgoing;
  if (!Math.hypot(ix, iy) || !Math.hypot(ox, oy)) return;
  const angle = Math.atan2(ix * oy - iy * ox, ix * ox + iy * oy);
  const degrees = (Math.abs(angle) * 180) / Math.PI;
  if (degrees + 1e-9 < 30 || degrees >= 150 - 1e-9) return;
  return angle > 0 ? 'right' : 'left';
}

/** Phase is independent of drawing FPS, wall time, and movement retries. */
export function visibleTurnSignal(
  routing: VehicleRouting | undefined,
  clock: number,
): TurnSignal | undefined {
  const side = routing?.signal?.side ?? (routing?.indicating ? routing.plan?.side : undefined);
  if (!side || !routing) return;
  const offset = ((routing.seed >>> 0) / 0x1_0000_0000) * TURN_SIGNAL.period;
  const phase = (((clock + offset) % TURN_SIGNAL.period) + TURN_SIGNAL.period) % TURN_SIGNAL.period;
  return { side, on: phase < TURN_SIGNAL.period * TURN_SIGNAL.duty };
}
