import { expect, it, vi } from 'vitest';
import { fixturePass, placeGrid, type View } from './passes';
import type { CellTargets, GL } from './gpu';
import type { ThemeResources } from './gpu-context';
import type { StreetFixture } from './life/fixtures';
import { signalState } from './life/signals';
import * as utilities from './life/utilities';

it('keeps seasonal geometry, ownership and texture uploads cached while wind and time change', () => {
  const upload = vi.fn();
  const gl = { bindTexture: vi.fn(), pixelStorei: vi.fn(), texSubImage2D: upload } as unknown as GL;
  const targets = { cols: 100, rows: 100, fixtureTex: {}, signalLightTex: {} } as CellTargets;
  const resources = { map: { atlas: { index: () => 300 } } } as unknown as ThemeResources;
  const view: View = {
    camera: { lng: 0, lat: 0, zoom: 19.5 },
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
      kind: 'season-bunting',
      id: 'row',
      from: [20, 30],
      to: [70, 30],
      seed: 7,
      style: 'red-yellow-rectangles',
      priority: { width: 9, corridor: 0, road: 'r' },
    },
  ];
  const visibility = fixturePass(gl, targets, resources, view, placement, fixtures, 0, false, {
    time: 0,
    strength: 0.7,
  });
  const bytes = (upload.mock.calls[0]!.at(-1) as Uint8Array).slice();
  expect(visibility.seasonal?.bunting).toBe(true);
  expect(upload).toHaveBeenCalledTimes(2);
  project.mockClear();
  for (const strength of [0, 0.25, 0.7, 1.5]) {
    expect(
      fixturePass(gl, targets, resources, view, placement, fixtures, 0, false, {
        time: 100,
        strength,
      }),
    ).toEqual(visibility);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(project).not.toHaveBeenCalled();
  }
  expect(upload.mock.calls[0]!.at(-1)).toEqual(bytes);
});

it('caches viewport utility visibility and updates it when only the visible bounds change', () => {
  const scan = vi.spyOn(utilities, 'utilityViewportVisibility');
  const upload = vi.fn();
  const gl = {
    bindTexture: vi.fn(),
    pixelStorei: vi.fn(),
    texSubImage2D: upload,
  } as unknown as GL;
  const targets = { cols: 100, rows: 100, fixtureTex: {}, signalLightTex: {} } as CellTargets;
  const resources = { map: { atlas: { index: () => 300 } } } as unknown as ThemeResources;
  const view: View = {
    camera: { lng: 0, lat: 0, zoom: 18.5 },
    dpr: 1,
    width: 500,
    height: 500,
    cellDev: { w: 5, h: 9 },
    labelDev: { w: 10, h: 18 },
    detailZoom: 20,
  };
  const project = vi.fn((x: number, y: number): [number, number] => [x, y]);
  const original = placeGrid(view, view.cellDev, 100, 100);
  const placement = {
    ...original,
    grid: { ...original.grid, shiftX: 0, shiftY: 0 },
    toCell: project,
  };
  const fixtures: StreetFixture[] = [
    {
      kind: 'utility-pole',
      pole: {
        id: 'p',
        road: 'r',
        component: 'r/0',
        at: [70.5, 30.5],
        heading: [1, 0],
        normal: [0, 1],
        transformer: false,
      },
    },
  ];
  try {
    expect(fixturePass(gl, targets, resources, view, placement, fixtures, 0, false).utilities).toBe(
      true,
    );
    expect(scan).toHaveBeenCalledTimes(1);
    project.mockClear();
    fixturePass(gl, targets, resources, view, placement, fixtures, 1, false);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(project).not.toHaveBeenCalled();
    const narrow = { ...view, width: 100 };
    expect(
      fixturePass(gl, targets, resources, narrow, placement, fixtures, 1, false).utilities,
    ).toBe(false);
    expect(scan).toHaveBeenCalledTimes(2);
    fixturePass(gl, targets, resources, narrow, placement, fixtures, 2, false);
    expect(scan).toHaveBeenCalledTimes(2);
    expect(project).not.toHaveBeenCalled();
    expect(fixturePass(gl, targets, resources, view, placement, fixtures, 2, false).utilities).toBe(
      true,
    );
    const zoomed = { ...view, camera: { ...view.camera, zoom: 19.5 } };
    fixturePass(gl, targets, resources, zoomed, placement, fixtures, 2, false);
    expect(project).toHaveBeenCalled();
    targets.cols = 120;
    fixturePass(gl, targets, resources, zoomed, placement, fixtures, 2, false);
    const uploaded = upload.mock.calls.at(-2)!.at(-1) as Uint8Array;
    expect(uploaded).toHaveLength(120 * 100 * 4);
  } finally {
    scan.mockRestore();
  }
});

it('animates cached flag cloth independently of the signal clock and lighting lookup', () => {
  const upload = vi.fn();
  const gl = { bindTexture: vi.fn(), pixelStorei: vi.fn(), texSubImage2D: upload } as unknown as GL;
  const targets = { cols: 100, rows: 100, fixtureTex: {}, signalLightTex: {} } as CellTargets;
  const resources = { map: { atlas: { index: () => 300 } } } as unknown as ThemeResources;
  const view: View = {
    camera: { lng: 0, lat: 0, zoom: 20.5 },
    dpr: 1,
    width: 500,
    height: 500,
    cellDev: { w: 5, h: 9 },
    labelDev: { w: 10, h: 18 },
    detailZoom: 21,
  };
  const project = vi.fn((x: number, y: number): [number, number] => [x, y]);
  const placement = { ...placeGrid(view, view.cellDev, 100, 100), toCell: project };
  const fixtures: StreetFixture[] = [
    {
      kind: 'flagpole',
      flag: 'PH',
      seed: 7,
      base: [40.5, 40.5],
      tip: [40.5, 39.5],
      forward: [40.5, 39.5],
      right: [41.5, 40.5],
    },
  ];
  fixturePass(gl, targets, resources, view, placement, fixtures, 0, false, {
    time: 0,
    strength: 0.7,
  });
  expect(upload).toHaveBeenCalledTimes(2);
  project.mockClear();
  fixturePass(gl, targets, resources, view, placement, fixtures, 0, false, {
    time: 0.7,
    strength: 0.7,
  });
  expect(project).not.toHaveBeenCalled();
  expect(upload).toHaveBeenCalledTimes(3);
  fixturePass(gl, targets, resources, view, placement, fixtures, 0, false, {
    time: 0.7,
    strength: 0.7,
  });
  expect(upload).toHaveBeenCalledTimes(3);
  fixturePass(gl, targets, resources, view, placement, fixtures, 0, false, {
    time: 1,
    strength: 0,
  });
  expect(upload).toHaveBeenCalledTimes(4);
  fixturePass(gl, targets, resources, view, placement, fixtures, 0, false, {
    time: 10,
    strength: 0,
  });
  expect(upload).toHaveBeenCalledTimes(4);
});

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
      kind: 'utility-pole',
      pole: {
        id: 'p',
        road: 'r',
        component: 'r/0',
        at: [30, 30],
        heading: [1, 0],
        normal: [0, 1],
        transformer: false,
      },
    },
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
