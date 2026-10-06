import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claudeEfforts,
  loadState,
  parseState,
  startReview,
  updateState,
} from './pr-review-checkpoint';
import type { Recovery } from './pr-review-checkpoint';
import { artifact, fixture, reviewText } from './pr-review-fixture';
import { interruptedResult, runProcess } from './pr-review-process';
import { command } from './pr-review-state';

let setup: ReturnType<typeof fixture>;
beforeEach(() => {
  setup = fixture();
});
afterEach(() => {
  rmSync(setup.directory, { recursive: true, force: true });
});

describe('Claude review effort', () => {
  it.each(claudeEfforts)(
    'forwards %s from initialization to native review arguments',
    async (effort) => {
      const initialized = await command('init', { ...setup.options, claudeEffort: effort });
      const { state } = initialized.value as Recovery;
      const result = await runProcess({
        run: state.run,
        phase: 'review',
        round: state.round,
        headSha: state.headSha,
        executable: process.execPath,
        args: [
          '-e',
          'process.stdout.write(process.argv[3] + "\\n" + JSON.stringify(process.argv.slice(1, 3)))',
          '--',
          '--effort',
          '{claudeEffort}',
          reviewText,
        ],
        output: 'stdout',
      });
      expect(state.claudeEffort).toBe(effort);
      expect(result.receipt.valid).toBe(true);
      expect(result.receipt.args).toContain(effort);
      const observed = readFileSync(result.receipt.report, 'utf8').trim().split('\n').at(-1);
      expect(JSON.parse(observed!)).toEqual(['--effort', effort]);
    },
  );

  it('defaults to medium, inherits explicit effort, and resets fresh runs to medium', async () => {
    expect((await startReview(setup.options)).state.claudeEffort).toBe('medium');
    const selected = await startReview({ ...setup.options, claudeEffort: 'medium' });
    const folder = join(selected.state.run, 'checkpoints');
    const before = readdirSync(folder).map((name) => readFileSync(join(folder, name), 'utf8'));
    const resumed = await startReview({ ...setup.options, resume: selected.state.run });
    expect(resumed.state.claudeEffort).toBe('medium');
    expect(resumed.state.claudeEffortExplicit).toBe(true);
    expect(readdirSync(folder).map((name) => readFileSync(join(folder, name), 'utf8'))).toEqual(
      before,
    );
    const fresh = await startReview({ ...setup.options, fresh: true });
    expect(fresh.state.claudeEffort).toBe('medium');
    expect(fresh.state.claudeEffortExplicit).toBe(false);
    expect(fresh.state.resumedFrom).toBeNull();
  });

  it('moves a resumed implicit default to the current default and keeps explicit choices', async () => {
    const { state } = await startReview(setup.options);
    await updateState(state.run, (saved) => {
      saved.claudeEffort = 'high';
      saved.claudeEffortExplicit = false;
    });
    expect((await startReview(setup.options)).state.claudeEffort).toBe('medium');
    const chosen = await startReview({ ...setup.options, fresh: true, claudeEffort: 'high' });
    const resumed = await startReview({ ...setup.options, resume: chosen.state.run });
    expect(resumed.state).toMatchObject({ claudeEffort: 'high', claudeEffortExplicit: true });
    expect(() => parseState({ ...state, claudeEffortExplicit: 'yes' })).toThrow(
      'Invalid review checkpoint',
    );
  });

  it('normalizes old checkpoints in memory and leaves their saved bytes unchanged', async () => {
    const { state } = await startReview(setup.options);
    const old: Record<string, unknown> = { ...state };
    delete old.claudeEffort;
    const folder = join(state.run, 'checkpoints');
    const name = readdirSync(folder)[0];
    if (!name) throw new Error('Expected saved checkpoint');
    const path = join(folder, name);
    const bytes = JSON.stringify(old);
    writeFileSync(path, bytes);
    expect(parseState(old).claudeEffort).toBe('high');
    expect(old).not.toHaveProperty('claudeEffort');
    expect(loadState(state.run).claudeEffort).toBe('high');
    expect((await startReview(setup.options)).state.claudeEffort).toBe('medium');
    expect(readFileSync(path, 'utf8')).toBe(bytes);
    expect(() => parseState({ ...state, claudeEffort: 'auto' })).toThrow(
      'Invalid review checkpoint',
    );
  });

  it.each(['', 'auto', 'ultracode', 'HIGH', null, 3])(
    'rejects invalid effort %s before creating a run',
    async (effort) => {
      await expect(command('init', { ...setup.options, claudeEffort: effort })).rejects.toThrow(
        'Invalid Claude effort',
      );
      expect(existsSync(join(setup.directory, '.plans'))).toBe(false);
    },
  );

  it('applies an override while retaining completed review provenance and reuse', async () => {
    const { state } = await startReview({ ...setup.options, claudeEffort: 'low' });
    await updateState(state.run, (saved) => {
      saved.phase = 'review';
    });
    await artifact(state, 'review', { args: ['--effort', 'low'] });
    const resumed = await startReview({ ...setup.options, claudeEffort: 'xhigh' });
    expect(resumed.state.claudeEffort).toBe('xhigh');
    expect(resumed.state.phase).toBe('validation');
    expect(resumed.reusable).toHaveLength(1);
    expect(resumed.reusable[0]?.args).toEqual(['--effort', 'low']);
    expect(loadState(state.run).claudeEffort).toBe('low');
  });

  it('retains selected effort in quota results and their continuation', async () => {
    const { state } = await startReview({ ...setup.options, claudeEffort: 'max' });
    await command('interrupt', { run: state.run, reason: 'Usage exhausted' });
    expect(interruptedResult(state.run)).toMatchObject({
      status: 'interrupted',
      claudeEffort: 'max',
    });
    expect((await startReview(setup.options)).state.claudeEffort).toBe('max');
  });
});
