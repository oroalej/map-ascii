import type { FireworksConfig } from '@atlas/shared';
import { FIREWORK_VARIANTS } from '@atlas/shared';
import { MAX_ZOOM, MIN_ZOOM } from './camera';
import type { Grid, View } from './grid';
import { random } from './life/random';

const REGULAR_SHELLS = 49;

/** A dense, overlapping display with bounded, immutable particle geometry. */
export const FIREWORKS = Object.freeze({
  minZoom: MIN_ZOOM,
  hideZoom: MAX_ZOOM,
  largeZoom: 16,
  sparseZoom: 20,
  referenceZoom: 19,
  shells: REGULAR_SHELLS + 1,
  regularShells: REGULAR_SHELLS,
  sparseShells: 4,
  minHeight: 80,
  maxHeight: 220,
  largeHeight: 460,
  largeHeightVariation: 100,
  distantScale: 0.6,
  stars: 40,
  tails: 4,
  smoke: 12,
  sparkLife: 4.4,
  smokeLife: 4.8,
});
export const FIREWORK_INSTANCE_COUNT =
  FIREWORKS.shells * (FIREWORKS.stars * FIREWORKS.tails + FIREWORKS.smoke);

/** Zoom bands share one visibility rule between the GPU pass and legend. */
export function fireworkShellCount(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom < FIREWORKS.minZoom || zoom >= FIREWORKS.hideZoom) return 0;
  if (zoom >= FIREWORKS.sparseZoom) return FIREWORKS.sparseShells;
  return FIREWORKS.regularShells + (zoom <= FIREWORKS.largeZoom ? 1 : 0);
}

/** Reference-world projection follows map magnification at every supported zoom. */
export function fireworkScale(zoom: number): number {
  const finiteZoom = Number.isFinite(zoom) ? zoom : FIREWORKS.referenceZoom;
  return (
    2 ** (Math.min(MAX_ZOOM, Math.max(FIREWORKS.minZoom, finiteZoom)) - FIREWORKS.referenceZoom)
  );
}

/** Higher breaks look closer to the overhead camera; zoom magnifies that height cue. */
export function fireworkRadius(height: number, zoom: number): number {
  return height * 0.95 * Math.max(FIREWORKS.distantScale, fireworkScale(zoom));
}

/** Illustrative rise time: taller launches take longer to reach their break height. */
export const fireworkRise = (height: number): number => 0.55 + height * 0.005;

type FireworkLaunch = {
  x: number;
  y: number;
  seed: number;
  height: number;
  rise: number;
  start: number;
  next: number;
};

export type FireworkDisplay = {
  rng: () => number;
  launches: (FireworkLaunch | undefined)[];
  /** Small per-shell ages and rise times keep shader clocks precise indefinitely. */
  flights: Float32Array;
  lastTime: number;
  reduced?: boolean;
};

/** Seed once per context, never per frame. An explicit seed makes behavior testable. */
export function createFireworkDisplay(
  seed = Math.floor(Math.random() * 4294967296),
): FireworkDisplay {
  return {
    rng: random(seed),
    launches: new Array<FireworkLaunch | undefined>(FIREWORKS.shells),
    flights: new Float32Array(FIREWORKS.shells * 2),
    lastTime: 0,
  };
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

/**
 * Sample a new visible world location, height and timing only after a shell's smoke expires.
 * In-flight launches retain their world anchors through pan, zoom and resize. Independent
 * random pauses remove synchronized waves; no lattice or repeating viewport center remains.
 */
export function fireworkShells(
  view: View,
  grid: Grid,
  out: Float32Array,
  display: FireworkDisplay,
  time: number,
  reduced: boolean,
): number {
  const count = fireworkShellCount(view.camera.zoom);
  out.fill(0);
  display.flights.fill(0);
  if (!count) return 0;
  const clock = reduced || !Number.isFinite(time) ? 0 : Math.max(0, time);
  if (display.reduced !== reduced || clock < display.lastTime) display.launches.fill(undefined);
  display.reduced = reduced;
  display.lastTime = clock;
  const scale = fireworkScale(view.camera.zoom);
  const left = grid.originCol * view.cellDev.w + grid.shiftX;
  const top = grid.originRow * view.cellDev.h + grid.shiftY;
  const worldToDevice = view.dpr * scale;
  if (reduced) {
    let visible = false;
    for (let slot = 0; slot < count; slot++) {
      const launch = display.launches[slot];
      if (!launch) {
        visible = true;
        break;
      }
      const x = launch.x * worldToDevice - left,
        y = launch.y * worldToDevice - top;
      const radius = fireworkRadius(launch.height, view.camera.zoom) * view.dpr;
      if (
        x + radius >= 0 &&
        x - radius <= view.width &&
        y + radius >= 0 &&
        y - radius <= view.height
      ) {
        visible = true;
        break;
      }
    }
    // A still show has no future launches to fill a completely new area after a long pan.
    if (!visible) display.launches.fill(undefined);
  }
  for (let slot = 0; slot < count; slot++) {
    const large = slot === FIREWORKS.regularShells;
    let launch = display.launches[slot];
    if (!launch || clock >= launch.next) {
      // Prewarm on entry/long tab suspension, so opening a preview never waits for a show.
      const prewarm = !launch || clock - launch.next > FIREWORKS.smokeLife;
      const rng = display.rng;
      const height = large
        ? FIREWORKS.largeHeight + rng() * FIREWORKS.largeHeightVariation
        : FIREWORKS.minHeight + rng() * (FIREWORKS.maxHeight - FIREWORKS.minHeight);
      const rise = fireworkRise(height);
      const radius = large
        ? Math.min(
            fireworkRadius(height, view.camera.zoom) * view.dpr,
            Math.min(view.width, view.height) * 0.45,
          )
        : 0;
      const marginX = large ? radius / view.width : 0.08;
      const marginY = large ? radius / view.height : 0.08;
      const interval = rise + FIREWORKS.smokeLife + 0.25 + rng() * 2.75;
      // Sample the whole interval on entry, rather than starting every shell in a burst
      // and creating a synchronized lull a few seconds later. Still poses show a break.
      const start = clock - (reduced ? rise + 0.2 + rng() * 3.2 : prewarm ? rng() * interval : 0);
      launch = {
        x: (left + (marginX + rng() * (1 - marginX * 2)) * view.width) / worldToDevice,
        y: (top + (marginY + rng() * (1 - marginY * 2)) * view.height) / worldToDevice,
        seed: Math.floor(rng() * 65536),
        height,
        rise,
        start,
        next: start + interval,
      };
      display.launches[slot] = launch;
    }
    const at = slot * 4;
    out[at] = launch.x * worldToDevice - left;
    out[at + 1] = launch.y * worldToDevice - top;
    out[at + 2] = launch.seed;
    const radius = fireworkRadius(launch.height, view.camera.zoom) * view.dpr;
    out[at + 3] = large ? Math.min(radius, Math.min(view.width, view.height) * 0.45) : radius;
    display.flights[slot * 2] = Math.min(
      clock - launch.start,
      launch.rise + FIREWORKS.smokeLife + 3,
    );
    display.flights[slot * 2 + 1] = launch.rise;
  }
  return count;
}

export const fireworkVariantCodes = (config: FireworksConfig): number[] =>
  config.variants.map((v) => FIREWORK_VARIANTS.indexOf(v));
