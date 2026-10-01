import { describe, expect, it, vi } from 'vitest';
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
  return { names, targets, draw };
}

describe('cached atlas labels', () => {
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
