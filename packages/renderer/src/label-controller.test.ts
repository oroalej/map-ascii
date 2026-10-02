import { afterEach, describe, expect, it, vi } from 'vitest';
import * as layout from './label-layout';
import * as grid from './grid';
import { AtlasLabels } from './label-controller';
import { LabelRank } from './labels';
import { labelMemory } from './passes';
import type { CellTargets, GL } from './gpu';
import type { Programs, ThemeResources } from './gpu-context';
import type { GridPlacement, View } from './grid';
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
const placement = (pan = 0, horizontal = 0): GridPlacement => ({
  grid: { originCol: 0, originRow: 0, shiftX: 0, shiftY: 0 },
  toCell: (lng, lat) => [lng + horizontal, lat - pan],
  tileMatrix: () => [],
});
const street = (lng: number, length: number, lat = 4): TileLabel => ({
  id: 1,
  text: 'Elm',
  rank: LabelRank.street,
  band: { min: 18 },
  lng,
  lat,
  angle: 0,
  run: [
    [lng - length / 2, lat],
    [lng + length / 2, lat],
  ],
});
function fixture(atView = view) {
  const names = new AtlasLabels();
  const gl = {
    bindTexture: vi.fn(),
    pixelStorei: vi.fn(),
    texSubImage2D: vi.fn(),
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
  } as unknown as GL;
  const targets = { labelCols: 13, labelRows: 13 } as CellTargets;
  const theme = {
    label: { atlas: { index: (c: string) => c.charCodeAt(0) } },
  } as unknown as ThemeResources;
  const programs = { streetText: { buffer: null, count: 0 } } as unknown as Programs;
  const draw = (labels: TileLabel[], pan = 0, horizontal = 0) => {
    const at = placement(pan, horizontal);
    names.collect(targets, atView, at, labels);
    return names.draw(gl, targets, theme, atView, at, programs, 0, 0);
  };
  return { names, targets, draw, gl, theme, programs };
}

afterEach(() => vi.restoreAllMocks());

describe('cached atlas labels', () => {
  it('prepares each tile copy once and reuses its projection for drawing and focus', () => {
    const { names, targets, gl, theme, programs } = fixture();
    const at = placement();
    const project = vi.spyOn(at, 'toCell');
    names.collect(targets, view, at, [street(3, 6), street(7, 6)]);
    expect(project).toHaveBeenCalledTimes(6);
    names.draw(gl, targets, theme, view, at, programs, 1, 0);
    names.relabel(gl, targets, theme, view, programs, 0, 0, at.grid);
    expect(project).toHaveBeenCalledTimes(6);
  });
  it('skips geometry on unchanged frames and remembers ineligible focus inputs', () => {
    const { names, targets, gl, theme, programs, draw } = fixture();
    draw([street(3, 6)]);
    const fit = vi.spyOn(layout, 'labelFitsArea');
    const area = vi.spyOn(grid, 'screenArea');
    const at = placement().grid;
    names.relabel(gl, targets, theme, view, programs, 1, 0, at);
    fit.mockClear();
    area.mockClear();
    for (let i = 0; i < 20; i++) names.relabel(gl, targets, theme, view, programs, 1, 0, at);
    expect(fit).not.toHaveBeenCalled();
    expect(area).not.toHaveBeenCalled();
    names.relabel(gl, targets, theme, view, programs, 99, 0, at);
    area.mockClear();
    names.relabel(gl, targets, theme, view, programs, 99, 0, at);
    expect(area).not.toHaveBeenCalled();
    names.relabel(gl, targets, theme, view, programs, 99, 0, { ...at, shiftX: 1 });
    expect(area).toHaveBeenCalled();
  });
  it('restores the baseline after focus and commits only when cells are redrawn', () => {
    const { names, targets, gl, theme, programs, draw } = fixture();
    const candidates = [street(3, 6), { ...street(3, 6), id: 5 }];
    expect(draw(candidates).map(({ id }) => id)).toEqual([1]);
    const baseline = [...labelMemory(targets)!];
    const at = placement();
    expect(
      names.relabel(gl, targets, theme, view, programs, 0, 5, at.grid)?.labels.map(({ id }) => id),
    ).toEqual([5]);
    expect([...labelMemory(targets)!]).toEqual(baseline);
    expect(
      names.relabel(gl, targets, theme, view, programs, 0, 0, at.grid)?.labels.map(({ id }) => id),
    ).toEqual([1]);
    names.collect(targets, view, at, candidates);
    names.draw(gl, targets, theme, view, at, programs, 5, 0);
    expect([...labelMemory(targets)!.keys()]).toEqual([5]);
  });
  it('rejects offscreen long copies before choosing a visible run in either tile order', () => {
    const visible = street(3, 6),
      outside = street(100, 30);
    expect(fixture().draw([visible, outside])[0]).toBe(visible);
    expect(fixture().draw([outside, visible])[0]).toBe(visible);
  });
  it('keeps the accepted anchor when a longer run arrives and releases it on disposal', () => {
    const { names, targets, draw } = fixture();
    const old = street(3, 6),
      longer = street(7, 20),
      reloaded = { ...old };
    expect(draw([old])[0]).toBe(old);
    expect(draw([longer, reloaded])[0]).toBe(reloaded);
    expect(labelMemory(targets)?.get(1)).toBe(-1);
    names.clear();
    expect(labelMemory(targets)).toBeUndefined();
    expect(draw([old, longer])[0]).toBe(longer);
  });
  it('replaces a retained ghost with an onscreen copy after panning', () => {
    const { draw } = fixture();
    const old = street(3, 20),
      visible = street(7, 6, 10);
    expect(draw([old])[0]).toBe(old);
    expect(draw([old, visible], 6)[0]).toBe(visible);
  });
  it('keeps an anchor whose remembered slot must fall back onto the screen', () => {
    const { draw, targets } = fixture({ ...view, height: 18 });
    const old = { ...street(-2, 6, 0), text: 'ABCDE', angle: undefined, run: undefined };
    const incoming = { ...old, lng: -10 };
    expect(draw([old])[0]).toBe(old);
    expect(labelMemory(targets)?.get(1)).toBe(2);
    expect(draw([incoming, old], 0, 13)[0]).toBe(old);
    expect(labelMemory(targets)?.get(1)).toBe(3);
  });
});
