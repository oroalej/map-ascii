import { expect, it } from 'vitest';
import { tooltipPosition } from './tooltip';

it.each([
  [[30, 40], { left: 44, top: 54 }],
  [[290, 40], { left: 196, top: 54 }],
  [[30, 190], { left: 44, top: 156 }],
  [[290, 190], { left: 196, top: 156 }],
  [[-20, -30], { left: 8, top: 8 }],
] as const)('fits the tooltip for pointer %s', (point, expected) => {
  expect(
    tooltipPosition(point, { width: 80, height: 20 }, { left: 0, top: 0, width: 300, height: 200 }),
  ).toEqual(expected);
});

it('clamps an oversized box and respects visual viewport offsets', () => {
  expect(
    tooltipPosition(
      [50, 50],
      { width: 100, height: 30 },
      { left: 0, top: 0, width: 100, height: 60 },
    ),
  ).toEqual({ left: 8, top: 8 });
  expect(
    tooltipPosition(
      [115, 125],
      { width: 60, height: 20 },
      { left: 100, top: 110, width: 100, height: 60 },
    ),
  ).toEqual({ left: 129, top: 139 });
});
