import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadState,
  parseReceipt,
  readJson,
  receiptValid,
  startReview,
  updateState,
} from './pr-review-checkpoint';
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
  // Review slots are machine-wide; tests must not queue behind (or block) real reviews.
  process.env.ATLAS_REVIEW_SLOTS_DIR = join(setup.directory, 'review-slots');
});
afterEach(() => {
  delete process.env.ATLAS_REVIEW_SLOTS_DIR;
  rmSync(setup.directory, { recursive: true, force: true });
});

/** A stub Claude: writes a transcript whose final message is a complete review, then behaves as asked. */
const transcriptStub = (then: string) =>
  [
    'const fs=require("node:fs"),p=require("node:path");',
    'const dir=p.join(process.env.CLAUDE_CONFIG_DIR,"projects","repo");',
    'fs.mkdirSync(dir,{recursive:true});',
    'const e=(o)=>JSON.stringify(o)+"\\n";',
    'fs.writeFileSync(p.join(dir,process.argv[2]+".jsonl"),',
    ' e({type:"assistant",message:{id:"a",stop_reason:"tool_use",usage:{output_tokens:1},content:[{type:"tool_use",name:"Read"}]}})',
    '+e({type:"user",message:{content:[{type:"tool_result",content:"x"}]}})',
    '+e({type:"assistant",message:{id:"b",stop_reason:"end_turn",usage:{output_tokens:2},content:[{type:"text",text:process.argv[1]}]}})',
    '+e({type:"attachment"}));',
    then,
  ].join('');

function withClaudeConfig<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(setup.directory, 'claude-config');
  return run().finally(() => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  });
}

describe('review process receipts', () => {
  it('pins a Claude session and records its token usage after exit', async () => {
    const { state } = await startReview(setup.options);
    const config = join(setup.directory, 'claude-config');
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = config;
    try {
      const result = await runProcess({
        run: state.run,
        phase: 'review',
        round: 1,
        headSha: state.headSha,
        executable: process.execPath,
        args: [
          '-e',
          [
            'const fs=require("node:fs"),p=require("node:path");',
            'const dir=p.join(process.env.CLAUDE_CONFIG_DIR,"projects","repo");',
            'fs.mkdirSync(p.join(dir,process.argv[2],"subagents"),{recursive:true});',
            'const t=(id,n)=>JSON.stringify({type:"assistant",message:{id,usage:{cache_read_input_tokens:n,output_tokens:1}}});',
            'fs.writeFileSync(p.join(dir,process.argv[2]+".jsonl"),t("m",5));',
            'fs.writeFileSync(p.join(dir,process.argv[2],"subagents","a.jsonl"),t("s",9));',
            'process.stdout.write(process.argv[1]);',
          ].join(''),
          reviewText,
          '{sessionId}',
        ],
        output: 'stdout',
      });
      const sessionId = result.receipt.sessionId;
      expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.receipt.args).toContain(sessionId);
      expect(result.receipt.usage).toMatchObject({
        sessionId,
        main: { turns: 1, cacheRead: 5, output: 1 },
        subagents: { count: 1, turns: 1, cacheRead: 9, output: 1 },
      });
      expect(parseReceipt(readJson(result.path)).usage).toEqual(result.receipt.usage);
      const plain = await runProcess({
        run: state.run,
        phase: 'review',
        round: 1,
        headSha: state.headSha,
        executable: process.execPath,
        args: ['-e', 'process.stdout.write(process.argv[1])', reviewText],
        output: 'stdout',
      });
      expect(plain.receipt).toMatchObject({ sessionId: null, usage: null });
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
  });

  it('takes the report from the transcript when a finished session never prints or exits', async () => {
    const { state } = await startReview(setup.options);
    const result = await withClaudeConfig(() =>
      runProcess({
        run: state.run,
        phase: 'review',
        round: 1,
        headSha: state.headSha,
        executable: process.execPath,
        // Finished (end_turn) but hung: exactly what headless Claude did on 2026-10-07.
        args: ['-e', transcriptStub('setInterval(()=>{},1000);'), reviewText, '{sessionId}'],
        output: 'stdout',
        watchdog: { pollMs: 50, idleMs: 150 },
      }),
    );
    expect(result.receipt).toMatchObject({
      valid: true,
      reportSource: 'transcript',
      terminatedBy: 'idle-watchdog',
      status: 'completed',
    });
    expect(result.receipt.exitCode).not.toBe(0);
    expect(readFileSync(result.receipt.report, 'utf8')).toBe(reviewText);
    expect(result.receipt.reportHash).toBe(parseReceipt(readJson(result.path)).reportHash);
    expect(receiptValid(result.receipt, state, state.headSha)).toBe(true);
  });

  it('ends a child at the phase time cap and keeps an unfinished transcript invalid', async () => {
    const { state } = await startReview(setup.options);
    const result = await withClaudeConfig(() =>
      runProcess({
        run: state.run,
        phase: 'review',
        round: 1,
        headSha: state.headSha,
        executable: process.execPath,
        // The last message is still a tool call: the session has not finished.
        args: [
          '-e',
          [
            'const fs=require("node:fs"),p=require("node:path");',
            'const dir=p.join(process.env.CLAUDE_CONFIG_DIR,"projects","repo");fs.mkdirSync(dir,{recursive:true});',
            'fs.writeFileSync(p.join(dir,process.argv[1]+".jsonl"),JSON.stringify({type:"assistant",message:{stop_reason:"tool_use",content:[{type:"tool_use"}]}})+"\\n");',
            'setInterval(()=>{},1000);',
          ].join(''),
          '{sessionId}',
        ],
        output: 'stdout',
        watchdog: { pollMs: 30, idleMs: 60, maxMs: 200 },
      }),
    );
    expect(result.receipt).toMatchObject({ valid: false, terminatedBy: 'time-cap', quota: null });
  });

  it('accepts a complete review whose section headings vary', async () => {
    const { state } = await startReview(setup.options);
    const result = await runProcess({
      run: state.run,
      phase: 'review',
      round: 1,
      headSha: state.headSha,
      executable: process.execPath,
      args: [
        '-e',
        'process.stdout.write(process.argv[1])',
        '**CI:** pending on the pinned head.\n\n**Verdict:** Approve. Nothing to fix.\n\n**Checked, no issues**\nA · B\n',
      ],
      output: 'stdout',
    });
    expect(result.receipt).toMatchObject({ valid: true, reportSource: 'stdout' });
    expect(reportComplete('review', '### Verdict\n**Verdict:** Changes requested — one gap')).toBe(
      true,
    );
    expect(reportComplete('review', 'Working on it: verdict pending')).toBe(false);
  });

  it('binds review and validation receipts to the round scope', async () => {
    const { state } = await startReview(setup.options);
    const scope = join(state.run, 'round1', 'scope.json');
    mkdirSync(join(state.run, 'round1'), { recursive: true });
    writeFileSync(scope, '{"mode":"full"}');
    const review = await runProcess({
      run: state.run,
      phase: 'review',
      round: 1,
      headSha: state.headSha,
      executable: process.execPath,
      args: ['-e', 'process.stdout.write(process.argv[1])', reviewText],
      output: 'stdout',
      scope,
    });
    expect(review.receipt.scope?.file).toBe(scope);
    expect(receiptValid(review.receipt, state, state.headSha)).toBe(true);
    const validate = (withScope?: string) =>
      runProcess({
        run: state.run,
        phase: 'validation',
        round: 1,
        headSha: state.headSha,
        executable: process.execPath,
        args: [
          '-e',
          'require("node:fs").writeFileSync(process.argv[1],process.argv[2])',
          '{report}',
          validationText,
        ],
        output: 'file',
        reviewReceipt: review.path,
        scope: withScope,
      });
    await expect(validate()).rejects.toThrow('Validation scope does not match its review');
    expect((await validate(scope)).receipt.valid).toBe(true);
    writeFileSync(scope, '{"mode":"delta"}');
    expect(receiptValid(review.receipt, state, state.headSha)).toBe(false);
  });

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
    const review = await artifact(state, 'review');
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
      reviewReceipt: review.path,
    });
    expect(result.receipt.valid).toBe(true);
    expect(result.receipt.inputReview).toEqual({
      token: review.receipt.token,
      reportHash: review.receipt.reportHash,
    });
    const recovered = await startReview(setup.options, loadState(state.run), receiptActive);
    expect(recovered.state.phase).toBe('fixes');
    expect(recovered.reusable).toHaveLength(2);
  });

  it('rejects an invalid input review before starting validation', async () => {
    const { state } = await startReview(setup.options);
    const review = await artifact(state, 'review', { exitCode: 1 });
    await expect(
      runProcess({
        run: state.run,
        phase: 'validation',
        round: 1,
        headSha: state.headSha,
        executable: process.execPath,
        args: ['-e', '', '{report}'],
        output: 'file',
        reviewReceipt: review.path,
      }),
    ).rejects.toThrow('input review could not be verified');
  });

  it('rejects validation completion if its input report changes while the child runs', async () => {
    const { state } = await startReview(setup.options);
    const review = await artifact(state, 'review');
    const result = await runProcess({
      run: state.run,
      phase: 'validation',
      round: 1,
      headSha: state.headSha,
      executable: process.execPath,
      args: [
        '-e',
        'const fs=require("node:fs");fs.writeFileSync(process.argv[1],process.argv[2]);fs.writeFileSync(process.argv[3],"changed")',
        '{report}',
        validationText,
        review.receipt.report,
      ],
      output: 'file',
      reviewReceipt: review.path,
    });
    expect(result.receipt.exitCode).toBe(0);
    expect(result.receipt.valid).toBe(false);
  });

  it('saves quota exhaustion immediately and publishes a usable interrupted result', async () => {
    const { state } = await startReview({ ...setup.options, claudeEffort: 'medium' });
    await updateState(state.run, (saved) => {
      saved.phase = 'review';
      saved.ci.status = 'pending';
    });
    const copy = join(setup.directory, '.plans', 'active', 'caller', 'review.json');
    const result = await command('run', {
      run: state.run,
      phase: 'review',
      round: 1,
      headSha: state.headSha,
      executable: process.execPath,
      args: [
        '-e',
        'console.error("You\'ve hit your Opus limit · resets 12:10pm (Asia/Manila)"); process.exit(1)',
      ],
      output: 'stdout',
      resultFile: copy,
    });
    expect(result.exitCode).toBe(75);
    const saved = loadState(state.run);
    expect(saved.status).toBe('interrupted');
    expect(saved.interruption?.reset).toBe('resets 12:10pm (Asia/Manila)');
    const published = publishInterrupted(state.run);
    expect(published).toMatchObject({
      status: 'interrupted',
      claudeEffort: 'medium',
      ci: { status: 'pending' },
      resume: { phase: 'review', round: 1, checkpoint: state.run },
    });
    expect(existsSync(`${state.run}/result.json`)).toBe(true);
    expect(readJson(copy)).toEqual(readJson(join(state.run, 'result.json')));
    expect((await startReview(setup.options)).state.claudeEffort).toBe('medium');
  });

  it('recognizes documented model, spend and budget exhaustion while preserving literal resets', () => {
    const messages = [
      "You've hit your limit · resets 3:45pm",
      "You've hit your Opus limit · resets 3:45pm",
      "You've hit your Sonnet limit · resets 3:45pm",
      "You've hit your monthly spend limit · raise it at claude.ai/settings/usage",
      "You've hit your individual spend limit · ask your admin for a higher limit",
      "You've hit your org's monthly spend limit · visit claude.ai/admin-settings/usage",
      "You've hit your channel's monthly spend limit · ask your admin",
      "You've hit your team's shared budget · ask your admin",
      "You've hit your individual usage limit · your session limit resets 3:45pm",
    ];
    for (const message of messages) {
      expect(quotaFailure(message), message).toEqual({
        reason: message,
        reset: message.includes('resets') ? 'resets 3:45pm' : null,
      });
    }
    expect(quotaFailure('HTTP 429: too many requests')).toBeNull();
    expect(quotaFailure('Rate limit exceeded; retry later')).toBeNull();
    expect(quotaFailure('{"error":{"code":"rate_limit_exceeded"}}')).toBeNull();
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
    expect(reportComplete('review', '**Verdict:** Approve')).toBe(true);
    expect(reportComplete('review', 'no verdict yet')).toBe(false);
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
