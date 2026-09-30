import { expect, it, vi } from 'vitest';
import type { GL } from './gpu';
import { GpuTimer, GPU_SAMPLE_MS, MAX_GPU_QUERIES } from './gpu-timer';

function setup(enabled = true, supported = true) {
  let available = false;
  let disjoint = false;
  const gl = {
    QUERY_RESULT_AVAILABLE: 1,
    QUERY_RESULT: 2,
    getExtension: vi.fn(() => (supported ? { TIME_ELAPSED_EXT: 3, GPU_DISJOINT_EXT: 4 } : null)),
    getParameter: vi.fn(() => disjoint),
    createQuery: vi.fn(() => ({})),
    beginQuery: vi.fn(),
    endQuery: vi.fn(),
    deleteQuery: vi.fn(),
    getQueryParameter: vi.fn((_query: unknown, parameter: number): boolean | number =>
      parameter === 1 ? available : 2_000_000,
    ),
  };
  const timer = new GpuTimer(gl as unknown as GL, enabled);
  return {
    timer,
    gl,
    ready: () => {
      available = true;
    },
    disjoint: () => {
      disjoint = true;
    },
  };
}

it('does no query work when disabled or unsupported', () => {
  for (const [enabled, supported] of [
    [false, true],
    [true, false],
  ]) {
    const { timer, gl } = setup(enabled, supported);
    timer.begin(0);
    timer.end();
    timer.poll();
    timer.reset();
    expect(timer.milliseconds).toBeNull();
    expect(gl.createQuery).not.toHaveBeenCalled();
    expect(gl.getParameter).not.toHaveBeenCalled();
    if (!enabled) expect(gl.getExtension).not.toHaveBeenCalled();
  }
});

it('reads asynchronously, converts nanoseconds, and throttles samples', () => {
  const { timer, gl, ready } = setup();
  timer.begin(0);
  timer.end();
  timer.poll();
  expect(timer.milliseconds).toBeNull();
  expect(gl.getQueryParameter).not.toHaveBeenCalledWith(expect.anything(), gl.QUERY_RESULT);
  timer.begin(GPU_SAMPLE_MS - 1);
  timer.end();
  expect(gl.createQuery).toHaveBeenCalledTimes(1);
  ready();
  timer.poll();
  expect(timer.milliseconds).toBe(2);
  expect(gl.deleteQuery).toHaveBeenCalledTimes(1);
});

it('bounds pending queries and drops disjoint results', () => {
  const { timer, gl, disjoint } = setup();
  for (let i = 0; i <= MAX_GPU_QUERIES; i++) {
    timer.begin(i * GPU_SAMPLE_MS);
    timer.end();
  }
  expect(gl.createQuery).toHaveBeenCalledTimes(MAX_GPU_QUERIES);
  disjoint();
  timer.poll();
  expect(gl.deleteQuery).toHaveBeenCalledTimes(MAX_GPU_QUERIES);
  expect(timer.milliseconds).toBeNull();
  expect(gl.getQueryParameter).not.toHaveBeenCalled();
});

it('disposes active queries normally and forgets dead context handles without GL calls', () => {
  const { timer, gl } = setup();
  timer.begin(0);
  timer.end();
  timer.begin(GPU_SAMPLE_MS);
  timer.reset(true);
  expect(gl.deleteQuery).not.toHaveBeenCalled();
  expect(timer.milliseconds).toBeNull();
  timer.begin(0);
  timer.reset();
  expect(gl.deleteQuery).toHaveBeenCalledTimes(1);
  expect(gl.endQuery).toHaveBeenCalledTimes(2);
});

it('smooths valid samples and discards invalid or disjoint samples', () => {
  const { timer, gl, ready, disjoint } = setup();
  ready();
  timer.begin(0);
  timer.end();
  timer.poll();
  gl.getQueryParameter.mockImplementation((_query, parameter) =>
    parameter === 1 ? true : 12_000_000,
  );
  timer.begin(250);
  timer.end();
  timer.poll();
  expect(timer.milliseconds).toBe(3);
  gl.getQueryParameter.mockImplementation((_query, parameter) => (parameter === 1 ? true : NaN));
  timer.begin(500);
  timer.end();
  timer.poll();
  expect(timer.milliseconds).toBe(3);
  disjoint();
  timer.begin(750);
  expect(timer.milliseconds).toBeNull();
});
