import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  atomicJson,
  contained,
  discoverRuns,
  hash,
  readJson,
  record,
  startReview,
  updateState,
} from './pr-review-checkpoint';
import type { Json, Receipt, Recovery, StartOptions } from './pr-review-checkpoint';
import { git, gitSucceeds, mainCheckout } from './git';
import { receiptActive, reportComplete } from './pr-review-process';
import { readFileSync } from 'node:fs';

function optional(file: string): Record<string, unknown> | null {
  try {
    const value = readJson(file);
    return record(value) ? value : null;
  } catch {
    return null;
  }
}

/** Bounded discovery: inspect invocation roots and known attempt folders, never scratch archives. */
export function legacySource(options: StartOptions): string | null {
  if (options.fresh) return null;
  const main = mainCheckout(options.checkout);
  const paths = options.resume
    ? [contained(join(main, '.plans'), options.resume)]
    : discoverRuns(main, options.pr);
  return (
    paths
      .filter((run) => {
        const invocation = optional(join(run, 'invocation.json'));
        const result = optional(join(run, 'result.json'));
        const pr = optional(join(run, 'pr-round1.json'));
        return (
          (invocation?.pr ?? result?.pr ?? pr?.number) === options.pr &&
          (invocation?.branch ?? pr?.headRefName) === options.branch
        );
      })
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null
  );
}

function validHistory(value: unknown, checkout: string): value is Json {
  if (
    !record(value) ||
    !Number.isSafeInteger(value.round) ||
    Number(value.round) < 1 ||
    !Array.isArray(value.commits) ||
    !Array.isArray(value.entries)
  )
    return false;
  const originalCommits: unknown[] = value.commits;
  const entries: unknown[] = value.entries;
  const commits = [
    ...originalCommits,
    ...entries.flatMap((entry: unknown) =>
      record(entry) && entry.outcome === 'fixed' ? [entry.commit] : [],
    ),
  ];
  return commits.every(
    (commit: unknown) =>
      typeof commit === 'string' &&
      /^[a-f0-9]{7,64}$/.test(commit) &&
      gitSucceeds(checkout, 'merge-base', '--is-ancestor', commit, 'HEAD'),
  );
}

function attempts(folder: string): string[] {
  if (!existsSync(folder)) return [];
  return [
    folder,
    ...readdirSync(folder, { withFileTypes: true })
      .filter(
        (e) =>
          e.isDirectory() &&
          !e.isSymbolicLink() &&
          /^(?:attempt-|validation-attempt-)/.test(e.name),
      )
      .map((e) => join(folder, e.name)),
  ];
}

/** Import verified legacy records into a new invocation; the source remains read-only. */
export async function importLegacy(options: StartOptions, source: string): Promise<Recovery> {
  if (legacySource({ ...options, resume: source }) !== source)
    throw new Error('Legacy invocation identity could not be verified');
  const recovery = await startReview({ ...options, resume: undefined }, null, receiptActive);
  const result = optional(join(source, 'result.json'));
  const folders = readdirSync(source)
    .filter((name) => /^round\d+$/.test(name))
    .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
  const history: Json[] = folders.flatMap<Json>((folder) => {
    const value = optional(join(source, folder, 'result.json'));
    return validHistory(value, options.checkout) ? [value] : [];
  });
  if (!history.length && Array.isArray(result?.rounds)) {
    const rounds: unknown[] = result.rounds;
    history.push(...rounds.filter((v: unknown): v is Json => validHistory(v, options.checkout)));
  }
  const lastCompleted = Math.max(0, ...history.map((h) => (record(h) ? Number(h.round) : 0)));
  const latestFolder = Math.max(0, ...folders.map((name) => Number(name.slice(5))));
  const lastRecord = history.find((h) => record(h) && h.round === lastCompleted);
  const cleanCandidate =
    lastCompleted > 0 &&
    latestFolder === lastCompleted &&
    record(lastRecord) &&
    Array.isArray(lastRecord.entries) &&
    lastRecord.entries.every(
      (entry: unknown) =>
        record(entry) &&
        (entry.verdict === 'invalid' || entry.outcome === 'open' || entry.finalSeverity === 'nit'),
    );
  const activeRound = cleanCandidate ? lastCompleted : Math.max(lastCompleted + 1, latestFolder);
  const head =
    optional(join(source, `pr-round${activeRound}.json`)) ??
    optional(join(source, `round${activeRound}`, 'input.json'));
  const inputSha = head?.headRefOid ?? head?.headSha;
  const receipts: string[] = [];
  if (
    inputSha === options.remoteSha &&
    git(options.checkout, 'rev-parse', 'HEAD') === options.remoteSha
  ) {
    const roundRoot = join(source, `round${activeRound}`);
    for (const kind of ['review', 'validation'] as const) {
      const name = kind === 'review' ? 'claude-review.md' : 'validation.md';
      const candidates = [
        ...attempts(roundRoot),
        ...attempts(join(roundRoot, kind === 'review' ? 'claude' : 'codex')),
        ...attempts(join(roundRoot, kind)),
      ];
      for (const folder of candidates) {
        const output = join(folder, name),
          exit = optional(join(folder, 'exit.json'));
        if (
          exit?.exitCode !== 0 ||
          typeof exit.started !== 'string' ||
          typeof exit.ended !== 'string' ||
          !existsSync(output)
        )
          continue;
        contained(source, output);
        const body = readFileSync(output, 'utf8').replace(/^\uFEFF/, '');
        if (!reportComplete(kind, body)) continue;
        const review = recovery.reusable.find((r) => r.phase === 'review');
        if (
          kind === 'validation' &&
          (!review ||
            exit.reviewReport !== review.report ||
            exit.reviewReportHash !== review.reportHash)
        )
          continue;
        const path = join(recovery.state.run, 'legacy', `${kind}-receipt.json`);
        const receipt: Receipt = {
          version: 1,
          repository: recovery.state.repository,
          pr: options.pr,
          branch: options.branch,
          token: `legacy:${folder}`,
          phase: kind,
          round: activeRound,
          headSha: options.remoteSha,
          executable: 'legacy (not executable)',
          args: [],
          cwd: options.checkout,
          report: output,
          startedAt: exit.started,
          finishedAt: exit.ended,
          launcherPid: 0,
          launcherIdentity: null,
          childPid: null,
          childIdentity: null,
          status: 'completed',
          exitCode: 0,
          signal: null,
          reportHash: hash(readFileSync(output)),
          inputReview:
            kind === 'validation' && review
              ? { token: review.token, reportHash: review.reportHash! }
              : null,
          valid: true,
          quota: null,
          error: null,
        };
        atomicJson(path, receipt);
        receipts.push(path);
        recovery.reusable.push(receipt);
        break;
      }
    }
  }
  const hasReview = recovery.reusable.some((r) => r.phase === 'review');
  const hasValidation = recovery.reusable.some((r) => r.phase === 'validation');
  const state = await updateState(recovery.state.run, (saved) => {
    saved.resumedFrom = source;
    saved.history = history;
    saved.round = activeRound;
    saved.receipts = receipts;
    saved.phase = hasReview
      ? hasValidation
        ? cleanCandidate
          ? 'ci'
          : 'fixes'
        : 'validation'
      : 'review';
    if (!gitSucceeds(options.checkout, 'merge-base', '--is-ancestor', 'origin/main', 'HEAD'))
      saved.phase = 'sync';
    saved.nextAction = `Recovered legacy history; continue ${saved.phase} in round ${activeRound}`;
    const rejected = join(source, 'rejected.md');
    if (existsSync(rejected)) saved.rejected = readFileSync(contained(source, rejected), 'utf8');
    // Legacy dirty files have no byte-level ownership record and remain baseline edits.
  });
  return { ...recovery, state, reason: state.nextAction };
}
