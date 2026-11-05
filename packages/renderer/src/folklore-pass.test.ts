import { expect, it, vi } from 'vitest';
import {
  folkloreLayout,
  folkloreHit,
  manananggalFrames,
  hauntUniforms,
  folklorePass,
  createHauntUniformScratch,
} from './folklore-pass';
import { deletePrograms, type Programs, type ThemeResources } from './gpu-context';
import { createProgram, createTexture, type GL, type CellTargets } from './gpu';
import { placeGrid, type View } from './grid';
import type { FolklorePacket } from './life/folklore';
import { normalizeFocus, focusPulse } from './focus';
import { SpriteFrame } from './life/manananggal-frames';
vi.mock('./gpu', () => ({
  createProgram: vi.fn(() => ({ program: {}, uniformSetters: {} })),
  createTexture: vi.fn(() => ({})),
}));
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
const figure = (over: Partial<FolklorePacket['sprites'][number]> = {}) => ({
  ...packet.sprites[0]!,
  id: 'creature',
  kind: 'manananggal' as const,
  pose: 'flying' as const,
  alpha: 1,
  ...over,
});
const under = (code: number) => Math.floor(code / 64) - 1;
it('draws only the ghosts while the sheet is on its way', async () => {
  const draw = vi.fn();
  const gl = new Proxy({ drawArraysInstanced: draw }, {
    get: (target, key) => (target[key as string] ??= vi.fn(() => ({}))),
  }) as unknown as GL;
  const p = {} as Programs;
  const theme = {
    map: { atlas: { index: () => 416, columns: 16 }, atlasTex: {} },
    uniforms: { accent: [1, 0.8, 0.3] },
  } as unknown as ThemeResources;
  const grid = { originCol: 0, originRow: 0, shiftX: 0, shiftY: 0 };
  const both = folkloreLayout({ ...packet, sprites: [packet.sprites[0]!, figure()] }, view);
  folklorePass(gl, p, {} as CellTargets, theme, view, grid, both);
  expect(draw).toHaveBeenLastCalledWith(gl.TRIANGLES, 0, 6, 1);
  await vi.waitFor(() => expect(p.folklore!.sheet).toBeDefined());
});
it('picks the frame for each moment of the manananggal, with its entrails under the wings', () => {
  const flying = manananggalFrames(figure({ phase: 0.5, wave: 0.5 }));
  expect(flying % 64).toBe(SpriteFrame.flap + 4);
  expect(under(flying)).toBe(SpriteFrame.trail + 2);
  const folding = manananggalFrames(figure({ fold: 0.6, wave: 0 }));
  expect(folding % 64).toBe(SpriteFrame.fold + 2);
  expect(under(folding)).toBe(SpriteFrame.trail);
  // Its last frames are the end of their sets at the very top of each range.
  expect(manananggalFrames(figure({ phase: 0.999 })) % 64).toBe(SpriteFrame.flaps - 1);
  expect(manananggalFrames(figure({ fold: 0.999 })) % 64).toBe(SpriteFrame.perch - 1);
  const perched = figure({ pose: 'perched', fold: 1, phase: 0, wave: 0.99 });
  expect(manananggalFrames(perched)).toBe(SpriteFrame.perch + 2);
  expect(manananggalFrames({ ...perched, phase: 1 })).toBe(SpriteFrame.perch + 3);
});
it('leans the manananggal into its flight, upright when folded, and leaves the legs still', () => {
  const lean = (over: Parameters<typeof figure>[0]) =>
    folkloreLayout({ ...packet, sprites: [figure(over)] }, view)[0]!.lean;
  expect(lean({ heading: 0 })).toBeGreaterThan(0.2);
  expect(lean({ heading: Math.PI })).toBeLessThan(-0.2);
  expect(lean({ heading: Math.PI / 2 })).toBeCloseTo(0);
  expect(lean({ heading: 0, fold: 1 })).toBe(0);
  const legs = folkloreLayout(
    { ...packet, sprites: [figure({ kind: 'lower-half' as never })] },
    view,
  )[0]!;
  expect(legs.glyph).toBe(SpriteFrame.lower);
  expect(legs.lean).toBe(0);
});
it('sizes the figure to a square of its frames at least, and in metres when closer', () => {
  const size = (zoom: number, dpr: number) =>
    folkloreLayout(
      { ...packet, sprites: [figure()] },
      { ...view, dpr, camera: { ...view.camera, zoom } },
    )[0]!;
  expect(size(15, 1).w).toBe(48);
  expect(size(15, 1).h).toBe(48);
  expect(size(15, 2).w).toBe(96);
  expect(size(22, 1).w).toBeGreaterThan(48);
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
  async (preparation) => {
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
        'deleteTexture',
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
        field: false,
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
    // Ghosts alone never ask for the sheet. The manananggal asks once, and waits for it unseen.
    vi.mocked(createTexture).mockClear();
    expect(r.sprites).toBeUndefined();
    expect(r.sheetRequested).toBeUndefined();
    const draws = vi.mocked(calls.drawArraysInstanced!);
    draws.mockClear();
    const creature = { ...packet, sprites: [figure()] };
    const quads = folkloreLayout(creature, view);
    folklorePass(gl, p, targets, theme, view, grid, quads);
    expect(r.sheetRequested).toBe(true);
    expect(draws).not.toHaveBeenCalled();
    const mixed = folkloreLayout({ ...packet, sprites: [packet.sprites[0]!, figure()] }, view);
    await vi.waitFor(() => expect(r.sheet).toBeDefined());
    expect(createTexture).not.toHaveBeenCalled();
    folklorePass(gl, p, targets, theme, view, grid, mixed);
    folklorePass(gl, p, targets, theme, view, grid, quads);
    expect(createTexture).toHaveBeenCalledTimes(1);
    expect(r.sprites).toBeDefined();
    expect(r.sheet).toBeUndefined();
    expect(draws).toHaveBeenLastCalledWith(gl.TRIANGLES, 0, 6, 1);
    expect(draws.mock.calls[0]![3]).toBe(2);
    gl.isContextLost = () => false;
    deletePrograms(gl, p);
    expect(calls.deleteProgram).toHaveBeenCalledWith(r.program.program);
    expect(calls.deleteBuffer).toHaveBeenCalledWith(r.buffer);
    expect(calls.deleteVertexArray).toHaveBeenCalledWith(r.vao);
    expect(calls.deleteTexture).toHaveBeenCalledWith(r.sprites);
    const restored = { ...p, folklore: undefined };
    folklorePass(gl, restored, targets, theme, view, grid, folkloreLayout(packet, view));
    expect(restored.folklore).not.toBe(r);
  },
);
