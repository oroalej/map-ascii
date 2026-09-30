import { access, readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { City, contentSchemas, TilesLock } from '@atlas/shared';
import type { z } from 'zod';

/**
 * Absolute path of `packages/content`. City packs live in its `cities/` folder. (Not
 * `new URL('..', import.meta.url)`: bundlers such as Turbopack treat that as an asset import.)
 */
export const contentRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

type Schemas = ReturnType<typeof contentSchemas>;

const collections = {
  landmarks: 'Landmark',
  events: 'Event',
  'name-history': 'NameHistory',
  tours: 'Tour',
  art: 'LandmarkArt',
  plans: 'LandmarkPlan',
  landcover: 'Landcover',
  details: 'SiteDetail',
  processions: 'Procession',
} as const satisfies Record<string, keyof Schemas>;

type Collections = typeof collections;

export type ContentBundle = { [K in keyof Collections]: z.infer<Schemas[Collections[K]]>[] };

/**
 * A registered city: its validated config and content, and where its published tiles are
 * (`tiles.lock.json`, written by `pnpm data:publish`), if they have been published.
 */
export type CityPack = { city: City; content: ContentBundle; tilesLock?: TilesLock };

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

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/** Parse and validate one JSON file, recording every problem in `errors`. */
async function readValid<T>(
  path: string,
  schema: z.ZodType<T>,
  file: string,
  errors: ContentError[],
): Promise<T | undefined> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    errors.push({ file, message: missing ? 'missing' : `invalid JSON: ${(err as Error).message}` });
    return undefined;
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    for (const issue of result.error.issues) {
      errors.push({ file, message: `${issue.path.join('.') || '(root)'}: ${issue.message}` });
    }
    return undefined;
  }
  return result.data;
}

/**
 * Load and validate every city pack under `<root>/cities/` (or only `only`, a city slug).
 * A pack is its `city.json` plus content collections, whose localized fields may use only the
 * city's declared languages. Returns the valid packs plus every validation error, so callers
 * can report everything at once and then fail.
 */
export async function loadCityPacks(
  root: string = contentRoot,
  { only }: { only?: string } = {},
): Promise<{ packs: CityPack[]; errors: ContentError[] }> {
  const packs: CityPack[] = [];
  const errors: ContentError[] = [];
  const toFile = (path: string) => relative(root, path).split(sep).join('/');
  const citiesDir = join(root, 'cities');

  const slugs = (await listDirs(citiesDir)).filter((slug) => only === undefined || slug === only);
  if (only !== undefined && slugs.length === 0) {
    errors.push({ file: `cities/${only}`, message: 'no such city pack' });
  }

  for (const slug of slugs) {
    const dir = join(citiesDir, slug);
    const configFile = toFile(join(dir, 'city.json'));
    const city = await readValid(join(dir, 'city.json'), City, configFile, errors);
    if (!city) continue;
    if (city.slug !== slug) {
      errors.push({
        file: configFile,
        message: `slug "${city.slug}" must match its folder "${slug}"`,
      });
      continue;
    }

    const schemas = contentSchemas(city.languages);
    const content: ContentBundle = {
      landmarks: [],
      events: [],
      'name-history': [],
      tours: [],
      art: [],
      plans: [],
      landcover: [],
      details: [],
      processions: [],
    };
    const seenIds = new Map<string, string>();
    const before = errors.length;

    for (const [name, schemaName] of Object.entries(collections) as [
      keyof Collections,
      Collections[keyof Collections],
    ][]) {
      for (const path of await listJson(join(dir, name))) {
        const file = toFile(path);
        const record = await readValid(path, schemas[schemaName] as z.ZodType, file, errors);
        if (record === undefined) continue;
        const { id, osm_id } = record as { id?: string; osm_id?: string };
        const key = id ?? `${name}:${osm_id}`;
        const previous = seenIds.get(key);
        if (previous) {
          errors.push({ file, message: `duplicate id "${key}" (also in ${previous})` });
          continue;
        }
        seenIds.set(key, file);
        (content[name] as unknown[]).push(record);
      }
    }

    const lockPath = join(dir, 'tiles.lock.json');
    const tilesLock = (await exists(lockPath))
      ? await readValid(lockPath, TilesLock, toFile(lockPath), errors)
      : undefined;

    if (errors.length === before) packs.push({ city, content, ...(tilesLock && { tilesLock }) });
  }

  return { packs, errors };
}
