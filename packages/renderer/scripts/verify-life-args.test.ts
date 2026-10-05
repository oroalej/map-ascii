import { afterAll, beforeAll, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { resolveBaselineRevision } from './verify-life-args';

const run = promisify(execFile);
let root: string;
let commits: string[];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'verify-life-args-'));
  const git = (...args: string[]) => run('git', args, { cwd: root });
  await git('init');
  await git('symbolic-ref', 'HEAD', 'refs/heads/main');
  commits = [];
  for (let i = 0; i < 3; i++) {
    await git(
      '-c',
      'user.name=Verifier fixture',
      '-c',
      'user.email=verifier@example.invalid',
      '-c',
      'commit.gpgSign=false',
      'commit',
      '--allow-empty',
      '-m',
      `fixture ${i}`,
    );
    commits.push((await git('rev-parse', 'HEAD')).stdout.trim());
  }
  await git('update-ref', 'refs/remotes/origin/main', commits[2]!);
});

afterAll(async () => {
  if (root && dirname(root) === tmpdir() && basename(root).startsWith('verify-life-args-'))
    await rm(root, { recursive: true, force: true });
});

it.each([
  ['HEAD~1', 1],
  ['main^', 1],
  ['origin/main~2', 0],
] as const)('resolves the ancestor expression %s to a pinned commit', async (revision, index) => {
  expect(await resolveBaselineRevision(root, revision)).toBe(commits[index]);
});

it.each(['unknown-revision', '--help'])('names the rejected revision %s', async (revision) => {
  await expect(resolveBaselineRevision(root, revision)).rejects.toThrow(`"${revision}"`);
});

it('reports a missing baseline separately', async () => {
  await expect(resolveBaselineRevision(root, '')).rejects.toThrow('Provide --baseline=<revision>');
});
