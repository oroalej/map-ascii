---
name: sync-review
description: For each comma-separated branch, commit and push, open a PR, delegate synchronization and resumable review to $review-pr, get CI green, and merge with $merge-pr. Usage exhaustion retains progress and ends the loop. Other branch errors skip only branches stacked on them. Use for $sync-review with optional --fast, --claude-effort and comma-separated branches.
---

# Sync, review and merge branches

Usage: `$sync-review [--fast] [--claude-effort <level>] codex/tree-canopy, codex/stable-labels, codex/vehicle-lamps-exhaust`

The user lists only branches that are safe to process. Invoking `$sync-review` authorizes these actions, for the listed branches only:

- creating a worktree for a branch that has none (or a detached work tree)
- committing everything uncommitted in their worktrees, except held-back files
- merging `main` into them, resolving every conflict (including regenerating and publishing tiles with `pnpm data:build` / `pnpm data:publish`), and pushing
- opening PRs to `main`
- running `$review-pr`, which commits and pushes fixes
- fixing CI
- merging the PRs into `main`, which deploys to production through Vercel
- after each merge, deleting the task's `.plans` scratch, its local branch and its worktree folder (`$merge-pr`). Remote branches stay.

Don't ask for confirmation between steps or branches. Follow [shared.md](../review-pr/references/shared.md): Ends, Shared patterns, Rules, Binaries (`codex` only), Speed and Claude effort. Propagate an interrupted delegated review immediately, keeping all task scratch and worktrees.

## Models

| Role | Model | Effort | Speed | How |
| --- | --- | --- | --- | --- |
| Loop session (this session): commits, conflicts, PRs, CI fixes, merges | Sol 6.1 (`gpt-6.1-sol`) | xhigh | the session's own setting | the user's session |
| PR review | Claude Opus 5.5 (`claude-opus-5-5`) | `<claude-effort>` | normal | started by `$review-pr` |
| Codex #1: validates Claude's review (analysis only) | Sol 6.1 (`gpt-6.1-sol`) | max | `<speed>` | started by `$review-pr` |
| Codex #2: runs `$review-pr` (review rounds, fixes, CI gate) | Sol 6.1 (`gpt-6.1-sol`) | xhigh | `<speed>` | started by this skill (step 4) |

`$review-pr` resolves its own `codex` and `claude`. `--fast` and `--claude-effort` apply to every listed branch's review.

## Rules for every branch

shared.md's Rules apply, plus:

- **Keep going:** a branch ends unmerged only with an "Ends" `error` (nothing to do, or a missing tool). Then continue with the next branch, skipping only later branches whose PR base, or whose merge-base with `main`, is that branch's head (they're stacked on it): report them as `not processed: stacked on <branch>`. A missing tool that every branch needs (`gh` auth, `codex`) ends the loop, since no later branch could run either.
- **Interrupted review:** `interrupted` ends the loop immediately. Report remaining branches as `not processed: review interrupted`, retain the original branch order in the report, and print the checkpoint and resume command. Do not merge, clean up, or repeatedly relaunch the exhausted coordinator.
- **Branch worktree:** run every command against the branch's worktree (`git -C <wt> …`, or with `<wt>` as the working directory). Background logs go in `<run>`.

## 0. Prepare (once)

1. Parse the argument:
   - Take out `--fast` if present and set `<speed>`.
   - Take out and validate `--claude-effort <level>` if present, retaining whether it was explicit.
   - Split the rest on commas. Trim, drop empty entries and duplicates, and strip a leading `origin/`.
   - Drop `main` and report it as skipped.
   - Print the branch order and the speed (fast or normal) as the first line of output.
2. Run `gh auth status`. If it fails, end with a missing tool. Then run `git fetch origin` (with Retry).
3. Map each branch to its worktree with `git worktree list --porcelain`.
   - No worktree: create one as `<review-pr-skill>` step 1.3 does, with `<main-checkout>/worktrees/<short>`. If the branch exists only locally and has no worktree, use `git worktree add <path> <branch>`.
   - Checked out in the first entry (the main checkout): use a detached work tree at `origin/<branch>` (shared.md). Uncommitted work in the main checkout stays untouched and is reported.
   - A branch that exists neither locally nor on `origin` → `skipped: no such branch` (nothing to do).
4. Create `<run>` = `$env:TEMP/sync-review-<yyyyMMdd-HHmmss>/`. It lives outside `.plans/` on purpose. `<main-checkout>` is the first worktree entry.
5. `<skill-dir>` is the absolute folder of this `SKILL.md`. `<review-pr-skill>` is `<skill-dir>/../review-pr/SKILL.md` and `<merge-pr-skill>` is `<skill-dir>/../merge-pr/SKILL.md`. Confirm both files exist. If one doesn't, end with a missing tool. Then resolve `<codex>` (shared.md, Binaries).

Then process the branches one at a time, in the order given. `<slug>` is the branch name with `/` replaced by `-`.
For a branch whose existing PR has a saved incomplete review, inspect it with the review recovery reference before step 1. Skip steps 1 and 3 and continue at step 4: the review coordinator owns its unfinished fixes and verification. Do not commit that WIP through the generic commit step. A live saved coordinator is awaited.

## 1. Commit and push

1. If `git -C <wt> status --porcelain` isn't empty, review `git diff`, `git diff --cached` and the untracked files.
2. Hold back any file that looks like a secret (`.env*`, keys, tokens, credentials) and any file over 10 MB. Leave held-back files uncommitted and untouched, report them, and continue.
3. Stage the rest by explicit path.
4. Commit with one gitmoji + conventional message written from the diff, matching `git log` (e.g. `✨ feat(life): …`): lowercase, imperative, header at most 72 characters. Hooks run. If a hook rejects the commit, fix what it reports (formatting, lint, a wrong branch for the main checkout: use the detached work tree) and commit again.
5. If `origin/<branch>` has commits the local branch lacks, run `git merge origin/<branch>`. Resolve any conflicts with the rules in [merge-main.md](../review-pr/references/merge-main.md) item 4.
6. `git push -u origin <branch>` (in a detached work tree, `git push origin HEAD:<branch>`). If it is rejected because the remote moved, repeat step 5 and push again; Retry a network failure.

## 2. Delegate main synchronization to review-pr

No action: `$review-pr` merges `origin/main` first (its step 1.7), and `$merge-pr` syncs again if `main` moves before the merge (its gate 3). Each branch therefore picks up the branches merged before it.

## 3. Open a PR if none exists

1. `gh pr list --head <branch> --base main --state open --json number,url`. If there's one, use it.
2. Otherwise, write a body to `<run>/<slug>-pr-body.md` and run `gh pr create --base main --head <branch> --title "<title>" --body-file <run>/<slug>-pr-body.md`.
   - Title: a gitmoji + conventional header summarizing the branch's commits since `main`.
   - Body: what the branch does, taken from its commits and its handoff, plus a test plan listing the checks the handoff names. Don't invent claims about tests that weren't run.

## 4. Review (up to 3 rounds), with the CI gate ($review-pr)

`$review-pr` runs the review loop and CI gate itself. Start Codex #2 with the delegated review call (shared.md), using `resultFile: "<run>/<slug>-review.json"`:

```
pnpm.cmd -C <repo> --silent review:state run --input <run>/<slug>-coordinator-input.json
```

If the result file is missing, use the canonical checkpoint result, or else the `review-pr-result` block at the end of the `-o` file.

- `clean` → step 5.
- `error` → the branch ends with its `stopReason`; apply "Keep going".
- `interrupted` → end the loop with saved progress, leaving later branches unprocessed ("Interrupted review").

## 5. Confirm CI

1. Confirm the result's `ci.status` is `green` or `fixed`.
2. Confirm `gh pr checks <N>` passes on the PR's current head SHA (`gh pr view <N> --json headRefOid`). If checks are still running, wait with `gh pr checks <N> --watch`.
3. If either check fails, run `<review-pr-skill>` step 6 (the CI gate) yourself in the branch's worktree until CI is green, including its review round when a CI fix touched non-test source code. Use the new head from then on.

## 6. Merge into main

1. Check that `$review-pr` ended `clean` and step 5 passed on the PR's current head SHA. Held-back files were never committed, so they don't block the merge.

   Don't check whether the PR is behind `main` or conflicting: if `main` moved, `$merge-pr` merges `origin/main` into it (its gate 3).
2. Follow `<merge-pr-skill>` exactly for `<branch>` with `Head: <sha>` and `--claude-effort <review-result.claudeEffort>`, where `<sha>` is the review result's `headSha` (or, after a step-6.3 retry, the head its CI gate passed on), with `<main-checkout>` as the working directory (never `<wt>`: its folder gets deleted). If an older result lacks effort, read its checkpoint or use the original fixed `high`. It re-checks the gate, merges `origin/main` into the branch whenever `main` moved, waits for CI, merges with `gh pr merge <N> --merge --match-head-commit <gated-sha>`, updates the task's `.plans` rows, deletes the scratch with `pnpm plans:clean`, stops processes left running in the worktree with `pnpm worktree:stop`, and removes the local branch and worktree with `pnpm worktree:remove`. The remote branch stays.
3. Read its `merge-pr-result`.
   - `merged` → done. A cleanup failure after a merge is reported in step 8 but doesn't stop the loop.
   - `error` → the branch ends with its `stopReason` (an "Ends" case); apply "Keep going". `$merge-pr` fixes CI and syncs `main` itself, so nothing else comes back.
   - `interrupted` → propagate the saved review checkpoint and end the loop; do not run cleanup or later branches.

## 7. Note an unmerged branch in `.plans`

When a branch ended with `error` or `interrupted` before merging: in `<main-checkout>/.plans/README.md`, set the Next step of the rows that aren't in `done/` and whose Evidence names the branch to the stop reason and continuation command. `$review-pr` has already set their PR review cell when it could report. Don't move or clean anything. A merged branch's rows were already handled by `$merge-pr`.

## 8. Report

After each branch, print one line:

`<branch>: commit <sha|none> · main <mainMerge from the review result> · PR #N · review <roundCount> rounds, <status>, <n> open · CI <ci.status> · <merged <sha>, cleanup <done|failed: what> | error: <reason>>`

At the end, print a table of every listed branch (branch / commit / main merge / PR / review / CI / result). It includes skipped and not-processed branches, created worktrees and detached work trees, held-back files, open review entries, aborted merges with the missing tool and their files, conflict decisions, cleanup failures, and errors. Print the `codex` version from step 0.5 under it. Leave `<run>` in the OS temp folder and print its path: Codex rejects recursive shell deletes as "blocked by policy".
