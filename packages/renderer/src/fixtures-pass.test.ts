import { expect, it, vi } from 'vitest';
import { fixturePass, placeGrid, type View } from './passes';
import type { CellTargets, GL } from './gpu';
import type { ThemeResources } from './gpu-context';
import type { StreetFixture } from './life/fixtures';
import { signalState } from './life/signals';

it('caches projection and rebuilds only for phase, geometry, grid, or atlas changes', () => {
  const upload = vi.fn();
  // Only the texture-upload surface is needed by this CPU pass test.
  const gl = { bindTexture: vi.fn(), pixelStorei: vi.fn(), texSubImage2D: upload } as unknown as GL;
  const targets = { cols: 100, rows: 100, fixtureTex: {}, signalLightTex: {} } as CellTargets;
  const resources = { map: { atlas: { index: () => 300 } } } as unknown as ThemeResources;
  const view: View = {
    camera: { lng: 0, lat: 0, zoom: 19 },
    dpr: 1,
    width: 500,
    height: 500,
    cellDev: { w: 5, h: 9 },
    labelDev: { w: 10, h: 18 },
    detailZoom: 20,
  };
  const project = vi.fn((x: number, y: number): [number, number] => [x, y]);
  const placement = { ...placeGrid(view, view.cellDev, 100, 100), toCell: project };
  const fixtures: StreetFixture[] = [
    {
      kind: 'signal',
      base: [40.5, 40.5],
      tip: [41.5, 40.5],
      forward: [41.5, 40.5],
      right: [40.5, 41.5],
      seed: 7,
      group: 'a',
      midBlock: false,
    },
  ];
  fixturePass(gl, targets, resources, view, placement, fixtures, 0, false);
  expect(upload).toHaveBeenCalledTimes(2);
  project.mockClear();
  fixturePass(gl, targets, resources, view, placement, fixtures, 0, false);
  expect(upload).toHaveBeenCalledTimes(2);
  expect(project).not.toHaveBeenCalled();
  const changed = Array.from({ length: 100 }, (_, i) => i).find(
    (t) => signalState(7, t).a !== signalState(7, 0).a,
  )!;
  fixturePass(gl, targets, resources, view, placement, fixtures, changed, false);
  expect(upload).toHaveBeenCalledTimes(4);
  const phaseLookup = (upload.mock.calls.at(-1)!.at(-1) as Uint8Array).slice();
  expect(phaseLookup.some((b) => b !== 0)).toBe(true);
  expect(project).not.toHaveBeenCalled();
  fixturePass(gl, targets, resources, view, placement, fixtures, changed, true);
  expect(project).toHaveBeenCalled();
  expect(upload).toHaveBeenCalledTimes(6);
  fixturePass(gl, { ...targets }, resources, view, placement, fixtures, changed, false);
  expect(upload).toHaveBeenCalledTimes(8);
  fixturePass(
    gl,
    targets,
    { map: { atlas: { index: () => 301 } } } as unknown as ThemeResources,
    view,
    placement,
    fixtures,
    changed,
    false,
  );
  expect(upload).toHaveBeenCalledTimes(10);
  fixturePass(
    gl,
    targets,
    resources,
    { ...view, camera: { ...view.camera, zoom: 21 } },
    placement,
    fixtures,
    changed,
    false,
  );
  expect(upload).toHaveBeenCalledTimes(12);
  fixturePass(gl, targets, resources, { ...view, dpr: 2 }, placement, fixtures, changed, false);
  expect(upload).toHaveBeenCalledTimes(14);
  fixturePass(gl, targets, resources, view, placement, [], changed, false);
  expect(upload).toHaveBeenCalledTimes(16);
  const empty = upload.mock.calls.at(-1)!.at(-1) as Uint8Array;
  expect(empty.every((b) => b === 0)).toBe(true);
});
