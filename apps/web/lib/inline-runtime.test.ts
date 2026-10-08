// @vitest-environment node
import { loadCityPacks } from '@atlas/content';
import { runtimeCityLife, runtimeDialogueCatalog } from '@atlas/shared';
import { expect, it } from 'vitest';
import { decodeInlineRuntime, type InlineRuntime } from './inline-runtime';
import { encodeInlineRuntime } from './inline-runtime-server';

// Declare the real pack inputs so content edits select this transport regression test.
const packInputs = import.meta.glob('../../../packages/content/cities/*/{city,dialogue}.json');

it('round-trips every real runtime pack without losing sources, calendars or Unicode speech', async () => {
  expect(Object.keys(packInputs).length).toBeGreaterThan(0);
  const { packs, errors } = await loadCityPacks();
  expect(errors).toEqual([]);
  expect(packs.some((pack) => pack.city.life && pack.dialogue)).toBe(true);
  for (const pack of packs) {
    const runtime: InlineRuntime = {};
    if (pack.city.life) runtime.cityLife = runtimeCityLife(pack.city.life);
    if (pack.dialogue) runtime.dialogue = runtimeDialogueCatalog(pack.dialogue)!;
    const encoded = encodeInlineRuntime(runtime);
    const decoded = decodeInlineRuntime(encoded);
    expect(decoded).toStrictEqual(runtime);
    expect(decoded.cityLife?.source).toEqual(runtime.cityLife?.source);
    expect(decoded.cityLife?.folklore?.sources).toEqual(runtime.cityLife?.folklore?.sources);
    expect(encoded).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(encoded.length).toBeLessThan(JSON.stringify(runtime).length);
  }
});

it('supports absent optional runtime data and rejects a damaged inline payload', () => {
  expect(decodeInlineRuntime(encodeInlineRuntime({}))).toStrictEqual({});
  expect(() => decodeInlineRuntime(btoa('invalid gzip'))).toThrow();
});
