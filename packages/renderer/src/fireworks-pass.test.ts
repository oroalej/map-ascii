import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FireworksConfig } from '@atlas/shared';
import type { GL, CellTargets } from './gpu';
import { createProgram } from './gpu';
import type { Programs, ThemeResources } from './gpu-context';
import { placeGrid, type View } from './grid';
import { fireworksPass as drawFireworks, deleteFireworks } from './fireworks-pass';
import type { FireworkSiteSampler } from './fireworks-sites';
import {
  FIREWORKS,
  fireworkRadius,
  fireworkShellCount,
  fireworkCameraHeight,
  fireworkSparkWidth,
} from './fireworks-layout';

const testSites: FireworkSiteSampler = (bounds, rng) => {
  const x = bounds.left + rng() * (bounds.right - bounds.left);
  const y = bounds.top + rng() * (bounds.bottom - bounds.top);
  return { x, y, id: Math.floor(x * 1000 + y * 100) };
};
const fireworksPass: typeof drawFireworks = (...args) => {
  args[12] ??= testSites;
  return drawFireworks(...args);
};

const setters = vi.hoisted(() => ({
  u_shells: vi.fn(),
  u_flights: vi.fn(),
  u_appearance: vi.fn(),
  u_wind: vi.fn(),
  u_variants: vi.fn(),
  u_variantCount: vi.fn(),
}));
vi.mock('./gpu', () => ({
  createProgram: vi.fn(() => ({ program: {}, uniformSetters: setters })),
}));
const view: View = {
  camera: { lng: 0, lat: 0, zoom: 19 },
  dpr: 1,
  width: 1000,
  height: 800,
  cellDev: { w: 5, h: 9 },
  labelDev: { w: 10, h: 18 },
  detailZoom: 19,
};
const config: FireworksConfig = {
  label: 'Fireworks',
  variants: ['peony', 'chrysanthemum', 'ring', 'willow'],
};
const resources = {
  map: { atlasTex: {}, atlas: { columns: 16, index: () => 1 } },
} as unknown as ThemeResources;
const wind = { dir: [1, 0] as [number, number], strength: 0.5, from: 270 };

function gpu() {
  return {
    createVertexArray: vi.fn(() => ({})),
    createBuffer: vi.fn(() => ({})),
    bindVertexArray: vi.fn(),
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
    enableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
    vertexAttribDivisor: vi.fn(),
    bindFramebuffer: vi.fn(),
    viewport: vi.fn(),
    disable: vi.fn(),
    useProgram: vi.fn(),
    enable: vi.fn(),
    blendFunc: vi.fn(),
    drawArraysInstanced: vi.fn(),
    deleteProgram: vi.fn(),
    deleteBuffer: vi.fn(),
    deleteVertexArray: vi.fn(),
    BLEND: 1,
    TRIANGLES: 4,
    FLOAT: 0x1406,
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88e4,
  };
}
beforeEach(() => vi.clearAllMocks());
describe('seasonal GPU fireworks', () => {
  it.each(['cached', 'pending'])(
    'consumes an idle %s program exactly once on first demand',
    (kind) => {
      const gl = gpu();
      const programs: Programs = {};
      const program: ReturnType<typeof createProgram> = {
        program: {},
        uniformSetters: setters,
        uniformLocations: {},
        attribLocations: {},
        attribSetters: {},
      };
      const finish = vi.fn(() => program);
      if (kind === 'cached') programs.fireworksProgram = program;
      else
        programs.glyphWarmup = {
          clocks: false,
          seasonal: false,
          fireworks: true,
          cancel: vi.fn(),
          pending: { key: 8, program: { ready: () => false, finish, cancel: vi.fn() } },
        };
      const grid = placeGrid(view, view.cellDev, 202, 92).grid;
      for (const time of [2.6, 2.7])
        fireworksPass(
          gl as unknown as GL,
          programs,
          {} as CellTargets,
          resources,
          view,
          grid,
          grid,
          config,
          time,
          false,
          wind,
          0,
        );
      expect(programs.fireworks?.program).toBe(program);
      expect(programs.fireworksProgram).toBeUndefined();
      expect(programs.glyphWarmup?.pending).toBeUndefined();
      expect(finish).toHaveBeenCalledTimes(kind === 'pending' ? 1 : 0);
      expect(createProgram).not.toHaveBeenCalled();
      expect(gl.bufferData).toHaveBeenCalledOnce();
      deleteFireworks(gl as unknown as GL, programs.fireworks!);
      expect(gl.deleteProgram).toHaveBeenCalledExactlyOnceWith(program.program);
    },
  );
  it('draws no fireworks without mapped residential sites', () => {
    const gl = gpu(),
      programs = {} as Programs;
    const grid = placeGrid(view, view.cellDev, 202, 92).grid;
    drawFireworks(
      gl as unknown as GL,
      programs,
      {} as CellTargets,
      resources,
      view,
      grid,
      grid,
      config,
      0,
      false,
      wind,
      0,
    );
    expect(gl.drawArraysInstanced).not.toHaveBeenCalled();
  });
  it('scales bursts and wind drift on zoom without uploading particles or resetting their clock', () => {
    const gl = gpu(),
      programs = {} as Programs;
    for (const [zoom, dpr] of [
      [19, 1],
      [19.5, 1],
      [20, 2],
      [20.75, 3],
    ] as const) {
      const v = {
        ...view,
        camera: { ...view.camera, zoom },
        dpr,
        cellDev: { w: 5 * dpr, h: 9 * dpr },
      };
      const grid = placeGrid(v, v.cellDev, 202, 92).grid;
      fireworksPass(
        gl as unknown as GL,
        programs,
        {} as CellTargets,
        resources,
        v,
        grid,
        grid,
        config,
        2.6,
        false,
        wind,
        0,
      );
      const scale = 2 ** (zoom - 19);
      const display = programs.fireworks!.display;
      const count = [...display.admitted].filter((id) => id >= 0).length;
      for (let i = 0; i < count * 4; i += 4) {
        const launch = display.launches[display.admitted[i / 4]!]!;
        expect(programs.fireworks!.shells[i + 3]).toBeCloseTo(
          fireworkRadius(launch.height, zoom) * dpr,
          3,
        );
        expect(launch.height).toBeLessThan(fireworkCameraHeight(zoom));
        expect(display.appearance[i / 2 + 1]).toBeCloseTo(
          fireworkSparkWidth(launch.height, zoom) * dpr,
          3,
        );
      }
      expect(setters.u_wind).toHaveBeenLastCalledWith([0.5 * dpr * scale, 0]);
      expect(setters.u_flights).toHaveBeenLastCalledWith(programs.fireworks!.display.flights);
      expect(setters.u_appearance).toHaveBeenLastCalledWith(display.appearance);
      expect(programs.fireworks!.display.lastTime).toBe(2.6);
    }
    expect(gl.bufferData).toHaveBeenCalledTimes(1);
    expect(gl.createBuffer).toHaveBeenCalledTimes(1);
    expect(gl.drawArraysInstanced).toHaveBeenCalledTimes(8);
  });
  it('creates nothing for old packs, inactive seasons or low zoom, and does not leave a stale overlay', () => {
    const gl = gpu(),
      programs = {} as Programs,
      grid = placeGrid(view, view.cellDev, 202, 92).grid;
    for (const [selected, zoom] of [
      [undefined, 19],
      [config, 6],
      [config, 21],
      [config, NaN],
    ] as const)
      fireworksPass(
        gl as unknown as GL,
        programs,
        {} as CellTargets,
        resources,
        { ...view, camera: { ...view.camera, zoom } },
        grid,
        grid,
        selected,
        2,
        false,
        wind,
        0,
      );
    expect(gl.createBuffer).not.toHaveBeenCalled();
    expect(gl.drawArraysInstanced).not.toHaveBeenCalled();
    fireworksPass(
      gl as unknown as GL,
      programs,
      {} as CellTargets,
      resources,
      view,
      grid,
      grid,
      config,
      2,
      false,
      wind,
      0,
    );
    const drawn = gl.drawArraysInstanced.mock.calls.length;
    fireworksPass(
      gl as unknown as GL,
      programs,
      {} as CellTargets,
      resources,
      view,
      grid,
      grid,
      undefined,
      3,
      false,
      wind,
      0,
    );
    expect(gl.drawArraysInstanced).toHaveBeenCalledTimes(drawn);
  });

  it('submits no particles when the viewpoint is below every cached burst', () => {
    const gl = gpu(),
      programs = {} as Programs;
    const draw = (v: View) => {
      const grid = placeGrid(v, v.cellDev, 202, 92).grid;
      fireworksPass(
        gl as unknown as GL,
        programs,
        {} as CellTargets,
        resources,
        v,
        grid,
        grid,
        config,
        2,
        false,
        wind,
        0,
      );
    };
    draw(view);
    const calls = gl.drawArraysInstanced.mock.calls.length;
    for (const launch of programs.fireworks!.display.launches) if (launch) launch.height = 200;
    draw({ ...view, camera: { ...view.camera, zoom: 20 } });
    expect(gl.drawArraysInstanced).toHaveBeenCalledTimes(calls);
    expect(programs.fireworks!.shells.every((value) => value === 0)).toBe(true);
    expect(programs.fireworks!.display.appearance.every((value) => value === 0)).toBe(true);
    expect(gl.bufferData).toHaveBeenCalledTimes(1);
  });
  it('draws only the admitted particle prefixes and clears all fireworks at close zoom', () => {
    const gl = gpu(),
      programs = {} as Programs;
    for (const [zoom, count] of [
      [16, 50],
      [17, 31],
      [18, 17],
      [19, 7],
      [20, 4],
      [21, 0],
      [20, 4],
    ] as const) {
      const v = { ...view, camera: { ...view.camera, zoom } };
      const grid = placeGrid(v, v.cellDev, 202, 92).grid;
      const before = gl.drawArraysInstanced.mock.calls.length;
      fireworksPass(
        gl as unknown as GL,
        programs,
        {} as CellTargets,
        resources,
        v,
        grid,
        grid,
        config,
        2.6,
        false,
        wind,
        0,
      );
      if (!count) {
        expect(gl.drawArraysInstanced).toHaveBeenCalledTimes(before);
        continue;
      }
      expect(gl.drawArraysInstanced.mock.calls.slice(before)).toEqual([
        [gl.TRIANGLES, 0, 6, count * FIREWORKS.smoke],
        [gl.TRIANGLES, 0, 6, count * FIREWORKS.stars * FIREWORKS.tails],
      ]);
      expect(gl.vertexAttribPointer).toHaveBeenLastCalledWith(
        0,
        4,
        gl.FLOAT,
        false,
        16,
        FIREWORKS.shells * FIREWORKS.smoke * 16,
      );
    }
    expect(gl.createBuffer).toHaveBeenCalledTimes(1);
    expect(gl.bufferData).toHaveBeenCalledTimes(1);
  });
  it('uploads immutable geometry once, animates with uniforms, holds reduced motion and releases all GPU handles', () => {
    const gl = gpu(),
      programs = {} as Programs,
      grid = placeGrid(view, view.cellDev, 202, 92).grid;
    const draw = (time: number, reduced = false, selected = config) =>
      fireworksPass(
        gl as unknown as GL,
        programs,
        {} as CellTargets,
        resources,
        view,
        grid,
        grid,
        selected,
        time,
        reduced,
        wind,
        1,
      );
    draw(2);
    const shells = programs.fireworks!.shells;
    const flights = programs.fireworks!.display.flights;
    const initialFlights = flights.slice();
    const particles: unknown = gl.bufferData.mock.calls[0]![1];
    const display = programs.fireworks!.display;
    const launch = display.launches[display.admitted[0]!]!;
    const elapsed = Math.min(0.1, (launch.next - 2) / 2);
    draw(2 + elapsed);
    expect(flights[0]).toBeCloseTo(initialFlights[0]! + elapsed);
    expect(setters.u_wind).toHaveBeenLastCalledWith([0.5, 0]);
    draw(8, true);
    const stillFlights = flights.slice(),
      stillShells = shells.slice();
    expect(setters.u_wind).toHaveBeenLastCalledWith([0, 0]);
    draw(500, true);
    expect(flights).toEqual(stillFlights);
    expect(shells).toEqual(stillShells);
    draw(6, false, { label: 'Ring', variants: ['ring'] });
    expect([...programs.fireworks!.variants]).toEqual([2, 0, 0, 0]);
    expect(setters.u_variantCount).toHaveBeenLastCalledWith(1);
    expect(programs.fireworks!.shells).toBe(shells);
    expect(programs.fireworks!.display.flights).toBe(flights);
    expect(gl.bufferData).toHaveBeenCalledTimes(1);
    expect(gl.bufferData.mock.calls[0]![1]).toBe(particles);
    expect(gl.drawArraysInstanced).toHaveBeenLastCalledWith(
      gl.TRIANGLES,
      0,
      6,
      fireworkShellCount(view.camera.zoom) * FIREWORKS.stars * FIREWORKS.tails,
    );
    expect(gl.disable).toHaveBeenLastCalledWith(gl.BLEND);
    deleteFireworks(gl as unknown as GL, programs.fireworks!);
    expect(gl.deleteProgram).toHaveBeenCalledWith(programs.fireworks!.program.program);
    expect(gl.deleteBuffer).toHaveBeenCalledWith(programs.fireworks!.buffer);
    expect(gl.deleteVertexArray).toHaveBeenCalledWith(programs.fireworks!.vao);
  });
});
