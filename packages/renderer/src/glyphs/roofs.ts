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
