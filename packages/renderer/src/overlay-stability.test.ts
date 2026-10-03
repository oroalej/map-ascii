import { labelCandidate } from './label-candidates';
import { describe, expect, it, vi } from 'vitest';
import { labelMemory, labelsInView, overlayPass, transferLabelPlacement } from './passes';
import { LabelRank } from './labels';
import type { GridPlacement, View } from './grid';
import type { CellTargets, GL } from './gpu';
import type { Programs, ThemeResources } from './gpu-context';
import type { TileLabel } from './raster/geometry';

const view: View = {
  camera: { lng: 0, lat: 0, zoom: 18 },
  width: 100,
  height: 180,
  dpr: 1,
  cellDev: { w: 5, h: 9 },
  labelDev: { w: 10, h: 18 },
  detailZoom: 19,
};
const placement: GridPlacement = {
  grid: { originCol: 0, originRow: 0, shiftX: 0, shiftY: 0 },
  toCell: (lng, lat) => [lng, lat],
  tileMatrix: () => [],
};
const label = (over: Partial<TileLabel> = {}): TileLabel => ({
  id: 1,
  text: 'Alpha',
  rank: LabelRank.landmark,
  lng: 5,
  lat: 4,
  band: { min: 17 },
  ...over,
});

function fixture() {
  const uploaded: Uint8Array[] = [];
  const gl = {
    bindTexture: vi.fn(),
    pixelStorei: vi.fn(),
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
    texSubImage2D: (...args: unknown[]) => uploaded.push((args.at(-1) as Uint8Array).slice()),
  } as unknown as GL;
  const targets = { labelCols: 13, labelRows: 13 } as CellTargets;
  const resources = {
    label: { atlas: { index: (c: string) => c.charCodeAt(0) } },
  } as unknown as ThemeResources;
  const programs = { streetText: { buffer: null, count: 0 } } as unknown as Programs;
  const draw = (
    labels: TileLabel[],
    focus: number[] = [],
    at = view,
    target = targets,
    commit = true,
  ) =>
    overlayPass(
      gl,
      target,
      resources,
      at,
      placement,
      labels.flatMap((label) => labelCandidate(label, at, placement) ?? []),
      programs,
      focus,
      commit,
    );
  return { targets, draw, uploaded, programs };
}

describe('overlay placement memory', () => {
  it('transfers only durable memory, uploads fresh textures and isolates replacement targets', () => {
    const { targets, draw, uploaded } = fixture();
    const accepted = label({ id: 9 });
    draw([accepted]);
    const oldMemory = labelMemory(targets)!;
    const replacement = { ...targets };
    const uploads = uploaded.length;
    transferLabelPlacement(targets, replacement);
    expect(labelMemory(targets)).toBeUndefined();
    expect(labelMemory(replacement)).not.toBe(oldMemory);
    expect(labelMemory(replacement)?.get(9)).toEqual(oldMemory.get(9));
    expect(labelMemory(replacement)?.get(9)).not.toBe(oldMemory.get(9));
    expect(draw([label(), accepted], [], view, replacement, false).map(({ id }) => id)).toEqual([
      9,
    ]);
    expect(uploaded).toHaveLength(uploads + 1);
    draw([label({ id: 3 })], [], view, replacement);
    expect([...oldMemory.keys()]).toEqual([9]);
    expect(draw([label(), accepted], [], view, targets).map(({ id }) => id)).toEqual([1]);
    expect([...labelMemory(replacement)!.keys()]).toEqual([3]);
  });
  it('keeps the accepted duplicate on its target and starts fresh on another target', () => {
    const { targets, draw } = fixture();
    draw([label({ id: 9 })]);
    const memory = labelMemory(targets);
    expect(draw([label(), label({ id: 9 })]).map(({ id }) => id)).toEqual([9]);
    expect(labelMemory(targets)).toBe(memory);
    expect(draw([label(), label({ id: 9 })], [], view, { ...targets }).map(({ id }) => id)).toEqual(
      [1],
    );
    expect(labelMemory(targets)?.has(9)).toBe(true);
  });
  it('retains offscreen text in memory while excluding it from the visible-label list', () => {
    const { targets, draw, uploaded } = fixture();
    draw([label()]);
    for (const lat of [-2, -4]) {
      const placed = draw([label({ lat })]);
      expect(placed).toHaveLength(1);
      expect(labelMemory(targets)?.get(1)).toEqual({ slot: 0, visible: false });
      expect(labelsInView(targets, view, placement.grid, placed)).toEqual([]);
      expect(uploaded.at(-1)?.every((byte) => byte === 0)).toBe(true);
    }
    expect(draw([label({ lat: -5 })])).toEqual([]);
    expect(labelMemory(targets)?.size).toBe(0);
  });
  it('renders the focused name first without extending its zoom band or the blackout', () => {
    const { targets, draw, programs } = fixture();
    const candidates = [label({ rank: LabelRank.city }), label({ id: 9 })];
    expect(draw(candidates, [9])[0]?.id).toBe(9);
    expect(labelsInView(targets, view, placement.grid, draw(candidates, [9]))[0]?.id).toBe(9);
    programs.streetText.count = 6;
    const hidden = { ...view, camera: { ...view.camera, zoom: 16 } };
    expect(draw(candidates, [9], hidden)).toEqual([]);
    expect(labelMemory(targets)?.size).toBe(0);
    expect(programs.streetText.count).toBe(0);
    expect(draw([label({ band: { min: 20 } })], [1])).toEqual([]);
  });
});
