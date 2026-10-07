import type { EmergencyCraft } from './vehicles';

export type EmergencyKind = 'ambulance' | 'police' | 'fire';
export type EmergencyPhase =
  | 'responding'
  | 'arriving'
  | 'parked'
  | 'cleared'
  | 'patrol'
  | 'call'
  | 'onscene'
  | 'returning'
  | 'held';
/** Replaced as a whole, so movement rollback and continuity share immutable state. */
export type EmergencyState = Readonly<{
  id: string;
  kind: EmergencyKind;
  phase: EmergencyPhase;
  lights: boolean;
  target?: string;
  station?: string;
  /** Physical speed, never rescaled by ownership or zoom. */
  baseSpeedMps: number;
  remaining: number;
  offscreen: number;
  run: number;
  /** Earned red entries stay capped until the whole body clears their geographic controller. */
  creep?: readonly Readonly<{
    at: readonly [number, number];
    out: readonly [number, number];
    radiusM: number;
  }>[];
}>;
export const BEACON_BIT = 16;
export const BEACON_COLORS = [
  [1, 0.08, 0.05],
  [0.08, 0.35, 1],
  [1, 1, 1],
] as const;
export type BeaconColor = 0 | 1 | 2;
export type Beacon = Readonly<{ half: 0 | 1; colors: readonly [BeaconColor, BeaconColor] }>;
export const EMERGENCY = {
  period: 0.5,
  yieldAheadM: 60,
  creepMps: 3,
  yieldMps: 2.5,
  stopBehindM: 12,
  arrivalM: 0.3,
  curbToleranceM: 0.2,
  approachM: 60,
  ambulanceReleaseS: 20,
  policeReleaseS: 30,
} as const;
export const emergencyCraft = (kind: EmergencyKind): EmergencyCraft =>
  kind === 'fire' ? 'firetruck' : kind;
export const isEmergencyCraft = (craft: string | undefined): craft is EmergencyCraft =>
  craft === 'ambulance' || craft === 'police' || craft === 'firetruck';
export const isUrgent = (m: { emergency?: EmergencyState }) => m.emergency?.lights === true;
export const emergencyParked = (m: { emergency?: EmergencyState }) =>
  m.emergency?.phase === 'parked' ||
  m.emergency?.phase === 'onscene' ||
  m.emergency?.phase === 'held';

/** The opposite halves alternate every 0.25 s, using only the dedicated route seed. */
export function beaconPhase(seed: number, clock: number): 0 | 1 {
  const offset = ((seed >>> 0) / 0x1_0000_0000) * EMERGENCY.period;
  const phase = (((clock + offset) % EMERGENCY.period) + EMERGENCY.period) % EMERGENCY.period;
  return phase < EMERGENCY.period / 2 ? 0 : 1;
}
export function emergencyBeacon(
  state: EmergencyState,
  seed: number,
  clock: number,
): Beacon | undefined {
  return state.lights
    ? { half: beaconPhase(seed, clock), colors: state.kind === 'fire' ? [0, 2] : [0, 1] }
    : undefined;
}
