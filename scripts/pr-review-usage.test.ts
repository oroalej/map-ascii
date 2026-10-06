import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeUsage, transcriptTotals } from './pr-review-usage';

const turn = (id: string, usage: Record<string, number>) =>
  JSON.stringify({ type: 'assistant', message: { id, usage } });
let directory: string | null = null;
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = null;
});

describe('Claude review usage', () => {
  it('counts each streamed assistant message once and ignores other lines', () => {
    const usage = {
      input_tokens: 3,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 1000,
      output_tokens: 20,
    };
    const text = [
      JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      turn('a', usage),
      turn('a', usage),
      'not json',
      turn('b', { ...usage, output_tokens: 5 }),
      '',
    ].join('\n');
    expect(transcriptTotals(text)).toEqual({
      turns: 2,
      input: 6,
      cacheWrite: 200,
      cacheRead: 2000,
      output: 25,
    });
  });

  it('keeps the main session and its subagents separate', () => {
    directory = mkdtempSync(join(tmpdir(), 'claude-usage-'));
    const project = join(directory, 'projects', 'D--repo');
    mkdirSync(join(project, 'session-1', 'subagents'), { recursive: true });
    writeFileSync(join(project, 'session-1.jsonl'), turn('m', { cache_read_input_tokens: 10 }));
    for (const name of ['agent-a.jsonl', 'agent-b.jsonl'])
      writeFileSync(
        join(project, 'session-1', 'subagents', name),
        turn(name, { cache_read_input_tokens: 7, output_tokens: 1 }),
      );
    expect(claudeUsage('session-1', directory)).toEqual({
      sessionId: 'session-1',
      main: { turns: 1, input: 0, cacheWrite: 0, cacheRead: 10, output: 0 },
      subagents: { count: 2, turns: 2, input: 0, cacheWrite: 0, cacheRead: 14, output: 2 },
    });
  });

  it('reports unavailable usage instead of estimating it', () => {
    directory = mkdtempSync(join(tmpdir(), 'claude-usage-'));
    expect(claudeUsage('missing', directory)).toBeNull();
    mkdirSync(join(directory, 'projects', 'D--repo'), { recursive: true });
    expect(claudeUsage('missing', directory)).toBeNull();
  });
});
