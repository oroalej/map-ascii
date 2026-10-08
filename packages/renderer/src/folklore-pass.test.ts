import { expect, it, vi } from 'vitest';
import {
  folkloreLayout,
  folkloreHit,
  hauntUniforms,
  folklorePass,
  createHauntUniformScratch,
} from './folklore-pass';
import { deletePrograms, type Programs, type ThemeResources } from './gpu-context';
import { createProgram, type GL, type CellTargets } from './gpu';
import { placeGrid, type View } from './grid';
import type { FolklorePacket } from './life/folklore';
import { normalizeFocus, focusPulse } from './focus';
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
  const upper = { ...quad[0]!, sprite: { ...quad[0]!.sprite, id: 'upper' } };
  expect(folkloreHit([...quad, upper], [400, 300], 1)?.id).toBe('upper');
  expect(
    folkloreLayout({ ...packet, sprites: packet.sprites.map((s) => ({ ...s, alpha: 0 })) }, view),
  ).toEqual([]);
  expect(folkloreLayout(packet, { ...view, camera: { ...view.camera, lng: 1 } })).toEqual([]);
});
it('keeps uniform scratch independent and clears unused or disabled haunts', () => {
  const a = createHauntUniformScratch(),
    b = createHauntUniformScratch(),
    grid = { originCol: 0, originRow: 0, shiftX: 0, shiftY: 0 };
  const many = { ...packet, haunts: [packet.haunts[0]!, { ...packet.haunts[0]!, radius: 20 }] };
  expect(hauntUniforms(many, view, grid, true, a)).toBe(a);
  expect(a.u_haunts[5]).toBe(20);
  expect(b.u_haunts.every((n) => n === 0)).toBe(true);
  hauntUniforms(packet, view, grid, true, a);
  expect(a.u_haunts[5]).toBe(0);
  hauntUniforms(packet, view, grid, false, a);
  expect(a.u_hauntCount).toBe(0);
  expect(a.u_haunts.every((n) => n === 0)).toBe(true);
  expect(a.u_haunts).not.toBe(b.u_haunts);
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
it.each(['cached', 'pending', 'demand'] as const)(
  'draws folklore with %s preparation and owns each resource once',
  (preparation) => {
    vi.mocked(createProgram).mockClear();
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
        uniforms: { accent: [1, 0.8, 0.3] },
      } as unknown as ThemeResources,
      targets = {} as CellTargets,
      grid = { originCol: 0, originRow: 0, shiftX: 0, shiftY: 0 };
    const uniformSetters = {
      u_accent: vi.fn(),
      u_focusMode: vi.fn(),
      u_pulse: vi.fn(),
    };
    const prepared: ReturnType<typeof createProgram> = {
        program: {},
        uniformSetters,
        uniformLocations: {},
        attribLocations: {},
        attribSetters: {},
      },
      finish = vi.fn(() => prepared);
    vi.mocked(createProgram).mockReturnValue(prepared);
    if (preparation === 'cached') p.folkloreProgram = prepared;
    if (preparation === 'pending')
      p.glyphWarmup = {
        clocks: false,
        seasonal: false,
        fireworks: false,
        folklore: true,
        cancel: vi.fn(),
        pending: { key: 16, program: { ready: () => false, finish, cancel: vi.fn() } },
      };
    folklorePass(gl, p, targets, theme, view, grid, []);
    expect(p.folklore).toBeUndefined();
    folklorePass(gl, p, targets, theme, view, grid, folkloreLayout(packet, view));
    const calls = gl as unknown as Record<string, ReturnType<typeof vi.fn>>;
    expect(calls.drawArraysInstanced).toHaveBeenCalledWith(gl.TRIANGLES, 0, 6, 1);
    const r = p.folklore!;
    expect(createProgram).toHaveBeenCalledTimes(preparation === 'demand' ? 1 : 0);
    expect(finish).toHaveBeenCalledTimes(preparation === 'pending' ? 1 : 0);
    expect(p.folkloreProgram).toBeUndefined();
    expect(p.glyphWarmup?.pending).toBeUndefined();
    const data = r.data;
    for (const [focus, mode] of [
      [normalizeFocus({ classes: [], life: [], folklore: true }), 2],
      [normalizeFocus({ classes: ['road_mid'], life: [] }), 1],
      [normalizeFocus({ classes: [], life: ['people'] }), 1],
      [normalizeFocus(null), 0],
    ] as const) {
      folklorePass(gl, p, targets, theme, view, grid, folkloreLayout(packet, view), focus, 0.5);
      expect(uniformSetters.u_accent).toHaveBeenLastCalledWith(theme.uniforms.accent);
      expect(uniformSetters.u_focusMode).toHaveBeenLastCalledWith(mode);
      expect(uniformSetters.u_pulse).toHaveBeenLastCalledWith(focusPulse(0.5, true));
      folklorePass(
        gl,
        p,
        targets,
        theme,
        view,
        grid,
        folkloreLayout(packet, view),
        focus,
        0.5,
        true,
      );
      expect(uniformSetters.u_pulse).toHaveBeenLastCalledWith(1);
    }
    folklorePass(gl, p, targets, theme, view, grid, folkloreLayout(packet, view));
    expect(r.data).toBe(data);
    deletePrograms(gl, p);
    expect(calls.deleteProgram).toHaveBeenCalledWith(r.program.program);
    expect(calls.deleteBuffer).toHaveBeenCalledWith(r.buffer);
    expect(calls.deleteVertexArray).toHaveBeenCalledWith(r.vao);
    const restored = { ...p, folklore: undefined };
    folklorePass(gl, restored, targets, theme, view, grid, folkloreLayout(packet, view));
    expect(restored.folklore).not.toBe(r);
  },
);
