/**
 * `pnpm data:fetch [-- --city <slug>] [--force]`: download each city's published tiles (its
 * `tiles.lock.json`) into `apps/web/public/tiles/`, if they aren't there. Runs before every web
 * build, so CI and deploys get the tiles without running the pipeline. See DATA.md §9.
 */
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { loadCityPacks } from '@atlas/content';
import { compareLocal, downloadFiles } from './lib/tiles-release';
import { paths } from './step';

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    city: { type: 'string' },
    force: { type: 'boolean', default: false },
  },
});

/** A GitHub token: `GITHUB_TOKEN` / `GH_TOKEN`, else the GitHub CLI's login, if any. */
function githubToken(): string | undefined {
  const env = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (env) return env;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch {
    return undefined;
  }
}

const { packs, errors } = await loadCityPacks(undefined, { only: values.city });
if (errors.length > 0) {
  for (const { file, message } of errors) console.error(`✗ ${file}: ${message}`);
  process.exit(1);
}

await mkdir(paths.webTiles, { recursive: true });
let failed = false;
for (const { city, tilesLock } of packs) {
  if (!tilesLock) {
    console.warn(`! ${city.slug}: no tiles.lock.json; run pnpm data:build, then pnpm data:publish`);
    continue;
  }
  const local = await compareLocal(tilesLock, paths.webTiles);
  const fetchNames = values.force ? [...local.missing, ...local.differ] : local.missing;
  if (!values.force && local.differ.length > 0) {
    console.warn(
      `! ${city.slug}: keeping local ${local.differ.join(', ')}, which differ from ` +
        `${tilesLock.tag} (rebuilt locally?). Use --force to replace them.`,
    );
  }
  if (fetchNames.length === 0) {
    console.log(`✓ ${city.slug}: tiles present (${tilesLock.tag})`);
    continue;
  }
  console.log(`▶ ${city.slug}: fetching ${fetchNames.join(', ')} from ${tilesLock.tag}`);
  try {
    await downloadFiles(tilesLock, fetchNames, paths.webTiles, { token: githubToken() });
    console.log(`✓ ${city.slug}: done`);
  } catch (err) {
    console.error(`✗ ${city.slug}: ${(err as Error).message}`);
    failed = true;
  }
}
if (failed) process.exit(1);
