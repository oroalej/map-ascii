import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

/** Turbopack emits chunk paths both for static dependencies and async imports. */
export function chunkReferences(source: string): string[] {
  // Worker URLs and their startup chunk arrays occur in the parent chunk. They do not
  // become canvas dependencies unless another ordinary reference also names them.
  const mainSource = source.replace(
    /["'](?:static\/)?chunks\/turbopack-worker-[\w.-]+\.js["']\s*,\s*\[[^\]]*\]/g,
    '',
  );
  return [
    ...new Set(
      [...mainSource.matchAll(/(?:static\/)?chunks\/[\w.-]+\.js/g)].map(
        (m) => `/_next/static/${m[0].replace(/^static\//, '')}`,
      ),
    ),
  ];
}

/** Walk the canvas dependency set; worker bootstraps own a separate, excluded graph. */
export function canvasChunks(
  out: string,
  entries: readonly string[],
  initial: ReadonlySet<string>,
) {
  const visited = new Set<string>();
  const pending = [...entries];
  while (pending.length) {
    const path = pending.pop()!;
    if (visited.has(path) || initial.has(path) || path.includes('turbopack-worker-')) continue;
    visited.add(path);
    pending.push(...chunkReferences(readFileSync(join(out, path), 'utf8')));
  }
  return visited;
}

export function gzippedChunks(out: string, paths: Iterable<string>): number {
  return [...paths].reduce((sum, path) => sum + gzipSync(readFileSync(join(out, path))).length, 0);
}
