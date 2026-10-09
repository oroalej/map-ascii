import { vi } from 'vitest';

const KINDS = [
  Uint8Array,
  Uint8ClampedArray,
  Int8Array,
  Uint16Array,
  Int16Array,
  Uint32Array,
  Int32Array,
  Float32Array,
  Float64Array,
] as const;

/**
 * How many typed arrays of at least `cells` elements `run` constructs: a per-frame packer may
 * allocate once per grid size, never once per call.
 */
export function gridArraysBuilt(cells: number, run: () => void): number {
  let built = 0;
  for (const Kind of KINDS)
    vi.stubGlobal(
      Kind.name,
      new Proxy(Kind, {
        construct(target, args: unknown[], newTarget: unknown) {
          const [size] = args;
          if (typeof size === 'number' && size >= cells) built++;
          return Reflect.construct(target, args, newTarget as typeof target) as object;
        },
      }),
    );
  try {
    run();
  } finally {
    vi.unstubAllGlobals();
  }
  return built;
}
