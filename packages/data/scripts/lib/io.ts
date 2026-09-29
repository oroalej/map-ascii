import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import type { Feature } from 'geojson';

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

export async function writeJson(path: string, value: unknown, pretty = false): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, pretty ? 2 : undefined) + '\n');
}

/** Read a GeoJSONSeq file (one feature per line). */
export async function* readFeatures(path: string): AsyncGenerator<Feature> {
  const lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim()) yield JSON.parse(line) as Feature;
  }
}

/** Write features as GeoJSONSeq (one per line), the format tippecanoe reads in parallel. */
export async function writeFeatures(path: string, features: Iterable<Feature>): Promise<number> {
  await mkdir(dirname(path), { recursive: true });
  const lines: string[] = [];
  for (const feature of features) lines.push(JSON.stringify(feature));
  await writeFile(path, lines.join('\n') + '\n');
  return lines.length;
}
