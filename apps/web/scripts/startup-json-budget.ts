import { gzipSync } from 'node:zlib';
import { AUTOMATIC_JSON, type AutomaticJsonPolicy } from '../lib/automatic-json';

export const STARTUP_JSON_BUDGET = 16 * 1024;
export function startupJsonSize(
  read: (suffix: string) => Uint8Array,
  policy: AutomaticJsonPolicy = AUTOMATIC_JSON,
): number {
  return Object.entries(policy).reduce(
    (sum, [suffix, schedule]) => sum + (schedule === 'startup' ? gzipSync(read(suffix)).length : 0),
    0,
  );
}
