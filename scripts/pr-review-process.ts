import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, parse } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  atomicJson,
  contained,
  hash,
  loadState,
  parseReceipt,
  readJson,
  record,
  receiptValid,
  updateState,
} from './pr-review-checkpoint';
import type { Json, Receipt } from './pr-review-checkpoint';
import { acquire } from './file-lock';
import { git, mainCheckout } from './git';
import { claudeUsage, findTranscript, transcriptReport } from './pr-review-usage';

export type Watchdog = {
  /** How often the wrapper looks at the child's transcript (default 30 s). */
  pollMs?: number;
  /** A finished transcript that stays unchanged this long means the child is hung on exit (default 2 min). */
  idleMs?: number;
  /** Hard cap on the child's run time; the phase default applies when omitted. */
  maxMs?: number;
};

export type ProcessSpec = {
  run: string;
  phase: Receipt['phase'];
  round: number;
  headSha: string;
  executable: string;
  args: string[];
  output: 'stdout' | 'file';
  resultFile?: string;
  reviewReceipt?: string;
  /** Absolute `round<k>/scope.json` written by `review:state scope`. */
  scope?: string;
  watchdog?: Watchdog;
};

/**
 * The wrapper owns every timeout, so callers never need a shell timeout that would kill a child
 * mid-report. Reviews and validations that run longer than this are not producing anything useful.
 */
export const phaseTimeCapMs: Record<Receipt['phase'], number> = {
  review: 90 * 60_000,
  validation: 60 * 60_000,
  coordinator: 6 * 60 * 60_000,
  check: 2 * 60 * 60_000,
};

/** Claude reviews that may run at once on this machine; more than this exhausts the 5-hour window. */
export const REVIEW_SLOTS = 2;
export const reviewSlotsDir = (): string =>
  process.env.ATLAS_REVIEW_SLOTS_DIR || join(tmpdir(), 'atlas-review-slots');

/** Preserve literal reset text; a clock time without a date is not an ISO timestamp. */
export function quotaFailure(text: string): Receipt['quota'] {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    let structured = false;
    try {
      const value = readError(JSON.parse(line) as unknown);
      structured =
        value === 'usage_limit_reached' ||
        value === 'quota_exceeded' ||
        value === 'insufficient_quota';
    } catch {
      /* Text mode CLIs do not emit JSON. */
    }
    if (
      structured ||
      /(?:you(?:'|’)?ve hit your (?:(?:(?:session|usage|weekly|monthly|opus|sonnet|haiku) )?limit|(?:(?:(?:org|channel)(?:'|’)s )?monthly|individual) (?:spend|usage) limit|team(?:'|’)s shared budget)|you have (?:hit|exceeded|reached) your usage limit|usage limit (?:reached|exceeded))\b/i.test(
        line,
      )
    ) {
      return { reason: line.trim(), reset: /\bresets?\b[^\r\n]*/i.exec(line)?.[0] ?? null };
    }
  }
  return null;
}

function readError(value: unknown): string | null {
  if (!record(value)) return null;
  if (typeof value.code === 'string') return value.code;
  if (
    typeof value.type === 'string' &&
    ['usage_limit_reached', 'quota_exceeded', 'insufficient_quota'].includes(value.type)
  )
    return value.type;
  return record(value.error) ? readError(value.error) : null;
}

export function reportComplete(kind: Receipt['phase'], text: string): boolean {
  // A review is complete when it states its verdict; section wording varies between runs and a
  // missing colon once cost a finished 35-minute review.
  if (kind === 'review')
    return /^\s*(?:#+\s*)?\*\*Verdict:?\*\*:?[^\n]*\b(?:approve|changes requested)\b/im.test(text);
  if (kind === 'validation')
    return (
      /^\*\*Claude's verdict:\*\*/m.test(text) &&
      /^### Validation\s*$/m.test(text) &&
      /^\|\s*#\s*\|/m.test(text) &&
      /^### Fix steps\s*$/m.test(text) &&
      /^### Noticed, not in Claude's review\s*$/m.test(text)
    );
  if (kind === 'coordinator') {
    const result = /```review-pr-result\s*([\s\S]*?)```/.exec(text)?.[1];
    if (!result) return false;
    try {
      const value: unknown = JSON.parse(result);
      return record(value) && ['clean', 'error', 'interrupted'].includes(String(value.status));
    } catch {
      return false;
    }
  }
  return true;
}

/** PID plus OS start identity distinguishes a surviving process from a recycled PID. */
export function processIdentity(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'win32')
      return (
        execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
          ],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
        ).trim() || null
      );
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
    }
    return (
      execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim() || null
    );
  } catch {
    return null;
  }
}

function alive(pid: number | null, identity: string | null): boolean {
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    return true; // Permission/inspection failures cannot prove that a process has exited.
  }
  const current = processIdentity(pid);
  return !identity || !current || current === identity;
}

export function receiptActive(receipt: Receipt): boolean {
  return (
    receipt.status === 'running' &&
    (alive(receipt.launcherPid, receipt.launcherIdentity) ||
      alive(receipt.childPid, receipt.childIdentity))
  );
}

export function parseProcessSpec(value: unknown): ProcessSpec {
  if (
    !record(value) ||
    !['run', 'headSha', 'executable'].every((k) => typeof value[k] === 'string') ||
    !['review', 'validation', 'coordinator', 'check'].includes(String(value.phase)) ||
    typeof value.round !== 'number' ||
    !Number.isSafeInteger(value.round) ||
    value.round < 1 ||
    !Array.isArray(value.args) ||
    !value.args.every((v: unknown) => typeof v === 'string') ||
    !['stdout', 'file'].includes(String(value.output))
  )
    throw new Error('Invalid process input');
  const spec = value as ProcessSpec;
  if (!isAbsolute(spec.executable))
    throw new Error('Executable must be the resolved absolute native binary path');
  if (
    spec.resultFile !== undefined &&
    (typeof spec.resultFile !== 'string' || !isAbsolute(spec.resultFile))
  )
    throw new Error('Result file must be an absolute scratch path');
  if (!/^[a-f0-9]{40,64}$/.test(spec.headSha)) throw new Error('Invalid process input commit');
  if (
    spec.reviewReceipt !== undefined &&
    (typeof spec.reviewReceipt !== 'string' || !isAbsolute(spec.reviewReceipt))
  )
    throw new Error('Review receipt must be an absolute path');
  if (spec.scope !== undefined && (typeof spec.scope !== 'string' || !isAbsolute(spec.scope)))
    throw new Error('Scope must be an absolute scratch path');
  if (spec.watchdog !== undefined) {
    if (!record(spec.watchdog)) throw new Error('Invalid watchdog');
    for (const key of ['pollMs', 'idleMs', 'maxMs'] as const) {
      const v = spec.watchdog[key];
      if (v !== undefined && !(typeof v === 'number' && Number.isFinite(v) && v > 0))
        throw new Error(`Invalid watchdog ${key}`);
    }
  }
  return spec;
}

/** The transcript's final report, once the session has stopped working (`end_turn`, no later turn). */
function finishedTranscript(
  sessionId: string | null,
  phase: Receipt['phase'],
): { text: string; file: string } | null {
  if (!sessionId || phase !== 'review') return null;
  const file = findTranscript(sessionId);
  if (!file) return null;
  try {
    const report = transcriptReport(readFileSync(file, 'utf8'));
    return report?.final && reportComplete(phase, report.text) ? { text: report.text, file } : null;
  } catch {
    return null;
  }
}

/** Report paths are substituted as individual arguments; no command string or shell is used. */
export async function runProcess(input: ProcessSpec): Promise<{ receipt: Receipt; path: string }> {
  const spec = parseProcessSpec(input),
    state = loadState(spec.run);
  if (spec.round !== state.round) throw new Error('Process round does not match checkpoint');
  const readReview = (): Receipt | null => {
    if (spec.phase !== 'validation') return null;
    if (!spec.reviewReceipt) throw new Error('Validation requires its input review receipt');
    const review = parseReceipt(
      readJson(contained(join(mainCheckout(state.checkout), '.plans'), spec.reviewReceipt)),
    );
    if (
      review.phase !== 'review' ||
      review.round !== spec.round ||
      !receiptValid(review, state, spec.headSha)
    )
      throw new Error('Validation input review could not be verified');
    return review;
  };
  const review = readReview();
  const scope = spec.scope
    ? {
        file: spec.scope,
        hash: hash(
          readFileSync(contained(join(mainCheckout(state.checkout), '.plans'), spec.scope)),
        ),
      }
    : null;
  // Validation must judge the review against the same scope the reviewer was given.
  if (review && (review.scope?.hash ?? null) !== (scope?.hash ?? null))
    throw new Error('Validation scope does not match its review');
  const stepRoot = contained(spec.run, join(spec.run, `round${spec.round}`, spec.phase));
  mkdirSync(stepRoot, { recursive: true });
  const processLock = contained(
    join(mainCheckout(state.checkout), '.plans'),
    join(
      mainCheckout(state.checkout),
      '.plans',
      'active',
      `pr${state.pr}-review-fixes`,
      `native-${spec.phase}.lock`,
    ),
  );
  const release = await acquire([processLock], {
    timeoutMs: 100,
    timeoutMessage: 'A matching process is still active; observe its receipt',
  });
  // Machine-wide: other worktrees' reviews queue here instead of all burning the Claude window at once.
  const releaseSlot =
    spec.phase === 'review' || spec.phase === 'validation'
      ? await acquire(
          Array.from({ length: REVIEW_SLOTS }, (_, i) => join(reviewSlotsDir(), `slot-${i}.lock`)),
          {
            timeoutMs: 3 * 60 * 60_000,
            onWait: () => console.error('waiting for a review slot; other worktrees are reviewing'),
            timeoutMessage: 'Timed out waiting for a review slot.',
          },
        ).catch(async (error: unknown) => {
          await release();
          throw error;
        })
      : null;
  try {
    // A restarted coordinator must inspect receipts first; this also rejects stale head input.
    if (
      state.headSha !== spec.headSha ||
      git(state.checkout, 'rev-parse', 'HEAD') !== spec.headSha ||
      (spec.phase !== 'coordinator' && spec.phase !== 'check' && state.remoteSha !== spec.headSha)
    )
      throw new Error('Synchronize local and remote commits before running a review process');
    for (const file of state.receipts) {
      try {
        const receipt = parseReceipt(readJson(file));
        if (receipt.round === spec.round && receipt.phase === spec.phase && receiptActive(receipt))
          throw new Error(`Matching process active: ${file}`);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Matching process active:'))
          throw error;
      }
    }
    const attempt = contained(spec.run, join(stepRoot, `attempt-${Date.now()}-${randomUUID()}`));
    mkdirSync(attempt);
    const report = join(attempt, 'report.md'),
      receiptPath = join(attempt, 'receipt.json');
    const sessionId = spec.args.some((arg) => arg.includes('{sessionId}')) ? randomUUID() : null;
    const args = spec.args.map((arg) => {
      const value = arg.replaceAll('{report}', report).replaceAll('{sessionId}', sessionId ?? '');
      return spec.phase === 'review'
        ? value.replaceAll('{claudeEffort}', state.claudeEffort)
        : value;
    });
    if (spec.output === 'file' && !spec.args.some((arg) => arg.includes('{report}')))
      throw new Error('File output requires a {report} argument');
    const receipt: Receipt = {
      version: 1,
      repository: state.repository,
      pr: state.pr,
      branch: state.branch,
      token: randomUUID(),
      phase: spec.phase,
      round: spec.round,
      headSha: spec.headSha,
      executable: spec.executable,
      args,
      cwd: state.checkout,
      report,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      launcherPid: process.pid,
      launcherIdentity: processIdentity(process.pid),
      childPid: null,
      childIdentity: null,
      status: 'running',
      exitCode: null,
      signal: null,
      reportHash: null,
      inputReview: review ? { token: review.token, reportHash: review.reportHash! } : null,
      scope,
      sessionId,
      usage: null,
      valid: false,
      quota: null,
      error: null,
    };
    atomicJson(receiptPath, receipt);
    await updateState(spec.run, (saved) => {
      saved.receipts.push(receiptPath);
    });
    const stdout = openSync(spec.output === 'stdout' ? report : join(attempt, 'stdout.log'), 'wx');
    const stderr = openSync(join(attempt, 'stderr.log'), 'wx');
    const pollMs = spec.watchdog?.pollMs ?? 30_000,
      idleMs = spec.watchdog?.idleMs ?? 2 * 60_000,
      maxMs = spec.watchdog?.maxMs ?? phaseTimeCapMs[spec.phase];
    let terminatedBy: Receipt['terminatedBy'] = null;
    try {
      const child = spawn(spec.executable, args, {
        cwd: state.checkout,
        stdio: ['ignore', stdout, stderr],
        windowsHide: true,
      });
      child.once('spawn', () => {
        receipt.childPid = child.pid ?? null;
        receipt.childIdentity =
          receipt.childPid === null ? null : processIdentity(receipt.childPid);
        atomicJson(receiptPath, receipt);
      });
      let closed = false;
      const exited = new Promise<void>((done) => {
        child.once('error', (error) => {
          receipt.error = error.message;
        });
        child.once('close', (code, signal) => {
          receipt.exitCode = code;
          receipt.signal = signal;
          closed = true;
          done();
        });
      });
      // Headless Claude can finish its turn and then neither print nor exit. Watch its transcript:
      // once the final report is there and the file stops changing, end the child and take the
      // report from the transcript. The time cap replaces every caller-side shell timeout.
      const started = Date.now();
      let finishedSince: number | null = null;
      let seenMtime = 0;
      const controller = new AbortController();
      void exited.then(() => controller.abort());
      const watch = (async () => {
        while (!closed) {
          await delay(pollMs, undefined, { signal: controller.signal }).catch(() => undefined);
          if (closed) return;
          const now = Date.now();
          const finished = finishedTranscript(sessionId, spec.phase);
          if (finished) {
            const mtime = statSync(finished.file).mtimeMs;
            if (mtime !== seenMtime) {
              seenMtime = mtime;
              finishedSince = now;
            }
            if (finishedSince !== null && now - finishedSince >= idleMs) {
              terminatedBy = 'idle-watchdog';
              child.kill();
              return;
            }
          } else finishedSince = null;
          if (now - started >= maxMs) {
            terminatedBy = 'time-cap';
            child.kill();
            return;
          }
        }
      })();
      await exited;
      await watch;
    } finally {
      closeSync(stdout);
      closeSync(stderr);
    }
    receipt.finishedAt = new Date().toISOString();
    receipt.status = 'completed';
    receipt.terminatedBy = terminatedBy;
    receipt.usage = sessionId ? claudeUsage(sessionId) : null;
    let body = existsSync(report) ? readFileSync(report, 'utf8').replace(/^\uFEFF/, '') : '';
    receipt.reportSource = spec.output;
    receipt.valid =
      receipt.exitCode === 0 &&
      receipt.signal === null &&
      receipt.error === null &&
      reportComplete(spec.phase, body);
    if (!receipt.valid && receipt.error === null) {
      // The process never printed its report or never exited (the watchdog ended it), but its
      // session finished the work: the transcript's final message is the report.
      const finished = finishedTranscript(sessionId, spec.phase);
      if (finished) {
        if (!reportComplete(spec.phase, body)) {
          writeFileSync(report, finished.text, 'utf8');
          body = finished.text;
          receipt.reportSource = 'transcript';
        }
        receipt.valid = true;
      }
    }
    receipt.reportHash = existsSync(report) ? hash(readFileSync(report)) : null;
    if (receipt.valid && review) {
      try {
        const currentReview = readReview();
        receipt.valid =
          currentReview?.token === review.token && currentReview?.reportHash === review.reportHash;
      } catch {
        receipt.valid = false;
      }
    }
    if (!receipt.valid)
      receipt.quota = quotaFailure(
        body +
          '\n' +
          readFileSync(join(attempt, 'stderr.log'), 'utf8') +
          '\n' +
          (spec.output === 'file' ? readFileSync(join(attempt, 'stdout.log'), 'utf8') : ''),
      );
    // The wrapper writes completion even when the coordinating agent no longer exists.
    atomicJson(receiptPath, receipt);
    if (receipt.quota) {
      await updateState(spec.run, (saved) => {
        saved.status = 'interrupted';
        saved.interruption = receipt.quota;
        saved.nextAction = `Resume ${spec.phase} in round ${spec.round} after usage resets`;
      });
      publishInterrupted(spec.run, spec.resultFile);
    }
    return { receipt, path: receiptPath };
  } finally {
    await releaseSlot?.();
    await release();
  }
}

export function interruptedResult(run: string): Record<string, Json> {
  const state = loadState(run);
  return {
    ...state.report,
    status: 'interrupted',
    pr: state.pr,
    headSha: state.remoteSha,
    fast: state.fast,
    claudeEffort: state.claudeEffort,
    cli: state.report.cli ?? { codex: null, claude: null },
    mainMerge: state.report.mainMerge ?? 'not-run',
    workTree: state.report.workTree ?? null,
    roundCount: state.round,
    rounds: state.history,
    noticed: state.report.noticed ?? [],
    ci: {
      ...(record(state.ci.data) ? state.ci.data : {}),
      status: state.ci.status,
      headSha: state.ci.headSha,
      needsReview: state.ci.needsReview,
    },
    stopReason: state.interruption?.reason ?? 'Coordinator ended before producing a final result',
    resume: {
      checkpoint: state.run,
      phase: state.phase,
      round: state.round,
      reason: state.interruption?.reason ?? 'Coordinator interrupted',
      reset: state.interruption?.reset ?? null,
      command: `$review-pr ${state.pr} --resume ${JSON.stringify(state.run)}`,
    },
  };
}

export function publishInterrupted(run: string, copy?: string): Record<string, Json> {
  const result = interruptedResult(run);
  atomicJson(contained(run, join(run, 'result.json')), result);
  if (copy) {
    // The exact caller destination is authorized by Result file; reject linked paths.
    if (!isAbsolute(copy)) throw new Error('Result file must be an absolute scratch path');
    atomicJson(contained(parse(copy).root, copy), result);
  }
  return result;
}
