/**
 * Find and stop processes started from a worktree (a forgotten `serve` or `dev` server, a test
 * watcher). Windows refuses to rename a folder such a process runs from, so `worktree:remove`
 * fails with EBUSY until they end. Used by `pnpm worktree:stop` (scripts/worktree-stop.ts).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readlinkSync } from 'node:fs';
import { basename } from 'node:path';

export interface ProcessInfo {
  pid: number;
  ppid: number;
  name: string;
  executable: string | null;
  commandLine: string | null;
  /** Known only on Linux. */
  cwd?: string | null;
}

/** Other agent sessions are never stopped, even when their arguments name the worktree. */
const agentCli = /^(?:claude|codex)(?:\.exe|\.cmd)?$/i;
const agentPackage = /@anthropic-ai[\\/]claude-code|@openai[\\/]codex/i;

function normalize(text: string, platform: NodeJS.Platform): string {
  const slashes = text.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  return platform === 'win32' ? slashes.toLowerCase() : slashes;
}

/** True when `text` names `folder` or something inside it (not a sibling such as `folder-2`). */
export function mentionsFolder(
  text: string | null | undefined,
  folder: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!text) return false;
  const haystack = normalize(text, platform);
  const needle = normalize(folder, platform).replace(/\/$/, '');
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    const next = haystack[at + needle.length];
    if (next === undefined || next === '/' || /[\s"'`;,)]/.test(next)) return true;
  }
  return false;
}

/** `pid` and every ancestor of it that appears in `processes`. */
export function ancestry(pid: number, processes: readonly ProcessInfo[]): Set<number> {
  const byPid = new Map(processes.map((p) => [p.pid, p]));
  const seen = new Set<number>();
  for (let current: number | undefined = pid; current && !seen.has(current);) {
    seen.add(current);
    current = byPid.get(current)?.ppid;
  }
  return seen;
}

/**
 * Processes that hold `worktree`, reduced to roots: a match whose parent also matches is ended
 * with its parent's tree. The caller's own ancestry and agent CLIs are never returned.
 */
export function worktreeHolders(
  processes: readonly ProcessInfo[],
  worktree: string,
  protectedPids: ReadonlySet<number>,
  platform: NodeJS.Platform = process.platform,
): ProcessInfo[] {
  const matches = processes.filter(
    (p) =>
      !protectedPids.has(p.pid) &&
      !agentCli.test(p.name) &&
      !agentPackage.test(p.commandLine ?? '') &&
      [p.executable, p.commandLine, p.cwd].some((text) => mentionsFolder(text, worktree, platform)),
  );
  const matched = new Set(matches.map((p) => p.pid));
  return matches.filter((p) => !matched.has(p.ppid));
}

/** Every process on this machine. */
export function listProcesses(platform: NodeJS.Platform = process.platform): ProcessInfo[] {
  const maxBuffer = 64 * 1024 * 1024;
  if (platform === 'win32') {
    const json = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine)',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer, windowsHide: true },
    );
    return parseWindowsProcesses(json);
  }
  const text = execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8', maxBuffer });
  return parsePsProcesses(text).map((p) => {
    if (platform !== 'linux') return p;
    try {
      return { ...p, cwd: readlinkSync(`/proc/${p.pid}/cwd`) };
    } catch {
      return { ...p, cwd: null };
    }
  });
}

export function parseWindowsProcesses(json: string): ProcessInfo[] {
  const parsed = JSON.parse(json.replace(/^\uFEFF/, '').trim() || '[]') as unknown;
  const rows: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  return rows.flatMap((value) => {
    const row = (typeof value === 'object' && value !== null ? value : {}) as Record<
      string,
      unknown
    >;
    return typeof row.ProcessId === 'number'
      ? [
          {
            pid: row.ProcessId,
            ppid: typeof row.ParentProcessId === 'number' ? row.ParentProcessId : 0,
            name: typeof row.Name === 'string' ? row.Name : '',
            executable: typeof row.ExecutablePath === 'string' ? row.ExecutablePath : null,
            commandLine: typeof row.CommandLine === 'string' ? row.CommandLine : null,
          },
        ]
      : [];
  });
}

export function parsePsProcesses(text: string): ProcessInfo[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) return [];
    const commandLine = match[3]!;
    const executable = commandLine.split(/\s+/)[0] ?? '';
    return [
      {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        name: basename(executable),
        executable,
        commandLine,
      },
    ];
  });
}

export interface StopDeps {
  platform: NodeJS.Platform;
  /** Runs `taskkill`; returns its exit status. */
  taskkill: (pid: number) => number | null;
  kill: (pid: number, signal: NodeJS.Signals | 0) => void;
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps: StopDeps = {
  platform: process.platform,
  taskkill: (pid) =>
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      .status,
  kill: (pid, signal) => process.kill(pid, signal),
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
};

function descendants(root: number, processes: readonly ProcessInfo[]): number[] {
  const tree = [root];
  for (let i = 0; i < tree.length; i++)
    for (const p of processes) if (p.ppid === tree[i] && !tree.includes(p.pid)) tree.push(p.pid);
  return tree;
}

/** Ends each root's process tree; returns the pids that could not be stopped. */
export async function stopProcesses(
  roots: readonly ProcessInfo[],
  processes: readonly ProcessInfo[],
  deps: Partial<StopDeps> = {},
): Promise<number[]> {
  const { platform, taskkill, kill, sleep } = { ...defaultDeps, ...deps };
  if (platform === 'win32')
    // 128: the process already exited.
    return roots.map((p) => p.pid).filter((pid) => ![0, 128].includes(taskkill(pid) ?? -1));
  const alive = (pid: number) => {
    try {
      kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  };
  const signal = (pids: number[], name: NodeJS.Signals) => {
    for (const pid of pids)
      try {
        kill(pid, name);
      } catch {
        /* Already gone, or checked by `alive` below. */
      }
  };
  let pids = roots.flatMap((p) => descendants(p.pid, processes));
  signal(pids, 'SIGTERM');
  for (let waited = 0; waited < 5000 && pids.some(alive); waited += 250) await sleep(250);
  pids = pids.filter(alive);
  signal(pids, 'SIGKILL');
  await sleep(250);
  return pids.filter(alive);
}
