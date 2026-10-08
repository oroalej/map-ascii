// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { readCityMeta } from './city-meta';

const readFile = vi.fn<(path: string, encoding: 'utf8') => Promise<string>>();
beforeEach(() => {
  readFile.mockReset();
});
const meta = {
  slug: 'fixture',
  name: { en: 'Fixture' },
  subdivisionLabel: { en: 'district' },
  languages: ['en'],
  bounds: [0, 0, 1, 1],
  regionBounds: [0, 0, 1, 1],
  defaultCamera: { lat: 0, lng: 0, zoom: 15 },
  yearRange: [1900, 2026],
  attribution: [],
};
it('reads valid inline metadata', async () => {
  readFile.mockResolvedValue(JSON.stringify(meta));
  await expect(readCityMeta('fixture', readFile)).resolves.toEqual({ status: 'ready', meta });
});
it('only treats ENOENT as missing', async () => {
  readFile.mockRejectedValue({ code: 'ENOENT' });
  await expect(readCityMeta('fixture', readFile)).resolves.toEqual({ status: 'missing' });
  readFile.mockRejectedValue(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
  await expect(readCityMeta('fixture', readFile)).rejects.toThrow('permission denied');
});
it.each(['{', '{}', JSON.stringify({ ...meta, slug: 'other' })])(
  'rejects invalid metadata %s',
  async (source) => {
    readFile.mockResolvedValue(source);
    await expect(readCityMeta('fixture', readFile)).rejects.toThrow();
  },
);
