import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const checkout = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * The port e2e serves this checkout's export on: `E2E_PORT` when set, 3100 in CI, and locally a
 * port derived from the checkout path, so concurrent worktrees never collide or reuse each
 * other's server.
 */
export function e2ePort(
  env: Record<string, string | undefined> = process.env,
  root: string = checkout,
): number {
  if (env.E2E_PORT) return Number(env.E2E_PORT);
  if (env.CI) return 3100;
  const digest = createHash('sha256').update(root.toLowerCase().replaceAll('\\', '/')).digest();
  return 3200 + (digest.readUInt32BE(0) % 700);
}
