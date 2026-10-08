import { gzipSync } from 'node:zlib';
import type { InlineRuntime } from './inline-runtime';

/** Build-time compression is lossless: retain all fields of the existing runtime objects. */
export function encodeInlineRuntime(runtime: InlineRuntime): string {
  return gzipSync(JSON.stringify(runtime), { level: 9 }).toString('base64');
}
