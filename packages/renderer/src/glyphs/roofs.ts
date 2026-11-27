import { foldRoofAngle, roofAngleByte, type RoofSurface } from '../raster/roofs';

export const RoofCode = {
  none: 0,
  sidePos: 1,
  sideNeg: 2,
  ridge: 3,
  endPos: 4,
  endNeg: 5,
  hipPos: 6,
  hipNeg: 7,
} as const;

/** Separate derivative widths mirror the two cell-shader distance fields. */
export function roofSurfaceCode(
  [along, across, ridgeHalf, scale]: RoofSurface,
  acrossWidth: number,
  hipWidth: number,
): number {
  const end = scale * (Math.abs(along) - ridgeHalf),
    side = Math.abs(across);
  if (scale > 0) {
    if (end > side + hipWidth * 0.5) return along > 0 ? RoofCode.endPos : RoofCode.endNeg;
    if (Math.abs(end - side) <= hipWidth * 0.5 && (end > 0 || ridgeHalf === 0))
      return along * across >= 0 ? RoofCode.hipPos : RoofCode.hipNeg;
  }
  if ((scale === 0 || (ridgeHalf > 0 && end <= 0)) && side <= acrossWidth * 0.5)
    return RoofCode.ridge;
  return across > 0 ? RoofCode.sidePos : RoofCode.sideNeg;
}

/** Angle byte is rewritten for hip lines only; slope cells retain the base axis. */
export function roofLineAngle(code: number, angleByte: number, endScale: number): number {
  if (code !== RoofCode.hipPos && code !== RoofCode.hipNeg) return angleByte;
  return roofAngleByte(
    foldRoofAngle(
      (angleByte / 255) * Math.PI + (code === RoofCode.hipPos ? 1 : -1) * Math.atan(endScale),
    ),
  );
}

/** null retains the height ramp. Sun vectors use physical east/south axes, not cell aspect. */
export function roofSlopeVariant(
  code: number,
  angleByte: number,
  sun: readonly [number, number],
): number | null {
  const theta = (angleByte / 255) * Math.PI;
  let x = -Math.sin(theta),
    y = Math.cos(theta);
  if (code === RoofCode.endPos || code === RoofCode.endNeg) {
    x = Math.cos(theta);
    y = Math.sin(theta);
  } else if (code !== RoofCode.sidePos && code !== RoofCode.sideNeg) return null;
  const sign = code === RoofCode.sideNeg || code === RoofCode.endNeg ? -1 : 1;
  const length = Math.hypot(...sun);
  const dot = length ? (sign * (x * sun[0] + y * sun[1])) / length : 0;
  return dot > 0.25 ? 2 : dot < -0.25 ? 1 : null;
}

/**
 * Roof surfaces on the fine cell steps (shaders/glyph.ts `roofTexture`). Pitched roofs show sheet
 * seams running down the slope, `seam` m apart and never closer than `minDots` dither dots, each
 * keeping `seamLight` of the roof's light. Flat roofs show a concrete speckle (`speckle` of their
 * dots at `speckleLight`) and a parapet ring at `parapetLight` one cell in from the rim. The
 * material is inferred from the roof's shape, as the shape is from the footprint.
 */
export const ROOF_TEXTURE = {
  seam: 0.75,
  minDots: 3,
  seamLight: 0.72,
  speckle: 0.07,
  speckleLight: 0.8,
  parapetLight: 0.78,
} as const;

/** Meters between seams when a dither dot covers `dotMeters` of ground. */
export const seamPitch = (dotMeters: number): number =>
  Math.max(ROOF_TEXTURE.seam, ROOF_TEXTURE.minDots * dotMeters);

/** Whether a point `along` m along the seam axis lies on a seam, one dot wide. */
export function onSeam(along: number, dotMeters: number): boolean {
  const pitch = seamPitch(dotMeters);
  return along - Math.floor(along / pitch) * pitch < dotMeters;
}

/**
 * Ground surfaces on the fine cell steps (shaders/glyph.ts `groundTexture`): paving shows slab
 * joints `slab` m apart (never closer than `minDots` dots) at `jointLight`, and carriageways an
 * asphalt grain, `grain` of their dots at `grainLight`.
 */
export const GROUND_TEXTURE = {
  slab: 1.2,
  minDots: 4,
  jointLight: 0.82,
  grain: 0.06,
  grainLight: 0.84,
} as const;
