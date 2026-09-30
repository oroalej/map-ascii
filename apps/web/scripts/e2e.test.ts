// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { runE2E } from './e2e';

describe('E2E preparation', () => {
  it('prepares before launching Playwright, independently of server reuse, and forwards filters', async () => {
    const events: string[] = [];
    const args = ['--project=chromium', '-g', 'draws the city', '--last-failed'];
    const prepare = vi.fn(() => {
      events.push('prepare');
      return Promise.resolve();
    });
    const run = vi.fn((_args: readonly string[]) => {
      events.push('playwright');
      return Promise.resolve(4);
    });
    expect(await runE2E(args, prepare, run)).toBe(4);
    expect(events).toEqual(['prepare', 'playwright']);
    expect(run).toHaveBeenCalledWith(args);
  });

  it.each(['--list', '--help', '-h'])('does not build for %s', async (arg) => {
    const prepare = vi.fn(async () => {});
    const run = vi.fn((_args: readonly string[]) => Promise.resolve(0));
    expect(await runE2E([arg], prepare, run)).toBe(0);
    expect(prepare).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith([arg]);
  });

  it('drops the -- separator pnpm forwards', async () => {
    const run = vi.fn((_args: readonly string[]) => Promise.resolve(0));
    await runE2E(['--', '--project=chromium'], async () => {}, run);
    expect(run).toHaveBeenCalledWith(['--project=chromium']);
  });

  it('does not launch browser tests when export preparation fails', async () => {
    const run = vi.fn((_args: readonly string[]) => Promise.resolve(0));
    await expect(runE2E([], () => Promise.reject(new Error('failed build')), run)).rejects.toThrow(
      'failed build',
    );
    expect(run).not.toHaveBeenCalled();
  });
});
