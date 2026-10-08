import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

/** Eager references; a nested Turbopack import factory owns a separately deferred graph. */
export function chunkReferences(source: string): string[] {
  // Worker URLs and their startup chunk arrays occur in the parent chunk. They do not
  // become canvas dependencies unless another ordinary reference also names them.
  const mainSource = source
    .replace(/["'](?:static\/)?chunks\/turbopack-worker-[\w.-]+\.js["']\s*,\s*\[[^\]]*\]/g, '')
    // e.v(load => Promise.all([...].map(chunk => e.l(chunk)))) declares an async
    // import factory; its chunks are requested only when that import is invoked.
    // The canvas's own factory is counted in full by canvasEntries before this walk.
    .replace(/\b[\w$]+\.v\(\s*[\w$]+\s*=>\s*Promise\.all\(\[[^\]]*\]/g, '');
  return [
    ...new Set(
      [...mainSource.matchAll(/(?:static\/)?chunks\/[\w.-]+\.js/g)].map(
        (m) => `/_next/static/${m[0].replace(/^static\//, '')}`,
      ),
    ),
  ];
}

/** Turbopack puts all chunks for an import in its parent's Promise.all loader. */
export function canvasEntries(
  out: string,
  initial: ReadonlySet<string>,
  renderer: string,
): string[] {
  const entries = new Set<string>();
  for (const path of initial) {
    const source = readFileSync(join(out, path), 'utf8');
    for (const group of source.matchAll(/Promise\.all\(\[([^\]]*)\]/g)) {
      const references = chunkReferences(group[1]!);
      if (references.includes(renderer)) for (const entry of references) entries.add(entry);
    }
  }
  if (!entries.size) throw new Error('Could not find the canvas import loader in initial JS');
  return [...entries];
}

/** Walk normal canvas startup; workers and nested lazy imports own separate graphs. */
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
