import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicJson, contained, hash, loadState, record } from './pr-review-checkpoint';
import type { Json } from './pr-review-checkpoint';
import { git, gitRaw, gitSucceeds } from './git';

/** A larger change gets the full review; a fix-sized one is reviewed as a delta. */
export const deltaLineLimit = 800;
/** Dependencies, build/CI configuration and agent instructions always get a full review. */
const structural = [
  /(^|\/)package\.json$/,
  /(^|\/)pnpm-(lock|workspace)\.yaml$/,
  /^\.github\//,
  /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)[^/]+\.config\.[cm]?[jt]s$/,
  /^\.(claude|agents)\//,
];

export type ReviewScope = {
  mode: 'full' | 'delta';
  head: string;
  since: string | null;
  reason: string;
  files: string[];
  changedLines: number;
  ledgerHash: string | null;
  deltaHash: string | null;
};
/** Paths are returned beside the scope, never saved in it, so its hash is the same in every invocation. */
export type ScopeFiles = { path: string; ledger: string | null; delta: string | null };

type Prior = { round: number; reviewedHead: string };

function priorReview(history: Json[], round: number): Prior | null {
  for (const entry of [...history].reverse())
    if (
      record(entry) &&
      typeof entry.round === 'number' &&
      entry.round < round &&
      typeof entry.reviewedHead === 'string' &&
      /^[a-f0-9]{40,64}$/.test(entry.reviewedHead)
    )
      return { round: entry.round, reviewedHead: entry.reviewedHead };
  return null;
}

const text = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';

/** Stable IDs `r<round>.<id>` come from the round that first recorded an entry. */
export function renderLedger(history: Json[], rejected: string): string | null {
  const lines: string[] = [];
  for (const round of history) {
    if (!record(round) || !Array.isArray(round.entries)) continue;
    for (const entry of round.entries) {
      if (!record(entry)) continue;
      const id = `r${text(round.round)}.${text(entry.id)}`;
      const where = `${text(entry.path)}${entry.line == null ? '' : `:${text(entry.line)}`}`;
      const detail = [
        text(entry.finalSeverity ?? entry.claudeSeverity),
        text(entry.verdict),
        text(entry.outcome),
        entry.commit ? `commit ${text(entry.commit)}` : '',
        entry.repeat ? `repeat of round ${text(entry.repeat)}` : '',
        entry.openReason ? `open: ${text(entry.openReason)}` : '',
      ].filter(Boolean);
      lines.push(`- **${id}** \`${where}\` — ${text(entry.claim)} (${detail.join(', ')})`);
    }
  }
  const decisions = rejected.trim();
  if (!lines.length && !decisions) return null;
  return [
    '# Review ledger',
    '',
    'Findings from earlier rounds of this review. Refer to an entry by its ID when it is still unresolved; moved lines keep their ID.',
    '',
    ...(lines.length ? lines : ['None.']),
    ...(decisions ? ['', '## Rejected decisions', '', decisions] : []),
    '',
  ].join('\n');
}

function select(
  checkout: string,
  head: string,
  prior: Prior | null,
): Omit<ReviewScope, 'ledgerHash' | 'deltaHash'> {
  const full = (reason: string, since: string | null = null) => ({
    mode: 'full' as const,
    head,
    since,
    reason,
    files: [],
    changedLines: 0,
  });
  if (!prior) return full('No earlier reviewed commit in this review');
  const since = prior.reviewedHead;
  if (since === head) return full('No commits since the last reviewed commit', since);
  if (!gitSucceeds(checkout, 'merge-base', '--is-ancestor', since, head))
    return full('The last reviewed commit is not an ancestor of HEAD', since);
  // Main moves every hour while several tasks run; a clean synchronization merge is not new
  // branch work. Only a merge that combined both sides' edits to the same file needs a full look.
  const merges = git(checkout, 'rev-list', '--merges', `${since}..${head}`);
  for (const merge of merges ? merges.split('\n') : []) {
    const names = (parent: string) =>
      new Set(git(checkout, 'diff', '--name-only', `${merge}^${parent}`, merge).split('\n'));
    const shared = [...names('1')].filter((file) => file && names('2').has(file)).sort();
    if (shared.length)
      return full(
        `Main synchronization ${merge.slice(0, 7)} combined both sides' changes to ${shared.join(', ')}`,
        since,
      );
  }
  let changedLines = 0;
  const files: string[] = [];
  const numstat = merges
    ? gitRaw(
        checkout,
        'log',
        '--numstat',
        '--first-parent',
        '--no-merges',
        '--format=',
        '-z',
        `${since}..${head}`,
      )
    : gitRaw(checkout, 'diff', '--numstat', '-z', since, head);
  for (const line of numstat.split(/\0|\n/)) {
    const [added, deleted, path] = line.split('\t');
    if (!path) continue;
    if (!files.includes(path)) files.push(path);
    if (added === '-' || deleted === '-') return full(`Binary change in ${path}`, since);
    changedLines += Number(added) + Number(deleted);
  }
  files.sort();
  const config = files.find((file) => structural.some((pattern) => pattern.test(file)));
  if (config) return { ...full(`Structural file changed: ${config}`, since), files, changedLines };
  if (changedLines > deltaLineLimit)
    return {
      ...full(`${changedLines} changed lines exceed the ${deltaLineLimit}-line delta limit`, since),
      files,
      changedLines,
    };
  return {
    mode: 'delta',
    head,
    since,
    reason: merges
      ? `Fix commits since round ${prior.round}; a clean main synchronization is left out`
      : `Fixes since round ${prior.round}`,
    files,
    changedLines,
  };
}

/** The patch a delta round reviews: the branch's own commits, never what a synchronization merged in. */
function deltaPatch(checkout: string, since: string, head: string): string {
  return git(checkout, 'rev-list', '--merges', `${since}..${head}`)
    ? gitRaw(
        checkout,
        'log',
        '-p',
        '--first-parent',
        '--no-merges',
        '--reverse',
        '--format=commit %H%n%s%n',
        `${since}..${head}`,
      )
    : gitRaw(checkout, 'diff', since, head);
}

/**
 * Chooses the round's review scope and writes `scope.json`, `ledger.md` and, for a delta,
 * `delta.patch` in `round<k>/`. The output is deterministic for the same commits and history,
 * so a resumed round reproduces the hash its receipts were bound to.
 */
export function reviewScope(run: string, round: number): ReviewScope & ScopeFiles {
  const state = loadState(run);
  if (round !== state.round) throw new Error('Scope round does not match checkpoint');
  const head = git(state.checkout, 'rev-parse', 'HEAD');
  if (head !== state.headSha) throw new Error('Checkpoint head does not match the checkout');
  const folder = contained(run, join(run, `round${round}`));
  const chosen = select(state.checkout, head, priorReview(state.history, round));
  const ledgerText = renderLedger(state.history, state.rejected);
  const ledger = ledgerText === null ? null : join(folder, 'ledger.md');
  const patch =
    chosen.mode === 'delta' && chosen.since ? deltaPatch(state.checkout, chosen.since, head) : null;
  const delta = patch === null ? null : join(folder, 'delta.patch');
  mkdirSync(folder, { recursive: true });
  if (ledger && ledgerText !== null) writeFileSync(ledger, ledgerText, 'utf8');
  if (delta && patch !== null) writeFileSync(delta, patch, 'utf8');
  const scope: ReviewScope = {
    ...chosen,
    ledgerHash: ledgerText === null ? null : hash(ledgerText),
    deltaHash: patch === null ? null : hash(patch),
  };
  const path = join(folder, 'scope.json');
  atomicJson(path, scope);
  return { ...scope, path, ledger, delta };
}
