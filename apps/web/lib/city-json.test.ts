// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { cityJson } from './city-json';
afterEach(() => vi.unstubAllGlobals());
it('shares in-flight requests per city and retries failed validation', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve('bad') })
    .mockResolvedValue({ ok: true, json: () => Promise.resolve([]) });
  vi.stubGlobal('fetch', fetcher);
  const load = cityJson('fixture', (v): v is unknown[] => Array.isArray(v));
  const first = load('a');
  expect(load('a')).toBe(first);
  await expect(first).rejects.toThrow('invalid data');
  await expect(load('a')).resolves.toEqual([]);
  await load('b');
  expect(fetcher).toHaveBeenCalledTimes(3);
});
