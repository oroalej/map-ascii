export type TooltipViewport = { left: number; top: number; width: number; height: number };
export const TOOLTIP_INSET = 8;

/** Prefer below/right, flip overflowing axes, then fit the measured box inside the viewport. */
export function tooltipPosition(
  point: readonly [number, number],
  size: { width: number; height: number },
  viewport: TooltipViewport,
): { left: number; top: number } {
  const place = (pointer: number, length: number, start: number, extent: number) => {
    const inset = Math.min(TOOLTIP_INSET, extent / 2);
    const min = start + inset;
    const max = Math.max(min, start + extent - inset - length);
    const preferred = pointer + 14;
    const flipped = preferred + length > start + extent - inset ? pointer - 14 - length : preferred;
    return Math.max(min, Math.min(max, flipped));
  };
  return {
    left: place(point[0], size.width, viewport.left, viewport.width),
    top: place(point[1], size.height, viewport.top, viewport.height),
  };
}
