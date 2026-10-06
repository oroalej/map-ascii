// @vitest-environment node
import { expect, it } from 'vitest';
import { popoverPlacement, type Side } from './popover';
const viewport = { left: 20, top: 30, width: 600, height: 500 };
const size = { width: 200, height: 100 };
it.each<[Side, [number, number]]>([
  ['right', [50, 250]],
  ['left', [600, 250]],
  ['bottom', [320, 40]],
  ['top', [320, 520]],
])('prefers %s when it fits and flips at its edge', (side, anchor) => {
  expect(popoverPlacement(anchor, size, viewport, side).side).toBe(side);
  const edge: Record<Side, [number, number]> = {
    right: [610, 250],
    left: [30, 250],
    bottom: [320, 520],
    top: [320, 40],
  };
  expect(popoverPlacement(edge[side], size, viewport, side).side).not.toBe(side);
});
it('retains a fitting preferred side while panning', () => {
  expect(popoverPlacement([320, 250], size, viewport).side).toBe('right');
  expect(popoverPlacement([320, 250], size, viewport, 'left').side).toBe('left');
});
it('chooses the most room when no side fits, then clamps both axes', () => {
  const placed = popoverPlacement([100, 100], { width: 500, height: 500 }, viewport);
  expect(placed).toEqual({ left: 112, top: 38, side: 'right', visible: true });
});
it('handles tiny, empty, and off-screen viewports', () => {
  expect(popoverPlacement([1, 1], size, { left: 0, top: 0, width: 2, height: 2 })).toMatchObject({
    left: 1,
    top: 1,
    visible: true,
  });
  expect(popoverPlacement([0, 0], size, viewport).visible).toBe(false);
  expect(popoverPlacement([50, 50], size, { ...viewport, width: 0 }).visible).toBe(false);
  expect(popoverPlacement([NaN, 50], size, viewport).visible).toBe(false);
});
