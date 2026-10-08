import type { SignalArm, SignalLayout } from './signal-layout';

export const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
export const isNonemptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;
export function isStrictRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}
export function isSignalPosition(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    isFiniteNumber(value[0]) &&
    value[0] >= -180 &&
    value[0] <= 180 &&
    isFiniteNumber(value[1]) &&
    value[1] >= -90 &&
    value[1] <= 90
  );
}
const direction = (value: unknown) => value === -1 || value === 1;
const bearing = (value: unknown) => isFiniteNumber(value) && value >= 0 && value < 360;
const positive = (value: unknown) => isFiniteNumber(value) && value > 0;
export function isSignalArm(value: unknown): value is SignalArm {
  if (
    !isStrictRecord(value, [
      'road_id',
      'junction',
      'toward',
      'direction',
      'inbound',
      'outbound',
      'group',
      'bearing',
      'width',
      'stop',
      'stop_width',
      'stop_bearing',
      'stop_road_id',
      'stop_direction',
      'stop_road_width',
    ])
  )
    return false;
  const v = value;
  return (
    isNonemptyString(v.road_id) &&
    isSignalPosition(v.junction) &&
    isSignalPosition(v.toward) &&
    direction(v.direction) &&
    typeof v.inbound === 'boolean' &&
    typeof v.outbound === 'boolean' &&
    (v.group === 'a' || v.group === 'b') &&
    bearing(v.bearing) &&
    positive(v.width) &&
    (v.stop === undefined || isSignalPosition(v.stop)) &&
    (v.stop_width === undefined || positive(v.stop_width)) &&
    (v.stop_bearing === undefined || bearing(v.stop_bearing)) &&
    (v.stop_road_id === undefined || isNonemptyString(v.stop_road_id)) &&
    (v.stop_direction === undefined || direction(v.stop_direction)) &&
    (v.stop_road_width === undefined || positive(v.stop_road_width)) &&
    !!v.stop === (v.stop_width !== undefined) &&
    (!v.stop || v.inbound) &&
    (v.stop_bearing === undefined || !!v.stop) &&
    (v.stop_road_id === undefined
      ? v.stop_direction === undefined && v.stop_road_width === undefined
      : !!v.stop && v.stop_direction !== undefined && v.stop_road_width !== undefined)
  );
}
export function isSignalLayout(value: unknown): value is SignalLayout {
  return (
    isStrictRecord(value, ['members', 'arms']) &&
    Array.isArray(value.members) &&
    value.members.length > 0 &&
    Array.from(value.members).every(isSignalPosition) &&
    Array.isArray(value.arms) &&
    Array.from(value.arms).every(isSignalArm)
  );
}
export function parseSignalLayout(value: unknown): SignalLayout {
  if (!isSignalLayout(value)) throw new Error('invalid signal layout');
  return value;
}
