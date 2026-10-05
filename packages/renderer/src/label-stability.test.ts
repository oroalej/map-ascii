import { describe, expect, it } from 'vitest';
import {
  KEEP_OVERHANG,
  labelFocus,
  labelSlots,
  orderLabels,
  placementArea,
  retentionArea,
  type LabelMemory,
  type LabelOrderKey,
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
  it('looks up memory once per candidate and reuses ordering keys across focus changes', () => {
    const candidates = [label(9), label(5), label(1), label(4, 1)];
    const memory: LabelMemory = new Map([[5, { slot: 0, visible: true }]]);
    let lookups = 0;
    const get = memory.get.bind(memory);
    memory.get = (id) => {
      lookups++;
      return get(id);
    };
    const order: LabelOrderKey[] = [];
    expect(orderLabels(candidates, { memory, order }).map(({ id }) => id)).toEqual([4, 5, 1, 9]);
    expect(lookups).toBe(candidates.length);
    const keys = new Set(order);
    lookups = 0;
    expect(orderLabels(candidates, { memory, order, focus: [9] }).map(({ id }) => id)).toEqual([
      9, 4, 5, 1,
    ]);
    expect(lookups).toBe(candidates.length);
    expect(order.every((key) => keys.has(key))).toBe(true);
    orderLabels([label(2)], { order });
    expect(order).toHaveLength(1);
    expect(order[0]?.label.id).toBe(2);
    expect(candidates.map(({ id }) => id)).toEqual([9, 5, 1, 4]);
  });
  it('keeps visible remembered names ahead of ghosts, with focus and rank still first', () => {
    const candidates = [label(1), label(2), label(3), label(4, 1)];
    const memory: LabelMemory = new Map([
      [1, { slot: 0, visible: false }],
      [2, { slot: 0, visible: true }],
    ]);
    expect(orderLabels(candidates, { memory }).map(({ id }) => id)).toEqual([4, 2, 1, 3]);
    expect(orderLabels(candidates, { memory, focus: [1] }).map(({ id }) => id)).toEqual([
      1, 4, 2, 3,
    ]);
  });
  it('orders focus, rank, kept status and feature id without changing the input', () => {
    const candidates = [label(9, 8), label(5, 3), label(1, 3), label(4, 1), label(7, 7)];
    const memory: LabelMemory = new Map([
      [5, { slot: 0, visible: true }],
      [7, { slot: 1, visible: true }],
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

it('tries rotation first and remembers only the horizontal fallback order', () => {
  expect(labelSlots('rotated', 1)).toEqual([-1, 1, 0, 2, 3]);
  expect(labelSlots('rotated', -1)).toEqual([-1, 0, 1, 2, 3]);
  expect(labelSlots('beside', -1)).toEqual([0, 1, 2, 3]);
  expect(labelSlots(undefined, 0)).toEqual([0, 1, 2, 3]);
});

it('widens only the area for retained labels', () => {
  const area = { left: 1, top: 2, right: 30, bottom: 40 };
  const retained = retentionArea(area);
  expect(placementArea(area, retained, false)).toBe(area);
  expect(placementArea(area, retained, true)).toBe(retained);
  expect(retained).toEqual({
    left: 1 - KEEP_OVERHANG,
    top: 2 - KEEP_OVERHANG,
    right: 30 + KEEP_OVERHANG,
    bottom: 40 + KEEP_OVERHANG,
  });
});
