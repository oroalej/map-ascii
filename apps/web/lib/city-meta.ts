import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CityMeta } from '@atlas/shared';
import { isCityMeta } from './guards';

export type MetaState =
  | { status: 'ready'; meta: CityMeta }
  | { status: 'missing' }
  | { status: 'invalid'; message: string };

/** Pinned tiles are fetched before export; only an absent file is a valid missing-data state. */
export async function readCityMeta(
  slug: string,
  read: (path: string, encoding: 'utf8') => Promise<string> = readFile,
): Promise<MetaState> {
  let source: string;
  try {
    source = await read(join(process.cwd(), 'public', 'tiles', `${slug}.meta.json`), 'utf8');
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
      return { status: 'missing' };
    throw error;
  }
  const meta: unknown = JSON.parse(source);
  if (!isCityMeta(meta) || meta.slug !== slug) throw new Error(`Invalid city meta for ${slug}`);
  return { status: 'ready', meta };
}
