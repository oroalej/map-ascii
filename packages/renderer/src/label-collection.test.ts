import { describe, expect, it } from 'vitest';
import { collectLabel, collectLabels } from './label-collection';
import { LabelRank } from './labels';
import type { TileLabel } from './raster/geometry';

const street = (lng: number, length: number): TileLabel => ({
  id: 1,
  text: 'Example',
  rank: LabelRank.street,
  lng,
  lat: 13,
  angle: 0,
  band: { min: 18 },
  run: [
    [lng - length / 2, 13],
    [lng + length / 2, 13],
  ],
});
const collect = (labels: TileLabel[], previous = new Map<number, TileLabel>()) => {
  const map = new Map<number, TileLabel>();
  for (const label of labels) collectLabel(map, label, previous.get(label.id));
  return map.get(1);
};

describe('street copy collection', () => {
  it('prefers eligible detail over a longer remembered coarse run in either order', () => {
    const coarse = street(0, 3),
      detail = street(2, 1);
    const depths = new Map([
      [coarse, 11],
      [detail, 16],
    ]);
    for (const labels of [
      [coarse, detail],
      [detail, coarse],
    ]) {
      for (const previous of [new Map<number, TileLabel>(), new Map([[1, coarse]])]) {
        expect(
          collectLabels(
            labels,
            previous,
            () => true,
            () => true,
            (label) => depths.get(label)!,
          ).get(1),
        ).toBe(detail);
      }
      expect(
        collectLabels(
          labels,
          new Map(),
          (label) => label !== detail,
          () => true,
          (label) => depths.get(label)!,
        ).get(1),
      ).toBe(coarse);
      expect(
        collectLabels(
          labels,
          new Map([[1, detail]]),
          () => true,
          (label) => label === coarse,
          (label) => depths.get(label)!,
        ).get(1),
      ).toBe(coarse);
    }
  });
  it('chooses the longer run in either insertion order', () => {
    const short = street(0, 1),
      long = street(3, 2);
    expect(collect([short, long])).toBe(long);
    expect(collect([long, short])).toBe(long);
  });
  it('breaks equal-length ties by coordinates in either order', () => {
    const a = street(0, 1),
      b = street(2, 1);
    expect(collect([a, b])).toBe(a);
    expect(collect([b, a])).toBe(a);
  });
  it('prefers a run to a copy without a run', () => {
    const a = street(0, 1),
      b = { ...a, run: undefined };
    expect(collect([a, b])).toBe(a);
    expect(collect([b, a])).toBe(a);
  });
  it('retains the accepted copy even when a longer copy arrives', () => {
    const old = street(0, 1),
      longer = street(2, 3),
      fresh = { ...old };
    const previous = new Map([[1, old]]);
    expect(collect([fresh, longer], previous)).toBe(fresh);
    expect(collect([longer, fresh], previous)).toBe(fresh);
  });
  it('recognizes reversed endpoints and an equivalent upright angle as the accepted copy', () => {
    const old = street(0, 1);
    const fresh = { ...old, angle: Math.PI, run: [old.run![1], old.run![0]] as const };
    const longer = street(0, 3);
    const previous = new Map([[1, old]]);
    expect(collect([fresh, longer], previous)).toBe(fresh);
    expect(collect([longer, fresh], previous)).toBe(fresh);
  });
  it('orders equal-length runs with the same anchor by their canonical endpoints', () => {
    const a = street(0, 1);
    const b = {
      ...a,
      run: [
        [0, 13],
        [1, 13],
      ] as const,
    };
    expect(collect([a, b])).toBe(a);
    expect(collect([b, a])).toBe(a);
  });
  it('chooses a new run after the old one disappears', () => {
    const old = street(0, 1),
      a = street(2, 1),
      b = street(4, 2);
    expect(collect([a, b], new Map([[1, old]]))).toBe(b);
  });
  it('filters ineligible copies before they can suppress a visible one', () => {
    const old = street(0, 3),
      visible = street(2, 1);
    expect(
      collectLabels([old, visible], new Map([[1, old]]), (label) => label.lng > 0).get(1),
    ).toBe(visible);
  });
  it('corrects horizontal lengths for latitude', () => {
    const horizontal = {
      ...street(0, 1),
      lat: 60,
      run: [
        [0, 60],
        [1, 60],
      ] as const,
    };
    const vertical = {
      ...street(0, 1),
      lat: 60,
      run: [
        [0, 60],
        [0, 60.75],
      ] as const,
    };
    expect(collect([horizontal, vertical])).toBe(vertical);
  });
  it('prefers on-screen text over a retained copy wholly beyond the edge', () => {
    const old = street(0, 3),
      visible = street(2, 1);
    const accepted = collectLabels(
      [old, visible],
      new Map([[1, old]]),
      () => true,
      (label) => label.lng > 0,
    );
    expect(accepted.get(1)).toBe(visible);
    expect(
      collectLabels(
        [visible, old],
        new Map([[1, old]]),
        () => true,
        (label) => label.lng > 0,
      ).get(1),
    ).toBe(visible);
  });
  it('collects ordinary anchors deterministically and preserves separate features', () => {
    const a = { ...street(0, 0), rank: LabelRank.landmark, run: undefined },
      b = { ...a, id: 2 };
    expect([...collectLabels([a, a, b], new Map(), () => true).keys()]).toEqual([1, 2]);
  });
});
