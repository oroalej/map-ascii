import { TOOLTIP_INSET, type TooltipViewport } from './tooltip';

export type Side = 'right' | 'left' | 'bottom' | 'top';
export const POPOVER_GAP = 18;
export function popoverPlacement(
  anchor: readonly [number, number],
  size: { width: number; height: number },
  viewport: TooltipViewport,
  prefer?: Side,
) {
  const [x, y] = anchor;
  const visible =
    viewport.width > 0 &&
    viewport.height > 0 &&
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    x >= viewport.left &&
    x <= viewport.left + viewport.width &&
    y >= viewport.top &&
    y <= viewport.top + viewport.height;
  const ix = Math.min(TOOLTIP_INSET, viewport.width / 2);
  const iy = Math.min(TOOLTIP_INSET, viewport.height / 2);
  const l = viewport.left + ix,
    r = viewport.left + viewport.width - ix;
  const t = viewport.top + iy,
    b = viewport.top + viewport.height - iy;
  const room = {
    right: r - x - POPOVER_GAP,
    left: x - l - POPOVER_GAP,
    bottom: b - y - POPOVER_GAP,
    top: y - t - POPOVER_GAP,
  };
  const sides = [...new Set<Side>([...(prefer ? [prefer] : []), 'right', 'left', 'bottom', 'top'])];
  const extent = (side: Side) => (side === 'left' || side === 'right' ? size.width : size.height);
  const side =
    sides.find((s) => room[s] >= extent(s)) ?? sides.reduce((a, s) => (room[s] > room[a] ? s : a));
  const left =
    side === 'right'
      ? x + POPOVER_GAP
      : side === 'left'
        ? x - POPOVER_GAP - size.width
        : x - size.width / 2;
  const top =
    side === 'bottom'
      ? y + POPOVER_GAP
      : side === 'top'
        ? y - POPOVER_GAP - size.height
        : y - size.height / 2;
  const clamp = (v: number, min: number, max: number) =>
    Math.max(min, Math.min(Math.max(min, max), v));
  return {
    left: clamp(left, l, r - size.width),
    top: clamp(top, t, b - size.height),
    side,
    visible,
  };
}
