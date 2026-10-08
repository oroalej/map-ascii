import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Walk nested worker/chunk directories too; Zod belongs only in server and pipeline code. */
export function assertZodFreeChunks(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) assertZodFreeChunks(path);
    else if (entry.name.endsWith('.js') && readFileSync(path, 'utf8').includes('ZodError'))
      throw new Error(`Zod runtime found in browser chunk: ${path}`);
  }
}
