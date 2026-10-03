import { afterEach, describe, expect, it, vi } from 'vitest';
import * as layout from './label-layout';
import * as grid from './grid';
import * as candidates from './label-candidates';
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
    names.collect(targets, atView, at, [{ labels, zoom: 16 }]);
    return names.draw(gl, targets, theme, atView, at, programs, 0, 0);
  };
  return { names, targets, draw, gl, theme, programs };
}

afterEach(() => vi.restoreAllMocks());

describe('cached atlas labels', () => {
  it('prepares shared copy identities once at their maximum source depth in either order', () => {
    const shared = street(3, 6),
      detail = street(7, 20),
      hidden = { ...street(3, 6), band: { min: 20 } };
    const sources = [
      { labels: [shared, hidden], zoom: 11 },
      { labels: [detail, hidden], zoom: 16 },
      { labels: [shared], zoom: 17 },
    ];
    for (const ordered of [sources, [...sources].reverse()]) {
      const { names, targets, gl, theme, programs } = fixture();
      const at = placement();
      const prepare = vi.spyOn(candidates, 'labelCandidate');
      names.collect(targets, view, at, ordered);
      expect(prepare).toHaveBeenCalledTimes(3);
      expect(names.draw(gl, targets, theme, view, at, programs, 0, 0)[0]).toBe(shared);
      prepare.mockClear();
      names.collect(targets, view, at, [{ labels: [detail], zoom: 16 }]);
      expect(prepare).toHaveBeenCalledOnce();
      expect(names.draw(gl, targets, theme, view, at, programs, 0, 0)[0]).toBe(detail);
      prepare.mockRestore();
    }
  });
  it('reuses collection maps and releases all copy scratch after each pass and clearing', () => {
    const { names, targets, draw } = fixture();
    draw([street(3, 6)]);
    const clear = vi.spyOn(Map.prototype, 'clear');
    let cleared: readonly unknown[] = [];
    let created = 0;
    vi.stubGlobal(
      'Map',
      new Proxy(Map, {
        construct(target, args) {
          created++;
          const map: unknown = Reflect.construct(target, args);
          if (typeof map !== 'object' || map === null) throw new Error('Expected a Map object');
          return map;
        },
      }),
    );
    try {
      for (const lng of [3, 7])
        names.collect(targets, view, placement(), [{ labels: [street(lng, 6)], zoom: 16 }]);
    } finally {
      cleared = clear.mock.contexts.slice();
      vi.unstubAllGlobals();
      clear.mockRestore();
    }
    expect(created).toBe(0);
    const counts = new Map<unknown, number>();
    for (const map of cleared) counts.set(map, (counts.get(map) ?? 0) + 1);
    const scratch = [...counts].filter(([, times]) => times === 4).map(([map]) => map);
    expect(scratch).toHaveLength(4);
    expect(scratch.every((map) => map instanceof Map && map.size === 0)).toBe(true);
    names.clear();
    expect(scratch.every((map) => map instanceof Map && map.size === 0)).toBe(true);
    expect(labelMemory(targets)).toBeUndefined();
  });
  it.each(['selected', 'hovered'])(
    'skips %s eligibility through fractional shifts inside the same admission bounds',
    (kind) => {
      const { names, targets, gl, theme, programs } = fixture();
      const at = placement();
      at.grid.shiftX = 1;
      at.grid.shiftY = 1;
      const selected = kind === 'selected' ? 1 : 0;
      const hover = kind === 'hovered' ? 1 : 0;
      names.collect(targets, view, at, [{ labels: [street(3, 6)], zoom: 16 }]);
      names.draw(gl, targets, theme, view, at, programs, selected, hover);
      const fit = vi.spyOn(layout, 'labelFitsArea');
      const texture = vi.spyOn(gl, 'texSubImage2D');
      const uploads = texture.mock.calls.length;
      for (let offset = 2; offset < 10; offset++)
        expect(
          names.relabel(gl, targets, theme, view, programs, selected, hover, {
            ...at.grid,
            shiftX: offset,
            shiftY: offset,
          }),
        ).toBeUndefined();
      expect(fit).not.toHaveBeenCalled();
      expect(texture).toHaveBeenCalledTimes(uploads);
      names.relabel(gl, targets, theme, view, programs, selected, hover, {
        ...at.grid,
        shiftX: 10,
      });
      expect(fit).toHaveBeenCalled();
    },
  );
  it('keeps acceptance and copy references across map-only target and density changes', () => {
    const { names, targets, gl, theme, programs, draw } = fixture();
    const accepted = { ...street(3, 6), id: 9 };
    expect(draw([accepted])[0]).toBe(accepted);
    const memory = [...labelMemory(targets)!];
    const replacement = { ...targets, cols: 61, rows: 27 };
    const nextView = { ...view, cellDev: { w: 4, h: 7 } };
    const at = placement();
    names.collect(replacement, nextView, at, [
      { labels: [street(3, 6), { ...accepted, run: street(7, 20).run }, accepted], zoom: 16 },
    ]);
    expect(labelMemory(targets)).toBeUndefined();
    expect([...labelMemory(replacement)!]).toEqual(memory);
    expect(names.draw(gl, replacement, theme, nextView, at, programs, 0, 0)[0]).toBe(accepted);
    names.clear();
    expect(labelMemory(replacement)).toBeUndefined();
  });
  it.each(['cols', 'rows', 'width', 'height'] as const)(
    'drops acceptance when label %s changes on target replacement',
    (dimension) => {
      const { names, targets, gl, theme, programs, draw } = fixture();
      const accepted = { ...street(3, 6), id: 9 };
      draw([accepted]);
      const replacement = {
        ...targets,
        labelCols: targets.labelCols + (dimension === 'cols' ? 1 : 0),
        labelRows: targets.labelRows + (dimension === 'rows' ? 1 : 0),
      };
      const nextView = {
        ...view,
        labelDev: {
          w: view.labelDev.w + (dimension === 'width' ? 1 : 0),
          h: view.labelDev.h + (dimension === 'height' ? 1 : 0),
        },
      };
      const incoming = street(3, 6);
      const at = placement();
      names.collect(replacement, nextView, at, [{ labels: [accepted, incoming], zoom: 16 }]);
      expect(labelMemory(targets)).toBeUndefined();
      expect(names.draw(gl, replacement, theme, nextView, at, programs, 0, 0)[0]).toBe(incoming);
    },
  );
  it('replaces a remembered coarse run when eligible detail arrives in either source order', () => {
    const coarse = street(3, 20),
      detail = street(7, 6);
    const sources = [
      { labels: [coarse], zoom: 11 },
      { labels: [detail], zoom: 16 },
    ];
    for (const ordered of [sources, [...sources].reverse()]) {
      const { names, targets, gl, theme, programs } = fixture();
      const at = placement();
      names.collect(targets, view, at, [sources[0]!]);
      expect(names.draw(gl, targets, theme, view, at, programs, 0, 0)[0]).toBe(coarse);
      names.collect(targets, view, at, ordered);
      expect(names.draw(gl, targets, theme, view, at, programs, 0, 0)[0]).toBe(detail);
    }
  });
  it('keeps coarse fallback when detail is ineligible or retained wholly offscreen', () => {
    const coarse = street(3, 6),
      outside = street(100, 30);
    const { names, targets, gl, theme, programs, draw } = fixture();
    const at = placement();
    const sources = [
      { labels: [coarse], zoom: 11 },
      { labels: [outside], zoom: 16 },
    ];
    for (const ordered of [sources, [...sources].reverse()]) {
      names.collect(targets, view, at, ordered);
      expect(names.draw(gl, targets, theme, view, at, programs, 0, 0)[0]).toBe(coarse);
    }
    const ghost = street(3, 20),
      visible = street(7, 6, 10);
    expect(draw([ghost])[0]).toBe(ghost);
    const shifted = placement(6);
    names.collect(targets, view, shifted, [
      { labels: [ghost], zoom: 16 },
      { labels: [visible], zoom: 11 },
    ]);
    expect(names.draw(gl, targets, theme, view, shifted, programs, 0, 0)[0]).toBe(visible);
  });
  it('reports rank/id order independently of selection, hover, memory and fractional shifts', () => {
    const { names, targets, gl, theme, programs, draw } = fixture();
    const labels = [1, 2, 3].map((id): TileLabel => ({
      ...street(1 + (id - 1) * 3, 6, 3),
      id,
      text: String(id),
      rank: id === 3 ? LabelRank.city : LabelRank.landmark,
      angle: undefined,
      run: undefined,
    }));
    const first = draw(labels);
    expect(first.map(({ id }) => id)).toEqual([3, 1, 2]);
    const baseline = [...labelMemory(targets)!];
    const at = placement().grid;
    for (const [selected, hover] of [
      [2, 1],
      [0, 2],
      [0, 0],
    ]) {
      names.relabel(gl, targets, theme, view, programs, selected!, hover!, at);
      expect(names.inView(targets, view, at).map(({ id }) => id)).toEqual([3, 1, 2]);
      expect([...labelMemory(targets)!]).toEqual(baseline);
    }
    expect(names.inView(targets, view, { ...at, shiftX: 1 }).map(({ id }) => id)).toEqual([
      3, 1, 2,
    ]);
    expect(draw([...labels].reverse()).map(({ id }) => id)).toEqual([3, 1, 2]);
    expect(first.map(({ id }) => id)).toEqual([3, 1, 2]);
  });
  it('skips uploads for already placed hover, selection and leave without committing focus', () => {
    const { names, targets, gl, theme, programs, draw } = fixture();
    draw([street(3, 6)]);
    const memory = [...labelMemory(targets)!];
    const texture = vi.spyOn(gl, 'texSubImage2D');
    const buffer = vi.spyOn(gl, 'bufferData');
    const uploads = texture.mock.calls.length;
    const streets = buffer.mock.calls.length;
    for (const [selected, hover] of [
      [0, 1],
      [1, 0],
      [0, 0],
      [0, 1],
    ]) {
      expect(
        names.relabel(gl, targets, theme, view, programs, selected!, hover!, placement().grid),
      ).toBeUndefined();
      expect([...labelMemory(targets)!]).toEqual(memory);
    }
    expect(texture).toHaveBeenCalledTimes(uploads);
    expect(buffer).toHaveBeenCalledTimes(streets);
  });
  it('does no focus geometry when both selected and hovered ids are absent, even during shifts', () => {
    const { names, targets, gl, theme, programs, draw } = fixture();
    draw([street(3, 6)]);
    const fit = vi.spyOn(layout, 'labelFitsArea');
    const area = vi.spyOn(grid, 'screenArea');
    for (let shiftX = 1; shiftX < 10; shiftX++)
      expect(
        names.relabel(gl, targets, theme, view, programs, 0, 0, {
          ...placement().grid,
          shiftX,
        }),
      ).toBeUndefined();
    expect(fit).not.toHaveBeenCalled();
    expect(area).not.toHaveBeenCalled();
  });
  it('returns an empty array for a redraw that clears visible text, then skips unchanged frames', () => {
    const { names, targets, gl, theme, programs } = fixture();
    const at = placement();
    names.collect(targets, view, at, [{ labels: [street(3, 6)], zoom: 16 }]);
    names.draw(gl, targets, theme, view, at, programs, 1, 0);
    const baseline = [...labelMemory(targets)!];
    const shifted = { ...at.grid, shiftX: 100 };
    expect(names.relabel(gl, targets, theme, view, programs, 1, 0, shifted)).toEqual([]);
    expect([...labelMemory(targets)!]).toEqual(baseline);
    expect(names.relabel(gl, targets, theme, view, programs, 1, 0, shifted)).toBeUndefined();
  });
  it('prepares each tile copy once and reuses its projection for drawing and focus', () => {
    const { names, targets, gl, theme, programs } = fixture();
    const at = placement();
    const project = vi.spyOn(at, 'toCell');
    names.collect(targets, view, at, [{ labels: [street(3, 6), street(7, 6)], zoom: 16 }]);
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
      names.relabel(gl, targets, theme, view, programs, 0, 5, at.grid)?.map(({ id }) => id),
    ).toEqual([5]);
    expect([...labelMemory(targets)!]).toEqual(baseline);
    expect(
      names.relabel(gl, targets, theme, view, programs, 0, 0, at.grid)?.map(({ id }) => id),
    ).toEqual([1]);
    names.collect(targets, view, at, [{ labels: candidates, zoom: 16 }]);
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
    expect(labelMemory(targets)?.get(1)?.slot).toBe(-1);
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
    expect(labelMemory(targets)?.get(1)?.slot).toBe(2);
    expect(draw([incoming, old], 0, 13)[0]).toBe(old);
    expect(labelMemory(targets)?.get(1)?.slot).toBe(3);
  });
});
