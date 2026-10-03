---
name: review-pr
description: Review the current branch's pull request until it's clean and CI is green. Each round, Claude Code (Opus 5.5, high effort) reviews with the repo's review-pr skill, a separate Sol 6.1 max-effort run validates every finding, and this session fixes, commits and pushes the valid ones; up to 3 rounds. Then failing CI is fixed. Never merges. Use when the user invokes $review-pr (optionally with --fast) or asks Codex to get a Claude review of this branch's PR and fix what holds up.
---

# Claude review → Codex validation → fixes, until clean, then CI

Treat invocation of `$review-pr` as authorization to run the whole flow: up to 3 review rounds (Claude's review, the validation run, the fixes, commits and pushes to the PR's branch), then the CI gate (CI fixes, commits and pushes). Do not ask for confirmation between steps. Stop only where this skill says to stop. Never merge the PR.

## Models

Always pass these explicitly. Never change them or fall back to another model.

| Role | Model | Effort | Speed |
| --- | --- | --- | --- |
| Review (every round) | Claude Opus 5.5 (`claude-opus-5-5`) | high | normal |
| Codex #1: validates Claude's review (analysis only, every round) | Sol 6.1 (`gpt-6.1-sol`) | max | `<speed>` |
| This session: fixes, commits, pushes, CI fixes | Sol 6.1 (`gpt-6.1-sol`) | xhigh | the session's own setting |

## Inputs (all optional)

The PR is always the current branch's PR. No input selects a different one.

- `--fast`: every Codex instance this skill starts runs in fast mode. Today that's Codex #1, in every round. Set `<speed>` once, and pass it to every `codex exec` this skill runs:
  - with `--fast`: `-c 'service_tier="fast"' --enable fast_mode`
  - without it: `--disable fast_mode`. Pass this explicitly, because the user's Codex config may default to fast.

  `--fast` doesn't change Claude or this session.
- `Result file: <path>`: a caller such as `$sync-review` passes this. Write the final result JSON there (step 7).

## Rules

- **Git safety:** never check out, switch branches, stash, reset, rebase, force-push, use `git add -A`, `git add .` or `git commit -a`, or pass `--no-verify`.
- **Windows:** stdout is captured with `Out-File -Encoding utf8`, never a plain `>`, which writes UTF-16.
- **Long commands:** if the shell tool can't hold a command for its timeout, start it in the background with output going to a log in `<scratch>`, and poll until it exits.
- **On "stop with `<status>`"**, skip straight to step 7 with that status and a `stopReason`.

## 1. Resolve the branch's PR

1. Confirm the repo has the Claude skill: `.claude/skills/review-pr/SKILL.md`. If it is missing, stop with `error`.
2. Run `git branch --show-current`, then `gh pr view --json number,title,headRefName,headRefOid,baseRefName,url`.
   - If the branch has no PR, stop with `error` (`No PR for <branch>`). Never fall back to another PR, a branch diff, or a PR number from anywhere else.
3. Find the checkout with this branch: `git worktree list`. Call it `<pr-checkout>`.
4. The main checkout is the first entry of `git worktree list`. Set `<scratch>` to `<main-checkout>/.plans/active/pr<N>-review-fixes/` and create it. `.plans/` is gitignored. Put every file this skill writes there.
5. Save the baseline: `git -C <pr-checkout> status --porcelain` → `<scratch>/status-baseline.txt`. Other sessions may have uncommitted edits. Leave them alone.
6. Set `<speed>` from `--fast`, and say in the first line of output which speed is used.

## 2. Round k: Claude reviews the PR

Rounds start at k = 1. Each round has its own folder, `<scratch>/round<k>/`. Refresh `headRefOid` with `gh pr view` at the start of every round.

Run from `<pr-checkout>`, with a shell timeout of at least 20 minutes:

```
claude -p "/review-pr <N>" --model claude-opus-5-5 --effort high --dangerously-skip-permissions --output-format text | Out-File -Encoding utf8 <scratch>/round<k>/claude-review.md
```

- Use exactly these flags. Never change the model or effort, or drop a flag.
- From round 2 on, if `<scratch>/rejected.md` exists, add `--append-system-prompt (Get-Content -Raw <scratch>/rejected.md)` to the command (PowerShell).
- Afterwards, compare `git -C <pr-checkout> status --porcelain` with the baseline. If anything changed, report the difference and stop with `error`. Do not revert it.
- If the command failed, or `claude-review.md` has no `**Verdict:**` line, stop with `error`, including the file's tail. Do not review the PR yourself instead.

## 3. Round k: validate Claude's review (Codex #1: Sol 6.1, max, analysis only)

Run from `<pr-checkout>`, with a shell timeout of at least 30 minutes. `<skill-dir>` is the absolute path of the folder holding this `SKILL.md` (`.agents/skills/review-pr/` in the checkout Codex loaded it from).

```
codex exec -m gpt-6.1-sol -c 'model_reasoning_effort="max"' <speed> -s danger-full-access -C <pr-checkout> -o <scratch>/round<k>/validation.md "Follow <skill-dir>/references/validate-prompt.md exactly. PR: #<N> (<url>), head <headRefOid>, base <baseRefName>. Claude's review: <scratch>/round<k>/claude-review.md."
```

- Never change the model, effort or speed flags, and never skip this run to validate in this session instead.
- Afterwards, compare `git -C <pr-checkout> status --porcelain` with the baseline. Gitignored test caches don't show up. If anything changed, report the difference and stop with `error`. Do not revert it.
- If `validation.md` is missing or has no validation table, stop with `error`.
- Append this round's `invalid` entries to `<scratch>/rejected.md`, one per line: `path:line — claim`. When creating the file, start it with this line: "Entries below were already judged invalid in earlier review rounds. Don't report them again unless the cited code has changed since."

## 4. Round k: implement the valid entries

Read `validation.md`, and check these before editing anything:

- **No valid blocker or should-fix:** the round is **clean**. Fix any valid nits as below, then go to step 6.
- **A fix step needs files outside the PR's diff, and the step doesn't explain why:** stop with `stopped`.
- **Stall** (round 2 and later, compared with `<scratch>/round<k-1>/result.json`): stop with `stalled`, without editing.
  - **Repeat:** a valid blocker or should-fix has the same `path` and the same claim as an entry the previous round marked `fixed`.
  - **Oscillation:** applying a fix would revert, fully or partly, one of the previous round's commits. Check with `git show <commit>`.

Otherwise, work in `<pr-checkout>` on the PR's head branch:

1. Follow the fix steps in order: blockers, then should-fix, then nits. Scope each change to its entry. Follow `AGENTS.md` conventions.
2. After each step, run that step's targeted test: the named Vitest file, or `pnpm run test --changed`. Fix a failure before moving on. If a fix can't be made to pass, revert only your own edit for that entry and mark it skipped. A skipped blocker or should-fix ends the round with `stopped`.
3. Once at the end of the round, run the checks from the `AGENTS.md` "Verifying changes" table that cover the touched files. Leave the full suite to CI.
4. Before committing, run `git status` and `git branch`. Confirm the branch is still the PR's head branch. Stage only the files you changed, by explicit path. If a file you must stage also holds someone else's uncommitted edits from the baseline, don't commit it. Report it instead.
5. Commit with a gitmoji + conventional message that matches `git log` (e.g. `🐛 fix(renderer): …`). Use one commit, or one per area if the fixes are unrelated.
6. Push to the PR's branch with a plain `git push`. If the fixes change what the PR description says, update it with `gh pr edit <N> --body-file`.

Write this round's record to `<scratch>/round<k>/result.json`: `{round, claudeVerdict, entries, commits}` (shape in step 7).

## 5. Review loop (at most 3 rounds)

After each round:

- **Clean** (no valid blocker or should-fix) → step 6.
- **Fixed** (valid blockers or should-fix items were fixed and pushed) → if k < 3, start round k+1 at step 2. Otherwise stop with `capped`, listing the entries still open.
- `stalled`, `stopped` and `error` have already ended the run.

Nits are fixed when they come up. New nits alone never start another round, because a round whose only valid entries are nits is clean.

## 6. CI gate (at most 3 fix attempts)

1. Wait until the PR has checks for its current head SHA (`gh pr view <N> --json headRefOid,statusCheckRollup`), then run `gh pr checks <N> --watch`, with a shell timeout of at least 30 minutes. If everything passes, go to step 7 with `clean`.
2. If a check fails, find its run and read it: `gh run view <run-id> --log-failed`. For e2e failures, also download the Playwright artifact: `gh run download <run-id> -n playwright-results-<shard> -D <scratch>/ci`.
   - **Infrastructure flake** (runner, network or dependency-download error, or a timeout with no failing test): rerun once with `gh run rerun <run-id> --failed`, then go back to 1. If the same failure comes back, treat it as real.
   - **Real failure:**
     - Reproduce it locally in `<pr-checkout>` with the narrowest command: the failing Vitest file, or `pnpm test:e2e --project=chromium -g "<test>"`. A run may wait for a heavy slot; let it wait.
     - Fix the cause. Change the test only if the test itself is wrong.
     - Once it passes locally, commit (`🐛 fix(<scope>): …` or `💚 ci(<scope>): …`) following step 4's staging rules, push, and go back to 1. This counts as one fix attempt.
3. If any CI fix touched non-test source code, run one more review round (steps 2–4) once CI is green. It counts toward the 3-round cap; if the cap is already used, stop with `capped`. If the round isn't clean, follow step 5's outcomes. If it's clean, repeat this step from 1 for its pushes.
4. Still red after 3 fix attempts → stop with `ci-red`, naming the failing check and what was tried.

## 7. Report and clean up

Report:

- Each round: Claude's verdict, and the validation table (# / Claude's severity / verdict / evidence / final severity)
- Fixed entries, with the commit hashes
- Skipped entries, each with its reason
- Anything under "Noticed, not in Claude's review", for the user to decide on (not fixed)
- The CI gate: reruns, fix attempts and fix commits, and the final check state
- Which checks ran locally, and which were left to CI
- The PR URL, the speed Codex #1 ran at (fast or normal), and the final status

End the report with a fenced block tagged `review-pr-result`, holding one JSON object:

```review-pr-result
{
  "status": "clean",
  "pr": 12,
  "fast": false,
  "rounds": [
    {
      "round": 1,
      "claudeVerdict": "Changes requested — …",
      "entries": [
        {
          "id": 1,
          "claudeSeverity": "blocker",
          "finalSeverity": "should-fix",
          "path": "packages/renderer/src/x.ts",
          "line": 42,
          "claim": "one line",
          "verdict": "valid",
          "outcome": "fixed",
          "commit": "abc1234",
          "skipReason": null
        }
      ],
      "commits": ["abc1234"]
    }
  ],
  "ci": { "status": "green", "reruns": 0, "attempts": 0, "fixCommits": [] },
  "stopReason": null
}
```

- `verdict` is one of `valid`, `partly` or `invalid`. `outcome` is one of `fixed`, `skipped` or `none`.
- `ci.status`: `green` (passed with no fixes), `fixed` (passed after fix commits), `red`, or `not-run` (the run stopped before step 6).
- `status`:
  - `clean`: the last round was clean and CI passed (`ci.status` is `green` or `fixed`).
  - `capped`: still had valid blockers or should-fix items after round 3.
  - `stalled`: a repeat or an oscillation was found. Nothing was edited in that round.
  - `stopped`: a fix needed files outside the PR's diff without a reason, or a valid blocker or should-fix was skipped.
  - `ci-red`: CI still failed after 3 fix attempts.
  - `error`: no PR, Claude or Codex #1 failed, or a `git status` check found unexpected changes.
- If a `Result file` was given, also write the same JSON object to that path. Write only the object, without the fence.

Then delete `<scratch>` and everything in it. The `Result file` lives outside `<scratch>`, so it stays.
