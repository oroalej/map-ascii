import { describe, expect, it } from 'vitest';
import {
  createOverlay,
  LabelRank,
  repeatDistance,
  resetOverlay,
  type LabelCandidate,
} from './labels';
import { labelFitsArea, labelIntersectsArea, labelTouchesArea, layoutLabels } from './label-layout';
import {
  KEEP_OVERHANG,
  STREET_REPEAT,
  type LabelMemory,
  type PlaceStability,
} from './label-stability';

const area = { left: 0, top: 0, right: 20, bottom: 1 };
const label = (over: Partial<LabelCandidate> = {}): LabelCandidate => ({
  id: 1,
  text: 'ABCDE',
  rank: LabelRank.landmark,
  col: 0,
  row: 0,
  ...over,
});
const repeat = repeatDistance;
const ids = (labels: readonly { label: LabelCandidate }[]) => labels.map(({ label }) => label.id);
const place = (candidates: LabelCandidate[], stability: PlaceStability = {}, at = area) =>
  layoutLabels(createOverlay(at.right, at.bottom), candidates, at, 1.8, stability, repeat);

describe('stable placement layouts', () => {
  it('keeps the existing winner ahead of a new equal-rank duplicate', () => {
    const memory: LabelMemory = new Map();
    place([label({ id: 5 })], { memory });
    expect(ids(place([label(), label({ id: 5 })], { memory }))).toEqual([5]);
    expect(ids(place([label(), label({ id: 5 })]))).toEqual([1]);
  });
  it('places a new higher rank before a retained lower rank', () => {
    const memory: LabelMemory = new Map([[5, 2]]);
    const placed = place(
      [label({ id: 5, text: 'FGHIJ', rank: LabelRank.street }), label({ rank: LabelRank.city })],
      { memory },
    );
    expect(placed[0]?.label.id).toBe(1);
    expect(placed[0]?.slot).toBe(2);
    expect(memory.get(5)).not.toBe(2);
  });
  it('keeps its above slot after the below blocker is removed', () => {
    const memory: LabelMemory = new Map();
    const target = label({ col: 10, row: 1 }),
      blocker = label({ id: 2, text: 'Block', rank: 0, col: 10, row: 1 });
    const roomy = { ...area, bottom: 3 };
    const first = place([target, blocker], { memory }, roomy);
    expect(first.find(({ label }) => label.id === 1)?.slot).toBe(1);
    expect(place([target], { memory }, roomy)[0]?.slot).toBe(1);
    expect(place([target], {}, roomy)[0]?.slot).toBe(0);
  });
  it('retains text two cells past the edge and drops it beyond the overhang', () => {
    const memory: LabelMemory = new Map();
    const starting = label({ col: -2 });
    expect(place([starting], { memory })[0]?.slot).toBe(2);
    const panned = { ...starting, col: -4 };
    expect(place([panned], { memory })[0]?.slot).toBe(2);
    expect(place([panned])).toEqual([]);
    const target = label({ col: 15, text: 'ABCDE' });
    expect(place([target], { memory: new Map([[1, 2]]) })[0]?.slot).toBe(2);
    expect(place([target]).some(({ slot }) => slot === 2)).toBe(false);
    // Put every slot beyond the right edge, including the left fallback.
    const outside = label({ col: area.right + KEEP_OVERHANG + 1 + 6 });
    expect(place([outside], { memory: new Map([[1, 2]]) })).toEqual([]);
  });
  it('uses strict admission for new text and expanded admission for retained text', () => {
    const onlyRight = label({ col: -4 });
    expect(labelFitsArea(onlyRight, area)).toBe(false);
    expect(labelFitsArea(onlyRight, area, 1.8, true)).toBe(true);
  });
  it('puts a focused landmark ahead of a city, and selection ahead of hover', () => {
    const landmark = label({ id: 5 }),
      city = label({ rank: LabelRank.city });
    expect(ids(place([city, landmark], { focus: [5] }))).toEqual([5]);
    expect(ids(place([city, landmark], { focus: [1, 5] }))).toEqual([1]);
  });
  it('repeats streets by pixel distance and keeps a remembered duplicate', () => {
    const a = label({ rank: LabelRank.street, col: 10, row: 3 }),
      b = { ...a, id: 2, col: 30 };
    const roomy = { left: 0, top: 0, right: 80, bottom: 40 };
    expect(ids(place([a, b], {}, roomy))).toEqual([1]);
    expect(ids(place([a, { ...b, col: a.col + STREET_REPEAT }], {}, roomy))).toEqual([1, 2]);
    expect(ids(place([a, { ...b, col: a.col, row: 29 }], {}, roomy))).toEqual([1, 2]);
    expect(ids(place([a, b], { memory: new Map([[2, 0]]) }, roomy))).toEqual([2]);
    expect(
      ids(
        place(
          [
            { ...a, rank: LabelRank.landmark },
            { ...b, col: 70, rank: LabelRank.landmark },
          ],
          {},
          roomy,
        ),
      ),
    ).toEqual([1]);
  });
  it('refills exactly the accepted ids and slots and clears stale memory', () => {
    const memory: LabelMemory = new Map([[99, 1]]);
    const street = label({
      mode: 'rotated',
      col: 10,
      row: 5,
      rank: LabelRank.street,
      runCells: 20,
    });
    place([street], { memory }, { ...area, bottom: 10 });
    expect([...memory]).toEqual([[1, -1]]);
    place([], { memory });
    expect(memory.size).toBe(0);
  });
  it('restores rotation when the run starts fitting', () => {
    const overlay = createOverlay(60, 30),
      memory: LabelMemory = new Map();
    const street = label({
      col: 30,
      row: 15,
      mode: 'rotated',
      rank: LabelRank.street,
      runCells: 2,
    });
    const at = { left: 0, top: 0, right: 60, bottom: 30 };
    expect(layoutLabels(overlay, [street], at, 1.8, { memory }, repeat)[0]?.slot).toBe(0);
    resetOverlay(overlay);
    expect(
      layoutLabels(overlay, [{ ...street, runCells: 20 }], at, 1.8, { memory }, repeat)[0]?.slot,
    ).toBe(-1);
    resetOverlay(overlay);
    expect(layoutLabels(overlay, [{ ...street, runCells: 20 }], at, 1.8, {}, repeat)[0]?.slot).toBe(
      -1,
    );
  });
  it('reserves complete halos while reporting text that intersects the physical screen', () => {
    const kept = place([label({ col: 0, row: -2 })], { memory: new Map([[1, 0]]) })[0]!;
    expect(kept).toBeDefined();
    expect(labelIntersectsArea(kept.textBounds, area)).toBe(false);
    expect(labelIntersectsArea({ ...kept.textBounds, top: -0.5 }, area)).toBe(true);
  });
  it('restores rotation after edge entry and after a collision blocker disappears', () => {
    const roomy = { left: 0, top: 0, right: 60, bottom: 30 };
    const street = label({
      col: -2,
      row: 15,
      mode: 'rotated',
      rank: LabelRank.street,
      runCells: 20,
    });
    const memory: LabelMemory = new Map();
    expect(place([street], { memory }, roomy)[0]?.slot).toBe(2);
    expect(place([{ ...street, col: 30 }], { memory }, roomy)[0]?.slot).toBe(-1);
    memory.clear();
    const centered = { ...street, col: 30 };
    const blocker = label({ id: 2, text: 'Block', col: 30, row: 13, rank: LabelRank.city });
    expect(
      place([centered, blocker], { memory }, roomy).find(({ label }) => label.id === 1)?.slot,
    ).toBe(0);
    expect(place([centered], { memory }, roomy)[0]?.slot).toBe(-1);
  });
  it('reads but does not replace durable memory during temporary focus placement', () => {
    const memory: LabelMemory = new Map();
    const candidates = [label(), label({ id: 5, text: 'FGHIJ' })];
    const before = place(candidates, { memory });
    const snapshot = [...memory];
    const focused = place(candidates, { memory, focus: [5], commitMemory: false });
    expect(focused[0]?.label.id).toBe(5);
    expect([...memory]).toEqual(snapshot);
    expect(place(candidates, { memory, commitMemory: false })).toEqual(before);
    place([], { memory, commitMemory: false });
    expect([...memory]).toEqual(snapshot);
  });
  it.each([LabelRank.street, LabelRank.landmark])(
    'ignores wholly offscreen repeat owners at rank %s',
    (rank) => {
      const roomy = { left: 0, top: 0, right: 80, bottom: 20 };
      for (const mode of ['beside', 'rotated'] as const) {
        const ghost = label({ col: 10, row: -2, rank, mode, runCells: 20 });
        const visible = { ...ghost, id: 2, col: 30, row: 5 };
        const memory: LabelMemory = new Map([[1, mode === 'rotated' ? -1 : 0]]);
        const placed = place([ghost, visible], { memory }, roomy);
        expect(ids(placed)).toEqual([1, 2]);
        expect(
          ids(placed.filter(({ textBounds }) => labelIntersectsArea(textBounds, roomy))),
        ).toEqual([2]);
        expect(memory.has(1)).toBe(true);
      }
    },
  );
  it('lets partially visible text claim a name using fractional screen bounds', () => {
    const admission = { left: 0, top: 1, right: 80, bottom: 20 };
    const screen = { ...admission, top: 0.5 };
    const first = label({ col: 10, row: -1 });
    const second = { ...first, id: 2, col: 30, row: 5 };
    expect(ids(place([first, second], { memory: new Map([[1, 0]]), screen }, admission))).toEqual([
      1,
    ]);
    expect(ids(place([first, second], { memory: new Map([[1, 0]]) }, admission))).toEqual([1, 2]);
  });
  it('checks fallback visibility when a remembered rotated slot no longer fits its run', () => {
    const street = label({ col: 10, mode: 'rotated', runCells: 2 });
    expect(labelTouchesArea(street, area, area, 1.8, -1)).toBe(true);
  });
  it('matches cell and box collision lookup outside the padded grid', () => {
    const candidates = Array.from({ length: 200 }, (_, id) =>
      label({
        id,
        text: `Name ${id}`,
        col: (id % 28) - 4,
        row: (id % 9) - 2,
        mode: id % 4 === 0 ? 'rotated' : 'beside',
        angle: (id % 5) * 0.2,
        runCells: 20,
      }),
    );
    const memory: LabelMemory = new Map(candidates.map(({ id }) => [id, 0]));
    const padded = createOverlay(20, 6),
      byBoxes = { ...createOverlay(20, 6), takenCells: undefined };
    const at = { ...area, bottom: 6 };
    const a = layoutLabels(
      padded,
      candidates,
      at,
      1.8,
      { memory: new Map(memory), focus: [7, 19] },
      repeat,
    );
    const b = layoutLabels(
      byBoxes,
      candidates,
      at,
      1.8,
      { memory: new Map(memory), focus: [7, 19] },
      repeat,
    );
    expect(ids(a)).toEqual(ids(b));
    expect(padded.taken).toEqual(byBoxes.taken);
    expect(a.length).toBeGreaterThan(1);
    for (const layouts of [a, b]) {
      for (let i = 0; i < layouts.length; i++)
        for (const other of layouts.slice(i + 1)) {
          const box = layouts[i]!.collision,
            next = other.collision;
          expect(
            box.left < next.left + next.width &&
              next.left < box.left + box.width &&
              box.top < next.top + next.height &&
              next.top < box.top + box.height,
          ).toBe(false);
        }
    }
  });
});
