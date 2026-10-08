import type { CrossingController, SignalController, SignalStops } from './traffic-control';
import {
  isFiniteNumber,
  isNonemptyString,
  isStrictRecord,
  isSignalPosition,
  isSignalArm,
  isSignalLayout,
} from './signal-layout-runtime';

export function isControllerSeed(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}
export function parseControllerSeed(value: unknown): number {
  if (!isControllerSeed(value)) throw new Error('invalid controller seed');
  return value;
}
export function isSignalStops(value: unknown): value is SignalStops {
  return (
    Array.isArray(value) &&
    Array.from(value).every(
      (arm) =>
        isSignalArm(arm) &&
        !!arm.stop &&
        arm.stop_width !== undefined &&
        arm.stop_bearing !== undefined,
    )
  );
}
export function parseSignalStops(value: unknown): SignalStops {
  if (!isSignalStops(value)) throw new Error('invalid signal stops');
  return value;
}
export function isCrossingController(value: unknown): value is CrossingController {
  return (
    isStrictRecord(value, ['id', 'at', 'seed', 'midBlock', 'walk']) &&
    isNonemptyString(value.id) &&
    isSignalPosition(value.at) &&
    isControllerSeed(value.seed) &&
    typeof value.midBlock === 'boolean' &&
    (value.walk === 'a' || value.walk === 'b')
  );
}
export function isSignalController(value: unknown): value is SignalController {
  return (
    isStrictRecord(value, ['id', 'at', 'seed', 'radius', 'a', 'b', 'mapped', 'layout', 'stops']) &&
    isNonemptyString(value.id) &&
    isSignalPosition(value.at) &&
    isControllerSeed(value.seed) &&
    isFiniteNumber(value.radius) &&
    value.radius > 0 &&
    isFiniteNumber(value.a) &&
    value.a >= -1 &&
    value.a < 180 &&
    isFiniteNumber(value.b) &&
    value.b >= 0 &&
    value.b < 180 &&
    typeof value.mapped === 'boolean' &&
    (value.layout === undefined || isSignalLayout(value.layout)) &&
    (value.stops === undefined || isSignalStops(value.stops))
  );
}
const crossingKeys = [
  'crossing_signal_control',
  'crossing_signal',
  'crossing_signal_at',
  'crossing_signal_seed',
  'crossing_mid',
  'crossing_walk',
] as const;
export function decodeCrossingController(
  properties: Readonly<Record<string, unknown>>,
): CrossingController | undefined {
  if (!crossingKeys.some((key) => properties[key] !== undefined)) return;
  if (typeof properties.crossing_signal_at !== 'string')
    throw new Error('crossing_signal_at must be scalar JSON');
  const at: unknown = JSON.parse(properties.crossing_signal_at);
  const value: unknown = {
    id: properties.crossing_signal,
    at,
    seed: properties.crossing_signal_seed,
    midBlock: properties.crossing_mid ?? false,
    walk: properties.crossing_walk,
  };
  if (!isCrossingController(value)) throw new Error('invalid crossing controller');
  return value;
}
export function decodeCrossingSignal(
  properties: Readonly<Record<string, unknown>>,
  crossing: CrossingController,
): SignalController | undefined {
  if (properties.crossing_signal_control === undefined) return;
  if (typeof properties.crossing_signal_control !== 'string')
    throw new Error('crossing_signal_control must be scalar JSON');
  const signal: unknown = JSON.parse(properties.crossing_signal_control);
  if (!isSignalController(signal)) throw new Error('invalid signal controller');
  if (
    signal.id !== crossing.id ||
    signal.seed !== crossing.seed ||
    JSON.stringify(signal.at) !== JSON.stringify(crossing.at) ||
    signal.a < 0 !== crossing.midBlock
  )
    throw new Error('inconsistent crossing controller');
  return signal;
}
