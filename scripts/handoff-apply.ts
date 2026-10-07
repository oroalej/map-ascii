/**
 * Apply a handoff reviewer's amendments to a candidate handoff (`.agents/skills/review-handoff`):
 *   pnpm --silent handoff:apply --report <review.md> --candidate <candidate.md> [--out <json>] [--record <label>] [--dry-run]
 * Reads the report's `### Amendments` section (`N. **<id> [factual|design]** — Section: <heading>`,
 * then `- Replace:` and `- With:` as inline text or fenced blocks), places each Find text in the
 * candidate (exact, then indentation-tolerant, then whitespace-tolerant; `(add)` appends to the
 * named section), rewrites the candidate, and lists what it could not place. Every handoff review
 * used to re-implement this in a throwaway Python script.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export type Amendment = {
  id: string;
  type: 'factual' | 'design';
  section: string;
  /** Exact text to replace, or null for `(add)`. */
  find: string | null;
  replace: string;
};

export type Placement = Amendment & { method: 'exact' | 'indent' | 'whitespace' | 'add' };
export type Unplaced = Amendment & { reason: string };
export type ApplyResult = { text: string; applied: Placement[]; unplaced: Unplaced[] };

const fence = /^[ \t]*```[\w-]*[ \t]*$/;
/** Reports saved with Out-File start with a byte-order mark. */
const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/** The text of one `- Replace:` / `- With:` item: inline on the same line, or a fenced block below. */
function itemText(lines: string[], start: number): { text: string | null; next: number } {
  const line = (at: number): string => lines[at] ?? '';
  const inline = line(start).replace(/^[ \t]*-\s*(?:Replace|With):\s*/i, '');
  if (inline.trim()) return { text: inline.trim(), next: start + 1 };
  let i = start + 1;
  while (i < lines.length && !line(i).trim()) i++;
  if (i >= lines.length || !fence.test(line(i))) return { text: null, next: i };
  const body: string[] = [];
  for (i++; i < lines.length && !fence.test(line(i)); i++) body.push(line(i));
  return { text: dedent(body).join('\n'), next: i + 1 };
}

function dedent(lines: string[]): string[] {
  const indents = lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length);
  const common = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => (l.trim() ? l.slice(common) : ''));
}

/** Parses the `### Amendments` section of a handoff review or validation report. */
export function parseAmendments(report: string): Amendment[] {
  const text = stripBom(report).replace(/\r\n/g, '\n');
  const start = text.search(/^###\s+Amendments\s*$/m);
  if (start < 0) return [];
  const rest = text.slice(start).split('\n').slice(1);
  const end = rest.findIndex((line) => /^#{1,3}\s/.test(line));
  const lines = end < 0 ? rest : rest.slice(0, end);
  const amendments: Amendment[] = [];
  let i = 0;
  while (i < lines.length) {
    const head =
      /^\s*\d+\.\s+\*\*([^\s*]+)\s+\[(factual|design)\]\*\*\s*(?:[—–-]+\s*)?(?:Section:\s*)?(.*)$/i.exec(
        lines[i] ?? '',
      );
    if (!head) {
      i++;
      continue;
    }
    const current: Amendment = {
      id: head[1] ?? '',
      type: (head[2] ?? 'factual').toLowerCase() as Amendment['type'],
      section: (head[3] ?? '').trim().replace(/^[*_`]+|[*_`]+$/g, ''),
      find: null,
      replace: '',
    };
    let find: string | null | undefined, replace: string | null | undefined;
    i++;
    while (i < lines.length && !/^\s*\d+\.\s+\*\*/.test(lines[i] ?? '')) {
      if (/^[ \t]*-\s*Replace:/i.test(lines[i] ?? '')) {
        const item = itemText(lines, i);
        find = item.text;
        i = item.next;
      } else if (/^[ \t]*-\s*With:/i.test(lines[i] ?? '')) {
        const item = itemText(lines, i);
        replace = item.text;
        i = item.next;
        // One entry may carry several Replace/With pairs.
        if (find !== undefined && replace !== null && replace !== undefined) {
          amendments.push({
            ...current,
            find: find === null || /^\(add\)$/i.test(find.trim()) ? null : find,
            replace,
          });
          find = undefined;
          replace = undefined;
        }
      } else i++;
    }
  }
  return amendments;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) count++;
  return count;
}

export type Location = {
  start: number;
  end: number;
  method: Placement['method'];
  /** Spaces the matched lines carry beyond the Find text; the replacement gets the same. */
  indent: number;
};

/**
 * Finds `find` once in `text`: at a line start as written, re-indented by the same amount on every
 * line (reviewers quote nested list items without their surrounding indentation), or ignoring
 * whitespace runs. A match that is only a substring of a longer line is not a match.
 */
export function locate(text: string, find: string): Location | { reason: string } {
  const lines = find.split('\n');
  const anchored = `\n${text}`;
  for (let indent = 0; indent <= 12; indent++) {
    const candidate = `\n${lines.map((l) => (l.trim() ? ' '.repeat(indent) + l : l)).join('\n')}`;
    const n = occurrences(anchored, candidate);
    if (n === 1) {
      const start = anchored.indexOf(candidate) + indent;
      return {
        start,
        end: start + candidate.length - 1 - indent,
        method: indent ? 'indent' : 'exact',
        indent,
      };
    }
    if (n > 1) return { reason: `matches ${n} places` };
  }
  const pattern = new RegExp(find.trim().split(/\s+/).map(escape).join('\\s+'), 'g');
  const matches = [...text.matchAll(pattern)];
  const only = matches.length === 1 ? matches[0] : undefined;
  if (only && only.index !== undefined) {
    const start = only.index;
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    const prefix = text.slice(lineStart, start);
    return {
      start,
      end: start + only[0].length,
      method: 'whitespace',
      indent: /^\s*$/.test(prefix) ? prefix.length : 0,
    };
  }
  return { reason: matches.length ? `matches ${matches.length} places` : 'text not found' };
}

const indentLines = (text: string, indent: number): string =>
  indent
    ? text
        .split('\n')
        .map((l, i) => (i > 0 && l.trim() ? ' '.repeat(indent) + l : l))
        .join('\n')
    : text;

/** The end offset of the section whose heading contains `section` (case-insensitive), or -1. */
function sectionEnd(text: string, section: string): number {
  const headings = [...text.matchAll(/^(#{1,6})[ \t]+(.+?)[ \t]*$/gm)].map((h) => ({
    index: h.index,
    level: (h[1] ?? '').length,
    title: (h[2] ?? '').toLowerCase(),
  }));
  const wanted = section.toLowerCase();
  const index = headings.findIndex((h) => h.title.includes(wanted));
  if (index < 0) return -1;
  const level = headings[index]?.level ?? 0;
  const next = headings.slice(index + 1).find((h) => h.level <= level);
  return next?.index ?? text.length;
}

export function applyAmendments(candidate: string, amendments: Amendment[]): ApplyResult {
  let text = stripBom(candidate).replace(/\r\n/g, '\n');
  const applied: Placement[] = [],
    unplaced: Unplaced[] = [];
  for (const amendment of amendments) {
    if (amendment.find === null) {
      const at = amendment.section ? sectionEnd(text, amendment.section) : -1;
      if (at < 0) {
        unplaced.push({ ...amendment, reason: `section "${amendment.section}" not found` });
        continue;
      }
      const before = text.slice(0, at).replace(/\n*$/, '\n\n');
      text = `${before}${amendment.replace}\n${at < text.length ? '\n' : ''}${text.slice(at)}`;
      applied.push({ ...amendment, method: 'add' });
      continue;
    }
    const where = locate(text, amendment.find);
    if ('reason' in where) {
      unplaced.push({ ...amendment, reason: where.reason });
      continue;
    }
    text =
      text.slice(0, where.start) +
      indentLines(amendment.replace, where.indent) +
      text.slice(where.end);
    applied.push({ ...amendment, method: where.method });
  }
  return { text, applied, unplaced };
}

/** Appends the applied amendments to the candidate's `## Review amendments` record. */
export function recordAmendments(text: string, label: string, applied: Placement[]): string {
  if (!applied.length) return text;
  // One entry may carry several Replace/With pairs; the record lists each amendment once.
  const lines = [...new Map(applied.map((a) => [a.id, a])).values()].map((a) => {
    const entry = `${label} ${a.id} [${a.type}] — ${a.section || 'unnamed section'}`;
    return `- ${a.type === 'design' ? `**${entry}**` : entry}`;
  });
  const heading = /^##\s+Review amendments\s*$/m.exec(text);
  if (!heading || heading.index === undefined)
    return `${text.replace(/\n*$/, '\n')}\n## Review amendments\n\n${lines.join('\n')}\n`;
  const end = sectionEnd(text, 'Review amendments');
  const before = text.slice(0, end).replace(/\n*$/, '\n');
  return `${before}${lines.join('\n')}\n${end < text.length ? '\n' : ''}${text.slice(end)}`;
}

export function parseHandoffApplyArgs(args: readonly string[]) {
  const { values } = parseArgs({
    args: args.filter((arg) => arg !== '--'),
    options: {
      report: { type: 'string' },
      candidate: { type: 'string' },
      out: { type: 'string' },
      record: { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
    strict: true,
  });
  if (!values.report || !values.candidate) throw new Error('--report and --candidate are required');
  return {
    report: resolve(values.report),
    candidate: resolve(values.candidate),
    out: values.out ? resolve(values.out) : null,
    record: values.record ?? null,
    dryRun: values['dry-run'] ?? false,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let options: ReturnType<typeof parseHandoffApplyArgs>;
  try {
    options = parseHandoffApplyArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    console.error(
      'usage: pnpm --silent handoff:apply --report <review.md> --candidate <candidate.md> [--out <json>] [--record <label>] [--dry-run]',
    );
    process.exit(2);
  }
  const amendments = parseAmendments(readFileSync(options.report, 'utf8'));
  const result = applyAmendments(readFileSync(options.candidate, 'utf8'), amendments);
  const text = options.record
    ? recordAmendments(result.text, options.record, result.applied)
    : result.text;
  if (!options.dryRun) writeFileSync(options.candidate, text, 'utf8');
  const summary = { applied: result.applied, unplaced: result.unplaced, dryRun: options.dryRun };
  if (options.out) writeFileSync(options.out, JSON.stringify(summary, null, 2) + '\n', 'utf8');
  console.log(
    `${options.dryRun ? 'would apply' : 'applied'} ${result.applied.length} of ${amendments.length}` +
      (result.unplaced.length
        ? `; unplaced: ${result.unplaced.map((u) => `${u.id} (${u.reason})`).join(', ')}`
        : ''),
  );
  process.exit(result.unplaced.length ? 1 : 0);
}
