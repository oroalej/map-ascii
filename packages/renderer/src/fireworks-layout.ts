import type { FireworksConfig } from '@atlas/shared';
import { FIREWORK_VARIANTS } from '@atlas/shared';
import { MAX_ZOOM, MIN_ZOOM } from './camera';
import type { Grid, View } from './grid';

const FIREWORK_COLUMNS = 7;

/** A dense, overlapping display with bounded, immutable particle geometry. */
export const FIREWORKS = Object.freeze({
  minZoom: MIN_ZOOM,
  hideZoom: MAX_ZOOM,
  largeZoom: 16,
  sparseZoom: 20,
  referenceZoom: 19,
  shells: FIREWORK_COLUMNS ** 2 + 1,
  columns: FIREWORK_COLUMNS,
  sparseShells: 4,
  worldGap: 48,
  radius: 120,
  radiusVariation: 80,
  distantScale: 0.6,
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

/** Zoom bands share one visibility rule between the GPU pass and legend. */
export function fireworkShellCount(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom < FIREWORKS.minZoom || zoom >= FIREWORKS.hideZoom) return 0;
  if (zoom >= FIREWORKS.sparseZoom) return FIREWORKS.sparseShells;
  return FIREWORKS.columns ** 2 + (zoom <= FIREWORKS.largeZoom ? 1 : 0);
}

/** Reference-world projection follows map magnification at every supported zoom. */
export function fireworkScale(zoom: number): number {
  const finiteZoom = Number.isFinite(zoom) ? zoom : FIREWORKS.referenceZoom;
  return (
    2 ** (Math.min(MAX_ZOOM, Math.max(FIREWORKS.minZoom, finiteZoom)) - FIREWORKS.referenceZoom)
  );
}

/** Distant bursts stay legible; approaching still doubles their extent above the floor. */
export function fireworkRadius(seed: number, zoom: number): number {
  return (
    (FIREWORKS.radius + (seed % FIREWORKS.radiusVariation)) *
    Math.max(FIREWORKS.distantScale, fireworkScale(zoom))
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
  // Each layer has a shell-major prefix, so drawing fewer shells skips their GPU work.
  for (let shell = 0; shell < FIREWORKS.shells; shell++)
    for (let tail = FIREWORKS.tails - 1; tail >= 0; tail--)
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
  const count = fireworkShellCount(view.camera.zoom);
  out.fill(0);
  if (!count) return 0;
  const scale = fireworkScale(view.camera.zoom);
  const left = grid.originCol * view.cellDev.w + grid.shiftX;
  const top = grid.originRow * view.cellDev.h + grid.shiftY;
  const worldToDevice = view.dpr * scale;
  const targetGap = Math.max(
    100,
    Math.max(view.width, view.height) / view.dpr / (FIREWORKS.columns - 1),
  );
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
      out[at + 3] = fireworkRadius(seed, view.camera.zoom) * view.dpr;
    }
  if (count === FIREWORKS.sparseShells) {
    // Keep only the four closest existing sites, rather than relocating bursts on zoom.
    for (let slot = 0; slot < count; slot++) {
      let nearest = slot,
        distance = Infinity;
      for (let site = slot; site < FIREWORKS.columns ** 2; site++) {
        const dx = out[site * 4]! - view.width / 2,
          dy = out[site * 4 + 1]! - view.height / 2;
        const next = dx * dx + dy * dy;
        if (next < distance) {
          nearest = site;
          distance = next;
        }
      }
      for (let dimension = 0; dimension < 4; dimension++) {
        const previous = out[slot * 4 + dimension]!;
        out[slot * 4 + dimension] = out[nearest * 4 + dimension]!;
        out[nearest * 4 + dimension] = previous;
      }
    }
    out.fill(0, count * 4);
  } else if (view.camera.zoom <= FIREWORKS.largeZoom) {
    const at = FIREWORKS.columns ** 2 * 4;
    out[at] = view.width / 2;
    out[at + 1] = view.height / 2;
    out[at + 2] = 65532;
    out[at + 3] = Math.min(320 * view.dpr, Math.min(view.width, view.height) * 0.45);
  }
  return count;
}

export const fireworkVariantCodes = (config: FireworksConfig): number[] =>
  config.variants.map((v) => FIREWORK_VARIANTS.indexOf(v));

/** Small time values retain GPU precision even in a long-running tab. */
export function fireworkTime(time: number, reduced: boolean): number {
  return reduced || !Number.isFinite(time)
    ? 0
    : ((time % (FIREWORKS.cycle * 256)) + FIREWORKS.cycle * 256) % (FIREWORKS.cycle * 256);
}
