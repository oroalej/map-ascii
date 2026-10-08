import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EtagMismatch, FetchSource } from 'pmtiles';
import { archiveSource, RangeCacheSource } from './range-cache';

const entries = new Map<string, Response>();
const address = (key: RequestInfo | URL) =>
  typeof key === 'string' ? key : key instanceof URL ? key.href : key.url;
const cache = {
  match: vi.fn((key: RequestInfo | URL) => Promise.resolve(entries.get(address(key))?.clone())),
  put: vi.fn((key: RequestInfo | URL, response: Response) => {
    entries.set(address(key), response.clone());
    return Promise.resolve();
  }),
  keys: vi.fn(() => Promise.resolve([...entries.keys()].map((key) => new Request(key)))),
  delete: vi.fn((key: RequestInfo | URL) => Promise.resolve(entries.delete(address(key)))),
};
function source(version = '1234abcd') {
  const original = new FetchSource(`https://fixture.test/tiles/fixture.pmtiles?v=${version}`);
  const network = vi.spyOn(original, 'getBytes').mockResolvedValue({
    data: new Uint8Array([1, 2, 3]).buffer,
    etag: 'one',
    cacheControl: 'immutable',
    expires: 'tomorrow',
  });
  return { original, network, cached: new RangeCacheSource(original) };
}
beforeEach(() => {
  entries.clear();
  vi.clearAllMocks();
  cache.match.mockImplementation((key) => Promise.resolve(entries.get(address(key))?.clone()));
  cache.put.mockImplementation((key, response) => {
    entries.set(address(key), response.clone());
    return Promise.resolve();
  });
  vi.stubGlobal('caches', { open: () => Promise.resolve(cache) });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('reuses exact ranges across instances with metadata and keeps versions distinct', async () => {
  const first = source();
  const bytes = await first.cached.getBytes(0, 3);
  const second = source();
  expect(await second.cached.getBytes(0, 3)).toEqual(bytes);
  expect(second.network).not.toHaveBeenCalled();
  await second.cached.getBytes(3, 3);
  expect(second.network).toHaveBeenCalledTimes(1);
  const other = source('deadbeef');
  await other.cached.getBytes(0, 3);
  expect(other.network).toHaveBeenCalledTimes(1);
  expect(first.cached.getKey()).toBe(first.original.getKey());
  expect([...entries.values()].every((response) => response.status === 200)).toBe(true);
});
it('invalidates ETag conflicts and bypasses storage during a required reload', async () => {
  const first = source();
  await first.cached.getBytes(0, 3);
  await expect(first.cached.getBytes(0, 3, undefined, 'two')).rejects.toBeInstanceOf(EtagMismatch);
  expect(entries.size).toBe(0);
  expect(first.original.mustReload).toBe(true);
  await first.cached.getBytes(0, 3);
  expect(first.network).toHaveBeenCalledTimes(2);
  expect(entries.size).toBe(0);
  const next = source();
  await next.cached.getBytes(0, 3);
  next.network.mockRejectedValueOnce(new EtagMismatch('network mismatch'));
  await expect(next.cached.getBytes(3, 3)).rejects.toBeInstanceOf(EtagMismatch);
  expect(entries.size).toBe(0);
});
it('does not let pre-invalidation network requests refill storage', async () => {
  const first = source();
  let finish!: (value: { data: ArrayBuffer }) => void;
  first.network.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const pending = first.cached.getBytes(9, 3);
  await vi.waitFor(() => expect(first.network).toHaveBeenCalledTimes(1));
  const other = source();
  other.original.mustReload = true;
  await other.cached.getBytes(0, 3);
  finish({ data: new ArrayBuffer(3) });
  await pending;
  expect(entries.size).toBe(0);
});
it('honors aborts on both cache and network paths', async () => {
  const first = source();
  await first.cached.getBytes(0, 3);
  const aborted = AbortSignal.abort();
  await expect(first.cached.getBytes(0, 3, aborted)).rejects.toThrow();
  const controller = new AbortController();
  first.network.mockImplementationOnce(() => {
    controller.abort();
    return Promise.resolve({ data: new ArrayBuffer(3) });
  });
  await expect(first.cached.getBytes(3, 3, controller.signal)).rejects.toThrow();
  expect([...entries.keys()].some((key) => key.includes('3%3A3'))).toBe(false);
});
it.each(['absent', 'open', 'read', 'write'] as const)(
  'falls back when storage is %s',
  async (failure) => {
    if (failure === 'absent') vi.stubGlobal('caches', undefined);
    if (failure === 'open')
      vi.stubGlobal('caches', {
        open: () => Promise.reject(new Error('denied')),
      });
    if (failure === 'read') cache.match.mockRejectedValue(new Error('denied'));
    if (failure === 'write') cache.put.mockRejectedValue(new Error('quota'));
    const first = source();
    expect((await first.cached.getBytes(0, 3)).data.byteLength).toBe(3);
    expect(first.network).toHaveBeenCalledTimes(1);
  },
);
it('retains only two recently used archive versions without touching other archives', async () => {
  const unrelated = new RangeCacheSource(
    new FetchSource('https://fixture.test/tiles/another.pmtiles?v=1234abcd'),
  );
  vi.spyOn(FetchSource.prototype, 'getBytes').mockResolvedValue({ data: new ArrayBuffer(3) });
  await unrelated.getBytes(0, 3);
  for (const version of ['00000001', '00000002', '00000003'])
    await source(version).cached.getBytes(0, 3);
  const archives = new Set(
    [...entries.keys()].map((key) => new URL(key).searchParams.get('archive')),
  );
  expect(archives.size).toBe(3);
  expect([...archives].some((url) => url?.endsWith('v=00000001'))).toBe(false);
});
it('selects owned caching only for valid pins and retains the Windows workaround', () => {
  vi.stubGlobal('navigator', { userAgent: 'Windows Chrome' });
  expect(archiveSource('https://fixture.test/map.pmtiles')).toBeInstanceOf(FetchSource);
  expect(archiveSource('https://fixture.test/map.pmtiles?v=broken')).toBeInstanceOf(FetchSource);
  expect(archiveSource('https://fixture.test/map.pmtiles?v=1234abcd')).toBeInstanceOf(
    RangeCacheSource,
  );
  expect(new FetchSource('https://fixture.test/map.pmtiles?v=1234abcd').chromeWindowsNoCache).toBe(
    true,
  );
});
