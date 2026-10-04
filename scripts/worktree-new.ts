/**
 * Create a task worktree ready to work in (AGENTS.md "Git"):
 *   pnpm worktree:new <short> <topic>
 * adds worktrees/<short> (gitignored, inside the main checkout) on a new branch
 * codex/<topic> from the latest origin/main, installs dependencies and fetches the pinned tiles.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { mainCheckout } from './git';

const [short, topic] = process.argv.slice(2).filter((arg) => arg !== '--');
const slug = /^[a-z0-9][a-z0-9-]*$/;
if (!short || !topic || !slug.test(short) || !slug.test(topic)) {
  console.error('usage: pnpm worktree:new <short> <topic>  (lowercase letters, digits and dashes)');
  process.exit(2);
}

const main = mainCheckout(process.cwd());
const path = resolve(main, 'worktrees', short);
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
