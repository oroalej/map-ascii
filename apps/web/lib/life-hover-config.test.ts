// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { parseLifeHoverPause } from './life-hover-config';

afterEach(() => vi.unstubAllEnvs());

it.each([undefined, '', 'item', 'all'])('accepts rollback setting %s', (value) => {
  expect(parseLifeHoverPause(value)).toBe(value === 'all' ? 'all' : 'item');
});

it.each(['ALL', ' ', 'aitem'])('rejects invalid nonempty rollback setting %s', (value) => {
  expect(() => parseLifeHoverPause(value)).toThrow('NEXT_PUBLIC_LIFE_HOVER_PAUSE');
});

it('rejects an invalid setting while loading the build configuration', async () => {
  vi.stubEnv('NEXT_PUBLIC_LIFE_HOVER_PAUSE', 'ALL');
  vi.resetModules();
  await expect(import('../next.config')).rejects.toThrow('NEXT_PUBLIC_LIFE_HOVER_PAUSE');
});
