import { expect, it, vi } from 'vitest';
import type * as Gpu from './gpu';
import { uploadEffectClocks } from './gpu';
import { effectClockPass, lifePass, lifeRaster, lightPass, placeGrid, type View } from './passes';
import type { ThemeResources } from './gpu-context';
import type { VisibleAgent } from './life/simulate';
import { themes } from './theme';

vi.mock('./gpu', async (load) => ({
  ...(await load<typeof Gpu>()),
  uploadLife: vi.fn(),
  uploadLights: vi.fn(),
  uploadEffectClocks: vi.fn((_gl, targets: Gpu.CellTargets, values?: Float32Array) => {
    targets.effectClockTex = values ? {} : undefined;
  }),
}));

it('uploads only changed final tokens and preserves idle pools until lighting clears them', () => {
  const gl = {} as Gpu.GL;
  const targets = { cols: 8, rows: 8 } as Gpu.CellTargets;
  const view: View = {
    camera: { lng: 0, lat: 0, zoom: 19 },
    dpr: 1,
    cellDev: { w: 10, h: 18 },
    labelDev: { w: 10, h: 18 },
    width: 80,
    height: 144,
    detailZoom: 18,
  };
  const placement = {
    ...placeGrid(view, view.cellDev, 8, 8),
    toCell: (lng: number, lat: number): [number, number] => [lng, lat],
  };
  const resources = { map: { atlas: { index: () => 1 } } } as unknown as ThemeResources;
  const candle: VisibleAgent = {
    kind: 'person',
    lng: 3.5,
    lat: 3.5,
    flap: 0,
    candle: true,
    candleSeed: 1,
    effectClock: -2,
  };
  const pack = (agents: VisibleAgent[]) =>
    lifePass(gl, targets, resources, themes.dark, view, placement, agents);
  pack([candle]);
  effectClockPass(gl, targets);
  const clocks = lifeRaster(targets)!.clocks!;
  expect(clocks.active).toBe(true);
  expect(clocks.values.some((value, at) => at % 2 === 0 && value === -2)).toBe(true);
  const revision = lifeRaster(targets)!.revision;
  pack([candle]);
  effectClockPass(gl, targets);
  expect(lifeRaster(targets)!.revision).toBeGreaterThan(revision);
  expect(uploadEffectClocks).toHaveBeenCalledTimes(1);
  lightPass(gl, targets, view, placement, [], [candle], true);
  const pools = clocks.values.filter((_value, at) => at % 2 === 1);
  expect(pools.some((value) => value === -2)).toBe(true);
  pack([{ ...candle, lng: 4.5 }]);
  effectClockPass(gl, targets);
  expect(clocks.values.filter((_value, at) => at % 2 === 1)).toEqual(pools);
  const uploads = vi.mocked(uploadEffectClocks).mock.calls.length;
  // Repacking an identical light map causes no clock upload.
  lightPass(gl, targets, view, placement, [], [candle], true);
  expect(uploadEffectClocks).toHaveBeenCalledTimes(uploads);
  lightPass(gl, targets, view, placement, [], [], true); // Beams/quality disabled.
  expect(clocks.values.filter((_value, at) => at % 2 === 1).every((value) => value === -1)).toBe(
    true,
  );
  expect(clocks.active).toBe(true); // Ink still owns R.
  pack([]);
  effectClockPass(gl, targets);
  expect(targets.effectClockTex).toBeUndefined();
  expect(lifeRaster(targets)!.clocks).toBeUndefined();
  expect(uploadEffectClocks).toHaveBeenLastCalledWith(gl, targets, undefined);
});
