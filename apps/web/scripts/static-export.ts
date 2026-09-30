import { createHash, randomUUID } from 'node:crypto';
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { runNodeCli } from './run-node-cli';

type Snapshot = Record<string, string>;
type Manifest = { version: 1; inputs: Snapshot; outputs: Snapshot };

export type PrepareOptions = {
  root?: string;
  force?: boolean;
  env?: Record<string, string | undefined>;
  log?: (message: string) => void;
  fetchTiles?: () => Promise<void>;
  build?: () => Promise<void>;
};

const defaultRoot = fileURLToPath(new URL('../../../', import.meta.url));
const cacheName = 'atlas-export.json';
const hash = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const snapshot = (value: unknown): value is Snapshot =>
  record(value) &&
  Object.values(value).every((v) => typeof v === 'string' && /^[a-f\d]{64}$/.test(v));
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** Walk in a stable order; public files and generated tiles are included even when Git ignores them. */
async function files(
  directory: string,
  accept: (path: string, directory: boolean) => boolean = () => true,
  prefix = '',
): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if (isMissing(error)) return [];
    throw error;
  });
  const found: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix + entry.name;
    if (!accept(path, entry.isDirectory())) continue;
    if (entry.isDirectory()) {
      found.push(...(await files(join(directory, entry.name), accept, `${path}/`)));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      found.push(path);
    }
  }
  return found;
}

const excludedDirectories = new Set([
  'node_modules',
  '.next',
  'out',
  'e2e',
  '__tests__',
  '__fixtures__',
  'test-results',
  'playwright-report',
  'blob-report',
  'coverage',
  'docs',
]);
const buildScripts = new Set([
  'scripts/build.ts',
  'scripts/static-export.ts',
  'scripts/run-node-cli.ts',
]);

function runtimeInput(path: string, directory: boolean): boolean {
  const parts = path.split('/');
  if (parts.some((part) => excludedDirectories.has(part))) return false;
  if (path.startsWith('public/')) return !path.endsWith('.gitkeep') && !path.endsWith('.download');
  if (directory) return true;
  // Next builds use production env files, not development/test-only ones.
  if (
    /^\.env\./.test(path) &&
    !['.env.local', '.env.production', '.env.production.local'].includes(path)
  )
    return false;
  if (path.startsWith('scripts/')) return buildScripts.has(path);
  return !(
    /\.(?:test|spec)\.[^/]+$/.test(path) ||
    /\.(?:md|tsbuildinfo|log)$/.test(path) ||
    /(?:^|\/)(?:playwright|vitest|eslint|prettier)\.config\./.test(path) ||
    /(?:^|\/)(?:next-env\.d\.ts|\.gitkeep|\.prettierignore|\.prettierrc.*)$/.test(path)
  );
}

/** Test scripts and test-only dependencies do not change the exported site. */
function manifestInput(bytes: Buffer): string {
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (!record(value)) throw new Error('Invalid package.json');
  const ignored = new Set([
    '@playwright/test',
    'serve',
    'vitest',
    'jsdom',
    'prettier',
    'eslint',
    '@eslint/js',
    'eslint-config-next',
    'globals',
    'typescript-eslint',
  ]);
  const devDependencies = record(value.devDependencies)
    ? Object.fromEntries(
        Object.entries(value.devDependencies).filter(([name]) => !ignored.has(name)),
      )
    : {};
  const scripts = record(value.scripts)
    ? Object.fromEntries(
        Object.entries(value.scripts).filter(
          ([name]) => name === 'build' || name === 'build:force',
        ),
      )
    : {};
  return JSON.stringify({
    name: value.name,
    type: value.type,
    exports: value.exports,
    sideEffects: value.sideEffects,
    dependencies: value.dependencies,
    devDependencies,
    scripts,
    packageManager: value.packageManager,
    engines: value.engines,
    pnpm: value.pnpm,
    overrides: value.overrides,
  });
}

async function inputs(root: string, env: Record<string, string | undefined>): Promise<Snapshot> {
  const result: Snapshot = {};
  const environmentKeys = new Set(['NODE_ENV', 'TZ']);
  for (const name of Object.keys(env)) {
    if (
      name.startsWith('NEXT_PUBLIC_') ||
      name.startsWith('VERCEL_') ||
      name === 'NEXT_DEPLOYMENT_ID'
    ) {
      environmentKeys.add(name);
    }
  }
  const add = async (path: string) => {
    let bytes: Buffer;
    try {
      bytes = await readFile(join(root, path));
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    // Binary tiles and images only need hashing, not a UTF-8 decode or environment scan.
    const text =
      /\.(?:[cm]?[jt]sx?|json)$/.test(path) || path.split('/').at(-1)?.startsWith('.env')
        ? bytes.toString('utf8')
        : '';
    // Include environment values read directly by runtime code or Next config, without logging them.
    for (const match of text.matchAll(/process\.env(?:\.([\w]+)|\[['"]([\w]+)['"]\])/g)) {
      environmentKeys.add((match[1] ?? match[2])!);
    }
    if (path.split('/').at(-1)?.startsWith('.env')) {
      for (const match of text.matchAll(/\$\{?([A-Za-z_]\w*)\}?/g)) environmentKeys.add(match[1]!);
    }
    result[path] = hash(path.endsWith('package.json') ? manifestInput(bytes) : bytes);
  };
  for (const directory of [
    'apps/web',
    'packages/renderer/src',
    'packages/shared/src',
    'packages/content/src',
    'packages/content/cities',
    'patches',
  ]) {
    for (const path of await files(join(root, directory), runtimeInput))
      await add(`${directory}/${path}`);
  }
  for (const path of [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    '.npmrc',
    '.nvmrc',
    'tsconfig.base.json',
  ]) {
    await add(path);
  }
  for (const pkg of ['renderer', 'shared', 'content']) {
    await add(`packages/${pkg}/package.json`);
    await add(`packages/${pkg}/tsconfig.json`);
  }
  result['@toolchain'] = hash(JSON.stringify([process.version, process.platform, process.arch]));
  result['@environment'] = hash(
    JSON.stringify([...environmentKeys].sort().map((key) => [key, env[key] ?? null])),
  );
  return result;
}

async function outputs(web: string): Promise<Snapshot> {
  const out = join(web, 'out');
  const result: Snapshot = {};
  for (const path of await files(out)) result[path] = hash(await readFile(join(out, path)));
  return result;
}

const changes = (before: Snapshot, after: Snapshot) =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort()
    .filter((path) => before[path] !== after[path]);
const complete = (output: Snapshot) =>
  !!output['index.html'] &&
  Object.keys(output).some((path) => path.startsWith('_next/') && path.endsWith('.js'));

async function cached(path: string): Promise<Manifest | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (
      record(value) &&
      value.version === 1 &&
      snapshot(value.inputs) &&
      snapshot(value.outputs) &&
      complete(value.outputs)
    ) {
      return { version: 1, inputs: value.inputs, outputs: value.outputs };
    }
  } catch (error) {
    if (!isMissing(error) && !(error instanceof SyntaxError)) throw error;
  }
}

/** Only one waiter can reclaim an observed stale owner; never unlink a new owner's lock. */
function reclaim(path: string, observed: string): void {
  const guard = `${path}.reclaim`;
  let fd: number;
  try {
    fd = openSync(guard, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
    throw error;
  }
  // Keep this critical section synchronous: there are no awaits between verifying and unlinking.
  try {
    if (readFileSync(path, 'utf8') === observed) unlinkSync(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  } finally {
    closeSync(fd);
    unlinkSync(guard);
  }
}

/** A checkout-wide lock lives in Next's persistent cache, not in the export being replaced. */
async function lock(cache: string, log: (message: string) => void): Promise<() => Promise<void>> {
  await mkdir(cache, { recursive: true });
  const path = join(cache, 'atlas-export.lock');
  const owner = JSON.stringify({ pid: process.pid, token: randomUUID() });
  // A cold build plus a tile download can take minutes; dead owners are reclaimed by pid below.
  const deadline = Date.now() + 15 * 60_000;
  let announced = false;
  for (;;) {
    try {
      const fd = openSync(path, 'wx');
      try {
        writeFileSync(fd, owner);
      } finally {
        closeSync(fd);
      }
      return async () => {
        if ((await readFile(path, 'utf8').catch(() => '')) === owner)
          await rm(path, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    let observed = '';
    try {
      observed = await readFile(path, 'utf8');
      const value: unknown = JSON.parse(observed);
      if (
        record(value) &&
        typeof value.pid === 'number' &&
        Number.isInteger(value.pid) &&
        value.pid > 0
      ) {
        try {
          process.kill(value.pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
            reclaim(path, observed);
            continue;
          }
        }
      } else if (Date.now() - (await stat(path)).mtimeMs > 30_000) {
        reclaim(path, observed);
        continue;
      }
    } catch (error) {
      if (isMissing(error)) continue;
      if (!(error instanceof SyntaxError)) throw error;
      if (Date.now() - (await stat(path)).mtimeMs > 30_000) {
        reclaim(path, observed);
        continue;
      }
    }
    if (Date.now() > deadline) throw new Error('Timed out waiting for another export preparation.');
    if (!announced) {
      log('waiting for another export preparation');
      announced = true;
    }
    await delay(100);
  }
}

/** Return true only when a build ran. A successful unchanged export is reused across invocations. */
export async function prepareExport(options: PrepareOptions = {}): Promise<boolean> {
  const root = options.root ?? defaultRoot;
  const web = join(root, 'apps/web');
  const cache = join(web, '.next/cache');
  const path = join(cache, cacheName);
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env), NODE_ENV: 'production' };
  const log = options.log ?? ((message: string) => console.log(`[export] ${message}`));
  const run = async (module: string, args: string[]) => {
    if ((await runNodeCli(module, args, web, env)) !== 0)
      throw new Error(`${module} failed; export was not cached.`);
  };
  const release = await lock(cache, log);
  try {
    const before = await inputs(root, env);
    const saved = await cached(path);
    const affected = saved ? changes(saved.inputs, before) : [];
    if (
      !options.force &&
      saved &&
      affected.length === 0 &&
      changes(saved.outputs, await outputs(web)).length === 0
    ) {
      log('export unchanged; reusing');
      return false;
    }
    log(
      options.force
        ? 'rebuilding: forced'
        : !saved
          ? 'rebuilding: no successful cached export'
          : affected.length
            ? `rebuilding: ${affected.slice(0, 8).join(', ')}${affected.length > 8 ? ` (+${affected.length - 8} more)` : ''}`
            : 'rebuilding: export output missing or changed',
    );
    // Never reuse an old success stamp after a failed or interrupted rebuild.
    await rm(path, { force: true });
    await (
      options.fetchTiles ??
      (() => run('tsx/cli', [join(root, 'packages/data/scripts/fetch-tiles.ts')]))
    )();
    // Fetching missing published assets changes the inputs intentionally; fingerprint them afterward.
    const building = await inputs(root, env);
    await (options.build ?? (() => run('next/dist/bin/next', ['build'])))();
    const after = await inputs(root, env);
    const exported = await outputs(web);
    if (!complete(exported))
      throw new Error('Static export is incomplete; no cache entry was saved.');
    // Other sessions may edit the tree mid-build: keep the export, but let the next run rebuild.
    const changed = changes(building, after);
    if (changed.length) {
      log(`inputs changed during export (${changed.join(', ')}); not caching it`);
      return true;
    }
    const manifest: Manifest = { version: 1, inputs: after, outputs: exported };
    const temporary = `${path}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(manifest));
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
    return true;
  } finally {
    await release();
  }
}
