import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { assertZodFreeChunks } from './browser-chunks';

it('rejects Zod in nested browser chunks and names the offending file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-chunks-'));
  try {
    mkdirSync(join(directory, 'workers'));
    writeFileSync(join(directory, 'renderer.js'), 'webglcontextlost');
    writeFileSync(join(directory, 'renderer.js.map'), 'ZodError');
    expect(() => assertZodFreeChunks(directory)).not.toThrow();
    const path = join(directory, 'workers', 'tile.js');
    writeFileSync(path, 'class $ZodError {}');
    expect(() => assertZodFreeChunks(directory)).toThrow(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
