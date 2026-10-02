import type { FireworksConfig } from '@atlas/shared';
import { FIREWORK_VARIANTS } from '@atlas/shared';
import type { Grid, View } from './grid';

/** Nine world-anchored shells, with bounded, immutable particle geometry. */
export const FIREWORKS = Object.freeze({
  minZoom: 14,
  shells: 9,
  stars: 40,
  tails: 4,
  smoke: 12,
  cycle: 9,
  burst: 1.1,
  sparkLife: 3.8,
  smokeLife: 6.8,
});
export const FIREWORK_INSTANCE_COUNT =
  FIREWORKS.shells * (FIREWORKS.stars * FIREWORKS.tails + FIREWORKS.smoke);

/** Smoke goes first, then spark tails and tips, so clouds cannot dim a burst. */
export function fireworkInstances(): Float32Array {
  const out = new Float32Array(FIREWORK_INSTANCE_COUNT * 4);
  let at = 0;
  const write = (shell: number, star: number, tail: number, smoke: number) => {
    out[at++] = shell;
    out[at++] = star;
    out[at++] = tail;
    out[at++] = smoke;
  };
  for (let shell = 0; shell < FIREWORKS.shells; shell++)
    for (let puff = 0; puff < FIREWORKS.smoke; puff++) write(shell, puff, 0, 1);
  for (let tail = FIREWORKS.tails - 1; tail >= 0; tail--)
    for (let shell = 0; shell < FIREWORKS.shells; shell++)
      for (let star = 0; star < FIREWORKS.stars; star++) write(shell, star, tail, 0);
  return out;
}

function seedAt(x: number, y: number, zoom: number) {
  let h = Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(zoom, 83492791);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  // Neighboring lattice sites stagger by three seconds, avoiding an empty viewport lull.
  return ((h ^ (h >>> 16)) & 65532) | ((((x + 2 * y) % 3) + 3) % 3);
}

/** Refill the same nine vec4 uniforms. Sub-cell panning preserves a shell's world position. */
export function fireworkShells(view: View, grid: Grid, out: Float32Array): number {
  const gap = Math.max(280 * view.dpr, Math.max(view.width, view.height) / 2);
  const left = grid.originCol * view.cellDev.w + grid.shiftX;
  const top = grid.originRow * view.cellDev.h + grid.shiftY;
  const x0 = Math.floor(left / gap),
    y0 = Math.floor(top / gap);
  for (let row = 0; row < 3; row++)
    for (let col = 0; col < 3; col++) {
      const x = x0 + col,
        y = y0 + row,
        seed = seedAt(x, y, Math.floor(view.camera.zoom));
      const at = (row * 3 + col) * 4;
      out[at] = (x + 0.2 + ((seed % 997) / 997) * 0.6) * gap - left;
      out[at + 1] = (y + 0.2 + ((seed % 991) / 991) * 0.6) * gap - top;
      out[at + 2] = seed;
      out[at + 3] = (75 + (seed % 65)) * view.dpr;
    }
  return FIREWORKS.shells;
}

export const fireworkVariantCodes = (config: FireworksConfig): number[] =>
  config.variants.map((v) => FIREWORK_VARIANTS.indexOf(v));

/** Small time values retain GPU precision even in a long-running tab. */
export function fireworkTime(time: number, reduced: boolean): number {
  return reduced || !Number.isFinite(time)
    ? 0
    : ((time % (FIREWORKS.cycle * 256)) + FIREWORKS.cycle * 256) % (FIREWORKS.cycle * 256);
}
