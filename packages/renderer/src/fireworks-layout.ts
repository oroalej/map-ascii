import type { FireworksConfig } from '@atlas/shared';
import { FIREWORK_VARIANTS } from '@atlas/shared';
import { MAX_ZOOM } from './camera';
import type { Grid, View } from './grid';

/** A dense, overlapping display with bounded, immutable particle geometry. */
export const FIREWORKS = Object.freeze({
  minZoom: 14,
  referenceZoom: 19,
  shells: 25,
  columns: 5,
  worldGap: 48,
  radius: 120,
  radiusVariation: 80,
  stars: 40,
  tails: 4,
  smoke: 12,
  cycle: 6,
  burst: 1.1,
  sparkLife: 4.4,
  smokeLife: 4.8,
});
export const FIREWORK_INSTANCE_COUNT =
  FIREWORKS.shells * (FIREWORKS.stars * FIREWORKS.tails + FIREWORKS.smoke);

/** Match map magnification continuously: each zoom level doubles burst and smoke extent. */
export function fireworkScale(zoom: number): number {
  const finiteZoom = Number.isFinite(zoom) ? zoom : FIREWORKS.referenceZoom;
  return (
    2 ** (Math.min(MAX_ZOOM, Math.max(FIREWORKS.minZoom, finiteZoom)) - FIREWORKS.referenceZoom)
  );
}

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

function seedAt(x: number, y: number) {
  let h = Math.imul(x, 73856093) ^ Math.imul(y, 19349663);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  // Power-of-two strides preserve three staggered phases, two seconds apart.
  return ((h ^ (h >>> 16)) & 65532) | ((((x + 2 * y) % 3) + 3) % 3);
}

/**
 * Refill fixed uniforms from a reference-world lattice. Zoom projects the same sites and
 * enlarges their radii; resize never moves a shared site. Coarser power-of-two strides bound
 * the number of sites in a large/distant view without changing their seeds or world positions.
 */
export function fireworkShells(view: View, grid: Grid, out: Float32Array): number {
  const scale = fireworkScale(view.camera.zoom);
  const left = grid.originCol * view.cellDev.w + grid.shiftX;
  const top = grid.originRow * view.cellDev.h + grid.shiftY;
  const worldToDevice = view.dpr * scale;
  const targetGap = Math.max(180, Math.max(view.width, view.height) / view.dpr / 4);
  const stride = 2 ** Math.max(0, Math.ceil(Math.log2(targetGap / (FIREWORKS.worldGap * scale))));
  const gap = FIREWORKS.worldGap * stride;
  const x0 = Math.floor(left / worldToDevice / gap),
    y0 = Math.floor(top / worldToDevice / gap);
  for (let row = 0; row < FIREWORKS.columns; row++)
    for (let col = 0; col < FIREWORKS.columns; col++) {
      const x = (x0 + col) * stride,
        y = (y0 + row) * stride,
        seed = seedAt(x, y);
      const at = (row * FIREWORKS.columns + col) * 4;
      // Jitter belongs to the finest world lattice, never to the selected stride.
      out[at] = (x + 0.2 + ((seed % 997) / 997) * 0.6) * FIREWORKS.worldGap * worldToDevice - left;
      out[at + 1] =
        (y + 0.2 + ((seed % 991) / 991) * 0.6) * FIREWORKS.worldGap * worldToDevice - top;
      out[at + 2] = seed;
      out[at + 3] = (FIREWORKS.radius + (seed % FIREWORKS.radiusVariation)) * worldToDevice;
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
