---
name: review-pr
description: Have Claude Code (Opus 5.5, high effort) review the current branch's pull request with the repo's review-pr skill, validate every Claude finding in a separate Sol 6.1 max-effort analysis-only run, then implement, commit and push the valid fixes. Use when the user invokes $review-pr (optionally with --fast) or asks Codex to get a Claude review of this branch's PR and fix what holds up.
---

# Claude review → Codex validation → fixes

Treat invocation of `$review-pr` as authorization to run the whole flow: Claude's review, the validation run, the fixes, one or more commits, and a push to the PR's branch. Do not ask for confirmation between steps. Stop only where this skill says to stop.

## Models

Always pass these explicitly. Never change them or fall back to another model.

| Role | Model | Effort | Speed |
| --- | --- | --- | --- |
| Review | Claude Opus 5.5 (`claude-opus-5-5`) | high | normal |
| Codex #1: validates Claude's review (analysis only) | Sol 6.1 (`gpt-6.1-sol`) | max | `<speed>` |
| This session: fixes, commits, pushes | Sol 6.1 (`gpt-6.1-sol`) | xhigh | the session's own setting |

## Inputs (all optional)

The PR is always the current branch's PR. None of these inputs selects a different one.

- `--fast`: Codex #1 runs in fast mode. Set `<speed>`:
  - with `--fast`: `-c 'service_tier="fast"' --enable fast_mode`
  - without it: `--disable fast_mode`. Pass this explicitly, because the user's Codex config may default to fast.
- A caller such as `$sync-review` may also pass:
  - `Round: <k>`: echo it back in the result.
  - `Rejected entries file: <path>`: a markdown list of entries judged invalid in earlier rounds. Pass it to Claude (step 2).
  - `Previous result file: <path>`: the previous round's result JSON, used for stall detection (step 4).
  - `Result file: <path>`: where to write this run's result JSON (step 5).

Without these inputs, the skill behaves as a single standalone review.

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
- If a `Rejected entries file` was given, add `--append-system-prompt (Get-Content -Raw <path>)` to the command (PowerShell). That file must start with: "Entries below were already judged invalid in earlier review rounds. Don't report them again unless the cited code has changed since."
- Afterwards, compare `git -C <pr-checkout> status --porcelain` with the baseline. If anything changed, report the difference and stop. Do not revert it.
- If the command failed, or `claude-review.md` has no `**Verdict:**` line, report the error and the file's tail and stop. Do not review the PR yourself instead.

## 3. Validate Claude's review (Codex #1: Sol 6.1, max, analysis only)

Run from `<pr-checkout>`, with a shell timeout of at least 30 minutes. `<skill-dir>` is the absolute path of the folder holding this `SKILL.md` (`.agents/skills/review-pr/` in the checkout Codex loaded it from). `<speed>` comes from the `--fast` input.

```
codex exec -m gpt-6.1-sol -c 'model_reasoning_effort="max"' <speed> -s danger-full-access -C <pr-checkout> -o <scratch>/validation.md "Follow <skill-dir>/references/validate-prompt.md exactly. PR: #<N> (<url>), head <headRefOid>, base <baseRefName>. Claude's review: <scratch>/claude-review.md."
```

- Never change the model, effort or speed flags, and never skip this run to validate in this session instead.
- Afterwards, compare `git -C <pr-checkout> status --porcelain` with the baseline. Gitignored test caches don't show up. If anything changed, report the difference and stop. Do not revert it.
- If `validation.md` is missing or has no validation table, report that and stop.

## 4. Implement the valid entries

Read `validation.md`. Stop and report the validation table, without editing anything, if:

- no entry is valid or partly valid, or
- a fix step needs files outside the PR's diff and the step doesn't explain why, or
- a stall is found (only when a `Previous result file` was given):
  - **Repeat:** a valid blocker or should-fix has the same `path` and the same claim as an entry the previous result marked `fixed`.
  - **Oscillation:** applying a fix would revert, fully or partly, one of the previous result's `commits`. Check with `git show <commit>`.

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
- The speed Codex #1 ran at (fast or normal)

End the report with a fenced block tagged `review-pr-result`, holding one JSON object:

```review-pr-result
{
  "status": "clean",
  "pr": 12,
  "round": 1,
  "fast": false,
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
  "commits": ["abc1234"],
  "stopReason": null
}
```

- `verdict` is one of `valid`, `partly` or `invalid`. `outcome` is one of `fixed`, `skipped` or `none`. `round` is `null` when no round was given.
- `status`:
  - `clean`: no valid or partly valid blocker or should-fix, including when no entry is valid at all. Valid nits may have been fixed.
  - `fixed`: at least one valid blocker or should-fix was fixed and pushed, and none was skipped.
  - `stalled`: a stall was found in step 4. Nothing was edited.
  - `stopped`: a fix needed files outside the PR's diff without a reason, or a valid blocker or should-fix was skipped.
  - `error`: Claude or Codex #1 failed, or a `git status` check failed. Every earlier "report … and stop" ends here, with `stopReason` set.
- If a `Result file` was given, also write the same JSON object to that path. Write only the object, without the fence.

Then delete `<scratch>` and everything in it. The `Result file` lives outside `<scratch>`, so it stays.
