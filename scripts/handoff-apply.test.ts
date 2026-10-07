import { describe, expect, it } from 'vitest';
import {
  applyAmendments,
  locate,
  parseAmendments,
  parseHandoffApplyArgs,
  recordAmendments,
} from './handoff-apply';
import type { Amendment } from './handoff-apply';

const report = `**Verdict:** ready-with-amendments — two stale citations

### Findings
| ID | Type | Section | Problem | Evidence |
| --- | --- | --- | --- | --- |
| 1.1 | factual | Steps | wrong line | main:draw.ts:12 |

### Amendments
1. **1.1 [factual]** — Section: Steps
   - Replace:

     \`\`\`md
     - Edit \`draw.ts:10\` so that
       people render.
     \`\`\`

   - With:

     \`\`\`md
     - Edit \`draw.ts:12\` so that
       people render.
     \`\`\`

2. **1.2 [design]** — Section: Invariants
   - Replace: (add)
   - With: - Never draw below z17.

3. **1.3 [factual]** — Section: Verification
   - Replace: run every test
   - With: run \`pnpm test:related packages/renderer/src/life/draw.ts\`

### Inspected paths
packages/renderer/src/life/draw.ts
`;

const candidate = `# Task

## 1. Goal
Draw people.

## 2. Invariants
- Keep the renderer city-agnostic.

## 3. Steps
1. Something first.
   - Edit \`draw.ts:10\` so that
     people render.
2. Then run every test.

## 4. Verification
Then   run every test again.
`;

describe('handoff amendments', () => {
  it('parses fenced, inline and (add) amendments', () => {
    const amendments = parseAmendments(report);
    expect(amendments).toEqual([
      {
        id: '1.1',
        type: 'factual',
        section: 'Steps',
        find: '- Edit `draw.ts:10` so that\n  people render.',
        replace: '- Edit `draw.ts:12` so that\n  people render.',
      },
      {
        id: '1.2',
        type: 'design',
        section: 'Invariants',
        find: null,
        replace: '- Never draw below z17.',
      },
      {
        id: '1.3',
        type: 'factual',
        section: 'Verification',
        find: 'run every test',
        replace: 'run `pnpm test:related packages/renderer/src/life/draw.ts`',
      },
    ]);
    expect(parseAmendments('**Verdict:** ready\n\n### Amendments\nNone\n')).toEqual([]);
  });

  it('places text exactly, by re-indenting, or ignoring whitespace runs, and reports the rest', () => {
    expect(locate('a\nb\n', 'b')).toMatchObject({ method: 'exact', start: 2, end: 3, indent: 0 });
    expect(locate('x\n   - item\n', '- item')).toMatchObject({
      method: 'indent',
      start: 5,
      end: 11,
      indent: 3,
    });
    expect(locate('Then   run every\ttest again.', 'run every test again')).toMatchObject({
      method: 'whitespace',
      indent: 0,
    });
    expect(locate('a\na\n', 'a')).toEqual({ reason: 'matches 2 places' });
    expect(locate('a', 'z')).toEqual({ reason: 'text not found' });
    // A line's tail is not a match for a Find that quotes a whole line.
    expect(locate('prefix item\n', 'item')).toMatchObject({ method: 'whitespace' });
  });

  it('applies amendments to the candidate and records them', () => {
    const [first, add, ambiguous] = parseAmendments(report) as [Amendment, Amendment, Amendment];
    const result = applyAmendments(candidate, [first, add, ambiguous]);
    expect(result.applied.map((a) => [a.id, a.method])).toEqual([
      ['1.1', 'indent'],
      ['1.2', 'add'],
    ]);
    expect(result.unplaced).toEqual([{ ...ambiguous, reason: 'matches 2 places' }]);
    expect(result.text).toContain('   - Edit `draw.ts:12` so that\n     people render.');
    expect(result.text).toContain(
      '- Keep the renderer city-agnostic.\n\n- Never draw below z17.\n\n## 3. Steps',
    );
    expect(applyAmendments(candidate, [{ ...add, section: 'Nowhere' }]).unplaced[0]?.reason).toBe(
      'section "Nowhere" not found',
    );
    const recorded = recordAmendments(result.text, 'round 1', result.applied);
    expect(recorded).toMatch(
      /## Review amendments\n\n- round 1 1\.1 \[factual\] — Steps\n- \*\*round 1 1\.2 \[design\] — Invariants\*\*\n$/,
    );
    const again = recordAmendments(recorded, 'round 2', [{ ...first, id: '2.1', method: 'exact' }]);
    expect(again).toMatch(/Invariants\*\*\n- round 2 2\.1 \[factual\] — Steps\n$/);
    expect(recordAmendments(candidate, 'round 1', [])).toBe(candidate);
    const twice = recordAmendments(candidate, 'round 1', [
      { ...first, method: 'exact' },
      { ...first, method: 'exact' },
    ]);
    expect(twice.match(/round 1 1\.1/g)).toHaveLength(1);
  });

  it('requires the report and candidate paths', () => {
    expect(() => parseHandoffApplyArgs(['--report', 'r.md'])).toThrow('--candidate');
    expect(
      parseHandoffApplyArgs([
        '--report',
        'r.md',
        '--candidate',
        'c.md',
        '--dry-run',
        '--record',
        'round 1',
      ]),
    ).toMatchObject({ dryRun: true, record: 'round 1', out: null });
  });
});
