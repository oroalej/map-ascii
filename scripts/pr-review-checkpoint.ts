import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { acquire } from './file-lock';
import { git, gitSucceeds, mainCheckout } from './git';
import type { ClaudeUsage } from './pr-review-usage';

/**
 * Checkpoints are round-level: a run records which phase of which round it is in, the receipts of
 * its native processes, and the rounds' records. Per-fix ownership tracking was removed on
 * 2026-10-07: PR #46's coordinator made 352 begin/finish calls in one run, and every real resume
 * restarted at a round boundary anyway (receipts make a finished review or validation reusable;
 * uncommitted fixes are committed as task leftovers and reviewed in the next round).
 */
export const phases = [
  'sync',
  'review',
  'validation',
  'fixes',
  'verify',
  'commit',
  'push',
  'ci',
  'complete',
] as const;
export type Phase = (typeof phases)[number];
export const claudeEfforts = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ClaudeEffort = (typeof claudeEfforts)[number];
/** Default for new Claude review attempts; earlier checkpoints recorded `high` as their default. */
export const defaultClaudeEffort: ClaudeEffort = 'medium';
export function parseClaudeEffort(value: unknown): ClaudeEffort {
  if (typeof value !== 'string' || !claudeEfforts.some((effort) => effort === value))
    throw new Error('Invalid Claude effort: expected low, medium, high, xhigh or max');
  return value as ClaudeEffort;
}
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Identity = { repository: string; pr: number; branch: string };
export type ReviewState = Identity & {
  version: 1;
  revision: number;
  updatedAt: string;
  checkout: string;
  run: string;
  resumedFrom: string | null;
  fast: boolean;
  claudeEffort: ClaudeEffort;
  /** True only when `--claude-effort` chose the effort; a resumed default takes the current default. */
  claudeEffortExplicit?: boolean;
  phase: Phase;
  round: number;
  status: 'running' | 'interrupted' | 'clean' | 'error';
  nextAction: string;
  headSha: string;
  remoteSha: string;
  mainSha: string | null;
  receipts: string[];
  history: Json[];
  rejected: string;
  report: { [key: string]: Json };
  ci: {
    status: 'not-run' | 'pending' | 'green' | 'fixed';
    headSha: string | null;
    needsReview: boolean;
    data: Json;
  };
  interruption: { reason: string; reset: string | null } | null;
};
export type Receipt = Identity & {
  version: 1;
  token: string;
  phase: 'review' | 'validation' | 'coordinator' | 'check';
  round: number;
  headSha: string;
  executable: string;
  args: string[];
  cwd: string;
  report: string;
  startedAt: string;
  finishedAt: string | null;
  launcherPid: number;
  launcherIdentity: string | null;
  childPid: number | null;
  childIdentity: string | null;
  status: 'running' | 'completed';
  exitCode: number | null;
  signal: string | null;
  reportHash: string | null;
  inputReview?: { token: string; reportHash: string } | null;
  /** Review scope file the process was given; a changed scope makes the receipt unusable. */
  scope?: { file: string; hash: string } | null;
  /** Claude session pinned with `--session-id`, and its token totals read after exit. */
  sessionId?: string | null;
  usage?: ClaudeUsage | null;
  /** Where the report came from: the process output, or its Claude transcript when the process never printed. */
  reportSource?: 'stdout' | 'file' | 'transcript' | null;
  /** Set when the wrapper ended the child: it had finished but never exited, or it hit the time cap. */
  terminatedBy?: 'idle-watchdog' | 'time-cap' | null;
  valid: boolean;
  quota: { reason: string; reset: string | null } | null;
  error: string | null;
};

export const hash = (bytes: string | Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');
export const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x: unknown) => typeof x === 'string');
const nullableString = (v: unknown) => v === null || typeof v === 'string';
const sha = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{40,64}$/.test(v);
const phase = (v: unknown): v is Phase => typeof v === 'string' && phases.some((p) => p === v);
const integer = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const json = (v: unknown): boolean =>
  v === null ||
  typeof v === 'string' ||
  typeof v === 'boolean' ||
  (typeof v === 'number' && Number.isFinite(v)) ||
  (Array.isArray(v) ? v.every(json) : record(v) && Object.values(v).every(json));
const identity = (v: Record<string, unknown>) =>
  typeof v.repository === 'string' &&
  integer(v.pr) &&
  v.pr !== 0 &&
  typeof v.branch === 'string' &&
  v.branch.length > 0;

/** Fields older checkpoints carry from per-operation tracking; read and dropped, never trusted. */
const retiredFields = ['baseline', 'current', 'owned', 'operations'];

/** Internal workflow state: validate persisted JSON before trusting it as a typed checkpoint. */
export function parseState(v: unknown): ReviewState {
  if (
    !record(v) ||
    v.version !== 1 ||
    !identity(v) ||
    !integer(v.revision) ||
    typeof v.updatedAt !== 'string' ||
    !['checkout', 'run', 'nextAction', 'rejected'].every((key) => typeof v[key] === 'string') ||
    !nullableString(v.resumedFrom) ||
    typeof v.fast !== 'boolean' ||
    ('claudeEffort' in v && !claudeEfforts.some((effort) => effort === v.claudeEffort)) ||
    ('claudeEffortExplicit' in v && typeof v.claudeEffortExplicit !== 'boolean') ||
    !phase(v.phase) ||
    !integer(v.round) ||
    v.round === 0 ||
    !['running', 'interrupted', 'clean', 'error'].includes(String(v.status)) ||
    !sha(v.headSha) ||
    !sha(v.remoteSha) ||
    !(v.mainSha === null || sha(v.mainSha)) ||
    !strings(v.receipts) ||
    !Array.isArray(v.history) ||
    !v.history.every(json) ||
    !record(v.report) ||
    !json(v.report) ||
    !record(v.ci) ||
    !['not-run', 'pending', 'green', 'fixed'].includes(String(v.ci.status)) ||
    !nullableString(v.ci.headSha) ||
    typeof v.ci.needsReview !== 'boolean' ||
    !json(v.ci.data) ||
    !(
      v.interruption === null ||
      (record(v.interruption) &&
        typeof v.interruption.reason === 'string' &&
        nullableString(v.interruption.reset))
    )
  )
    throw new Error('Invalid review checkpoint');
  const state = { ...v } as Record<string, unknown>;
  for (const key of retiredFields) delete state[key];
  // Version 1 predates effort selection; normalize without changing the source object/file.
  return { ...state, claudeEffort: v.claudeEffort ?? 'high' } as ReviewState;
}

export function parseReceipt(v: unknown): Receipt {
  if (
    !record(v) ||
    v.version !== 1 ||
    !identity(v) ||
    typeof v.token !== 'string' ||
    !['review', 'validation', 'coordinator', 'check'].includes(String(v.phase)) ||
    !integer(v.round) ||
    !sha(v.headSha) ||
    !['executable', 'cwd', 'report', 'startedAt'].every((key) => typeof v[key] === 'string') ||
    !strings(v.args) ||
    !nullableString(v.finishedAt) ||
    !integer(v.launcherPid) ||
    !nullableString(v.launcherIdentity) ||
    !(v.childPid === null || integer(v.childPid)) ||
    !nullableString(v.childIdentity) ||
    !['running', 'completed'].includes(String(v.status)) ||
    !(
      v.exitCode === null ||
      (typeof v.exitCode === 'number' && Number.isSafeInteger(v.exitCode))
    ) ||
    !nullableString(v.signal) ||
    !nullableString(v.reportHash) ||
    !(
      v.inputReview === undefined ||
      v.inputReview === null ||
      (record(v.inputReview) &&
        typeof v.inputReview.token === 'string' &&
        typeof v.inputReview.reportHash === 'string')
    ) ||
    !(
      v.scope === undefined ||
      v.scope === null ||
      (record(v.scope) && typeof v.scope.file === 'string' && typeof v.scope.hash === 'string')
    ) ||
    !(v.sessionId === undefined || nullableString(v.sessionId)) ||
    !(v.usage === undefined || v.usage === null || record(v.usage)) ||
    !(
      v.reportSource === undefined ||
      v.reportSource === null ||
      (typeof v.reportSource === 'string' &&
        ['stdout', 'file', 'transcript'].includes(v.reportSource))
    ) ||
    !(
      v.terminatedBy === undefined ||
      v.terminatedBy === null ||
      (typeof v.terminatedBy === 'string' && ['idle-watchdog', 'time-cap'].includes(v.terminatedBy))
    ) ||
    typeof v.valid !== 'boolean' ||
    !nullableString(v.error) ||
    !(
      v.quota === null ||
      (record(v.quota) && typeof v.quota.reason === 'string' && nullableString(v.quota.reset))
    )
  )
    throw new Error('Invalid process receipt');
  return v as Receipt;
}

/** Reject links and escapes before writing scratch or source files, including missing paths. */
export function contained(root: string, file: string): string {
  const base = resolve(root),
    target = resolve(file),
    rel = relative(base, target);
  if (
    rel === '' ||
    rel === '..' ||
    rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(rel)
  )
    throw new Error(`Path outside ${base}: ${file}`);
  let cursor = target;
  while (true) {
    try {
      if (lstatSync(cursor).isSymbolicLink()) throw new Error(`Linked path: ${cursor}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (relative(base, cursor) === '') break;
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error(`Path outside ${base}: ${file}`);
    cursor = parent;
  }
  return target;
}

export function atomicJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    flush: true,
  });
  renameSync(temporary, file);
}

export function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as unknown;
}

function directories(folder: string): string[] {
  if (!existsSync(folder) || lstatSync(folder).isSymbolicLink()) return [];
  return readdirSync(folder, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.isSymbolicLink())
    .map((e) => join(folder, e.name));
}

export function repository(checkout: string): string {
  return realpathSync(resolve(checkout, git(checkout, 'rev-parse', '--git-common-dir')));
}

function assertCheckout(checkout: string, expected: Identity): void {
  const branch = git(checkout, 'branch', '--show-current');
  if (
    repository(checkout) !== expected.repository ||
    branch === 'main' ||
    (branch !== '' && branch !== expected.branch)
  ) {
    throw new Error('Review checkout no longer belongs to the PR branch');
  }
}

export function loadState(run: string): ReviewState {
  const folder = join(run, 'checkpoints');
  const names = existsSync(folder)
    ? readdirSync(folder)
        .filter((name) => /^\d+-[a-f0-9-]+\.json$/.test(name))
        .sort()
        .reverse()
    : [];
  for (const name of names) {
    try {
      const state = parseState(readJson(contained(run, join(folder, name))));
      if (relative(resolve(state.run), resolve(run)) !== '') continue;
      return state;
    } catch {
      /* Incomplete/corrupt snapshots never advance the recovered phase. */
    }
  }
  throw new Error(`No valid checkpoint in ${run}`);
}

function persist(state: ReviewState): ReviewState {
  state.revision++;
  state.updatedAt = new Date().toISOString();
  parseState(state);
  atomicJson(
    contained(
      state.run,
      join(
        state.run,
        'checkpoints',
        `${String(state.revision).padStart(8, '0')}-${randomUUID()}.json`,
      ),
    ),
    state,
  );
  return state;
}

export async function updateState(
  run: string,
  change: (state: ReviewState) => void,
): Promise<ReviewState> {
  const release = await acquire([contained(run, join(run, 'checkpoint.lock'))]);
  try {
    const state = loadState(run);
    change(state);
    return persist(state);
  } finally {
    await release();
  }
}

export function receiptValid(receipt: Receipt, state: Identity, headSha: string): boolean {
  if (
    receipt.repository !== state.repository ||
    receipt.pr !== state.pr ||
    receipt.branch !== state.branch ||
    receipt.headSha !== headSha ||
    receipt.status !== 'completed' ||
    // A report recovered from the session transcript is complete even though the hung process
    // had to be ended by the wrapper; the wrapper only marks it valid for a finished session.
    (receipt.reportSource !== 'transcript' &&
      (receipt.exitCode !== 0 || receipt.signal !== null)) ||
    !receipt.valid ||
    receipt.quota !== null ||
    !receipt.reportHash
  )
    return false;
  try {
    return (
      hash(readFileSync(receipt.report)) === receipt.reportHash &&
      (!receipt.scope || hash(readFileSync(receipt.scope.file)) === receipt.scope.hash)
    );
  } catch {
    return false;
  }
}

export function discoverRuns(main: string, pr: number): string[] {
  return directories(join(main, '.plans'))
    .flatMap((status) => directories(status))
    .flatMap((task) => {
      const root = task.endsWith(`${process.platform === 'win32' ? '\\' : '/'}pr${pr}-review-fixes`)
        ? task
        : join(task, 'pr-review');
      return directories(root).filter((run) => /[\\/]run-/.test(run));
    });
}

export type StartOptions = {
  checkout: string;
  pr: number;
  branch: string;
  remoteSha: string;
  fast?: boolean;
  claudeEffort?: ClaudeEffort;
  fresh?: boolean;
  resume?: string;
};
export type Recovery = {
  state: ReviewState;
  reusable: Receipt[];
  active: Receipt[];
  reason: string;
};

/** Selection is read-only. */
export function selectState(options: StartOptions): ReviewState | null {
  if (options.claudeEffort !== undefined) parseClaudeEffort(options.claudeEffort);
  if (options.fresh && options.resume) throw new Error('--fresh and --resume cannot be combined');
  const repo = repository(options.checkout);
  if (options.resume) {
    contained(join(mainCheckout(options.checkout), '.plans'), options.resume);
    const state = loadState(options.resume);
    if (state.repository !== repo || state.pr !== options.pr || state.branch !== options.branch)
      throw new Error('Resume target does not match the repository, PR and branch');
    return state;
  }
  if (options.fresh) return null;
  return (
    discoverRuns(mainCheckout(options.checkout), options.pr)
      .flatMap((run) => {
        try {
          const state = loadState(run);
          return state.repository === repo &&
            state.pr === options.pr &&
            state.branch === options.branch
            ? [state]
            : [];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null
  );
}

/**
 * Where a saved run continues. A finished review or validation receipt at the same head is
 * reused; a changed head starts a new round; a saved clean result stays clean for its head
 * (main synchronization and the CI gate belong to `$merge-pr`).
 */
export function recover(
  state: ReviewState,
  options: StartOptions,
  isActive: (receipt: Receipt) => boolean,
): Omit<Recovery, 'state'> & { phase: Phase; round: number } {
  const head = git(options.checkout, 'rev-parse', 'HEAD');
  const receipts = state.receipts
    .flatMap((file) => {
      try {
        const plans = join(mainCheckout(options.checkout), '.plans');
        const receipt = parseReceipt(readJson(contained(plans, file)));
        contained(plans, receipt.report);
        return [receipt];
      } catch {
        return [];
      }
    })
    .filter(
      (r) => r.repository === state.repository && r.pr === state.pr && r.branch === state.branch,
    );
  const active = receipts.filter((r) => r.status === 'running' && isActive(r));
  const unchanged = head === state.headSha && options.remoteSha === state.headSha;
  const verified = receipts.filter((r) => receiptValid(r, state, state.headSha));
  let next = state.phase,
    round = state.round,
    reason = 'Continue saved phase';
  const ahead =
    head !== options.remoteSha &&
    gitSucceeds(options.checkout, 'merge-base', '--is-ancestor', options.remoteSha, head);
  if (ahead) {
    next = 'push';
    if (head !== state.headSha) round++;
    reason = 'Local commits must be pushed before they are reviewed';
  } else if (!unchanged) {
    next = 'review';
    round++;
    reason = 'Reviewed commit changed; retain history and review the new commit';
  } else if (state.phase === 'push') {
    next = 'review';
    reason = 'Pending push reached the remote; review the pushed commits';
  }
  const review = [...verified].reverse().find((r) => r.round === round && r.phase === 'review');
  const reusable = verified.filter(
    (r) =>
      r.round === round &&
      (r.phase === 'review'
        ? r === review
        : r.phase !== 'validation' ||
          (!!review &&
            r.inputReview?.token === review.token &&
            r.inputReview.reportHash === review.reportHash)),
  );
  if (next === 'review' && review) next = 'validation';
  if (
    next === 'validation' &&
    reusable.some((r) => r.phase === 'validation') &&
    reusable.some((r) => r.phase === 'review')
  )
    next = 'fixes';
  if (next === 'ci' && state.ci.needsReview) {
    next = 'review';
    round++;
    reason = 'Source CI fixes still require a review round';
  }
  if (
    ['validation', 'fixes', 'verify', 'commit'].includes(next) &&
    !reusable.some((r) => r.phase === 'review')
  ) {
    next = 'review';
    reason = 'Completed review provenance could not be verified';
  } else if (
    ['fixes', 'verify', 'commit'].includes(next) &&
    !reusable.some((r) => r.phase === 'validation')
  ) {
    next = 'validation';
    reason = 'Completed validation provenance could not be verified';
  }
  return { reusable: unchanged ? reusable : [], active, reason, phase: next, round };
}

export async function startReview(
  options: StartOptions,
  previous: ReviewState | null = selectState(options),
  isActive: (receipt: Receipt) => boolean = () => true,
): Promise<Recovery> {
  if (options.claudeEffort !== undefined) parseClaudeEffort(options.claudeEffort);
  if (options.fresh && options.resume) throw new Error('--fresh and --resume cannot be combined');
  if (!Number.isSafeInteger(options.pr) || options.pr < 1 || !sha(options.remoteSha))
    throw new Error('Invalid PR or remote commit');
  const main = mainCheckout(options.checkout),
    repo = repository(options.checkout);
  assertCheckout(options.checkout, { repository: repo, pr: options.pr, branch: options.branch });
  if (
    previous &&
    (previous.repository !== repo ||
      previous.pr !== options.pr ||
      previous.branch !== options.branch)
  )
    throw new Error('Checkpoint identity mismatch');
  const recovery = previous
    ? recover(previous, options, isActive)
    : { reusable: [], active: [], reason: 'New review', phase: 'sync' as Phase, round: 1 };
  if (recovery.active.length)
    throw new Error(
      `Review process still active; observe ${recovery.active.map((r) => r.report).join(', ')}`,
    );
  // --fresh and a newer invocation must not hide a surviving process in an older run.
  for (const oldRun of discoverRuns(main, options.pr)) {
    let saved: ReviewState;
    try {
      saved = loadState(oldRun);
    } catch {
      continue;
    }
    if (saved.repository !== repo || saved.branch !== options.branch) continue;
    for (const file of saved.receipts) {
      let receipt: Receipt;
      try {
        receipt = parseReceipt(readJson(contained(join(main, '.plans'), file)));
      } catch {
        continue;
      }
      if (
        receipt.repository === repo &&
        receipt.pr === options.pr &&
        receipt.branch === options.branch &&
        receipt.status === 'running' &&
        isActive(receipt)
      )
        throw new Error(`Review process still active; observe ${receipt.report}`);
    }
  }
  const root = join(main, '.plans', 'active', `pr${options.pr}-review-fixes`);
  contained(main, root);
  mkdirSync(root, { recursive: true });
  const run = contained(root, join(root, `run-${Date.now()}-${randomUUID()}`));
  mkdirSync(run);
  const headSha = git(options.checkout, 'rev-parse', 'HEAD');
  const state: ReviewState = previous
    ? structuredClone(previous)
    : {
        version: 1,
        revision: 0,
        repository: repo,
        pr: options.pr,
        branch: options.branch,
        updatedAt: '',
        checkout: resolve(options.checkout),
        run,
        resumedFrom: null,
        fast: !!options.fast,
        claudeEffort: options.claudeEffort ?? defaultClaudeEffort,
        phase: recovery.phase,
        round: recovery.round,
        status: 'running',
        nextAction: recovery.reason,
        headSha,
        remoteSha: options.remoteSha,
        mainSha: null,
        receipts: [],
        history: [],
        rejected: '',
        report: {},
        ci: { status: 'not-run', headSha: null, needsReview: false, data: null },
        interruption: null,
      };
  Object.assign(state, {
    revision: 0,
    run,
    resumedFrom: previous?.run ?? null,
    checkout: resolve(options.checkout),
    fast: !!options.fast,
    claudeEffort:
      options.claudeEffort ??
      (previous?.claudeEffortExplicit ? previous.claudeEffort : defaultClaudeEffort),
    claudeEffortExplicit: options.claudeEffort !== undefined || !!previous?.claudeEffortExplicit,
    phase: recovery.phase,
    round: recovery.round,
    status: 'running',
    nextAction: recovery.reason,
    headSha,
    remoteSha: options.remoteSha,
    interruption: null,
  });
  if (previous && (headSha !== previous.headSha || options.remoteSha !== previous.remoteSha))
    state.ci = { ...state.ci, status: 'not-run', headSha: null };
  const release = await acquire([contained(run, join(run, 'checkpoint.lock'))]);
  try {
    persist(state);
  } finally {
    await release();
  }
  return { ...recovery, state };
}
