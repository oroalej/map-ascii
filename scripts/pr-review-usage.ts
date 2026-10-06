import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type TokenTotals = {
  turns: number;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
};
/** Main session and subagents stay separate so neither total is counted twice. */
export type ClaudeUsage = {
  sessionId: string;
  main: TokenTotals;
  subagents: TokenTotals & { count: number };
};

const empty = (): TokenTotals => ({ turns: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

/** Streamed chunks of one assistant message repeat its id and usage; count each id once. */
export function transcriptTotals(text: string): TokenTotals {
  const totals = empty(),
    seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry !== 'object' || entry === null) continue;
    const { type, message } = entry as { type?: unknown; message?: unknown };
    if (type !== 'assistant' || typeof message !== 'object' || message === null) continue;
    const { id, usage } = message as { id?: unknown; usage?: unknown };
    if (typeof usage !== 'object' || usage === null) continue;
    if (typeof id === 'string') {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    const u = usage as Record<string, unknown>;
    totals.turns++;
    totals.input += count(u.input_tokens);
    totals.cacheWrite += count(u.cache_creation_input_tokens);
    totals.cacheRead += count(u.cache_read_input_tokens);
    totals.output += count(u.output_tokens);
  }
  return totals;
}

/**
 * Reads a `claude -p --session-id` transcript after the process exits. Claude Code stores it
 * under `<config>/projects/<project>/<session>.jsonl`, with subagents in `<session>/subagents/`.
 * Returns null when the transcript is missing or unreadable; usage is never estimated.
 */
export function claudeUsage(
  sessionId: string,
  configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
): ClaudeUsage | null {
  try {
    const projects = join(configDir, 'projects');
    if (!existsSync(projects)) return null;
    for (const project of readdirSync(projects)) {
      const transcript = join(projects, project, `${sessionId}.jsonl`);
      if (!existsSync(transcript)) continue;
      const main = transcriptTotals(readFileSync(transcript, 'utf8'));
      const subagents = { ...empty(), count: 0 };
      const folder = join(projects, project, sessionId, 'subagents');
      if (existsSync(folder))
        for (const name of readdirSync(folder)
          .filter((file) => file.endsWith('.jsonl'))
          .sort()) {
          const totals = transcriptTotals(readFileSync(join(folder, name), 'utf8'));
          subagents.count++;
          for (const key of Object.keys(totals) as (keyof TokenTotals)[])
            subagents[key] += totals[key];
        }
      return { sessionId, main, subagents };
    }
    return null;
  } catch {
    return null;
  }
}
