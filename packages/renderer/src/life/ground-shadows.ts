/**
 * Shadows on the ground (SPEC.md §4 "Life layer"): each admitted vehicle's or large figure's
 * footprint, swept away from the sun by its height over the tangent of the sun's altitude, marked
 * sixth by sixth as `LIFE_GROUND_SHADOW` texels for the glyph shader to darken the ground under.
 * They fall after every agent is drawn: a rejected agent leaves none, and where an agent stands
 * the part layer notes the shadow under it instead, so the ground beside it stays dark.
 */
import { packGlyph } from '../glyphs/select';
import { GROUND_SHADOW, LIFE_GROUND_SHADOW } from './config';
import { PartsFlag, SHADOW_STRIDE, writeParts, type LifePartsTarget } from './parts-layer';
import type { Sun } from './sun';
import { LIFE_AGENT_MASK } from './turn-signals';

type ShadowGrid = { cols: number; rows: number; cellWidth: number; cellHeight: number };

/** Sixths already shaded this frame, by cell, so overlapping shadows join up. */
let shaded = new Uint8Array(0);

/** How far a caster's shadow reaches, m. */
export const shadowLength = (height: number, altitude: number) =>
  Math.min(GROUND_SHADOW.reach, height / Math.tan((Math.max(altitude, 1) * Math.PI) / 180));

export function castGroundShadows(
  out: Uint8Array,
  parts: LifePartsTarget | undefined,
  grid: ShadowGrid,
  casters: Float64Array,
  count: number,
  sun: Sun,
  sextants: Uint16Array,
) {
  if (!count) return;
  const { cols, rows, cellWidth: w, cellHeight: h } = grid;
  if (shaded.length < cols * rows) shaded = new Uint8Array(cols * rows);
  else shaded.fill(0, 0, cols * rows);
  const az = (sun.azimuth * Math.PI) / 180;
  const awayX = -Math.sin(az);
  const awayY = Math.cos(az);
  const smallest = Math.min(w / 2, h / 3);
  for (let i = 0; i < count; i++) {
    const slot = i * SHADOW_STRIDE;
    const cx = casters[slot]!,
      cy = casters[slot + 1]!,
      ax = casters[slot + 2]!,
      ay = casters[slot + 3]!,
      sx = casters[slot + 4]!,
      sy = casters[slot + 5]!,
      hl = casters[slot + 6]!,
      hw = casters[slot + 7]!,
      height = casters[slot + 8]!;
    const det = ax * sy - ay * sx;
    if (Math.abs(det) < 1e-9) continue;
    // Device px per meter (a meter is square on screen), then the shadow's reach in cells.
    const perMeter = Math.hypot(ax * w, ay * h);
    const reachPx = shadowLength(height, sun.altitude) * perMeter;
    // A shadow that wouldn't clear a sixth doesn't show.
    if (reachPx < smallest) continue;
    const dx = (awayX * reachPx) / w;
    const dy = (awayY * reachPx) / h;
    // The same reach in meters forward and to the right.
    const df = (dx * sy - dy * sx) / det;
    const dr = (ax * dy - ay * dx) / det;
    const extentX = Math.abs(ax) * hl + Math.abs(sx) * hw;
    const extentY = Math.abs(ay) * hl + Math.abs(sy) * hw;
    const c0 = Math.max(0, Math.floor(Math.min(cx, cx + dx) - extentX));
    const c1 = Math.min(cols - 1, Math.floor(Math.max(cx, cx + dx) + extentX));
    const r0 = Math.max(0, Math.floor(Math.min(cy, cy + dy) - extentY));
    const r1 = Math.min(rows - 1, Math.floor(Math.max(cy, cy + dy) + extentY));
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        let mask = 0;
        for (let bit = 0; bit < 6; bit++) {
          const qx = c + ((bit & 1) + 0.5) / 2 - cx;
          const qy = r + ((bit >> 1) + 0.5) / 3 - cy;
          const forward = (qx * sy - qy * sx) / det;
          const right = (ax * qy - ay * qx) / det;
          // Is there a point along the sweep whose footprint covers this sixth?
          let from = 0;
          let to = 1;
          if (Math.abs(df) < 1e-9) {
            if (Math.abs(forward) >= hl) continue;
          } else {
            const a = (forward - hl) / df;
            const b = (forward + hl) / df;
            from = Math.max(from, Math.min(a, b));
            to = Math.min(to, Math.max(a, b));
          }
          if (Math.abs(dr) < 1e-9) {
            if (Math.abs(right) >= hw) continue;
          } else {
            const a = (right - hw) / dr;
            const b = (right + hw) / dr;
            from = Math.max(from, Math.min(a, b));
            to = Math.min(to, Math.max(a, b));
          }
          if (from <= to) mask |= 1 << bit;
        }
        if (mask === 0) continue;
        const cell = r * cols + c;
        const at = cell * 4;
        if ((out[at + 2]! & LIFE_AGENT_MASK) !== 0) {
          if (parts) {
            const value =
              (parts.texels[at]! |
                (parts.texels[at + 1]! << 8) |
                (parts.texels[at + 2]! << 16) |
                ((parts.texels[at + 3]! | PartsFlag.shadowUnder) << 24)) >>>
              0;
            writeParts(parts, at, value, cols);
          }
          continue;
        }
        const joined = shaded[cell]! | mask;
        shaded[cell] = joined;
        const glyph = sextants[joined]!;
        if (glyph <= 0) continue;
        [out[at], out[at + 1]] = packGlyph(glyph, 0);
        out[at + 2] = 0;
        out[at + 3] = LIFE_GROUND_SHADOW;
      }
  }
}
