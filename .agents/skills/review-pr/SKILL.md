---
name: review-pr
description: Have Claude Code (Opus 5.5, high effort) review the current branch's pull request with the repo's review-pr skill, validate every Claude finding in a separate Sol 6.1 max-effort analysis-only run, then implement, commit and push the valid fixes. Use when the user invokes $review-pr or asks Codex to get a Claude review of this branch's PR and fix what holds up. Takes no argument.
---

# Claude review → Codex validation → fixes

Treat invocation of `$review-pr` as authorization to run the whole flow: Claude's review, the validation run, the fixes, one or more commits, and a push to the PR's branch. Do not ask for confirmation between steps. Stop only where this skill says to stop.

## 1. Resolve the branch's PR

1. Confirm the repo has the Claude skill: `.claude/skills/review-pr/SKILL.md`. If it is missing, report that and stop.
2. Run `git branch --show-current`, then `gh pr view --json number,title,headRefName,headRefOid,baseRefName,url`.
   - If the branch has no PR, report `No PR for <branch>` and stop. Never fall back to another PR, a branch diff, or a PR number from anywhere else.
3. Find the checkout with this branch: `git worktree list`. Call it `<pr-checkout>`. Never check out, switch, stash, or reset.
4. The main checkout is the first entry of `git worktree list`. Set `<scratch>` to `<main-checkout>/.plans/active/pr<N>-review-fixes/` and create it. `.plans/` is gitignored. Put every file this skill writes there.
5. Save the baseline: `git -C <pr-checkout> status --porcelain` → `<scratch>/status-baseline.txt`. Other sessions may have uncommitted edits. Leave them alone.

## 2. Claude reviews the PR

Run from `<pr-checkout>`, with a shell timeout of at least 20 minutes. Capture stdout as UTF-8. In PowerShell, pipe to `Out-File -Encoding utf8`, because a plain `>` writes UTF-16.

```
claude -p "/review-pr <N>" --model claude-opus-5-5 --effort high --dangerously-skip-permissions --output-format text | Out-File -Encoding utf8 <scratch>/claude-review.md
```

- Use exactly these flags. Never change the model or effort, or drop a flag.
- Afterwards, compare `git -C <pr-checkout> status --porcelain` with the baseline. If anything changed, report the difference and stop. Do not revert it.
- If the command failed, or `claude-review.md` has no `**Verdict:**` line, report the error and the file's tail and stop. Do not review the PR yourself instead.

## 3. Validate Claude's review (Sol 6.1, max, analysis only)

Run from `<pr-checkout>`, with a shell timeout of at least 30 minutes. `<skill-dir>` is the absolute path of the folder holding this `SKILL.md` (`.agents/skills/review-pr/` in the checkout Codex loaded it from).

```
codex exec -m gpt-6.1-sol -c 'model_reasoning_effort="max"' -s danger-full-access -C <pr-checkout> -o <scratch>/validation.md "Follow <skill-dir>/references/validate-prompt.md exactly. PR: #<N> (<url>), head <headRefOid>, base <baseRefName>. Claude's review: <scratch>/claude-review.md."
```

- Never change the model or effort, and never skip this run to validate in this session instead.
- Afterwards, compare `git -C <pr-checkout> status --porcelain` with the baseline. Gitignored test caches don't show up. If anything changed, report the difference and stop. Do not revert it.
- If `validation.md` is missing or has no validation table, report that and stop.

## 4. Implement the valid entries

Read `validation.md`. Stop and report the validation table, without editing anything, if:

- no entry is valid or partly valid, or
- a fix step needs files outside the PR's diff and the step doesn't explain why.

Otherwise, work in `<pr-checkout>` on the PR's head branch:

1. Follow the fix steps in order: blockers, then should-fix, then nits. Scope each change to its entry. Follow `AGENTS.md` conventions.
2. After each step, run that step's targeted test: the named Vitest file, or `pnpm run test --changed`. Fix a failure before moving on. If a fix can't be made to pass, revert only your own edit for that entry, mark it skipped, and continue.
3. Once at the end, run the checks from the `AGENTS.md` "Verifying changes" table that cover the touched files. Leave the full suite to CI.
4. Before committing, run `git status` and `git branch`. Confirm the branch is still the PR's head branch. Stage only the files you changed, by explicit path. Never use `git add -A`, `git add .`, or `git commit -a`. If a file you must stage also holds someone else's uncommitted edits from the baseline, don't commit it. Report it instead.
5. Commit with a gitmoji + conventional message that matches `git log` (e.g. `🐛 fix(renderer): …`). Use one commit, or one per area if the fixes are unrelated.
6. Push to the PR's branch with a plain `git push`. Never force-push. If the fixes change what the PR description says, update it with `gh pr edit <N> --body-file`.

## 5. Report and clean up

Report:

- Claude's verdict, and the validation table: # / Claude's severity / verdict / evidence / final severity
- Fixed entries, with the commit hashes
- Skipped entries, each with its reason
- Anything under "Noticed, not in Claude's review", for the user to decide on (not fixed)
- Which checks ran, and which were left to CI
- The push result and the PR URL

Then delete `<scratch>` and everything in it.
