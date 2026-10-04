import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listWorktrees, removeWorktree } from './worktree-removal';
import { branch, git, worktreeRemovalFixture } from './worktree-removal-fixture';
import {
  claudeSettingsPath,
  initializeClaudeWorktree,
  mainInstructionExcludes,
} from './claude-worktree-settings';

describe('nested worktree removal', () => {
  const fixture = worktreeRemovalFixture('nested');

  it('preserves the main checkout through dry-run and real removal', () => {
    const { repo, wt } = fixture;
    const options = fixture.mergedOptions();
    const mainHead = git(repo, 'rev-parse', 'HEAD');
    const mainIgnore = readFileSync(join(repo, '.gitignore'), 'utf8');
    const registration = git(wt, 'rev-parse', '--absolute-git-dir').trim();
    initializeClaudeWorktree(repo, wt);
    const settings = readFileSync(join(wt, claudeSettingsPath), 'utf8');
    expect(wt).toBe(join(repo, 'worktrees', 'topic'));
    expect(git(repo, 'status', '--porcelain')).toBe('');

    expect(removeWorktree({ ...options, dryRun: true })).toMatchObject({
      removedWorktree: true,
      deletedBranch: true,
      resumed: false,
    });
    expect(existsSync(wt)).toBe(true);
    expect(existsSync(registration)).toBe(true);
    expect(listWorktrees(repo).some((entry) => entry.path === wt)).toBe(true);
    expect(fixture.branches()).toContain(branch);
    expect(readFileSync(join(wt, claudeSettingsPath), 'utf8')).toBe(settings);
    expect(git(repo, 'status', '--porcelain')).toBe('');

    expect(removeWorktree(options)).toMatchObject({
      removedWorktree: true,
      deletedBranch: true,
      resumed: false,
    });
    expect(existsSync(wt)).toBe(false);
    expect(existsSync(registration)).toBe(false);
    expect(listWorktrees(repo)).toEqual([{ path: repo, branch: 'main' }]);
    expect(fixture.branches()).toEqual(['main']);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(mainHead);
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe(mainIgnore);
  });

  it.each([
    { claudeMdExcludes: [], permissions: { allow: ['Read'] } },
    { claudeMdExcludes: ['**/personal/CLAUDE.md'] },
  ])('protects customized Claude settings through dry-run and removal: %j', (settings) => {
    const { repo, wt } = fixture;
    const options = fixture.mergedOptions();
    initializeClaudeWorktree(repo, wt);
    const content = JSON.stringify({
      ...settings,
      claudeMdExcludes: [...settings.claudeMdExcludes, ...mainInstructionExcludes(repo)],
    });
    writeFileSync(join(wt, claudeSettingsPath), content);
    for (const dryRun of [true, false]) {
      expect(() => removeWorktree({ ...options, dryRun })).toThrow(/protected ignored files/);
      expect(readFileSync(join(wt, claudeSettingsPath), 'utf8')).toBe(content);
      expect(fixture.branches()).toContain(branch);
      expect(listWorktrees(repo).some((entry) => entry.path === wt)).toBe(true);
      expect(git(repo, 'status', '--porcelain')).toBe('');
    }
  });
});
