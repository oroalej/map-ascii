import { describe, expect, it } from 'vitest';
import {
  KEEP_OVERHANG,
  labelFocus,
  labelSlots,
  orderLabels,
  retentionArea,
  type LabelMemory,
} from './label-stability';
import type { LabelCandidate } from './labels';

const label = (id: number, rank = 3): LabelCandidate => ({
  id,
  rank,
  text: String(id),
  col: 5,
  row: 5,
});

describe('placement ordering', () => {
  it('orders focus, rank, kept status and feature id without changing the input', () => {
    const candidates = [label(9, 8), label(5, 3), label(1, 3), label(4, 1), label(7, 7)];
    const memory: LabelMemory = new Map([
      [5, 0],
      [7, 1],
    ]);
    expect(orderLabels(candidates, { memory, focus: [9, 7] }).map((l) => l.id)).toEqual([
      9, 7, 4, 5, 1,
    ]);
    expect(candidates.map((l) => l.id)).toEqual([9, 5, 1, 4, 7]);
    expect(orderLabels(candidates, {}).map((l) => l.id)).toEqual([4, 1, 5, 7, 9]);
  });
  it('keeps the first occurrence of a focus id', () => {
    expect(orderLabels([label(1), label(2)], { focus: [2, 1, 2] }).map((l) => l.id)).toEqual([
      2, 1,
    ]);
  });
});

it('drops zero, unknown and duplicate focus while preserving selected precedence', () => {
  const known = (id: number) => id === 1 || id === 2;
  expect(labelFocus(1, 2, known)).toEqual([1, 2]);
  expect(labelFocus(1, 1, known)).toEqual([1]);
  expect(labelFocus(0, 2, known)).toEqual([2]);
  expect(labelFocus(3, 0, known)).toEqual([]);
});

it('tries a remembered slot once, falling back in the original order', () => {
  expect(labelSlots('rotated', 1)).toEqual([1, -1, 0, 2, 3]);
  expect(labelSlots('rotated', -1)).toEqual([-1, 0, 1, 2, 3]);
  expect(labelSlots('beside', -1)).toEqual([0, 1, 2, 3]);
  expect(labelSlots(undefined, 0)).toEqual([0, 1, 2, 3]);
});

it('widens only the area for retained labels', () => {
  const area = { left: 1, top: 2, right: 30, bottom: 40 };
  expect(retentionArea(area, false)).toBe(area);
  expect(retentionArea(area, true)).toEqual({
    left: 1 - KEEP_OVERHANG,
    top: 2 - KEEP_OVERHANG,
    right: 30 + KEEP_OVERHANG,
    bottom: 40 + KEEP_OVERHANG,
  });
});
