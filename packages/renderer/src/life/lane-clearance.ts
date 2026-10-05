import type { Body } from './occupancy';

/** Fixed obstacles a vehicle body must keep off, in a line's tile metres. */
export type LaneTerrain = {
  /** Whether any obstacle lies in this box (tile metres); a cheap filter before sampling. */
  near(x0: number, y0: number, x1: number, y1: number): boolean;
  /** Whether the body touches an obstacle. */
  hits(body: Body): boolean;
};

/** How a lane bends around fixed obstacles: sample spacing, steepest bend, and clearances. */
export const LANE_BEND = {
  /** Profile samples, m apart along the line. */
  sampleM: 1,
  /** Sideways metres per metre of travel, at most (about 14°). */
  slope: 0.25,
  /** Candidate offsets are tried this far apart, m. */
  stepM: 0.25,
  /** A move between two lines' lanes takes at most this long, m. */
  handoffMaxM: 40,
  /** A bend is held across a dip shorter than this, m, instead of weaving. */
  holdM: 12,
  /** Bends are rounded over this radius, m, so the nose turns gradually. */
  smoothM: 2,
  /** Extra room kept around the body while planning, m (width, length). */
  pad: { width: 0.3, length: 0.4 },
} as const;

export type LaneSpec = {
  /** The line's points in travel order, in tile units. */
  points: ArrayLike<number>;
  perMeter: number;
  /** The ordinary lane offset right of travel, m. */
  base: number;
  /** The total offset may lie in [lo, hi], m right of the centre line. */
  lo: number;
  hi: number;
  length: number;
  width: number;
};

/**
 * Sideways metres to add to a lane at each `LANE_BEND.sampleM` along a line so a vehicle's body
 * clears fixed obstacles, tapered so it bends no steeper than `LANE_BEND.slope`. Undefined
 * when the ordinary lane is clear throughout. Where no offset in [lo, hi] clears, that sample
 * keeps its ordinary lane and the movement guard stops the vehicle there as before.
 */
export function laneBend(spec: LaneSpec, terrain: LaneTerrain): Float32Array | undefined {
  const { points, perMeter, base, lo, hi } = spec;
  const width = spec.width + LANE_BEND.pad.width,
    length = spec.length + LANE_BEND.pad.length;
  const count = points.length / 2;
  if (count < 2) return;
  // Broad phase: the whole line, widened by the lane's reach.
  const reach = Math.max(Math.abs(lo), Math.abs(hi)) + width / 2 + length / 2;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = points[i * 2]! / perMeter,
      y = points[i * 2 + 1]! / perMeter;
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  if (!terrain.near(x0 - reach, y0 - reach, x1 + reach, y1 + reach)) return;
  const segments: { x: number; y: number; hx: number; hy: number; start: number; length: number }[] =
    [];
  let total = 0;
  for (let i = 0; i < count - 1; i++) {
    const x = points[i * 2]! / perMeter,
      y = points[i * 2 + 1]! / perMeter;
    const dx = points[i * 2 + 2]! / perMeter - x,
      dy = points[i * 2 + 3]! / perMeter - y;
    const l = Math.hypot(dx, dy);
    if (l <= 1e-9) continue;
    segments.push({ x, y, hx: dx / l, hy: dy / l, start: total, length: l });
    total += l;
  }
  if (!segments.length) return;
  const samples = Math.floor(total / LANE_BEND.sampleM) + 1;
  const need = new Float32Array(samples);
  const body: Body = { x: 0, y: 0, hx: 0, hy: 0, length, width };
  let segment = 0,
    any = false;
  const at = (s: number, offset: number) => {
    const g = segments[segment]!;
    const t = s - g.start;
    body.x = g.x + g.hx * t - g.hy * offset;
    body.y = g.y + g.hy * t + g.hx * offset;
    body.hx = g.hx;
    body.hy = g.hy;
    return body;
  };
  // Candidates nearest the lane first; at equal distance, the right (own) side first.
  const candidates: number[] = [];
  for (let k = 1; base - k * LANE_BEND.stepM >= lo || base + k * LANE_BEND.stepM <= hi; k++) {
    if (base + k * LANE_BEND.stepM <= hi) candidates.push(k * LANE_BEND.stepM);
    if (base - k * LANE_BEND.stepM >= lo) candidates.push(-k * LANE_BEND.stepM);
  }
  const clear = (s: number, shift: number, yaw = 0) => {
    // Padded room first; where only the exact body fits, the guard's own test decides.
    for (const pad of [1, 0]) {
      body.width = spec.width + pad * LANE_BEND.pad.width;
      body.length = spec.length + pad * LANE_BEND.pad.length;
      const b = at(s, base + shift);
      if (yaw) {
        // The body as drawn while the lane moves sideways: its nose turned along the bend.
        const hx = b.hx - b.hy * yaw,
          hy = b.hy + b.hx * yaw;
        const norm = Math.hypot(hx, hy);
        b.hx = hx / norm;
        b.hy = hy / norm;
      }
      if (!terrain.hits(b)) return pad === 1 ? 2 : 1;
    }
    return 0;
  };
  const near = (i: number) => {
    const s = Math.min(i * LANE_BEND.sampleM, total - 1e-6);
    segment = 0;
    while (segment < segments.length - 1 && s >= segments[segment + 1]!.start) segment++;
    const g = segments[segment]!;
    const px = g.x + g.hx * (s - g.start),
      py = g.y + g.hy * (s - g.start);
    const r = Math.max(Math.abs(lo), Math.abs(hi)) + width / 2 + length / 2;
    return terrain.near(px - r, py - r, px + r, py + r) ? s : undefined;
  };
  /** The shift nearest `from` (and beyond it, away from the lane) that clears sample `i`. */
  const search = (i: number, s: number, from: number, yaw: number) => {
    let fallback: number | undefined;
    const ordered = from
      ? candidates.filter((c) => Math.sign(c) === Math.sign(from) && Math.abs(c) >= Math.abs(from))
      : candidates;
    for (const shift of from ? [from, ...ordered] : ordered) {
      const fit = clear(s, shift, yaw);
      if (fit === 2) return shift;
      if (fit === 1) fallback ??= shift;
    }
    return fallback;
  };
  for (let i = 0; i < samples; i++) {
    const s = near(i);
    if (s === undefined || clear(s, 0) === 2) continue;
    const shift = search(i, s, 0, 0);
    // Where only the exact body fits in the ordinary lane, it needs no bend.
    if (shift !== undefined && (clear(s, shift) === 2 || clear(s, 0) === 0)) {
      need[i] = shift;
      any = true;
    }
  }
  if (!any) return;
  const step = LANE_BEND.slope * LANE_BEND.sampleM;
  let profile = taper(need, step);
  // Turning the nose along the bend swings the body's ends sideways: check each sample as it
  // will be drawn, and bend further where that touches an obstacle.
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (let i = 0; i < samples; i++) {
      const yaw =
        ((profile[Math.min(samples - 1, i + 1)]! - profile[Math.max(0, i - 1)]!) /
          (Math.min(samples - 1, i + 1) - Math.max(0, i - 1) || 1)) /
        LANE_BEND.sampleM;
      if (!yaw) continue;
      const s = near(i);
      if (s === undefined || clear(s, profile[i]!, yaw)) continue;
      const shift = search(i, s, profile[i]!, yaw);
      if (shift === undefined || shift === profile[i]) continue;
      need[i] = shift;
      changed = true;
    }
    if (!changed) break;
    profile = taper(need, step);
  }
  return profile;
}

/**
 * A smooth profile that keeps each sample's required shift and changes by at most `step` per
 * sample. A shift to one side is kept until the other side's requirement outweighs it.
 */
export function taper(need: Float32Array, step: number): Float32Array {
  const n = need.length;
  const right = new Float32Array(n),
    left = new Float32Array(n);
  const r = Math.round(LANE_BEND.smoothM / LANE_BEND.sampleM);
  for (let i = 0; i < n; i++) {
    // Widened by the smoothing radius, so the averaging below never falls short of it.
    for (let j = Math.max(0, i - r); j <= Math.min(n - 1, i + r); j++) {
      right[i] = Math.max(right[i]!, need[j]!);
      left[i] = Math.max(left[i]!, -need[j]!);
    }
  }
  const gap = Math.round(LANE_BEND.holdM / LANE_BEND.sampleM);
  for (const side of [right, left]) {
    // A short dip between two requirements is held: a driver doesn't weave between them.
    const held = Float32Array.from(side);
    for (let i = 0; i < n; i++) {
      let before = 0,
        after = 0;
      for (let j = Math.max(0, i - gap); j <= i; j++) before = Math.max(before, side[j]!);
      for (let j = i; j <= Math.min(n - 1, i + gap); j++) after = Math.max(after, side[j]!);
      held[i] = Math.max(side[i]!, Math.min(before, after));
    }
    side.set(held);
    for (let i = 1; i < n; i++) side[i] = Math.max(side[i]!, side[i - 1]! - step);
    for (let i = n - 2; i >= 0; i--) side[i] = Math.max(side[i]!, side[i + 1]! - step);
    // Averaging rounds the bend's corners, so the nose turns gradually; it keeps the slope.
    const sharp = Float32Array.from(side);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let j = i - r; j <= i + r; j++) sum += sharp[Math.max(0, Math.min(n - 1, j))]!;
      side[i] = sum / (2 * r + 1);
    }
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = right[i]! >= left[i]! ? right[i]! : -left[i]!;
  return out;
}

/** A profile's value `s` metres along it, interpolated; its ends hold. */
export function bendAt(profile: Float32Array, s: number): number {
  const at = s / LANE_BEND.sampleM;
  if (at <= 0) return profile[0]!;
  const last = profile.length - 1;
  if (at >= last) return profile[last]!;
  const i = Math.floor(at);
  return profile[i]! + (profile[i + 1]! - profile[i]!) * (at - i);
}
