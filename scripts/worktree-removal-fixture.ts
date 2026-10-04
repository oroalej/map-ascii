import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect } from 'vitest';
import { removeWorktree } from './worktree-removal';

export const branch = 'codex/topic';
export const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );

export function worktreeRemovalFixture() {
  let root: string, repo: string, wt: string;
  let templateRoot: string, template: string;
  const branches = () => git(repo, 'branch', '--format=%(refname:short)').trim().split('\n');
  const markerPath = () => join(repo, '.git', 'atlas-worktree-removal', encodeURIComponent(branch));
  const mergedOptions = () => {
    git(repo, 'merge', '-q', '--ff-only', branch);
    return { repo, branch, mergedInto: 'main', cwd: repo };
  };
  function interruptRemoval(options: ReturnType<typeof mergedOptions>) {
    expect(() =>
      removeWorktree({
        ...options,
        remove: () => {
          rmSync(join(wt, 'tracked.txt'));
          throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
        },
      }),
    ).toThrow(/Partially deleted/);
  }
  function trackedFile() {
    writeFileSync(join(wt, 'tracked.txt'), 'original');
    git(wt, 'add', 'tracked.txt');
    git(wt, 'commit', '-q', '-m', 'tracked');
  }

  /** Build immutable base/work commits once; each test clones independent refs and metadata. */
  beforeAll(() => {
    templateRoot = mkdtempSync(join(tmpdir(), 'worktree-removal-template-'));
    template = join(templateRoot, 'repo');
    const templateWorktree = join(templateRoot, 'topic');
    git(templateRoot, 'init', '-q', template);
    git(template, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    writeFileSync(
      join(template, '.gitignore'),
      readFileSync(new URL('../.gitignore', import.meta.url)),
    );
    mkdirSync(join(template, 'apps/web/public/tiles'), { recursive: true });
    writeFileSync(join(template, 'apps/web/public/tiles/.gitkeep'), '');
    git(template, 'add', '.gitignore', 'apps/web/public/tiles/.gitkeep');
    git(template, 'commit', '-q', '--allow-empty', '-m', 'base');
    git(template, 'worktree', 'add', '-q', templateWorktree, '-b', branch);
    git(templateWorktree, 'commit', '-q', '--allow-empty', '-m', 'work');
  });
  afterAll(() => rmSync(templateRoot, { recursive: true, force: true, maxRetries: 3 }));
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'worktree-removal-'));
    repo = join(root, 'repo');
    wt = join(root, 'repo-topic');
    git(root, 'clone', '-q', '--local', template, repo);
    git(repo, 'worktree', 'add', '-q', wt, '-b', branch, '--no-track', `origin/${branch}`);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));

  return {
    get root() {
      return root;
    },
    get repo() {
      return repo;
    },
    get wt() {
      return wt;
    },
    branches,
    markerPath,
    mergedOptions,
    interruptRemoval,
    trackedFile,
  };
}
