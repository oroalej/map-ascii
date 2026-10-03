import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FireworksConfig } from '@atlas/shared';
import type { GL, CellTargets } from './gpu';
import type { Programs, ThemeResources } from './gpu-context';
import { placeGrid, type View } from './grid';
import { fireworksPass, deleteFireworks } from './fireworks-pass';
import { FIREWORKS, FIREWORK_INSTANCE_COUNT } from './fireworks-layout';

const setters = vi.hoisted(() => ({
  u_shells: vi.fn(),
  u_time: vi.fn(),
  u_still: vi.fn(),
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
  };
}
beforeEach(() => vi.clearAllMocks());
describe('seasonal GPU fireworks', () => {
  it('scales bursts and wind drift on zoom without uploading particles or resetting their clock', () => {
    const gl = gpu(),
      programs = {} as Programs;
    for (const [zoom, dpr] of [
      [19, 1],
      [19.5, 1],
      [20, 2],
      [21, 3],
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
      for (let i = 0; i < programs.fireworks!.shells.length; i += 4) {
        const seed = programs.fireworks!.shells[i + 2]!;
        expect(programs.fireworks!.shells[i + 3]).toBeCloseTo(
          (FIREWORKS.radius + (seed % FIREWORKS.radiusVariation)) * dpr * scale,
          3,
        );
      }
      expect(setters.u_wind).toHaveBeenLastCalledWith([0.5 * dpr * scale, 0]);
      expect(setters.u_time.mock.calls.at(-1)?.[0]).toBeCloseTo(2.6);
      expect(setters.u_still).toHaveBeenLastCalledWith(false);
    }
    expect(gl.bufferData).toHaveBeenCalledTimes(1);
    expect(gl.createBuffer).toHaveBeenCalledTimes(1);
    expect(gl.drawArraysInstanced).toHaveBeenCalledTimes(4);
  });
  it('creates nothing for old packs, inactive seasons or low zoom, and does not leave a stale overlay', () => {
    const gl = gpu(),
      programs = {} as Programs,
      grid = placeGrid(view, view.cellDev, 202, 92).grid;
    for (const [selected, zoom] of [
      [undefined, 19],
      [config, 13],
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
    const particles: unknown = gl.bufferData.mock.calls[0]![1];
    draw(5);
    expect(setters.u_time).toHaveBeenLastCalledWith(5);
    expect(setters.u_wind).toHaveBeenLastCalledWith([0.5, 0]);
    draw(8, true);
    expect(setters.u_time).toHaveBeenLastCalledWith(0);
    expect(setters.u_still).toHaveBeenLastCalledWith(true);
    expect(setters.u_wind).toHaveBeenLastCalledWith([0, 0]);
    draw(500, true);
    expect(setters.u_time).toHaveBeenLastCalledWith(0);
    draw(6, false, { label: 'Ring', variants: ['ring'] });
    expect([...programs.fireworks!.variants]).toEqual([2, 0, 0, 0]);
    expect(setters.u_variantCount).toHaveBeenLastCalledWith(1);
    expect(programs.fireworks!.shells).toBe(shells);
    expect(gl.bufferData).toHaveBeenCalledTimes(1);
    expect(gl.bufferData.mock.calls[0]![1]).toBe(particles);
    expect(gl.drawArraysInstanced).toHaveBeenLastCalledWith(
      gl.TRIANGLES,
      0,
      6,
      FIREWORK_INSTANCE_COUNT,
    );
    expect(gl.disable).toHaveBeenLastCalledWith(gl.BLEND);
    deleteFireworks(gl as unknown as GL, programs.fireworks!);
    expect(gl.deleteProgram).toHaveBeenCalledWith(programs.fireworks!.program.program);
    expect(gl.deleteBuffer).toHaveBeenCalledWith(programs.fireworks!.buffer);
    expect(gl.deleteVertexArray).toHaveBeenCalledWith(programs.fireworks!.vao);
  });
});
