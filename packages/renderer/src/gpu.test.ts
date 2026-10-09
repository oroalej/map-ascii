import { expect, it, vi } from 'vitest';
import {
  createCellTargets,
  deleteCellTargets,
  deleteTile,
  drawCrowns,
  drawGround,
  uploadTile,
  uploadEffectClocks,
  uploadCrowdMask,
  type GL,
  type CellTargets,
} from './gpu';
import { buildTileGeometry, createIdRegistry } from './raster/geometry';

it('keeps crowd texture storage across active updates, Stop and later reactivation', () => {
  const gl = {
    TEXTURE_2D: 3553,
    RGBA32UI: 36208,
    RGBA_INTEGER: 36249,
    UNSIGNED_INT: 5125,
    bindTexture: vi.fn(),
    texImage2D: vi.fn(),
    texSubImage2D: vi.fn(),
    texParameteri: vi.fn(),
    createTexture: vi.fn(),
  };
  const targets = {
    cols: 2,
    rows: 2,
    crowdMaskTex: {},
    crowdMaskCols: 1,
    crowdMaskRows: 1,
  } as CellTargets;
  for (let i = 0; i < 3; i++) uploadCrowdMask(gl as unknown as GL, targets);
  expect(targets.crowdMaskActive).toBe(false);
  expect(gl.bindTexture).not.toHaveBeenCalled();
  const values = new Uint32Array(32);
  uploadCrowdMask(gl as unknown as GL, targets, values);
  expect(gl.texImage2D.mock.calls[0]!.slice(2)).toEqual([
    gl.RGBA32UI,
    4,
    2,
    0,
    gl.RGBA_INTEGER,
    gl.UNSIGNED_INT,
    values,
  ]);
  expect(targets.crowdMaskActive).toBe(true);
  uploadCrowdMask(gl as unknown as GL, targets, values);
  uploadCrowdMask(gl as unknown as GL, targets);
  expect(targets.crowdMaskActive).toBe(false);
  uploadCrowdMask(gl as unknown as GL, targets, values);
  expect(gl.texImage2D).toHaveBeenCalledTimes(1);
  expect(gl.texSubImage2D).toHaveBeenCalledTimes(2);
  targets.cols = 3;
  uploadCrowdMask(gl as unknown as GL, targets, new Uint32Array(48));
  expect(gl.texImage2D).toHaveBeenCalledTimes(2);
  expect(targets.crowdMaskCols).toBe(6);
  expect(gl.texParameteri).not.toHaveBeenCalled();
  expect(gl.createTexture).not.toHaveBeenCalled();
});

it('uploads moved crowd row unions, retains pending clearing through Stop, and fully initializes resize', () => {
  let stored = new Uint32Array();
  const gl = {
    TEXTURE_2D: 3553,
    RGBA32UI: 36208,
    RGBA_INTEGER: 36249,
    UNSIGNED_INT: 5125,
    bindTexture: vi.fn(),
    texImage2D: vi.fn(
      (_target, _level, _format, _width, _height, _border, _layout, _type, data: Uint32Array) => {
        stored = data.slice();
      },
    ),
    texSubImage2D: vi.fn(
      (
        _target,
        _level,
        _x,
        y: number,
        width: number,
        _height,
        _format,
        _type,
        data: Uint32Array,
      ) => {
        stored.set(data, y * width * 4);
      },
    ),
  };
  const targets = {
    cols: 2,
    rows: 6,
    crowdMaskTex: {},
    crowdMaskCols: 1,
    crowdMaskRows: 1,
  } as CellTargets;
  const values = new Uint32Array(96);
  values.fill(9, 16, 32);
  uploadCrowdMask(gl as unknown as GL, targets, values, [1, 2]);
  values.fill(0);
  values.fill(7, 64, 80);
  uploadCrowdMask(gl as unknown as GL, targets, values, [4, 5]);
  expect(gl.texSubImage2D.mock.calls.at(-1)!.slice(2, 6)).toEqual([0, 1, 4, 4]);
  expect([...stored]).toEqual([...values]);
  uploadCrowdMask(gl as unknown as GL, targets, values, [4, 5]);
  expect(gl.texSubImage2D.mock.calls.at(-1)!.slice(2, 6)).toEqual([0, 4, 4, 1]);
  uploadCrowdMask(gl as unknown as GL, targets);
  const count = gl.texSubImage2D.mock.calls.length;
  uploadCrowdMask(gl as unknown as GL, targets);
  expect(gl.texSubImage2D).toHaveBeenCalledTimes(count);
  values.fill(0);
  values.fill(5, 0, 16);
  uploadCrowdMask(gl as unknown as GL, targets, values, [0, 1]);
  expect([...stored]).toEqual([...values]);
  targets.cols = 3;
  const resized = new Uint32Array(144);
  resized.fill(3, 120, 144);
  uploadCrowdMask(gl as unknown as GL, targets, resized, [5, 6]);
  expect(gl.texImage2D).toHaveBeenCalledTimes(2);
  expect([...stored]).toEqual([...resized]);
});

it('allocates an exact float clock texture lazily, reuses it, and releases it when unused', () => {
  const texture = {};
  const gl = {
    UNSIGNED_BYTE: 5121,
    FLOAT: 5126,
    RG32F: 33328,
    RG: 33319,
    createTexture: vi.fn(() => texture),
    bindTexture: vi.fn(),
    pixelStorei: vi.fn(),
    texImage2D: vi.fn(),
    texSubImage2D: vi.fn(),
    texParameteri: vi.fn(),
    deleteTexture: vi.fn(),
  };
  const targets = { cols: 2, rows: 2 } as CellTargets;
  const values = new Float32Array(8).fill(-2.4);
  uploadEffectClocks(gl as unknown as GL, targets, undefined);
  expect(gl.createTexture).not.toHaveBeenCalled();
  uploadEffectClocks(gl as unknown as GL, targets, values);
  expect(gl.texImage2D.mock.calls[0]!.slice(2)).toEqual([
    gl.RG32F,
    2,
    2,
    0,
    gl.RG,
    gl.FLOAT,
    values,
  ]);
  uploadEffectClocks(gl as unknown as GL, targets, values);
  expect(gl.createTexture).toHaveBeenCalledTimes(1);
  expect(gl.texSubImage2D).toHaveBeenCalledTimes(1);
  uploadEffectClocks(gl as unknown as GL, targets, undefined);
  expect(gl.deleteTexture).toHaveBeenCalledWith(texture);
  expect(targets.effectClockTex).toBeUndefined();
});

function setup() {
  const gl = {
    ARRAY_BUFFER: 1,
    ELEMENT_ARRAY_BUFFER: 2,
    STATIC_DRAW: 3,
    SHORT: 4,
    UNSIGNED_BYTE: 5,
    UNSIGNED_INT: 6,
    FLOAT: 8,
    TRIANGLES: 7,
    createVertexArray: vi.fn(() => ({})),
    createBuffer: vi.fn(() => ({})),
    bindVertexArray: vi.fn(),
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
    enableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
    vertexAttribIPointer: vi.fn(),
    deleteVertexArray: vi.fn(),
    deleteBuffer: vi.fn(),
    drawElements: vi.fn(),
    drawArrays: vi.fn(),
    clearBufferfi: vi.fn(),
  };
  const geometry = buildTileGeometry({}, createIdRegistry(), { z: 16, x: 1, y: 1 });
  return { gl, api: gl as unknown as GL, geometry };
}

it('creates, draws, and deletes no GPU resources for empty submeshes', () => {
  const { api, gl, geometry } = setup();
  const mesh = uploadTile(api, geometry);
  expect(mesh.crowns).toEqual({ vao: null, buffers: [], count: 0 });
  drawGround(api, mesh);
  drawCrowns(api, mesh);
  deleteTile(api, mesh);
  expect(gl.createVertexArray).not.toHaveBeenCalled();
  expect(gl.createBuffer).not.toHaveBeenCalled();
  expect(gl.deleteVertexArray).not.toHaveBeenCalled();
  expect(gl.deleteBuffer).not.toHaveBeenCalled();
  expect(gl.drawElements).not.toHaveBeenCalled();
});

it('uploads and releases only the nonempty submesh', () => {
  const { api, gl, geometry } = setup();
  geometry.points = {
    positions: new Int16Array([1, 2]),
    meta: new Uint8Array(4),
    ids: new Uint32Array([1]),
    ridge: new Int16Array(1),
  };
  const mesh = uploadTile(api, geometry);
  expect(gl.createVertexArray).toHaveBeenCalledTimes(1);
  expect(gl.createBuffer).toHaveBeenCalledTimes(4);
  drawGround(api, mesh);
  deleteTile(api, mesh);
  expect(gl.drawArrays).toHaveBeenCalledTimes(1);
  expect(gl.deleteVertexArray).toHaveBeenCalledTimes(1);
  expect(gl.deleteBuffer).toHaveBeenCalledTimes(4);
});

it.each([false, true])(
  'binds roof surfaces with the correct numeric type (packed: %s) and releases their buffer',
  (packed) => {
    const { api, gl, geometry } = setup();
    geometry.fills = {
      positions: new Int16Array([0, 0, 1, 0, 0, 1]),
      meta: new Uint8Array(12),
      ids: new Uint32Array(3),
      ridge: new Int16Array(3),
      indices: new Uint32Array([0, 1, 2]),
      surface: packed ? new Int16Array(12) : new Float32Array(12),
      surfaceSize: 4,
      ...(packed ? { surfaceScale: 1 / 64 } : {}),
    };
    const mesh = uploadTile(api, geometry);
    expect(gl.vertexAttribPointer).toHaveBeenCalledWith(
      4,
      4,
      packed ? gl.SHORT : gl.FLOAT,
      false,
      0,
      0,
    );
    expect(mesh.fills.surfaceScale).toBe(packed ? 1 / 64 : undefined);
    deleteTile(api, mesh);
    expect(gl.deleteBuffer).toHaveBeenCalledTimes(6);
  },
);

it('creates the cell light as a filtered R8 second attachment of the glyph target, and deletes it', () => {
  const constants = new Map<string, number>();
  const calls: { name: string; args: unknown[] }[] = [];
  let made = 0;
  const constant = (key: string) => {
    if (!constants.has(key)) constants.set(key, 0x1000 + constants.size);
    return constants.get(key)!;
  };
  const gl = new Proxy(
    {},
    {
      get(_, key: string) {
        if (/^[A-Z0-9_]+$/.test(key)) return constant(key);
        return (...args: unknown[]) => {
          calls.push({ name: key, args });
          if (key === 'checkFramebufferStatus') return constant('FRAMEBUFFER_COMPLETE');
          if (key.startsWith('create')) return { handle: ++made, kind: key };
          return undefined;
        };
      },
    },
  ) as unknown as GL;
  const k = (name: string) => (gl as unknown as Record<string, number>)[name]!;
  const targets = createCellTargets(gl, 12, 7, 4, 3);
  // Its storage: a RED and a GREEN byte per cell.
  const image = calls.find(
    (c, i) => c.name === 'texImage2D' && calls[i - 2]?.args[1] === targets.shadeTex,
  );
  expect(image?.args.slice(2, 8)).toEqual([k('RG8'), 12, 7, 0, k('RG'), k('UNSIGNED_BYTE')]);
  // Linear, edge-clamped: the parameters set while it is bound, after its storage.
  const bound = calls.findIndex((c) => c.name === 'bindTexture' && c.args[1] === targets.shadeTex);
  const next = calls.findIndex((c, i) => i > bound && c.name === 'createTexture');
  const params = calls
    .slice(bound, next)
    .filter((c) => c.name === 'texParameteri')
    .map((c) => [c.args[1], c.args[2]]);
  expect(params).toEqual(
    expect.arrayContaining([
      [k('TEXTURE_MIN_FILTER'), k('LINEAR')],
      [k('TEXTURE_MAG_FILTER'), k('LINEAR')],
      [k('TEXTURE_WRAP_S'), k('CLAMP_TO_EDGE')],
      [k('TEXTURE_WRAP_T'), k('CLAMP_TO_EDGE')],
    ]),
  );
  expect(new Map(params as [number, number][]).get(k('TEXTURE_MIN_FILTER'))).toBe(k('LINEAR'));
  // Attachment 1 of the glyph framebuffer, drawn together with the glyphs, then checked.
  const attach = calls.find(
    (c) => c.name === 'framebufferTexture2D' && c.args[3] === targets.shadeTex,
  );
  expect(attach?.args[1]).toBe(k('COLOR_ATTACHMENT1'));
  const glyphBind = calls.findIndex(
    (c) => c.name === 'bindFramebuffer' && c.args[1] === targets.glyphFbo,
  );
  const after = calls.slice(glyphBind);
  expect(after.find((c) => c.name === 'drawBuffers')?.args[0]).toEqual([
    k('COLOR_ATTACHMENT0'),
    k('COLOR_ATTACHMENT1'),
  ]);
  expect(after.find((c) => c.name === 'readBuffer')?.args[0]).toBe(k('COLOR_ATTACHMENT0'));
  expect(after.some((c) => c.name === 'checkFramebufferStatus')).toBe(true);
  calls.length = 0;
  deleteCellTargets(gl, targets);
  expect(
    calls.filter((c) => c.name === 'deleteTexture' && c.args[0] === targets.shadeTex),
  ).toHaveLength(1);
});
