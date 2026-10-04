import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claudeSettingsPath,
  initializeClaudeWorktree,
  isGeneratedClaudeSettings,
  mainInstructionExcludes,
} from './claude-worktree-settings';

let root: string, main: string, worktree: string, path: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'claude-worktree-'));
  main = join(root, 'repo with spaces');
  worktree = join(main, 'worktrees', 'topic');
  path = join(worktree, claudeSettingsPath);
  mkdirSync(worktree, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('Claude worktree settings', () => {
  it('excludes only the main checkout instructions with absolute forward-slash paths', () => {
    initializeClaudeWorktree(main, worktree);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      claudeMdExcludes: ['CLAUDE.md', 'AGENTS.md'].map((name) =>
        join(main, name).replaceAll('\\', '/'),
      ),
    });
    expect(isGeneratedClaudeSettings(main, worktree)).toBe(true);
    expect(isGeneratedClaudeSettings(join(root, 'another repo'), worktree)).toBe(false);
  });

  it('preserves personal settings and existing exclusions, and does not rewrite on rerun', () => {
    mkdirSync(join(worktree, '.claude'));
    const settings = {
      permissions: { allow: ['Read'] },
      claudeMdExcludes: ['**/other/CLAUDE.md', '**/other/CLAUDE.md'],
    };
    writeFileSync(path, JSON.stringify(settings));
    initializeClaudeWorktree(main, worktree);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      ...settings,
      claudeMdExcludes: [...settings.claudeMdExcludes, ...mainInstructionExcludes(main)],
    });
    const content = readFileSync(path, 'utf8');
    initializeClaudeWorktree(main, worktree);
    expect(readFileSync(path, 'utf8')).toBe(content);
    expect(isGeneratedClaudeSettings(main, worktree)).toBe(false);
  });

  it.each(['{', '[]', 'null', '{"claudeMdExcludes":null}', '{"claudeMdExcludes":[42]}'])(
    'preserves invalid settings without making them disposable: %s',
    (content) => {
      mkdirSync(join(worktree, '.claude'));
      writeFileSync(path, content);
      expect(() => initializeClaudeWorktree(main, worktree)).toThrow();
      expect(readFileSync(path, 'utf8')).toBe(content);
      expect(isGeneratedClaudeSettings(main, worktree)).toBe(false);
    },
  );

  it('protects a linked settings directory and its external contents', () => {
    const external = join(root, 'personal-settings');
    mkdirSync(external);
    const content = JSON.stringify({ claudeMdExcludes: mainInstructionExcludes(main) });
    writeFileSync(join(external, 'settings.local.json'), content);
    symlinkSync(
      external,
      join(worktree, '.claude'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect(() => initializeClaudeWorktree(main, worktree)).toThrow(/Refusing linked/);
    expect(isGeneratedClaudeSettings(main, worktree)).toBe(false);
    expect(readFileSync(join(external, 'settings.local.json'), 'utf8')).toBe(content);
  });

  it('protects hard-linked settings even when their contents match generated setup', () => {
    initializeClaudeWorktree(main, worktree);
    const external = join(root, 'shared-settings.json');
    linkSync(path, external);
    const content = readFileSync(external, 'utf8');
    expect(() => initializeClaudeWorktree(main, worktree)).toThrow(/Refusing linked/);
    expect(isGeneratedClaudeSettings(main, worktree)).toBe(false);
    expect(readFileSync(external, 'utf8')).toBe(content);
  });

  it('refuses the main checkout and sibling folders without creating settings', () => {
    expect(() => initializeClaudeWorktree(main, main)).toThrow(/nested worktree/);
    expect(() => initializeClaudeWorktree(main, join(root, 'sibling'))).toThrow(/nested worktree/);
    expect(isGeneratedClaudeSettings(main, main)).toBe(false);
  });
});
