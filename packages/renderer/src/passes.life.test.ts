import type * as GpuModule from './gpu';
import { expect, it, vi } from 'vitest';
import { lifePass, lifeRaster, placeGrid, type View } from './passes';
import { packLife } from './life/draw';
import { uploadLife } from './gpu';
import type { CellTargets, GL } from './gpu';
import type { ThemeResources } from './gpu-context';
import { themes } from './theme';

vi.mock('./gpu', async (load) => ({
  ...(await load<typeof GpuModule>()),
  uploadLife: vi.fn(),
}));
vi.mock('./life/draw', () => ({ packLife: vi.fn() }));

it('reuses held uploads, invalidates packing inputs, and clears the raster when Life stops', () => {
  vi.mocked(packLife).mockImplementation(
    (out, _grid, agents, _theme, _glyph, _sun, _glyphs, metadata) => {
      out.fill(agents.length);
      metadata!.owners!.fill(agents.length);
      return agents.length;
    },
  );
  const view: View = {
    camera: { lng: 0, lat: 0, zoom: 18 },
    dpr: 1,
    cellDev: { w: 10, h: 18 },
    labelDev: { w: 10, h: 18 },
    width: 100,
    height: 100,
    detailZoom: 18,
  };
  const targets = { cols: 2, rows: 2 } as CellTargets;
  const resources = { map: { atlas: { index: () => 1 } } } as unknown as ThemeResources;
  const args: Parameters<typeof lifePass> = [
    {} as GL,
    targets,
    resources,
    themes.dark,
    view,
    placeGrid(view, view.cellDev, 2, 2),
    [{ kind: 'person', lng: 0, lat: 0, flap: 0 }],
    null,
    undefined,
    () => true,
    new Set(['people']),
    {},
    { members: new Uint8Array(4), points: new Map() },
  ];
  expect(lifePass(...args)).toBe(1);
  const raster = lifeRaster(targets)!;
  const firstRevision = raster.revision;
  for (let i = 0; i < 30; i++) {
    args[9] = () => true; // New guard wrapper, same immutable frame/terrain.
    expect(lifePass(...args)).toBe(1);
  }
  expect(raster.revision).toBe(firstRevision);
  expect(uploadLife).toHaveBeenCalledTimes(1);
  expect(raster.owners[0]).toBe(1);
  const withArg = <I extends number>(
    index: I,
    value: Parameters<typeof lifePass>[I],
  ): Parameters<typeof lifePass> => {
    const next: Parameters<typeof lifePass> = [...args];
    next[index] = value;
    return next;
  };
  const changed: Parameters<typeof lifePass>[] = [
    withArg(11, {}),
    withArg(12, { members: new Uint8Array(4), points: new Map() }),
    withArg(2, { ...resources }),
    withArg(3, themes.light),
    withArg(4, { ...view, dpr: 2 }),
    withArg(4, { ...view, camera: { ...view.camera, zoom: 19 } }),
    withArg(4, { ...view, cellDev: { w: 8, h: 16 } }),
    withArg(5, placeGrid(view, view.cellDev, 2, 2)),
    withArg(10, new Set(['traffic'])),
    withArg(7, { altitude: 30, azimuth: 90 }),
  ];
  for (const next of changed) {
    lifePass(...args);
    const before = raster.revision;
    lifePass(...next);
    expect(raster.revision).toBe(before + 1);
  }
  lifePass(...withArg(1, { ...targets }));
  expect(lifeRaster(targets)).toBe(raster);
  args[6] = [];
  args[11] = undefined;
  expect(lifePass(...args)).toBe(0);
  expect(raster.life.every((byte) => byte === 0)).toBe(true);
  expect(raster.owners.every((owner) => owner === 0)).toBe(true);
  const before = raster.revision;
  lifePass(...args);
  expect(raster.revision).toBe(before + 1); // A running frame cannot reuse inspection state.
});
