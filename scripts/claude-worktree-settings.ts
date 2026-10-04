import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mainCheckout } from './git';

export const claudeSettingsPath = '.claude/settings.local.json';

export function mainInstructionExcludes(main: string): string[] {
  return ['CLAUDE.md', 'AGENTS.md'].map((name) => resolve(main, name).replaceAll('\\', '/'));
}

function settingsDirectory(worktree: string): string {
  const directory = join(worktree, '.claude');
  if (existsSync(directory)) {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Refusing linked or non-directory Claude settings folder ${directory}`);
    }
  }
  return directory;
}

function readSettings(path: string): Record<string, unknown> {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`Refusing linked or non-file Claude settings ${path}`);
  }
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected a Claude settings object in ${path}`);
  }
  return value as Record<string, unknown>;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/** Suppress the parent checkout's instructions without replacing personal settings. */
export function initializeClaudeWorktree(main: string, worktree: string): void {
  const rel = relative(resolve(main), resolve(worktree));
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('Claude worktree settings require a nested worktree');
  }
  const directory = settingsDirectory(worktree);
  const path = join(worktree, claudeSettingsPath);
  let settings: Record<string, unknown> = {};
  try {
    settings = readSettings(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const existing = settings.claudeMdExcludes === undefined ? [] : settings.claudeMdExcludes;
  if (!isStringArray(existing)) {
    throw new Error(`Expected claudeMdExcludes to be a string array in ${path}`);
  }
  const excludes = [
    ...existing,
    ...mainInstructionExcludes(main).filter((entry) => !existing.includes(entry)),
  ];
  if (excludes.length === existing.length) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(path, JSON.stringify({ ...settings, claudeMdExcludes: excludes }, null, 2) + '\n');
}

/** Only pristine generated setup is disposable; personal settings and links stay protected. */
export function isGeneratedClaudeSettings(main: string, worktree: string): boolean {
  try {
    settingsDirectory(worktree);
    const settings = readSettings(join(worktree, claudeSettingsPath));
    const excludes = settings.claudeMdExcludes;
    const expected = mainInstructionExcludes(main);
    return (
      Object.keys(settings).length === 1 &&
      Array.isArray(excludes) &&
      excludes.length === expected.length &&
      excludes.every((entry, index) => entry === expected[index])
    );
  } catch {
    return false;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    initializeClaudeWorktree(mainCheckout(process.cwd()), process.cwd());
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
