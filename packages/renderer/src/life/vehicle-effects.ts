import type { ExhaustEmitter } from './exhaust';

export type VehicleEffects = { brake: number; sourceId?: number; exhaust?: ExhaustEmitter };
// Movement snapshots copy movers frequently. Keep decorative state off their hot shapes.
// Identity-preserving transfers retain it; detached continuity previews copy it explicitly.
const states = new WeakMap<object, VehicleEffects>();
export const vehicleEffects = (mover: object) => states.get(mover);
export function ensureVehicleEffects(mover: object) {
  let state = states.get(mover);
  if (!state) states.set(mover, (state = { brake: 0, exhaust: undefined }));
  return state;
}
export function copyVehicleEffects(source: object, preview: object) {
  const state = states.get(source);
  if (state) states.set(preview, { ...state, exhaust: state.exhaust && { ...state.exhaust } });
}
