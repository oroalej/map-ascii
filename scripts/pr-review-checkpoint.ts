import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  writeFileSync,
  unlinkSync,
  chmodSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { acquire } from './file-lock';
import { git, gitRaw, gitSucceeds, mainCheckout } from './git';

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
export function parseClaudeEffort(value: unknown): ClaudeEffort {
  if (typeof value !== 'string' || !claudeEfforts.some((effort) => effort === value))
    throw new Error('Invalid Claude effort: expected low, medium, high, xhigh or max');
  return value as ClaudeEffort;
}
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Identity = { repository: string; pr: number; branch: string };
export type Snapshot = {
  headSha: string;
  status: string;
  indexHash: string;
  treeHash: string;
  files: Record<string, string | null>;
};
export type OwnedFile = {
  baseHash: string | null;
  hash: string | null;
  content: string | null;
  mode: number;
};
export type Operation = {
  id: string;
  phase: Phase;
  round: number;
  before: Snapshot;
  after: Snapshot | null;
  paths: string[];
  expectedTree: string | null;
  expectedParents?: string[] | null;
  commit: string | null;
  data: Json;
};
export type ReviewState = Identity & {
  version: 1;
  revision: number;
  updatedAt: string;
  checkout: string;
  run: string;
  resumedFrom: string | null;
  fast: boolean;
  claudeEffort: ClaudeEffort;
  phase: Phase;
  round: number;
  status: 'running' | 'interrupted' | 'clean' | 'error';
  nextAction: string;
  headSha: string;
  remoteSha: string;
  mainSha: string | null;
  baseline: Snapshot;
  current: Snapshot;
  owned: Record<string, OwnedFile>;
  operations: Operation[];
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
const snapshotShape = (v: unknown): boolean =>
  record(v) &&
  sha(v.headSha) &&
  typeof v.status === 'string' &&
  typeof v.indexHash === 'string' &&
  typeof v.treeHash === 'string' &&
  record(v.files) &&
  Object.values(v.files).every(nullableString);

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
    !phase(v.phase) ||
    !integer(v.round) ||
    v.round === 0 ||
    !['running', 'interrupted', 'clean', 'error'].includes(String(v.status)) ||
    !sha(v.headSha) ||
    !sha(v.remoteSha) ||
    !(v.mainSha === null || sha(v.mainSha)) ||
    !snapshotShape(v.baseline) ||
    !snapshotShape(v.current) ||
    !record(v.owned) ||
    !Object.values(v.owned).every(
      (file) =>
        record(file) &&
        nullableString(file.baseHash) &&
        nullableString(file.hash) &&
        nullableString(file.content) &&
        integer(file.mode) &&
        (file.content === null
          ? file.hash === null
          : typeof file.content === 'string' &&
            file.hash === hash(Buffer.from(file.content, 'base64'))),
    ) ||
    !Array.isArray(v.operations) ||
    !v.operations.every(
      (op: unknown) =>
        record(op) &&
        typeof op.id === 'string' &&
        phase(op.phase) &&
        integer(op.round) &&
        snapshotShape(op.before) &&
        (op.after === null || snapshotShape(op.after)) &&
        strings(op.paths) &&
        nullableString(op.expectedTree) &&
        (op.expectedParents === undefined ||
          op.expectedParents === null ||
          (strings(op.expectedParents) &&
            op.expectedParents.length > 0 &&
            op.expectedParents.every(sha) &&
            record(op.before) &&
            op.expectedParents[0] === op.before.headSha)) &&
        nullableString(op.commit) &&
        json(op.data),
    ) ||
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
  // Version 1 predates effort selection; normalize without changing the source object/file.
  return { ...v, claudeEffort: v.claudeEffort ?? 'high' } as ReviewState;
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

export function sourcePath(checkout: string, name: string): string {
  if (
    !name ||
    isAbsolute(name) ||
    name.split(/[\\/]/).some((p) => p === '..' || p.includes(':')) ||
    /^(?:\.git|\.plans)(?:[\\/]|$)/.test(name)
  )
    throw new Error(`Invalid source path: ${name}`);
  return contained(checkout, resolve(checkout, name));
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

function dirtyPaths(status: string): string[] {
  const entries = status.split('\0'),
    paths: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    paths.push(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2))) {
      const old = entries[++i];
      if (old) paths.push(old);
    }
  }
  return paths;
}

function fileHash(checkout: string, name: string): string | null {
  const file = resolve(checkout, name);
  if (!existsSync(file)) return null;
  const info = lstatSync(file);
  return info.isSymbolicLink() ? hash(`link:${readlinkSync(file)}`) : hash(readFileSync(file));
}

export function capture(checkout: string, paths: string[] = []): Snapshot {
  const status = gitRaw(checkout, 'status', '--porcelain=v1', '-z', '--untracked-files=all');
  const files = Object.fromEntries(
    [...new Set([...dirtyPaths(status), ...paths])]
      .sort()
      .map((name) => [name, fileHash(checkout, name)]),
  );
  const indexHash = hash(gitRaw(checkout, 'diff', '--cached', '--binary'));
  const headSha = git(checkout, 'rev-parse', 'HEAD');
  return {
    headSha,
    status,
    indexHash,
    files,
    treeHash: hash(
      JSON.stringify([headSha, indexHash, gitRaw(checkout, 'diff', '--binary', 'HEAD'), files]),
    ),
  };
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
    receipt.exitCode !== 0 ||
    receipt.signal !== null ||
    !receipt.valid ||
    receipt.quota !== null ||
    !receipt.reportHash
  )
    return false;
  try {
    return hash(readFileSync(receipt.report)) === receipt.reportHash;
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
  workingTreeMatches: boolean;
  recoveredCommit: string | null;
  pushCompleted: boolean;
  reason: string;
};

/** Selection is read-only. The caller imports legacy evidence if this finds no checkpoint. */
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

export function recover(
  state: ReviewState,
  options: StartOptions,
  isActive: (receipt: Receipt) => boolean,
): Omit<Recovery, 'state'> & { phase: Phase; round: number } {
  const now = capture(options.checkout, Object.keys(state.owned));
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
  const pending = [...state.operations].reverse().find((op) => op.after === null);
  let recoveredCommit: string | null = null;
  if (
    pending?.phase === 'commit' &&
    pending.expectedTree &&
    git(options.checkout, 'rev-parse', 'HEAD^{tree}') === pending.expectedTree &&
    git(options.checkout, 'rev-list', '--parents', '-n', '1', 'HEAD') ===
      [now.headSha, ...(pending.expectedParents ?? [pending.before.headSha])].join(' ')
  )
    recoveredCommit = now.headSha;
  const pushCompleted =
    pending?.phase === 'push' &&
    gitSucceeds(
      options.checkout,
      'merge-base',
      '--is-ancestor',
      pending.before.headSha,
      options.remoteSha,
    );
  const expectedHead = recoveredCommit ?? state.headSha;
  const unchanged = now.headSha === expectedHead && options.remoteSha === expectedHead;
  const workingTreeMatches = now.treeHash === state.current.treeHash;
  const verified = receipts.filter((r) => receiptValid(r, state, expectedHead));
  let next = state.phase,
    round = state.round,
    reason = 'Continue saved phase';
  if (!gitSucceeds(options.checkout, 'merge-base', '--is-ancestor', 'origin/main', now.headSha)) {
    next = 'sync';
    reason = 'Current main must be synchronized before consuming saved review results';
  } else if (recoveredCommit) {
    if (options.remoteSha === recoveredCommit) {
      next = 'review';
      round = Math.max(round, (pending?.round ?? state.round) + 1);
      reason = 'Pending commit already reached the remote; review it without another push';
    } else {
      next = 'push';
      reason = 'Pending commit already exists; push it instead of committing again';
    }
  } else if (
    now.headSha === state.headSha &&
    options.remoteSha !== state.headSha &&
    gitSucceeds(options.checkout, 'merge-base', '--is-ancestor', options.remoteSha, now.headSha)
  ) {
    next = 'push';
    reason = 'Local commits must be pushed before consuming saved results';
  } else if (!unchanged) {
    next = 'review';
    round++;
    reason = 'Reviewed commit changed; retain history and review the new commit';
  } else if (pushCompleted) {
    next = 'review';
    round = Math.max(round, pending.round + 1);
    reason = 'Pending push already reached the remote; review the pushed fixes';
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
  if (next === 'complete') {
    next = 'ci';
    reason = 'Recheck GitHub CI against the current remote head before reusing a clean result';
  }
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
  if (!workingTreeMatches && ['verify', 'commit'].includes(next)) {
    next = 'fixes';
    reason = 'Working changes differ from the checkpoint; inspect ownership before continuing';
  }
  return {
    reusable: unchanged ? reusable : [],
    active,
    workingTreeMatches,
    recoveredCommit,
    pushCompleted,
    reason,
    phase: next,
    round,
  };
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
    : {
        reusable: [],
        active: [],
        workingTreeMatches: true,
        recoveredCommit: null,
        pushCompleted: false,
        reason: 'New review',
        phase: 'sync' as Phase,
        round: 1,
      };
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
  const current = capture(options.checkout, previous ? Object.keys(previous.owned) : []);
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
        claudeEffort: options.claudeEffort ?? 'high',
        phase: recovery.phase,
        round: recovery.round,
        status: 'running',
        nextAction: recovery.reason,
        headSha: current.headSha,
        remoteSha: options.remoteSha,
        mainSha: null,
        baseline: current,
        current,
        owned: {},
        operations: [],
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
    claudeEffort: options.claudeEffort ?? previous?.claudeEffort ?? 'high',
    phase: recovery.phase,
    round: recovery.round,
    status: 'running',
    nextAction: recovery.reason,
    headSha: current.headSha,
    remoteSha: options.remoteSha,
    current,
    interruption: null,
  });
  if (
    previous &&
    (current.headSha !== previous.headSha || options.remoteSha !== previous.remoteSha)
  ) {
    state.ci = { ...state.ci, status: 'not-run', headSha: null };
  }
  if (previous && !recovery.workingTreeMatches) state.ci.status = 'not-run';
  if (previous) {
    const dirty = new Set(dirtyPaths(current.status));
    state.baseline = {
      ...current,
      files: Object.fromEntries(
        Object.entries(current.files).filter(
          ([name, digest]) =>
            dirty.has(name) && (!state.owned[name] || state.owned[name].hash !== digest),
        ),
      ),
    };
  }
  if (recovery.recoveredCommit) {
    const op = [...state.operations]
      .reverse()
      .find((o) => o.phase === 'commit' && o.after === null);
    if (op) {
      op.commit = recovery.recoveredCommit;
      retireCommittedOwnership(state, op.before.headSha, recovery.recoveredCommit);
      op.after = capture(options.checkout, Object.keys(state.owned));
    }
    state.current = capture(options.checkout, Object.keys(state.owned));
  }
  if (recovery.pushCompleted) {
    const op = [...state.operations].reverse().find((o) => o.phase === 'push' && o.after === null);
    if (op) op.after = current;
  }
  const release = await acquire([contained(run, join(run, 'checkpoint.lock'))]);
  try {
    persist(state);
  } finally {
    await release();
  }
  return { ...recovery, state };
}

/** Protect newly observed foreign edits without claiming or changing their contents. */
export async function protectChanges(run: string): Promise<ReviewState> {
  return updateState(run, (state) => {
    const observed = capture(state.checkout, Object.keys(state.owned));
    const dirty = new Set(dirtyPaths(observed.status));
    state.baseline = {
      ...observed,
      files: Object.fromEntries(
        Object.entries(observed.files).filter(
          ([name, digest]) =>
            dirty.has(name) && (!state.owned[name] || state.owned[name].hash !== digest),
        ),
      ),
    };
  });
}

/** A commit may cover only one area; untouched fixes retain their original ownership proof. */
function retireCommittedOwnership(state: ReviewState, parent: string, commit: string): void {
  const committed = gitRaw(
    state.checkout,
    'diff',
    '--no-renames',
    '--name-only',
    '-z',
    parent,
    commit,
    '--',
  )
    .split('\0')
    .filter(Boolean);
  for (const name of committed) delete state.owned[name];
}

/** Merge ancestry belongs to a recorded synchronization, not just an observed MERGE_HEAD. */
function expectedCommitParents(state: ReviewState, head: string): string[] {
  const mergeFile = resolve(
    state.checkout,
    git(state.checkout, 'rev-parse', '--git-path', 'MERGE_HEAD'),
  );
  if (!existsSync(mergeFile)) return [head];
  const mergeHeads = readFileSync(mergeFile, 'utf8').trim().split(/\s+/);
  const synchronization = state.operations.some(
    (op) =>
      op.phase === 'sync' &&
      op.before.headSha === head &&
      record(op.data) &&
      strings(op.data.mergeHeads) &&
      op.data.mergeHeads.length === mergeHeads.length &&
      op.data.mergeHeads.every((parent, i) => parent === mergeHeads[i]),
  );
  if (!mergeHeads.every(sha) || !synchronization)
    throw new Error('Merge parents have no matching owned synchronization');
  return [head, ...mergeHeads];
}

export async function beginOperation(
  run: string,
  id: string,
  step: Phase,
  paths: string[] = [],
  data: Json = null,
): Promise<ReviewState> {
  return updateState(run, (state) => {
    assertCheckout(state.checkout, state);
    if (state.operations.some((op) => op.id === id))
      throw new Error(`Operation already recorded: ${id}`);
    for (const name of paths) {
      sourcePath(state.checkout, name);
      if (name in state.baseline.files && !(name in state.owned))
        throw new Error(`Unfamiliar baseline edit: ${name}`);
      const owned = state.owned[name];
      if (owned && fileHash(state.checkout, name) !== owned.hash)
        throw new Error(`Owned file changed outside the checkpoint: ${name}`);
      if (
        !owned &&
        gitRaw(
          state.checkout,
          'status',
          '--porcelain=v1',
          '-z',
          '--untracked-files=all',
          '--',
          name,
        )
      )
        throw new Error(`Unrecorded edit: ${name}`);
    }
    if (step === 'commit') {
      const staged = gitRaw(state.checkout, 'diff', '--cached', '--no-renames', '--name-only', '-z')
        .split('\0')
        .filter(Boolean);
      for (const name of staged) {
        const owned = state.owned[name];
        if (
          !owned ||
          fileHash(state.checkout, name) !== owned.hash ||
          gitRaw(state.checkout, 'diff', '--name-only', '--', name).trim()
        )
          throw new Error(`Commit includes unowned or partially staged bytes: ${name}`);
      }
    }
    const before = capture(state.checkout, [...new Set([...Object.keys(state.owned), ...paths])]);
    const expectedTree =
      step === 'commit' && gitSucceeds(state.checkout, 'write-tree')
        ? git(state.checkout, 'write-tree')
        : null;
    const expectedParents = step === 'commit' ? expectedCommitParents(state, before.headSha) : null;
    state.phase = step;
    state.current = before;
    state.headSha = before.headSha;
    state.status = 'running';
    state.operations.push({
      id,
      phase: step,
      round: state.round,
      before,
      after: null,
      paths,
      expectedTree,
      expectedParents,
      commit: null,
      data,
    });
  });
}

export async function finishOperation(
  run: string,
  id: string,
  next: Phase,
  nextAction: string,
  data: Json = null,
): Promise<ReviewState> {
  return updateState(run, (state) => {
    assertCheckout(state.checkout, state);
    const op = state.operations.find((entry) => entry.id === id);
    if (!op || op.after !== null) throw new Error(`No pending operation: ${id}`);
    for (const name of op.paths) {
      const file = sourcePath(state.checkout, name),
        old = state.owned[name];
      const content = existsSync(file) ? readFileSync(file).toString('base64') : null;
      state.owned[name] = {
        baseHash: old ? old.baseHash : (op.before.files[name] ?? null),
        hash: content === null ? null : hash(Buffer.from(content, 'base64')),
        content,
        mode: existsSync(file) ? lstatSync(file).mode : (old?.mode ?? 0o644),
      };
    }
    op.after = capture(state.checkout, Object.keys(state.owned));
    op.data = data;
    if (op.phase === 'commit') {
      op.commit = op.after.headSha;
      retireCommittedOwnership(state, op.before.headSha, op.commit);
      op.after = capture(state.checkout, Object.keys(state.owned));
    }
    state.current = op.after;
    state.headSha = op.after.headSha;
    state.phase = next;
    state.nextAction = nextAction;
  });
}

/** Replay only saved owned bytes, and only onto the exact base bytes they replaced. */
export function restoreOwned(state: ReviewState, checkout: string): string[] {
  if (repository(checkout) !== state.repository)
    throw new Error('Restore checkout is from another repository');
  const entries = Object.entries(state.owned);
  for (const [name, file] of entries) {
    sourcePath(checkout, name);
    if (fileHash(checkout, name) !== file.baseHash)
      throw new Error(`Restore base differs: ${name}`);
  }
  for (const [name, file] of entries) {
    const path = sourcePath(checkout, name);
    if (file.content === null) {
      if (existsSync(path)) unlinkSync(path);
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, Buffer.from(file.content, 'base64'), { mode: file.mode });
      chmodSync(path, file.mode);
    }
  }
  return entries.map(([name]) => name);
}
