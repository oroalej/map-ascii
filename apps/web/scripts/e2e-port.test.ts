// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { e2ePort } from './e2e-port';

describe('e2ePort', () => {
  it('prefers E2E_PORT, then 3100 in CI', () => {
    expect(e2ePort({ E2E_PORT: '4321', CI: 'true' }, 'D:/a')).toBe(4321);
    expect(e2ePort({ CI: 'true' }, 'D:/a')).toBe(3100);
  });

  it('gives each checkout a stable local port in 3200-3899', () => {
    const a = e2ePort({}, 'D:\\Projects\\naga-ascii-trees\\');
    expect(a).toBe(e2ePort({}, 'd:/projects/naga-ascii-trees/'));
    expect(a).toBeGreaterThanOrEqual(3200);
    expect(a).toBeLessThan(3900);
    expect(e2ePort({}, 'D:/Projects/naga-ascii-lamps/')).not.toBe(a);
  });
});
