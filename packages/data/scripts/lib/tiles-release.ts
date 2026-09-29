/**
 * Published tiles (DATA.md §9): a city's generated files live in a GitHub release, and the city
 * pack's `tiles.lock.json` records the release and each file's sha256. `pnpm data:publish`
 * uploads them; `pnpm data:fetch` (run before every web build) downloads the missing ones.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TilesLock } from '@atlas/shared';

/** The files `pnpm data:build` writes for a city in `apps/web/public/tiles/`: `<slug>.*`. */
export async function generatedFiles(dir: string, slug: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  return names.filter((name) => name.startsWith(`${slug}.`) && !name.endsWith('.download')).sort();
}

export const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

/** A file's sha256, or null if it doesn't exist. */
async function fileSha256(path: string): Promise<string | null> {
  try {
    return sha256(await readFile(path));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** The release tag for a city's tiles published at `date` (UTC): `tiles-<slug>-YYYYMMDD-HHMM`. */
export function releaseTag(slug: string, date: Date): string {
  const stamp = date.toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', '-');
  return `tiles-${slug}-${stamp}`;
}

/** The lock for `files` in `dir`, published as `tag` in `repo`. */
export async function buildLock(
  repo: string,
  tag: string,
  dir: string,
  files: readonly string[],
): Promise<TilesLock> {
  const hashes: Record<string, string> = {};
  for (const name of files) hashes[name] = (await fileSha256(join(dir, name)))!;
  return { repo, tag, files: hashes };
}

/** How the local copy compares with the lock, file by file. */
export type LocalState = { missing: string[]; differ: string[]; match: string[] };

export async function compareLocal(lock: TilesLock, dir: string): Promise<LocalState> {
  const state: LocalState = { missing: [], differ: [], match: [] };
  for (const [name, expected] of Object.entries(lock.files)) {
    const actual = await fileSha256(join(dir, name));
    if (actual === null) state.missing.push(name);
    else if (actual === expected) state.match.push(name);
    else state.differ.push(name);
  }
  return state;
}

type Fetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<Response>;

/**
 * Where each release asset downloads from. With a token, through the GitHub API (required for
 * private repositories); without one, the public download URL.
 */
async function assetUrls(
  lock: TilesLock,
  fetchImpl: Fetch,
  token: string | undefined,
): Promise<{ url: (name: string) => string; headers: Record<string, string> }> {
  if (!token) {
    return {
      url: (name) => `https://github.com/${lock.repo}/releases/download/${lock.tag}/${name}`,
      headers: {},
    };
  }
  const auth = { Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' };
  const response = await fetchImpl(
    `https://api.github.com/repos/${lock.repo}/releases/tags/${lock.tag}`,
    { headers: { ...auth, Accept: 'application/vnd.github+json' } },
  );
  if (!response.ok) {
    throw new Error(`release ${lock.tag} in ${lock.repo}: HTTP ${response.status}`);
  }
  const release = (await response.json()) as { assets: { name: string; url: string }[] };
  const byName = new Map(release.assets.map((a) => [a.name, a.url]));
  return {
    url: (name) => {
      const url = byName.get(name);
      if (!url) throw new Error(`release ${lock.tag} has no asset ${name}`);
      return url;
    },
    headers: { ...auth, Accept: 'application/octet-stream' },
  };
}

/**
 * Download `names` from the lock's release into `dir`. Each file is checked against its sha256
 * before it replaces anything, so a bad download never leaves a corrupt file behind.
 */
export async function downloadFiles(
  lock: TilesLock,
  names: readonly string[],
  dir: string,
  { fetch: fetchImpl = fetch, token }: { fetch?: Fetch; token?: string } = {},
): Promise<void> {
  if (names.length === 0) return;
  const { url, headers } = await assetUrls(lock, fetchImpl, token);
  for (const name of names) {
    const response = await fetchImpl(url(name), { headers });
    if (!response.ok) {
      const hint =
        response.status === 404 && !token ? ' (private repository? set GITHUB_TOKEN)' : '';
      throw new Error(`${name}: HTTP ${response.status}${hint}`);
    }
    const data = new Uint8Array(await response.arrayBuffer());
    const actual = sha256(data);
    if (actual !== lock.files[name]) {
      throw new Error(`${name}: sha256 ${actual} does not match the lock (${lock.files[name]})`);
    }
    const path = join(dir, name);
    await writeFile(`${path}.download`, data);
    await rename(`${path}.download`, path);
  }
}
