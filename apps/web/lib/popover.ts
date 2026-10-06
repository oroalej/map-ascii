import { TOOLTIP_INSET, type TooltipViewport } from './tooltip';

export type Side = 'right' | 'left' | 'bottom' | 'top';
export const POPOVER_GAP = 18;
export const POPOVER_WIDTH = 320;
export const POPOVER_MAX_HEIGHT_RATIO = 0.6;
export const POPOVER_PADDING = 14;
export const POPOVER_PADDING_RATIO = 1 / 8;
export const POPOVER_ARROW_INSET = 8;

export function popoverAnchorVisible([x, y]: readonly [number, number], viewport: TooltipViewport) {
  return (
    viewport.width > 0 &&
    viewport.height > 0 &&
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    x >= viewport.left &&
    x <= viewport.left + viewport.width &&
    y >= viewport.top &&
    y <= viewport.top + viewport.height
  );
}

export function popoverArrowOffset(
  anchor: readonly [number, number],
  size: { width: number; height: number },
  placement: { left: number; top: number; side: Side },
) {
  const vertical = placement.side === 'left' || placement.side === 'right';
  const extent = vertical ? size.height : size.width;
  const offset = vertical ? anchor[1] - placement.top : anchor[0] - placement.left;
  const inset = Math.min(POPOVER_ARROW_INSET, extent / 2);
  return Math.max(inset, Math.min(extent - inset, offset));
}

export function popoverPlacement(
  anchor: readonly [number, number],
  size: { width: number; height: number },
  viewport: TooltipViewport,
  prefer?: Side,
) {
  const [x, y] = anchor;
  const visible = popoverAnchorVisible(anchor, viewport);
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
