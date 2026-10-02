import { cellHash, type WindDir } from '../glyphs/select';
import { WIND_PRESETS, WIND_VARIATION } from './wind';

/** Cell-local cloth: its upper quarter stays attached and its ink never leaves its owner. */
export const BUNTING_MOTION = {
  anchor: 0.25,
  freeEdge: 0.87,
  // At 5×9 CSS pixels, a full flutter moves the free edge about 1.5 pixels. The atlas
  // guards keep it in its owned cell; smaller offsets looked like brightness changes.
  maxX: 0.3,
  maxY: 0.16,
  minHz: 0.7,
  frequencyRange: 0.6,
  fold: 0.12,
} as const;

const smooth = (lo: number, hi: number, value: number): number => {
  const t = Math.max(0, Math.min(1, (value - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};

/** Calm includes its strongest breathing gust; other wind effects keep their existing response. */
export function buntingWindResponse(strength: number, reducedMotion = false): number {
  if (reducedMotion || !Number.isFinite(strength)) return 0;
  const bounded = Math.max(0, Math.min(WIND_PRESETS.storm, strength));
  return (
    smooth(
      WIND_PRESETS.calm * (1 + WIND_VARIATION.breathe),
      WIND_PRESETS.breeze * (1 - WIND_VARIATION.breathe),
      bounded,
    ) * Math.sqrt(bounded / WIND_PRESETS.storm)
  );
}

/** CPU reference for the inverse sampling warp and fold, in normalized glyph coordinates. */
export function buntingMotion(
  world: readonly [number, number],
  seed: number,
  uv: readonly [number, number],
  time: number,
  response: number,
  direction: WindDir,
): { source: [number, number]; fold: number } {
  const gain = Math.max(0, Math.min(1, response));
  const attach = smooth(BUNTING_MOTION.anchor, BUNTING_MOTION.freeEdge, uv[1]);
  if (gain === 0 || attach === 0) return { source: [...uv], fold: 1 };
  const row = seed & 31;
  const hash = cellHash(world[0] + row * 131, world[1] + row * 17);
  const phase = ((hash & 255) / 255) * Math.PI * 2;
  // Frequency is fixed per flag: changing wind strength must not multiply elapsed time.
  const hz = BUNTING_MOTION.minHz + BUNTING_MOTION.frequencyRange * (((hash >>> 8) & 255) / 255);
  const angle = time * Math.PI * 2 * hz + phase;
  const wave = 0.75 * Math.sin(angle) + 0.25 * Math.sin(2 * angle + phase);
  return {
    source: [
      uv[0] - BUNTING_MOTION.maxX * gain * attach * wave * direction[0],
      uv[1] - BUNTING_MOTION.maxY * gain * attach * wave * direction[1],
    ],
    fold: 1 - BUNTING_MOTION.fold * gain * attach * (0.5 + 0.5 * Math.cos(angle)),
  };
}

/** Uses the glyph pass's existing atlas, time, world origin and reduced-motion gate. */
export const buntingMotionGlsl = /* glsl */ `
vec3 buntingMotion(ivec2 cell, int seed, vec2 uv) {
  float attach = smoothstep(${BUNTING_MOTION.anchor}, ${BUNTING_MOTION.freeEdge}, uv.y);
  uint h = cellHash(u_origin + cell + ivec2(seed * 131, seed * 17));
  float phase = float(h & 255u) / 255.0 * 6.28318530718;
  float hz = ${BUNTING_MOTION.minHz} + ${BUNTING_MOTION.frequencyRange} * float((h >> 8u) & 255u) / 255.0;
  float angle = u_time * 6.28318530718 * hz + phase;
  float wave = 0.75 * sin(angle) + 0.25 * sin(2.0 * angle + phase);
  vec2 source = uv - vec2(${BUNTING_MOTION.maxX}, ${BUNTING_MOTION.maxY}) * u_buntingWind * attach * wave * u_buntingWindDir;
  float fold = 1.0 - ${BUNTING_MOTION.fold} * u_buntingWind * attach * (0.5 + 0.5 * cos(angle));
  return vec3(source, fold);
}

float buntingTexel(ivec2 slot, ivec2 pixel) {
  if (any(lessThan(pixel, ivec2(0))) || any(greaterThanEqual(pixel, ivec2(u_cell)))) return 0.0;
  return texelFetch(u_atlas, slot + pixel, 0).r;
}

float buntingInk(ivec2 slot, ivec2 pixel, ivec2 cell, int seed, out float fold) {
  fold = 1.0;
  vec2 uv = (vec2(pixel) + 0.5) / u_cell;
  if (!u_shimmer || u_buntingWind <= 0.0 || uv.y <= ${BUNTING_MOTION.anchor})
    return texelFetch(u_atlas, slot + pixel, 0).r;
  vec3 motion = buntingMotion(cell, seed, uv);
  fold = motion.z;
  vec2 source = motion.xy * u_cell - 0.5;
  ivec2 base = ivec2(floor(source));
  vec2 fraction = fract(source);
  return mix(
    mix(buntingTexel(slot, base), buntingTexel(slot, base + ivec2(1, 0)), fraction.x),
    mix(buntingTexel(slot, base + ivec2(0, 1)), buntingTexel(slot, base + ivec2(1, 1)), fraction.x),
    fraction.y
  );
}`;
