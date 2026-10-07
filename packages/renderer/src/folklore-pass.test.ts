import { expect, it, vi } from 'vitest';
import { folkloreLayout, folkloreHit, hauntUniforms, folklorePass } from './folklore-pass';
import { deletePrograms, type Programs, type ThemeResources } from './gpu-context';
import type { GL, CellTargets } from './gpu';
import { placeGrid, type View } from './grid';
import type { FolklorePacket } from './life/folklore';
vi.mock('./gpu', () => ({ createProgram: vi.fn(() => ({ program: {}, uniformSetters: {} })) }));
const packet: FolklorePacket = {
  sprites: [
    {
      id: 'ghost',
      kind: 'ghost',
      lng: 0,
      lat: 0,
      heading: 0,
      pose: 'breath',
      alpha: 0.5,
      phase: 0,
      wisp: 0,
    },
  ],
  haunts: [{ id: 'ghost', lng: 0, lat: 0, radius: 8 }],
};
const view: View = {
  camera: { lng: 0, lat: 0, zoom: 18 },
  width: 800,
  height: 600,
  dpr: 1,
  detailZoom: 18,
  cellDev: { w: 5, h: 9 },
  labelDev: { w: 10, h: 18 },
};
it('uses common quad bounds, gates ghosts and neighborhood creatures, and rejects transparent/offscreen output', () => {
  expect(folkloreLayout(packet, { ...view, camera: { ...view.camera, zoom: 16 } })).toEqual([]);
  const creature = {
    ...packet,
    sprites: packet.sprites.map((s) => ({ ...s, kind: 'manananggal' as const })),
  };
  expect(folkloreLayout(creature, { ...view, camera: { ...view.camera, zoom: 15 } })).toHaveLength(
    1,
  );
  const quad = folkloreLayout(packet, view);
  expect(folkloreHit(quad, [400, 300], 1)?.id).toBe('ghost');
  expect(folkloreHit(quad, [0, 0], 1)).toBeUndefined();
  expect(
    folkloreLayout({ ...packet, sprites: packet.sprites.map((s) => ({ ...s, alpha: 0 })) }, view),
  ).toEqual([]);
  expect(folkloreLayout(packet, { ...view, camera: { ...view.camera, lng: 1 } })).toEqual([]);
});
it('keeps haunt positions and meter radii consistent across pan, zoom and DPR and clears disabled uniforms', () => {
  for (const zoom of [15, 18])
    for (const dpr of [1, 2]) {
      const v = {
          ...view,
          camera: { lng: 0.0001, lat: 0, zoom },
          dpr,
          width: 800 * dpr,
          height: 600 * dpr,
        },
        grid = placeGrid(v, { w: 5, h: 9 }, dpr, 1).grid;
      const u = hauntUniforms(packet, v, grid),
        q = folkloreLayout(
          {
            ...packet,
            sprites: packet.sprites.map((s) => ({ ...s, kind: 'manananggal' as const })),
          },
          v,
        )[0]!;
      const metricX = u.u_hauntOrigin[0]! + ((q.x + grid.shiftX) / v.cellDev.w) * u.u_hauntCell[0]!;
      expect(metricX).toBeCloseTo(u.u_haunts[0]!, 3);
      expect(u.u_haunts[2]).toBe(8);
      expect(hauntUniforms(packet, v, grid, false).u_hauntCount).toBe(0);
      expect(hauntUniforms(packet, v, grid, false).u_haunts.every((n) => n === 0)).toBe(true);
    }
  expect(
    hauntUniforms(
      { ...packet, haunts: Array.from({ length: 20 }, () => packet.haunts[0]!) },
      view,
      { originCol: 0, originRow: 0, shiftX: 0, shiftY: 0 },
    ).u_hauntCount,
  ).toBe(8);
});
it('draws a folklore-only frame lazily and deletes all resources through program ownership', () => {
  const gl = Object.fromEntries(
    [
      'createVertexArray',
      'createBuffer',
      'bindVertexArray',
      'bindBuffer',
      'bufferData',
      'enableVertexAttribArray',
      'vertexAttribPointer',
      'vertexAttribDivisor',
      'bindFramebuffer',
      'viewport',
      'disable',
      'useProgram',
      'enable',
      'blendFunc',
      'drawArraysInstanced',
      'deleteProgram',
      'deleteVertexArray',
      'deleteBuffer',
    ].map((k) => [k, vi.fn(() => ({}))]),
  ) as unknown as GL;
  const p = {
    labels: { program: {} },
    streetText: { vao: {}, buffer: {} },
    cell: { program: {} },
    select: { program: {} },
    glyph: { program: {} },
  } as Programs;
  const theme = {
      map: { atlas: { index: () => 416, columns: 16 }, atlasTex: {} },
    } as unknown as ThemeResources,
    targets = {} as CellTargets,
    grid = { originCol: 0, originRow: 0, shiftX: 0, shiftY: 0 };
  folklorePass(gl, p, targets, theme, view, grid, []);
  expect(p.folklore).toBeUndefined();
  folklorePass(gl, p, targets, theme, view, grid, folkloreLayout(packet, view));
  const calls = gl as unknown as Record<string, ReturnType<typeof vi.fn>>;
  expect(calls.drawArraysInstanced).toHaveBeenCalledWith(gl.TRIANGLES, 0, 6, 1);
  const r = p.folklore!;
  deletePrograms(gl, p);
  expect(calls.deleteProgram).toHaveBeenCalledWith(r.program.program);
  expect(calls.deleteBuffer).toHaveBeenCalledWith(r.buffer);
  expect(calls.deleteVertexArray).toHaveBeenCalledWith(r.vao);
  const restored = { ...p, folklore: undefined };
  folklorePass(gl, restored, targets, theme, view, grid, folkloreLayout(packet, view));
  expect(restored.folklore).not.toBe(r);
});
