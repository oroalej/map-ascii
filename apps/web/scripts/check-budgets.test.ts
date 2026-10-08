// @vitest-environment node
import { randomBytes } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { AUTOMATIC_JSON } from '../lib/automatic-json';
import { STARTUP_JSON_BUDGET, startupJsonSize } from './startup-json-budget';

it('counts an eager payload against the cap and excludes resources gated by readiness', () => {
  const read = vi.fn(() => randomBytes(20 * 1024));
  expect(startupJsonSize(read)).toBe(0);
  expect(read).not.toHaveBeenCalled();
  const size = startupJsonSize(read, { ...AUTOMATIC_JSON, subdivisions: 'startup' });
  expect(read).toHaveBeenCalledExactlyOnceWith('subdivisions');
  expect(size < STARTUP_JSON_BUDGET).toBe(false);
});
