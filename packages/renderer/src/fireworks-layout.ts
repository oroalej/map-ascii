import type { FireworksConfig } from '@atlas/shared';
import { FIREWORK_VARIANTS } from '@atlas/shared';
import { MAX_ZOOM, project } from './camera';
import type { Grid, View } from './grid';
import { NO_FIREWORK_SITES, type FireworkSiteSampler } from './fireworks-sites';
import { hashString, random } from './life/random';

const REGULAR_SHELLS = 49;

/** A dense, overlapping display with bounded, immutable particle geometry. */
export const FIREWORKS = Object.freeze({
  minZoom: 7,
  hideZoom: MAX_ZOOM,
  denseZoom: 16,
  sparseZoom: 20,
  referenceZoom: 19,
  cameraHeight: 320,
  shells: REGULAR_SHELLS + 1,
  regularShells: REGULAR_SHELLS,
  sparseShells: 4,
  minHeight: 80,
  maxHeight: 220,
  largeHeight: 460,
  largeHeightVariation: 100,
  maxRadius: 520,
  stars: 40,
  tails: 4,
  smoke: 12,
  sparkLife: 4.4,
  smokeLife: 4.8,
});
export const FIREWORK_INSTANCE_COUNT =
  FIREWORKS.shells * (FIREWORKS.stars * FIREWORKS.tails + FIREWORKS.smoke);

/** Density decreases on approach; keep the high burst until its altitude cutoff. */
export function fireworkShellCount(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom < FIREWORKS.minZoom || zoom >= FIREWORKS.hideZoom) return 0;
  const distant = Math.min(
    1,
    (FIREWORKS.sparseZoom - zoom) / (FIREWORKS.sparseZoom - FIREWORKS.denseZoom),
  );
  const regular = Math.ceil(
    zoom >= FIREWORKS.sparseZoom
      ? FIREWORKS.sparseShells * (FIREWORKS.hideZoom - zoom)
      : FIREWORKS.sparseShells + (FIREWORKS.regularShells - FIREWORKS.sparseShells) * distant ** 2,
  );
  return regular + (fireworkCameraHeight(zoom) > FIREWORKS.largeHeight ? 1 : 0);
}

/** Reference-world projection follows map magnification at every supported zoom. */
export function fireworkScale(zoom: number): number {
  const finiteZoom = Number.isFinite(zoom) ? zoom : FIREWORKS.referenceZoom;
  return (
    2 ** (Math.min(MAX_ZOOM, Math.max(FIREWORKS.minZoom, finiteZoom)) - FIREWORKS.referenceZoom)
  );
}

/** Illustrative camera altitude: zooming in descends toward the ground. */
export const fireworkCameraHeight = (zoom: number): number =>
  FIREWORKS.cameraHeight / fireworkScale(zoom);

/** A near plane bounds magnification before the overhead viewpoint passes the burst. */
export function fireworkPerspective(height: number, zoom: number): number {
  const eye = fireworkCameraHeight(zoom);
  return eye > height ? eye / Math.max(eye - height, height * 0.15) : 0;
}

/** Higher fireworks leave the overhead view first as the eye descends below them. */
export function fireworkVisibility(height: number, zoom: number): number {
  const gap = fireworkCameraHeight(zoom) - height;
  const t = Math.min(1, Math.max(0, gap / (height * 0.35)));
  return t * t * (3 - 2 * t);
}

const distantRadius = (height: number) => 30 + height * 0.1;

/** A fixed burst grows on approach, then is culled above the eye rather than shrinking. */
export function fireworkRadius(height: number, zoom: number): number {
  const perspective = fireworkPerspective(height, zoom);
  return perspective
    ? Math.max(
        distantRadius(height) * 2 ** ((zoom - FIREWORKS.denseZoom) * 0.5),
        Math.min(FIREWORKS.maxRadius, height * 0.35 * fireworkScale(zoom) * perspective),
      )
    : 0;
}

/** Spark ink grows with the burst and never shrinks when the map changes cell size. */
export function fireworkSparkWidth(height: number, zoom: number): number {
  const radius = fireworkRadius(height, zoom);
  return radius ? Math.min(12, 2 + Math.sqrt(radius) * 0.6) : 0;
}

/** Illustrative rise time: taller launches take longer to reach their break height. */
export const fireworkRise = (height: number): number => 0.55 + height * 0.005;

type FireworkLaunch = {
  site: number;
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
  /** Packed height visibility and device-pixel spark width for each admitted launch. */
  appearance: Float32Array;
  admitted: Int16Array;
  /** Previously visible source identities, independent of their packed GPU indices. */
  retained: Uint8Array;
  lastTime: number;
  occupied: Set<number>;
  retryAt: Float64Array;
  siteView: Float64Array;
  sites?: FireworkSiteSampler;
  reduced?: boolean;
  /** Tap-only overrides borrow the last four regular slots; ambient launches stay intact. */
  requested?: Map<number, FireworkLaunch>;
};

export type FireworkRequest = {
  id: number;
  at: readonly [number, number];
  zoom: number;
  time: number;
};

export const fireworkTapEligible = (config: FireworksConfig | undefined, altitude: number) =>
  !!config?.variants.length && altitude < 0;

export function clearRequestedFireworks(display: FireworkDisplay) {
  if (!display.requested) return;
  for (const slot of display.requested.keys()) display.retained[slot] = 0;
  delete display.requested;
}

/** Explicit launches need no residential reservation and consume no ambient random draws. */
export function requestFirework(display: FireworkDisplay, request: FireworkRequest): boolean {
  if (!Number.isFinite(request.time) || !request.at.every(Number.isFinite)) return false;
  const requested = (display.requested ??= new Map<number, FireworkLaunch>());
  for (const [slot, launch] of requested)
    if (request.time >= launch.next) {
      requested.delete(slot);
      display.retained[slot] = 0;
    }
  let slot = FIREWORKS.regularShells - 4;
  while (slot < FIREWORKS.regularShells && requested.has(slot)) slot++;
  if (slot === FIREWORKS.regularShells) return false;
  const seed = hashString(`${request.id}/${request.at[0]}/${request.at[1]}`) & 65535;
  const height = Math.min(160, fireworkCameraHeight(request.zoom) * (0.4 + (seed / 65535) * 0.15));
  const rise = fireworkRise(height);
  const [x, y] = project(request.at[0], request.at[1], FIREWORKS.referenceZoom);
  requested.set(slot, {
    site: -1,
    x,
    y,
    seed,
    height,
    rise,
    start: request.time,
    next: request.time + rise + FIREWORKS.smokeLife,
  });
  display.retained[slot] = 0;
  return true;
}

/** Seed once per context, never per frame. An explicit seed makes behavior testable. */
export function createFireworkDisplay(
  seed = Math.floor(Math.random() * 4294967296),
): FireworkDisplay {
  return {
    rng: random(seed),
    launches: new Array<FireworkLaunch | undefined>(FIREWORKS.shells),
    flights: new Float32Array(FIREWORKS.shells * 2),
    appearance: new Float32Array(FIREWORKS.shells * 2),
    admitted: new Int16Array(FIREWORKS.shells),
    retained: new Uint8Array(FIREWORKS.shells),
    lastTime: 0,
    occupied: new Set<number>(),
    retryAt: new Float64Array(FIREWORKS.shells),
    siteView: new Float64Array(5),
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

function swapSlots(buffer: Float32Array | Int16Array, width: number, a: number, b: number) {
  for (let dimension = 0; dimension < width; dimension++) {
    const previous = buffer[a * width + dimension]!;
    buffer[a * width + dimension] = buffer[b * width + dimension]!;
    buffer[b * width + dimension] = previous;
  }
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
  sites: FireworkSiteSampler = NO_FIREWORK_SITES,
): number {
  const limit = fireworkShellCount(view.camera.zoom);
  out.fill(0);
  display.flights.fill(0);
  display.appearance.fill(0);
  display.admitted.fill(-1);
  const clock = reduced || !Number.isFinite(time) ? 0 : Math.max(0, time);
  if (display.requested) {
    if (reduced || clock < display.lastTime) clearRequestedFireworks(display);
    else {
      for (const [slot, launch] of display.requested)
        if (clock >= launch.next) {
          display.requested.delete(slot);
          display.retained[slot] = 0;
        }
      if (!display.requested.size) delete display.requested;
    }
  }
  if (!limit && !display.requested?.size) return 0;
  const slots =
    FIREWORKS.regularShells +
    (fireworkCameraHeight(view.camera.zoom) > FIREWORKS.largeHeight ? 1 : 0);
  if (display.reduced !== reduced || clock < display.lastTime) {
    display.launches.fill(undefined);
    display.retained.fill(0);
    display.retryAt.fill(0);
    display.occupied.clear();
  }
  if (display.sites !== sites) {
    display.sites = sites;
    display.retryAt.fill(0);
  }
  display.reduced = reduced;
  display.lastTime = clock;
  const scale = fireworkScale(view.camera.zoom);
  const left = grid.originCol * view.cellDev.w + grid.shiftX;
  const top = grid.originRow * view.cellDev.h + grid.shiftY;
  const worldToDevice = view.dpr * scale;
  if (
    reduced &&
    (display.siteView[0] !== left ||
      display.siteView[1] !== top ||
      display.siteView[2] !== view.width ||
      display.siteView[3] !== view.height ||
      display.siteView[4] !== worldToDevice)
  )
    display.retryAt.fill(0);
  display.siteView[0] = left;
  display.siteView[1] = top;
  display.siteView[2] = view.width;
  display.siteView[3] = view.height;
  display.siteView[4] = worldToDevice;
  if (reduced) {
    let visible = false,
      surviving = false;
    for (let slot = 0; slot < slots; slot++) {
      const launch = display.launches[slot];
      if (!launch) {
        continue;
      }
      const perspective = fireworkPerspective(launch.height, view.camera.zoom);
      if (!perspective) continue;
      surviving = true;
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
    // Being below every burst is altitude culling, not a pan that needs new still poses.
    if (!visible && surviving) {
      display.launches.fill(undefined);
      display.retained.fill(0);
      display.retryAt.fill(0);
      display.occupied.clear();
    }
  }
  for (const launch of display.launches)
    if (launch && clock >= launch.next) display.occupied.delete(launch.site);
  let count = 0;
  for (let slot = 0; slot < slots; slot++) {
    const large = slot === FIREWORKS.regularShells;
    const requested = display.requested?.get(slot);
    if (!limit && !requested) continue;
    let launch = requested ?? display.launches[slot];
    if (!launch || clock >= launch.next) {
      if (clock < display.retryAt[slot]!) continue;
      // Prewarm on entry/long tab suspension, so opening a preview never waits for a show.
      const prewarm = !launch || clock - launch.next > FIREWORKS.smokeLife;
      const rng = display.rng;
      const height = large
        ? FIREWORKS.largeHeight + rng() * FIREWORKS.largeHeightVariation
        : FIREWORKS.minHeight + rng() * (FIREWORKS.maxHeight - FIREWORKS.minHeight);
      const rise = fireworkRise(height);
      // Hidden high-density slots cover wider ground footprints instead of all spawning
      // inside the close viewport and collapsing into one patch when zooming back out.
      // Invert the regular density curve to assign each rank its own coverage scale.
      const coverageZoom = Math.min(
        view.camera.zoom,
        large || slot < FIREWORKS.sparseShells
          ? view.camera.zoom
          : FIREWORKS.sparseZoom -
              (FIREWORKS.sparseZoom - FIREWORKS.denseZoom) *
                Math.sqrt(
                  (slot + 1 - FIREWORKS.sparseShells) /
                    (FIREWORKS.regularShells - FIREWORKS.sparseShells),
                ),
      );
      const coverage = scale / fireworkScale(coverageZoom);
      const radius = large ? fireworkRadius(height, view.camera.zoom) * view.dpr : 0;
      const marginX = large ? Math.min(0.45, radius / view.width) : 0.08;
      const marginY = large ? Math.min(0.45, radius / view.height) : 0.08;
      const centerX = (left + view.width / 2) / worldToDevice;
      const centerY = (top + view.height / 2) / worldToDevice;
      const halfWidth = ((0.5 - marginX) * view.width * coverage) / worldToDevice;
      const halfHeight = ((0.5 - marginY) * view.height * coverage) / worldToDevice;
      const site = sites(
        {
          left: centerX - halfWidth,
          right: centerX + halfWidth,
          top: centerY - halfHeight,
          bottom: centerY + halfHeight,
        },
        rng,
        display.occupied,
      );
      if (!site) {
        display.launches[slot] = undefined;
        display.retained[slot] = 0;
        // Retry boundedly while waiting for geography; a new tile set retries immediately.
        display.retryAt[slot] = clock + 0.5;
        continue;
      }
      display.occupied.add(site.id);
      const interval = rise + FIREWORKS.smokeLife + 0.25 + rng() * 2.75;
      // Sample the whole interval on entry, rather than starting every shell in a burst
      // and creating a synchronized lull a few seconds later. Still poses show a break.
      const start = clock - (reduced ? rise + 0.2 + rng() * 3.2 : prewarm ? rng() * interval : 0);
      launch = {
        site: site.id,
        x: site.x,
        y: site.y,
        seed: Math.floor(rng() * 65536),
        height,
        rise,
        start,
        next: start + interval,
      };
      display.launches[slot] = launch;
      display.retained[slot] = 0;
    }
    const perspective = fireworkPerspective(launch.height, view.camera.zoom);
    if (!perspective) continue;
    const at = count * 4;
    // Orthographic ground anchors keep the burst over its mapped residential footprint.
    // Altitude magnifies its extent, not its geographic position into adjacent fields.
    out[at] = launch.x * worldToDevice - left;
    out[at + 1] = launch.y * worldToDevice - top;
    out[at + 2] = launch.seed;
    out[at + 3] = fireworkRadius(launch.height, view.camera.zoom) * view.dpr;
    display.flights[count * 2] = Math.min(
      clock - launch.start,
      launch.rise + FIREWORKS.smokeLife + 3,
    );
    display.flights[count * 2 + 1] = launch.rise;
    display.appearance[count * 2] = fireworkVisibility(launch.height, view.camera.zoom);
    display.appearance[count * 2 + 1] =
      fireworkSparkWidth(launch.height, view.camera.zoom) * view.dpr;
    display.admitted[count++] = slot;
  }
  const high = count > 0 && display.admitted[count - 1] === FIREWORKS.regularShells ? 1 : 0;
  const candidates = count - high;
  const regularLimit = Math.max(
    limit - (slots - FIREWORKS.regularShells),
    display.requested?.size ?? 0,
  );
  if (regularLimit < candidates) {
    // Keep still-visible identities before admitting nearer replacements. This prevents
    // incremental zoom/pan from swapping a followed burst for a smaller nearby launch.
    // Thin regular launches by proximity; the high burst still leaves by altitude alone.
    // Never substitute lower heights or restart flights to fill a closer view.
    for (let slot = 0; slot < regularLimit; slot++) {
      let nearest = slot,
        retained = -1,
        distance = Infinity;
      for (let candidate = slot; candidate < candidates; candidate++) {
        const dx = out[candidate * 4]! - view.width / 2,
          dy = out[candidate * 4 + 1]! - view.height / 2;
        const radius = out[candidate * 4 + 3]!;
        const visible =
          Math.abs(dx) <= view.width / 2 + radius && Math.abs(dy) <= view.height / 2 + radius;
        const source = display.admitted[candidate]!;
        const keep = display.requested?.has(source)
          ? 2
          : visible && display.retained[source]
            ? 1
            : 0;
        const next = dx * dx + dy * dy;
        if (keep > retained || (keep === retained && next < distance)) {
          nearest = candidate;
          retained = keep;
          distance = next;
        }
      }
      swapSlots(out, 4, slot, nearest);
      swapSlots(display.flights, 2, slot, nearest);
      swapSlots(display.appearance, 2, slot, nearest);
      swapSlots(display.admitted, 1, slot, nearest);
    }
    if (high) {
      swapSlots(out, 4, regularLimit, candidates);
      swapSlots(display.flights, 2, regularLimit, candidates);
      swapSlots(display.appearance, 2, regularLimit, candidates);
      swapSlots(display.admitted, 1, regularLimit, candidates);
    }
    count = regularLimit + high;
    out.fill(0, count * 4);
    display.flights.fill(0, count * 2);
    display.appearance.fill(0, count * 2);
    display.admitted.fill(-1, count);
  }
  display.retained.fill(0);
  for (let packed = 0; packed < count; packed++) display.retained[display.admitted[packed]!] = 1;
  return count;
}

export const fireworkVariantCodes = (config: FireworksConfig): number[] =>
  config.variants.map((v) => FIREWORK_VARIANTS.indexOf(v));
