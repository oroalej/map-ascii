import { utilitySeed, type BBox } from '@atlas/shared';
import { project, TILE_SIZE } from '../camera';
import { cellHash } from '../glyphs/select';
import { MERCATOR_METERS } from '../raster/geometry';
import type { WindNow } from './wind';

/** Shared CPU/shader constants. The octave lattices tile the fixed meter wrap. */
export const SKY = {
  wrap: 8192,
  coarseCells: 20,
  fineCells: 51,
  coarseWeight: 0.65,
  fineWeight: 0.35,
  spellSeconds: 3 * 3600,
  wobbleSeconds: 40 * 60,
  wobbleWeight: 0.1,
  clearEdge: 0.32,
  cloudyEdge: 0.85,
  maxCover: 0.75,
  softness: 0.25,
  shadow: 0.22,
  moonLoss: 0.8,
  speed: 6 / 0.7,
  maxDt: 0.25,
  dirtyCover: 0.01,
  detailMin: 0.05,
  detailPixels: 4,
  coarsePurpose: utilitySeed('sky:coarse'),
  finePurpose: utilitySeed('sky:fine'),
} as const;

export type Meters = readonly [number, number];
const wrap = (v: number, period: number = SKY.wrap): number => ((v % period) + period) % period;
const ease = (v: number): number => v * v * (3 - 2 * v);
const smoothstep = (a: number, b: number, v: number): number =>
  ease(Math.max(0, Math.min(1, (v - a) / (b - a))));
const random = (x: number, y: number): number => (cellHash(x, y) >>> 8) / 16777216;
const timeNoise = (seconds: number, period: number, seed: number): number => {
  const t = seconds / period,
    k = Math.floor(t);
  return random(k, seed) + (random(k + 1, seed) - random(k, seed)) * ease(t - k);
};

/** One replacement point for future climate cover; depends only on the shown city moment. */
export function cloudCover(moment: Date, seed: number): number {
  const seconds = moment.getTime() / 1000;
  const spell = timeNoise(seconds, SKY.spellSeconds, utilitySeed('cover:spell', seed));
  const wobble = timeNoise(seconds, SKY.wobbleSeconds, utilitySeed('cover:wobble', seed));
  return (
    SKY.maxCover *
    smoothstep(
      SKY.clearEdge,
      SKY.cloudyEdge,
      spell * (1 - SKY.wobbleWeight) + wobble * SKY.wobbleWeight,
    )
  );
}

/** Bounds midpoint, independent of camera, density, DPR and the city's display name. */
export function skyAnchor(bounds: BBox) {
  const lng = (bounds[0] + bounds[2]) / 2,
    lat = (bounds[1] + bounds[3]) / 2;
  return {
    point: project(lng, lat, 0),
    meters: (MERCATOR_METERS * Math.cos((lat * Math.PI) / 180)) / TILE_SIZE,
    seed: utilitySeed(`sky:${Math.round(lng * 1e4)},${Math.round(lat * 1e4)}`),
  };
}

/** Float64 subtraction happens here before upload, preserving precision at street zoom. */
export function skyGrid(
  anchor: ReturnType<typeof skyAnchor>,
  world: readonly [number, number, number, number],
) {
  const [sx, sy, col, row] = world,
    [x, y] = anchor.point,
    k = anchor.meters;
  return {
    meterOrigin: [wrap((col / sx - x) * k), wrap((row / sy - y) * k)] as Meters,
    meterStep: [k / sx, k / sy] as Meters,
  };
}

/** Periodic float-coordinate value noise; scale is the number of lattice cells per wrap. */
export function skyNoise(meters: Meters, scale: number, seed: number): number {
  const x = (wrap(meters[0]) / SKY.wrap) * scale,
    y = (wrap(meters[1]) / SKY.wrap) * scale;
  const ix = Math.floor(x),
    iy = Math.floor(y),
    fx = ease(x - ix),
    fy = ease(y - iy);
  const at = (dx: number, dy: number) => random(wrap(ix + dx, scale), wrap(iy + dy, scale) ^ seed);
  const top = at(0, 0) + (at(1, 0) - at(0, 0)) * fx;
  const bottom = at(0, 1) + (at(1, 1) - at(0, 1)) * fx;
  return top + (bottom - top) * fy;
}

export function shadowAt(meters: Meters, cover: number, offset: Meters, seed: number): number {
  if (cover <= 0) return 0;
  if (cover >= 1) return 1;
  const at: Meters = [meters[0] - offset[0], meters[1] - offset[1]];
  const noise =
    skyNoise(at, SKY.coarseCells, seed ^ SKY.coarsePurpose) * SKY.coarseWeight +
    skyNoise(at, SKY.fineCells, seed ^ SKY.finePurpose) * SKY.fineWeight;
  return smoothstep(1 - cover, 1 - cover + SKY.softness, noise);
}

/** Positive downwind displacement. Inactive intervals are rebased by the atlas. */
export function driftClouds(
  offset: Meters,
  wind: WindNow,
  dt: number,
  reducedMotion: boolean,
): Meters {
  if (reducedMotion) return offset;
  const distance = Math.max(0, Math.min(SKY.maxDt, dt)) * wind.strength * SKY.speed;
  return [wrap(offset[0] + wind.dir[0] * distance), wrap(offset[1] + wind.dir[1] * distance)];
}

export const skyNoiseGlsl = /* glsl */ `
float skyValue(ivec2 cell, int size, uint seed) {
  ivec2 p = ivec2((cell.x + size) % size, (cell.y + size) % size);
  return float(cellHash(ivec2(p.x, int(uint(p.y) ^ seed))) >> 8u) / 16777216.0;
}
float skyNoise(vec2 meters, int size, uint seed) {
  vec2 p = mod(meters, ${SKY.wrap}.0) / ${SKY.wrap}.0 * float(size);
  ivec2 c = ivec2(floor(p));
  vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(skyValue(c, size, seed), skyValue(c + ivec2(1, 0), size, seed), f.x),
    mix(skyValue(c + ivec2(0, 1), size, seed), skyValue(c + ivec2(1), size, seed), f.x), f.y);
}
float cloudShadow(vec2 meters, float cover, uint seed) {
  if (cover <= 0.0) return 0.0;
  if (cover >= 1.0) return 1.0;
  float noise = skyNoise(meters, ${SKY.coarseCells}, seed ^ ${SKY.coarsePurpose}u) * ${SKY.coarseWeight} +
    skyNoise(meters, ${SKY.fineCells}, seed ^ ${SKY.finePurpose}u) * ${SKY.fineWeight};
  return smoothstep(1.0 - cover, 1.0 - cover + ${SKY.softness}, noise);
}
`;
