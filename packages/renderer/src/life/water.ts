import { cellHash } from '../glyphs/select';

export const WATER_EFFECTS = {
  block: 8,
  rainPeriod: 1.3,
  fishPeriod: 18,
  fishDuration: 2.8,
} as const;
export const waterGlyphs = ['(', ')', '·', '◊'] as const;

/** CPU twin of the shader, for water-only, deterministic, world-anchored effects. */
export function waterEffect(
  x: number,
  y: number,
  time: number,
  rain: number,
  fish: boolean,
): number | null {
  const block = WATER_EFFECTS.block;
  const bx = Math.floor(x / block);
  const by = Math.floor(y / block);
  const hash = cellHash(bx, by);
  const cx = bx * block + 2 + (hash & 3);
  const cy = by * block + 2 + ((hash >>> 2) & 3);
  const dx = x - cx;
  const dy = y - cy;
  const age =
    ((time + ((hash >>> 8) & 255) / 17) % WATER_EFFECTS.rainPeriod) / WATER_EFFECTS.rainPeriod;
  if (rain > 0 && ((hash >>> 16) & 255) / 255 < rain * 0.45) {
    const radius = 0.25 + age * 2.2;
    if (Math.abs(Math.hypot(dx, dy * 1.8) - radius) < 0.5 && age < 0.85)
      return dx < 0 ? 0 : dx > 0 ? 1 : 2;
  }
  const moment = (time + ((hash >>> 8) & 255)) % WATER_EFFECTS.fishPeriod;
  if (!fish || (hash & 15) !== 0 || moment >= WATER_EFFECTS.fishDuration) return null;
  if (moment < 1 && Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return 3;
  if (moment >= 1 && Math.abs(Math.hypot(dx, dy * 1.8) - (moment - 1) * 1.4) < 0.5)
    return dx < 0 ? 0 : dx > 0 ? 1 : 2;
  return null;
}

export const waterEffectGlsl = /* glsl */ `
int waterEffect(ivec2 cell, bool fishWater) {
  if (!u_shimmer || !u_waterDetail) return -1;
  ivec2 world = u_origin + cell;
  ivec2 block = ivec2(floor(vec2(world) / ${WATER_EFFECTS.block}.0));
  uint h = cellHash(block);
  vec2 center = vec2(block * ${WATER_EFFECTS.block} + ivec2(2 + int(h & 3u), 2 + int((h >> 2u) & 3u)));
  vec2 delta = vec2(world) - center;
  float age = mod(u_time + float((h >> 8u) & 255u) / 17.0, ${WATER_EFFECTS.rainPeriod}) / ${WATER_EFFECTS.rainPeriod};
  float radius = 0.25 + age * 2.2;
  if (u_rain > 0.0 && float((h >> 16u) & 255u) / 255.0 < u_rain * 0.45 && age < 0.85 &&
      abs(length(delta * vec2(1.0, 1.8)) - radius) < 0.5)
    return delta.x < 0.0 ? 0 : delta.x > 0.0 ? 1 : 2;
  float moment = mod(u_time + float((h >> 8u) & 255u), ${WATER_EFFECTS.fishPeriod}.0);
  if (!u_fish || !fishWater || (h & 15u) != 0u || moment >= ${WATER_EFFECTS.fishDuration}) return -1;
  if (moment < 1.0 && abs(delta.x) < 0.5 && abs(delta.y) < 0.5) return 3;
  if (moment >= 1.0 && abs(length(delta * vec2(1.0, 1.8)) - (moment - 1.0) * 1.4) < 0.5)
    return delta.x < 0.0 ? 0 : delta.x > 0.0 ? 1 : 2;
  return -1;
}`;
