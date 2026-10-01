import { cellHash } from './select';

/** Small, stable variations in leaf ink, confined to the glyph's owned cell. */
export const FOLIAGE_INK = {
  maxSin: 0.55,
  minScale: 0.7,
  scaleRange: 0.3,
  jitterX: 0.3,
  jitterY: 0.2,
} as const;

export function foliageInkSample(
  x: number,
  y: number,
  width: number,
  height: number,
  worldX: number,
  worldY: number,
): readonly [number, number] | null {
  const h = cellHash(worldX, worldY);
  const byte = (shift: number) => ((h >>> shift) & 255) / 255;
  const scale = FOLIAGE_INK.minScale + byte(0) * FOLIAGE_INK.scaleRange;
  const px = (x + 0.5) / width - 0.5 - (byte(8) - 0.5) * FOLIAGE_INK.jitterX;
  const py = (y + 0.5) / height - 0.5 - (byte(16) - 0.5) * FOLIAGE_INK.jitterY;
  const sin = (byte(24) * 2 - 1) * FOLIAGE_INK.maxSin;
  const cos = Math.sqrt(1 - sin * sin);
  const sx = ((px * cos + py * sin) / scale + 0.5) * width;
  const sy = ((-px * sin + py * cos) / scale + 0.5) * height;
  return sx < 0 || sy < 0 || sx >= width || sy >= height ? null : [Math.floor(sx), Math.floor(sy)];
}
