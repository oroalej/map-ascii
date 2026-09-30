import { expect, it, vi } from 'vitest';
import { deleteTile, drawCrowns, drawGround, uploadTile, type GL } from './gpu';
import { buildTileGeometry, createIdRegistry } from './raster/geometry';

function setup() {
  const gl = {
    ARRAY_BUFFER: 1,
    ELEMENT_ARRAY_BUFFER: 2,
    STATIC_DRAW: 3,
    SHORT: 4,
    UNSIGNED_BYTE: 5,
    UNSIGNED_INT: 6,
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
