import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, gitRaw } from './git';
import {
  atomicJson,
  hash,
  loadState,
  parseReceipt,
  readJson,
  receiptValid,
  updateState,
} from './pr-review-checkpoint';
import type { Receipt, ReviewState, StartOptions } from './pr-review-checkpoint';

export const reviewText =
  '**Verdict:** Approve — checked\n\n**Checked, no issues:** A correctness · B performance\n**Not checked:** visuals\n';
export const validationText =
  "**Claude's verdict:** Approve\n\n### Validation\n| # | Claude's severity | Entry | Verdict | Evidence | Final severity |\n| --- | --- | --- | --- | --- | --- |\n\n### Fix steps\nNo valid entries\n\n### Noticed, not in Claude's review\nNone\n";

export function fixture(): { directory: string; options: StartOptions } {
  const directory = mkdtempSync(join(tmpdir(), 'pr-review-'));
  git(directory, 'init', '-q');
  git(directory, 'symbolic-ref', 'HEAD', 'refs/heads/codex/test');
  git(directory, 'config', 'user.name', 'Review fixture');
  git(directory, 'config', 'user.email', 'review@example.invalid');
  git(directory, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(directory, '.gitignore'), '.plans/\n');
  writeFileSync(join(directory, 'file.txt'), 'before\n');
  git(directory, 'add', '--', '.gitignore', 'file.txt');
  git(directory, 'commit', '-qm', 'fixture');
  const head = git(directory, 'rev-parse', 'HEAD');
  git(directory, 'update-ref', 'refs/remotes/origin/main', head);
  return {
    directory,
    options: { checkout: directory, pr: 12, branch: 'codex/test', remoteSha: head },
  };
}

export async function artifact(
  state: ReviewState,
  kind: 'review' | 'validation',
  changes: Partial<Receipt> = {},
): Promise<{ path: string; receipt: Receipt }> {
  const token = randomUUID();
  const output = join(state.run, `saved-${kind}-${token}.md`);
  writeFileSync(output, kind === 'review' ? reviewText : validationText);
  const review = loadState(state.run)
    .receipts.map((file) => parseReceipt(readJson(file)))
    .reverse()
    .find(
      (r) =>
        r.phase === 'review' && r.round === state.round && receiptValid(r, state, state.headSha),
    );
  const receipt: Receipt = {
    version: 1,
    repository: state.repository,
    pr: state.pr,
    branch: state.branch,
    token,
    phase: kind,
    round: state.round,
    headSha: state.headSha,
    executable: process.execPath,
    args: [],
    cwd: state.checkout,
    report: output,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    launcherPid: process.pid,
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
    ...changes,
  };
  const path = join(state.run, `saved-${kind}-${token}-receipt.json`);
  atomicJson(path, receipt);
  await updateState(state.run, (saved) => {
    saved.receipts.push(path);
  });
  return { path, receipt };
}

export function commit(checkout: string): string {
  gitRaw(checkout, 'add', '--', 'file.txt');
  git(checkout, 'commit', '-qm', 'fix');
  return git(checkout, 'rev-parse', 'HEAD');
}
