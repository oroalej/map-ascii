/**
 * Print the path of the newest installed `codex` or `claude` native executable:
 *   tsx scripts/latest-cli.ts <codex|claude>
 * Several copies can be installed (npm global, the Codex app, the native Claude installer), and
 * PATH order decides which one a bare `codex` runs. Agent skills call this instead, so an old
 * copy never runs a model it doesn't support. stdout: the path. stderr: `<tool> <version> <path>`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export type Tool = 'codex' | 'claude';

export interface Version {
  core: [number, number, number];
  pre: string[];
}

export interface Probe {
  path: string;
  version: Version;
  raw: string;
}

const win = process.platform === 'win32';
const exe = (name: string) => (win ? `${name}.exe` : name);

export function parseVersion(output: string): Version | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(output);
  if (!match) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split('.') : [],
  };
}

/** Semver precedence: core first, then a prerelease ranks below its release. */
export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i]! - b.core[i]!;
  if (!a.pre.length || !b.pre.length) return b.pre.length - a.pre.length;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) - Number(y);
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** The highest version; ties go to the earlier probe (candidate order). */
export function pickLatest(probes: Probe[]): Probe | undefined {
  return probes.reduce<Probe | undefined>(
    (best, probe) => (!best || compareVersions(probe.version, best.version) > 0 ? probe : best),
    undefined,
  );
}

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

/**
 * Native binaries vendored by an npm `@openai/codex` install under `nodeModules`
 * (`@openai/codex/node_modules/@openai/codex-<platform>/vendor/<triple>/bin/codex`).
 * npm's `.codex-*` folders are interrupted-install leftovers and are skipped.
 */
export function codexVendorBinaries(nodeModules: string): string[] {
  const scope = path.join(nodeModules, '@openai', 'codex', 'node_modules', '@openai');
  return subdirs(scope)
    .filter((dir) => path.basename(dir).startsWith('codex-'))
    .flatMap((dir) => subdirs(path.join(dir, 'vendor')))
    .map((triple) => path.join(triple, 'bin', exe('codex')))
    .filter((file) => existsSync(file));
}

function lines(command: string, args: string[] = []): string[] {
  // npm is a .cmd shim on Windows, which only runs through a shell.
  const result = spawnSync(command, args, { encoding: 'utf8', shell: args.length === 0 });
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function candidates(tool: Tool): string[] {
  const found: string[] = [];
  for (const hit of lines(win ? 'where.exe' : 'which', win ? [tool] : ['-a', tool])) {
    if (!win || hit.toLowerCase().endsWith('.exe')) found.push(hit);
    // An npm shim (codex, codex.cmd, codex.ps1) sits next to the node_modules it launches.
    if (tool === 'codex')
      found.push(...codexVendorBinaries(path.join(path.dirname(hit), 'node_modules')));
  }
  const npmRoot = lines('npm root -g')[0];
  if (tool === 'codex') {
    if (npmRoot) found.push(...codexVendorBinaries(npmRoot));
    const local = process.env.LOCALAPPDATA;
    if (local) {
      const app = path.join(local, 'OpenAI', 'Codex', 'bin');
      found.push(path.join(app, exe('codex')));
      found.push(...subdirs(app).map((dir) => path.join(dir, exe('codex'))));
      found.push(path.join(local, 'Programs', 'OpenAI', 'Codex', 'bin', exe('codex')));
    }
  } else {
    found.push(path.join(homedir(), '.local', 'bin', exe('claude')));
  }
  const seen = new Set<string>();
  return found.filter((file) => {
    if (!existsSync(file) || !statSync(file).isFile()) return false;
    const real = realpathSync(file).toLowerCase();
    if (seen.has(real)) return false;
    seen.add(real);
    return true;
  });
}

function probe(file: string): Probe | undefined {
  const result = spawnSync(file, ['--version'], { encoding: 'utf8', timeout: 15_000 });
  const raw = (result.stdout ?? '').trim();
  const version = result.status === 0 ? parseVersion(raw) : undefined;
  return version ? { path: file, version, raw } : undefined;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const tool = process.argv.slice(2).find((arg) => arg !== '--');
  if (tool !== 'codex' && tool !== 'claude') {
    console.error('usage: tsx scripts/latest-cli.ts <codex|claude>');
    process.exit(2);
  }
  const latest = pickLatest(candidates(tool).flatMap((file) => probe(file) ?? []));
  if (!latest) {
    console.error(`no installed ${tool} answered --version`);
    process.exit(1);
  }
  console.error(`${tool} ${latest.raw} ${latest.path}`);
  console.log(latest.path);
}
