# Validate Claude's PR review

You are validating a code review that Claude Code wrote for an ASCII Atlas pull request. The PR number, head commit, base branch, and the path to Claude's review are given in the prompt that sent you here.

## Analysis only

Work as if in plan mode. Don't edit, create, delete, stage, commit, or push anything in the repository. You may:

- read files, and run `git` and `gh` commands (`gh pr view`, `gh pr diff`, `gh pr checks`, `git show <headRefOid>:<path>`)
- run targeted tests to confirm or refute a finding (`pnpm --filter @atlas/<pkg> exec vitest run <file>`)
- write throwaway probe scripts outside the repo only (the OS temp dir)

Other sessions may have uncommitted edits in this checkout. Read the PR's code from the head commit, not the working tree, unless `git status` shows the file is clean.

## Read first

1. Claude's review (the file path in the prompt).
2. `AGENTS.md`: conventions, the "Verifying changes" table, and the Don'ts.
3. The PR: `gh pr view <N> --json title,body,files,commits`, `gh pr diff <N>`, and `gh pr checks <N>`.
4. If `.plans/README.md` in the main checkout lists the PR's branch, read that task's `handoff.md` for the PR's intent, invariants, and out-of-scope list.

## Validate every entry

Go through every Blocker, Should-fix, and Nit in Claude's review. For each one:

1. Read the cited `path:line` on the head commit, plus enough of the surrounding code and callers to judge it.
2. Check the claim:
   - The code really does what the entry says.
   - The scenario really happens, with inputs or state that can actually occur. Prove it with a test run when reading alone can't settle it.
   - CI doesn't already catch it (ESLint, typecheck, `no-hardcoding.test.ts`, `check:budgets`), unless `gh pr checks` shows that check failing.
   - A reuse claim cites a helper that exists and fits.
   - A performance claim sits on a real hot path (per frame, per agent step, per tile, worker message, initial JS, renderer chunk, pmtiles, or CI time).
   - The suggested fix is correct and follows `AGENTS.md`, and it stays within the PR's intent and any handoff out-of-scope list.
3. Give a verdict:
   - **valid**: the problem and the fix both hold
   - **partly valid**: the problem holds but the fix or scope needs changing (say how)
   - **invalid**: the claim doesn't hold (say why)
4. Correct the severity if it's wrong, with a one-line reason.

Don't add findings of your own. If you notice something serious that Claude missed, list it under "Noticed, not in Claude's review", with an id `N<n>`, its `path:line` and a severity (blocker / should-fix / nit), judged as strictly as Claude's entries. Prove it the same way. The fixer fixes a noticed blocker or should-fix in this round like any valid entry, so give each one a fix step (`**N<n> <severity>**`). Noticed nits get no fix step.

## Output

Your final message is saved as `validation.md` and drives the fixes. Use exactly this shape:

```
**Claude's verdict:** <copied from the review>

### Validation
| # | Claude's severity | Entry (path:line — one-line claim) | Verdict | Evidence | Final severity |
| --- | --- | --- | --- | --- | --- |

### Fix steps
1. **#<n> <final severity>** — `path:line`
   - Change: <what to change; a short code sketch when the shape matters>
   - Files: <repo-relative paths>
   - Test: <the targeted Vitest file or `pnpm run test --changed`; add or update a unit test when the bug has none>
   - Outside the PR's diff: <no | yes, because …>

### Noticed, not in Claude's review
- **N<n> <blocker | should-fix | nit>** <path:line — one line> — <evidence> (or "None")
```

- Include every entry in the Validation table, invalid ones too.
- Fix steps cover the valid and partly valid entries plus noticed blockers and should-fix items, ordered blockers, then should-fix, then nits. Merge entries that change the same code into one step.
- If no entry is valid and nothing serious was noticed, write "No valid entries" under Fix steps.
