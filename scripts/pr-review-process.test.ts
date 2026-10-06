import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadState, readJson, startReview, updateState } from './pr-review-checkpoint';
import { artifact, fixture, reviewText, validationText } from './pr-review-fixture';
import { command } from './pr-review-state';
import {
  publishInterrupted,
  quotaFailure,
  receiptActive,
  reportComplete,
  runProcess,
} from './pr-review-process';

let setup: ReturnType<typeof fixture>;
beforeEach(() => {
  setup = fixture();
});
afterEach(() => {
  rmSync(setup.directory, { recursive: true, force: true });
});

describe('review process receipts', () => {
  it('captures stdout and individual arguments without a shell', async () => {
    const { state } = await startReview(setup.options);
    const result = await runProcess({
      run: state.run,
      phase: 'review',
      round: 1,
      headSha: state.headSha,
      executable: process.execPath,
      args: ['-e', 'process.stdout.write(process.argv[1])', reviewText],
      output: 'stdout',
    });
    expect(result.receipt.exitCode).toBe(0);
    expect(result.receipt.valid).toBe(true);
    expect(readFileSync(result.receipt.report, 'utf8')).toBe(reviewText);
    expect(readJson(result.path)).toMatchObject({ status: 'completed', valid: true });
  });

  it('writes file-output completion independently and resumes without running the reviewer again', async () => {
    const { state } = await startReview(setup.options);
    await updateState(state.run, (saved) => {
      saved.phase = 'validation';
    });
    await artifact(state, 'review');
    const result = await runProcess({
      run: state.run,
      phase: 'validation',
      round: 1,
      headSha: state.headSha,
      executable: process.execPath,
      args: [
        '-e',
        'require("node:fs").writeFileSync(process.argv[1], process.argv[2])',
        '{report}',
        validationText,
      ],
      output: 'file',
    });
    expect(result.receipt.valid).toBe(true);
    const recovered = await startReview(setup.options, loadState(state.run), receiptActive);
    expect(recovered.state.phase).toBe('fixes');
    expect(recovered.reusable).toHaveLength(2);
  });

  it('saves quota exhaustion immediately and publishes a usable interrupted result', async () => {
    const { state } = await startReview(setup.options);
    await updateState(state.run, (saved) => {
      saved.phase = 'review';
      saved.ci.status = 'pending';
    });
    const result = await command('run', {
      run: state.run,
      phase: 'review',
      round: 1,
      headSha: state.headSha,
      executable: process.execPath,
      args: [
        '-e',
        'console.error("You\'ve hit your session limit · resets 12:10pm (Asia/Manila)"); process.exit(1)',
      ],
      output: 'stdout',
    });
    expect(result.exitCode).toBe(75);
    const saved = loadState(state.run);
    expect(saved.status).toBe('interrupted');
    expect(saved.interruption?.reset).toBe('resets 12:10pm (Asia/Manila)');
    const published = publishInterrupted(state.run);
    expect(published).toMatchObject({
      status: 'interrupted',
      ci: { status: 'pending' },
      resume: { phase: 'review', round: 1, checkpoint: state.run },
    });
    expect(existsSync(`${state.run}/result.json`)).toBe(true);
  });

  it('keeps capacity failures, partial reports and spawn failures eligible for retry', async () => {
    const { state } = await startReview(setup.options);
    const result = await runProcess({
      run: state.run,
      phase: 'review',
      round: 1,
      headSha: state.headSha,
      executable: process.execPath,
      args: [
        '-e',
        'console.log("**Verdict:** Approve"); console.error("model at capacity; retry later"); process.exit(1)',
      ],
      output: 'stdout',
    });
    expect(result.receipt.valid).toBe(false);
    expect(result.receipt.quota).toBeNull();
    const failed = await runProcess({
      run: state.run,
      phase: 'review',
      round: 1,
      headSha: state.headSha,
      executable: `${process.execPath}.missing`,
      args: [],
      output: 'stdout',
    });
    expect(failed.receipt.error).toBeTruthy();
    expect(failed.receipt.valid).toBe(false);
    expect(loadState(state.run).status).toBe('running');
  });

  it('detects structured quota errors without turning ordinary 429s or review claims into interruptions', () => {
    expect(quotaFailure('{"error":{"code":"usage_limit_reached"}}')).toMatchObject({ reset: null });
    expect(quotaFailure('{"error":{"code":"rate_limit_exceeded"}}')).toBeNull();
    expect(quotaFailure('HTTP 429: too many requests')).toBeNull();
    expect(reportComplete('review', '**Verdict:** Approve')).toBe(false);
    expect(reportComplete('validation', '### Validation\n| # | other |')).toBe(false);
  });

  it('propagates coordinator quota exhaustion to the caller result without changing Git files', async () => {
    const { state } = await startReview(setup.options);
    await updateState(state.run, (saved) => {
      saved.phase = 'fixes';
      saved.report.mainMerge = 'current';
      saved.history = [{ round: 1, entries: [], commits: [] }];
    });
    const copy = join(setup.directory, '.plans', 'active', 'caller', 'review.json');
    const before = readFileSync(join(setup.directory, 'file.txt'));
    const result = await runProcess({
      run: state.run,
      phase: 'coordinator',
      round: 1,
      headSha: state.headSha,
      executable: process.execPath,
      args: [
        '-e',
        "console.error(JSON.stringify({error:{code:'usage_limit_reached'}}));process.exit(1)",
        '{report}',
      ],
      output: 'file',
      resultFile: copy,
    });
    expect(result.receipt.quota).toBeTruthy();
    expect(readJson(copy)).toEqual(readJson(join(state.run, 'result.json')));
    expect(readJson(copy)).toMatchObject({
      status: 'interrupted',
      mainMerge: 'current',
      resume: { phase: 'fixes' },
      rounds: [{ round: 1 }],
    });
    expect(readFileSync(join(setup.directory, 'file.txt'))).toEqual(before);
  });
});
