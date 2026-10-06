/** JSON-file inputs avoid PowerShell quoting issues and keep review subprocesses shell-free. */
import { pathToFileURL } from 'node:url';
import {
  beginOperation,
  finishOperation,
  loadState,
  parseClaudeEffort,
  protectChanges,
  readJson,
  record,
  restoreOwned,
  selectState,
  startReview,
  updateState,
} from './pr-review-checkpoint';
import type { Json, Phase, StartOptions } from './pr-review-checkpoint';
import { phases } from './pr-review-checkpoint';
import { importLegacy, legacySource } from './pr-review-legacy';
import { reviewScope } from './pr-review-scope';
import {
  parseProcessSpec,
  publishInterrupted,
  receiptActive,
  runProcess,
} from './pr-review-process';

function string(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || !value) throw new Error(`Expected ${key} string`);
  return value;
}

function step(input: Record<string, unknown>, key: string): Phase {
  const value = string(input, key);
  if (!phases.some((p) => p === value)) throw new Error(`Invalid ${key}`);
  return value as Phase;
}

function startOptions(input: Record<string, unknown>): StartOptions {
  if (typeof input.pr !== 'number' || !Number.isSafeInteger(input.pr) || input.pr < 1)
    throw new Error('Expected PR number');
  for (const key of ['fresh', 'fast'])
    if (key in input && typeof input[key] !== 'boolean') throw new Error(`Expected ${key} boolean`);
  if ('resume' in input && typeof input.resume !== 'string')
    throw new Error('Expected resume path');
  return {
    checkout: string(input, 'checkout'),
    pr: input.pr,
    branch: string(input, 'branch'),
    remoteSha: string(input, 'remoteSha'),
    fast: input.fast as boolean | undefined,
    claudeEffort: 'claudeEffort' in input ? parseClaudeEffort(input.claudeEffort) : undefined,
    fresh: input.fresh as boolean | undefined,
    resume: input.resume as string | undefined,
  };
}

export async function command(
  action: string,
  input: Record<string, unknown>,
): Promise<{ value: unknown; exitCode: number }> {
  let value: unknown;
  if (action === 'init' || action === 'inspect') {
    const options = startOptions(input);
    let previous;
    try {
      previous = selectState(options);
    } catch (error) {
      if (
        options.fresh ||
        !options.resume ||
        !(error instanceof Error && error.message.startsWith('No valid checkpoint'))
      )
        throw error;
    }
    const legacy = !previous && !options.fresh ? legacySource(options) : null;
    if (options.resume && !previous && !legacy)
      throw new Error('No verifiable checkpoint or legacy invocation at the selected path');
    value =
      action === 'inspect'
        ? { checkpoint: previous ?? null, legacy }
        : previous
          ? await startReview(options, previous, receiptActive)
          : legacy
            ? await importLegacy(options, legacy)
            : await startReview(options, null, receiptActive);
  } else if (action === 'show') value = loadState(string(input, 'run'));
  else if (action === 'protect') value = await protectChanges(string(input, 'run'));
  else if (action === 'scope') {
    if (typeof input.round !== 'number' || !Number.isSafeInteger(input.round) || input.round < 1)
      throw new Error('Expected round number');
    value = reviewScope(string(input, 'run'), input.round);
  } else if (action === 'begin') {
    if (
      'paths' in input &&
      (!Array.isArray(input.paths) || !input.paths.every((p: unknown) => typeof p === 'string'))
    )
      throw new Error('Expected source paths array');
    value = await beginOperation(
      string(input, 'run'),
      string(input, 'id'),
      step(input, 'phase'),
      input.paths as string[] | undefined,
      (input.data ?? null) as Json,
    );
  } else if (action === 'finish')
    value = await finishOperation(
      string(input, 'run'),
      string(input, 'id'),
      step(input, 'next'),
      string(input, 'nextAction'),
      (input.data ?? null) as Json,
    );
  else if (action === 'record') {
    const allowed = [
      'phase',
      'round',
      'status',
      'nextAction',
      'remoteSha',
      'mainSha',
      'history',
      'rejected',
      'ci',
      'interruption',
      'report',
    ];
    if (!record(input.patch) || Object.keys(input.patch).some((key) => !allowed.includes(key)))
      throw new Error('Invalid checkpoint patch');
    const patch = input.patch;
    value = await updateState(string(input, 'run'), (state) => {
      Object.assign(state, patch);
    });
  } else if (action === 'restore')
    value = restoreOwned(loadState(string(input, 'run')), string(input, 'checkout'));
  else if (action === 'interrupt') {
    const run = string(input, 'run');
    await updateState(run, (state) => {
      state.status = 'interrupted';
      state.interruption = {
        reason:
          typeof input.reason === 'string'
            ? input.reason
            : (state.interruption?.reason ?? 'Coordinator interrupted'),
        reset: typeof input.reset === 'string' ? input.reset : (state.interruption?.reset ?? null),
      };
    });
    value = publishInterrupted(
      run,
      typeof input.resultFile === 'string' ? input.resultFile : undefined,
    );
  } else if (action === 'run') {
    const result = await runProcess(parseProcessSpec(input));
    return { value: result, exitCode: result.receipt.quota ? 75 : result.receipt.valid ? 0 : 1 };
  } else
    throw new Error(
      'Expected inspect, init, show, protect, scope, begin, finish, record, run, restore, or interrupt',
    );
  return { value, exitCode: 0 };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const [action, flag, file, ...rest] = process.argv.slice(2);
    if (!action || flag !== '--input' || !file || rest.length)
      throw new Error('usage: pnpm review:state <action> --input <absolute JSON path>');
    const input = readJson(file);
    if (!record(input)) throw new Error('Expected JSON object input');
    const result = await command(action, input);
    console.log(JSON.stringify(result.value, null, 2));
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
