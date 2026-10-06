import { describe, expect, it } from 'vitest';
import {
  ancestry,
  mentionsFolder,
  parsePsProcesses,
  parseWindowsProcesses,
  stopProcesses,
  worktreeHolders,
} from './worktree-processes';
import type { ProcessInfo } from './worktree-processes';
import { formatHolder, parseWorktreeStopArgs } from './worktree-stop';

const wt = 'D:\\Projects\\naga-ascii\\worktrees\\emoji';
const proc = (
  pid: number,
  ppid: number,
  name: string,
  commandLine: string | null,
): ProcessInfo => ({
  pid,
  ppid,
  name,
  executable: null,
  commandLine,
});

// The leftover `pnpm --filter @atlas/web serve` that blocked removing worktrees/emoji.
const serve = [
  proc(30616, 1, 'cmd.exe', 'cmd.exe /c pnpm --filter @atlas/web serve'),
  proc(
    29052,
    30616,
    'node.exe',
    'node   "D:\\Projects\\naga-ascii\\worktrees\\emoji\\node_modules\\.bin\\\\..\\tsx\\dist\\cli.mjs" scripts/serve.ts',
  ),
  proc(
    31800,
    29052,
    'node.exe',
    '"C:\\Program Files\\nodejs\\node.exe" --require D:\\Projects\\naga-ascii\\worktrees\\emoji\\node_modules\\.pnpm\\tsx@4.23.15\\node_modules\\tsx\\dist\\preflight.cjs --import file:///D:/Projects/naga-ascii/worktrees/emoji/node_modules/.pnpm/tsx@4.23.15/node_modules/tsx/dist/loader.mjs scripts/serve.ts',
  ),
];

describe('worktreeHolders', () => {
  it('returns the leftover server as one root whose tree ends its child', () => {
    expect(worktreeHolders(serve, wt, new Set(), 'win32').map((p) => p.pid)).toEqual([29052]);
  });

  it('ignores sibling worktrees and the main checkout', () => {
    const others = [
      proc(1, 0, 'node.exe', 'node D:\\Projects\\naga-ascii\\worktrees\\emoji-2\\x.js'),
      proc(2, 0, 'node.exe', 'node D:\\Projects\\naga-ascii\\node_modules\\tsx\\dist\\cli.mjs'),
      proc(3, 0, 'node.exe', 'node D:\\Projects\\naga-ascii\\worktrees\\emojis\\x.js'),
    ];
    expect(worktreeHolders(others, wt, new Set(), 'win32')).toEqual([]);
  });

  it('never returns the caller, its ancestors, or agent sessions', () => {
    const processes = [
      ...serve,
      proc(40, 1, 'claude.exe', `claude --add-dir ${wt}`),
      proc(41, 1, 'node.exe', `node C:\\npm\\@openai\\codex\\bin\\codex.js -C ${wt}`),
      proc(50, 1, 'pwsh.exe', `pwsh -WorkingDirectory ${wt}`),
      proc(
        51,
        50,
        'node.exe',
        `node ${wt}\\node_modules\\tsx\\dist\\cli.mjs scripts/worktree-stop.ts`,
      ),
    ];
    const roots = worktreeHolders(processes, wt, ancestry(51, processes), 'win32');
    expect(roots.map((p) => p.pid)).toEqual([29052]);
  });

  it('matches a Linux working directory', () => {
    const shell = { ...proc(7, 1, 'bash', 'bash'), cwd: '/repo/worktrees/emoji/apps/web' };
    expect(worktreeHolders([shell], '/repo/worktrees/emoji', new Set(), 'linux')).toEqual([shell]);
  });
});

describe('mentionsFolder', () => {
  it.each([
    [`"${wt}"`, true],
    [wt, true],
    ['file:///d:/projects/NAGA-ascii/worktrees/emoji/x.mjs', true],
    ['D:/Projects/naga-ascii/worktrees/emoji-bubbles', false],
    [null, false],
  ])('%s → %s on win32', (text, expected) => {
    expect(mentionsFolder(text, wt, 'win32')).toBe(expected);
  });

  it('is case-sensitive outside Windows', () => {
    expect(mentionsFolder('/Repo/worktrees/emoji/x', '/repo/worktrees/emoji', 'linux')).toBe(false);
  });
});

describe('process listing', () => {
  it('parses one or many Win32_Process rows', () => {
    const row = {
      ProcessId: 5,
      ParentProcessId: 4,
      Name: 'node.exe',
      ExecutablePath: null,
      CommandLine: 'node x',
    };
    const expected = [
      { pid: 5, ppid: 4, name: 'node.exe', executable: null, commandLine: 'node x' },
    ];
    expect(parseWindowsProcesses(`\uFEFF${JSON.stringify([row])}`)).toEqual(expected);
    expect(parseWindowsProcesses(JSON.stringify(row))).toEqual(expected);
  });

  it('parses ps output', () => {
    expect(parsePsProcesses('  12   1 /usr/bin/node /repo/x.js --flag\n')).toEqual([
      {
        pid: 12,
        ppid: 1,
        name: 'node',
        executable: '/usr/bin/node',
        commandLine: '/usr/bin/node /repo/x.js --flag',
      },
    ]);
  });
});

describe('stopProcesses', () => {
  it('ends each Windows root tree and treats an exited process as stopped', async () => {
    const killed: number[] = [];
    const statuses: Record<number, number> = { 1: 0, 2: 128, 3: 1 };
    const failed = await stopProcesses(
      [proc(1, 0, 'a', null), proc(2, 0, 'b', null), proc(3, 0, 'c', null)],
      [],
      {
        platform: 'win32',
        taskkill: (pid) => (killed.push(pid), statuses[pid] ?? 1),
      },
    );
    expect(killed).toEqual([1, 2, 3]);
    expect(failed).toEqual([3]);
  });

  it('signals a POSIX tree and escalates to SIGKILL', async () => {
    const alive = new Set([10, 11, 12]);
    const signals: string[] = [];
    const failed = await stopProcesses(
      [proc(10, 1, 'node', null)],
      [proc(10, 1, 'node', null), proc(11, 10, 'node', null), proc(12, 11, 'sh', null)],
      {
        platform: 'linux',
        kill: (pid, signal) => {
          if (!alive.has(pid)) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
          if (signal === 0) return;
          signals.push(`${signal} ${pid}`);
          if (signal === 'SIGKILL' || pid !== 12) alive.delete(pid);
        },
        sleep: () => Promise.resolve(),
      },
    );
    expect(signals).toEqual(['SIGTERM 10', 'SIGTERM 11', 'SIGTERM 12', 'SIGKILL 12']);
    expect(failed).toEqual([]);
  });
});

describe('worktree:stop', () => {
  it.each([[[]], [['a', 'b']], [['--force', 'a']]])('rejects %j', (args) => {
    expect(() => parseWorktreeStopArgs(args)).toThrow();
  });

  it('parses a branch and dry-run', () => {
    expect(parseWorktreeStopArgs(['--', 'codex/emoji-bubbles', '--dry-run'])).toEqual({
      branch: 'codex/emoji-bubbles',
      dryRun: true,
    });
  });

  it('prints one line per holder', () => {
    expect(formatHolder('stopped', serve[1]!)).toBe(
      'stopped 29052 node.exe node "D:\\Projects\\naga-ascii\\worktrees\\emoji\\node_modules\\.bin\\\\..\\tsx\\dist\\cli.mjs" scripts/serve.ts',
    );
  });
});
