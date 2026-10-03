/**
 * Create a task worktree ready to work in (AGENTS.md "Git"):
 *   pnpm worktree:new <short> <topic>
 * adds ../naga-ascii-<short> on a new branch codex/<topic> from the latest origin/main, installs
 * dependencies and fetches the pinned tiles.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

const [short, topic] = process.argv.slice(2).filter((arg) => arg !== '--');
const slug = /^[a-z0-9][a-z0-9-]*$/;
if (!short || !topic || !slug.test(short) || !slug.test(topic)) {
  console.error('usage: pnpm worktree:new <short> <topic>  (lowercase letters, digits and dashes)');
  process.exit(2);
}

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
// The main checkout is the common directory's parent, whichever worktree this runs from.
const common = resolve(git('rev-parse', '--git-common-dir'));
const main = dirname(common);
const path = resolve(dirname(main), `${basename(main)}-${short}`);
const branch = `codex/${topic}`;

if (existsSync(path)) {
  console.error(`${path} already exists. A follow-up continues in its task's existing worktree.`);
  process.exit(1);
}
if (spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0) {
  console.error(`Branch ${branch} already exists; continue in its worktree (git worktree list).`);
  process.exit(1);
}

const run = (command: string, args: string[], cwd: string) => {
  console.log(`> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`${command} ${args.join(' ')} failed in ${cwd}`);
    process.exit(result.status ?? 1);
  }
};
// pnpm's own entry script, run with this Node: its Windows .cmd shim would need a shell.
const pnpm = (args: string[], cwd: string) => {
  const entry = process.env.npm_execpath;
  if (!entry) throw new Error('Run this through pnpm: pnpm worktree:new <short> <topic>');
  run(process.execPath, [entry, ...args], cwd);
};

run('git', ['fetch', 'origin', 'main'], main);
// From origin/main, not the main checkout's local main, which may be behind. --no-track: the
// branch gets its own upstream on first push instead of tracking main.
run('git', ['worktree', 'add', path, '-b', branch, '--no-track', 'origin/main'], main);
pnpm(['install', '--frozen-lockfile', '--prefer-offline'], path);
pnpm(['data:fetch'], path);
console.log(`\nReady: ${path} on ${branch}`);
