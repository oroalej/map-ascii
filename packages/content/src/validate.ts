import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Event, Landmark, NameHistory, Tour } from '@naga/shared';
import type { z } from 'zod';

/** Absolute path of `packages/content`. */
export const contentRoot = fileURLToPath(new URL('..', import.meta.url));

const collections = {
  landmarks: Landmark,
  events: Event,
  'name-history': NameHistory,
  tours: Tour,
} as const;

type Collections = typeof collections;

export type ContentBundle = { [K in keyof Collections]: z.infer<Collections[K]>[] };

export type ContentError = { file: string; message: string };

async function listJson(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true, recursive: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.json'))
      .map((e) => join(e.parentPath, e.name))
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Load and validate every content collection under `root`. Returns all records plus every
 * validation error, so callers can report everything at once and then fail.
 */
export async function loadContent(
  root: string = contentRoot,
): Promise<{ content: ContentBundle; errors: ContentError[] }> {
  const content: ContentBundle = { landmarks: [], events: [], 'name-history': [], tours: [] };
  const errors: ContentError[] = [];
  const seenIds = new Map<string, string>();

  for (const [name, schema] of Object.entries(collections) as [keyof Collections, z.ZodType][]) {
    for (const path of await listJson(join(root, name))) {
      const file = relative(root, path).split(sep).join('/');
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(path, 'utf8'));
      } catch (err) {
        errors.push({ file, message: `invalid JSON: ${(err as Error).message}` });
        continue;
      }
      const result = schema.safeParse(raw);
      if (!result.success) {
        for (const issue of result.error.issues) {
          errors.push({ file, message: `${issue.path.join('.') || '(root)'}: ${issue.message}` });
        }
        continue;
      }
      const record = result.data as { id?: string; osm_id?: string };
      const key = record.id ?? `${name}:${record.osm_id}`;
      const previous = seenIds.get(key);
      if (previous) {
        errors.push({ file, message: `duplicate id "${key}" (also in ${previous})` });
        continue;
      }
      seenIds.set(key, file);
      (content[name] as unknown[]).push(result.data);
    }
  }

  return { content, errors };
}
